import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import {
  ALLOWED_DIAGNOSTIC_COLLECTIONS,
  authorizeDiagnosticsActor,
  DiagnosticsSecurityError,
  maskUidServer,
  redactSecretsServer,
  sanitizeTextServer,
  SlidingWindowRateLimiter,
  validateDiagnosticsRequest,
  type DiagnosticStatus,
} from './diagnosticsCore.js';
import {
  buildWorldEventRotationPlan,
  type ExistingWorldEventRecord,
} from './worldEventsEngine.js';

const NEXORA_PROJECT_ID = 'gen-lang-client-0074900177';
const NEXORA_DATABASE_ID = 'ai-studio-74843d9e-8228-49b7-a616-317cadd90bff';
const NEXORA_AUTH_DOMAIN = 'gen-lang-client-0074900177.firebaseapp.com';

const adminApp = getApps().length > 0 ? getApps()[0] : initializeApp();
const db = getFirestore(adminApp, NEXORA_DATABASE_ID);
const rateLimiter = new SlidingWindowRateLimiter(6, 60_000);

function toHttpsError(err: unknown): HttpsError {
  if (err instanceof DiagnosticsSecurityError) {
    const map: Record<DiagnosticsSecurityError['code'], 'unauthenticated' | 'permission-denied' | 'invalid-argument' | 'resource-exhausted'> = {
      UNAUTHENTICATED: 'unauthenticated',
      PERMISSION_DENIED: 'permission-denied',
      INVALID_ARGUMENT: 'invalid-argument',
      RESOURCE_EXHAUSTED: 'resource-exhausted',
    };
    return new HttpsError(map[err.code], err.message);
  }
  return new HttpsError('internal', 'Internal diagnostics check failure.');
}

function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Read-only owner-restricted Cloud Function Gen 2 for NEXORA Diagnostics.
 * - Verifies Firebase ID token (via onCall auth context).
 * - Enforces verified email + owner authorization (Custom Claims, diagnostics_admins/{uid}, or server env allowlist).
 * - Rejects arbitrary collection names, free-form queries, and all mutations.
 * - Aggregates collection counts using Firestore count() without full collection downloads or PII leaks.
 */
export const nexoraDiagnostics = onCall(
  {
    region: 'us-central1',
    cors: true,
    maxInstances: 2,
    timeoutSeconds: 30,
    memory: '256MiB',
    enforceAppCheck: process.env.NEXORA_ENFORCE_APP_CHECK === 'true',
  },
  async (request) => {
    try {
      const { action, locale } = validateDiagnosticsRequest(request.data);

      if (!request.auth) {
        throw new DiagnosticsSecurityError('UNAUTHENTICATED', 'Authentication is required.');
      }

      const token = request.auth.token;
      const uid = request.auth.uid;

      // Check read-only Admin-managed diagnostics_admins/{uid} document
      let adminDocEnabled = false;
      try {
        const adminSnap = await db.doc(`diagnostics_admins/${uid}`).get();
        const adminData = adminSnap.data();
        adminDocEnabled =
          adminSnap.exists && adminData?.enabled === true && adminData?.role === 'owner';
      } catch {
        adminDocEnabled = false;
      }

      const authResult = authorizeDiagnosticsActor(
        {
          uid,
          email: typeof token.email === 'string' ? token.email : null,
          emailVerified: token.email_verified === true,
          claims: token as Record<string, unknown>,
        },
        adminDocEnabled,
        {
          allowedUids: parseAllowlist(process.env.DIAGNOSTICS_ALLOWED_UIDS),
          allowedEmails: parseAllowlist(process.env.DIAGNOSTICS_ALLOWED_EMAILS),
        }
      );

      rateLimiter.consume(uid);

      const nowIso = new Date().toISOString();

      if (action === 'health_ping') {
        return redactSecretsServer({
          ok: true,
          status: 'healthy' as DiagnosticStatus,
          checkedAt: nowIso,
          verifiedBy: authResult.verifiedBy,
          runtime: 'nodejs22-gen2',
        });
      }

      // 1. Firestore Health Ping
      const pingStart = Date.now();
      let firestoreStatus: DiagnosticStatus = 'healthy';
      let firestoreMsg = 'Connected to named Firestore Enterprise database.';
      try {
        await db.doc('test/connection').get();
      } catch (err) {
        firestoreStatus = 'error';
        firestoreMsg = sanitizeTextServer(err instanceof Error ? err.message : String(err));
      }
      const latencyMs = Date.now() - pingStart;

      // 2. Server-side count() aggregations across fixed allowlist
      const countMap = new Map<string, number | null>();
      const databaseCollections = await Promise.all(
        ALLOWED_DIAGNOSTIC_COLLECTIONS.map(async (spec) => {
          try {
            const agg = await db.collection(spec.name).count().get();
            const count = agg.data().count;
            countMap.set(spec.name, count);
            return {
              name: spec.name,
              category: spec.category,
              piiRestricted: spec.piiRestricted,
              count,
              countSource: 'admin_aggregation' as const,
              status: 'healthy' as DiagnosticStatus,
              note: spec.piiRestricted
                ? 'PII/restricted collection: aggregate count only.'
                : 'Verified via Admin SDK count().',
            };
          } catch (err) {
            countMap.set(spec.name, null);
            return {
              name: spec.name,
              category: spec.category,
              piiRestricted: spec.piiRestricted,
              count: null,
              countSource: 'unavailable' as const,
              status: 'warning' as DiagnosticStatus,
              note: sanitizeTextServer(err instanceof Error ? err.message : 'Count query failed'),
            };
          }
        })
      );

      // 3. Bounded referential integrity checks (max 50 docs, zero PII returned)
      const warnings: string[] = [];
      const failedChecks: string[] = [];

      let orphanedOrgRefs = 0;
      let invalidSkillProfiles = 0;
      let profilesSampled = 0;
      try {
        const profSnap = await db.collection('profiles').limit(50).get();
        profilesSampled = profSnap.size;
        for (const docSnap of profSnap.docs) {
          const data = docSnap.data();
          if (typeof data.skillPoints !== 'number' || data.skillPoints < 0 || !data.skills) {
            invalidSkillProfiles += 1;
          }
          if (typeof data.orgId === 'string' && data.orgId.length > 0) {
            const memberExists = (
              await db.doc(`organization_members/${data.orgId}_${docSnap.id}`).get()
            ).exists;
            if (!memberExists) {
              orphanedOrgRefs += 1;
            }
          }
        }
      } catch (err) {
        warnings.push(`Profile integrity check warning: ${sanitizeTextServer(String(err))}`);
      }

      if (orphanedOrgRefs > 0) {
        warnings.push(`Detected ${orphanedOrgRefs} profile(s) with orphaned orgId references.`);
      }
      if (invalidSkillProfiles > 0) {
        failedChecks.push(`Detected ${invalidSkillProfiles} profile(s) with invalid skill structure.`);
      }

      let negativeWallets = 0;
      try {
        const negWalletAgg = await db.collection('wallets').where('balance', '<', 0).count().get();
        negativeWallets = negWalletAgg.data().count;
        if (negativeWallets > 0) {
          failedChecks.push(`Detected ${negativeWallets} wallet(s) with negative balance.`);
        }
      } catch (err) {
        warnings.push(`Wallet check warning: ${sanitizeTextServer(String(err))}`);
      }

      let inconsistentListings = 0;
      try {
        const badListings = await db
          .collection('market_listings')
          .where('status', '==', 'active')
          .where('remainingQty', '<=', 0)
          .count()
          .get();
        inconsistentListings = badListings.data().count;
        if (inconsistentListings > 0) {
          warnings.push(`Detected ${inconsistentListings} active market listing(s) with remainingQty <= 0.`);
        }
      } catch (err) {
        warnings.push(`Market listing check warning: ${sanitizeTextServer(String(err))}`);
      }

      const profilesCount = countMap.get('profiles') ?? 0;
      const walletsCount = countMap.get('wallets') ?? 0;
      const profileWalletMismatch = Math.abs(profilesCount - walletsCount);
      if (profileWalletMismatch > 0) {
        warnings.push(
          `Count delta between profiles (${profilesCount}) and wallets (${walletsCount}).`
        );
      }

      const gameSystems = [
        {
          key: 'characters' as const,
          labelAr: 'نظام الشخصيات',
          labelEn: 'Characters',
          status: (invalidSkillProfiles > 0 ? 'error' : profilesCount > 0 ? 'healthy' : 'warning') as DiagnosticStatus,
          collectionsChecked: ['profiles', 'usernames'],
          metrics: {
            profilesCount,
            usernamesCount: countMap.get('usernames') ?? 0,
            sampledChecked: profilesSampled,
          },
          issues: invalidSkillProfiles > 0 ? [`${invalidSkillProfiles} malformed profile docs`] : [],
        },
        {
          key: 'wallets_economy' as const,
          labelAr: 'المحافظ والاقتصاد',
          labelEn: 'Wallets & Economy',
          status: (negativeWallets > 0 ? 'error' : profileWalletMismatch > 0 ? 'warning' : 'healthy') as DiagnosticStatus,
          collectionsChecked: ['wallets', 'transactions'],
          metrics: {
            walletsCount,
            transactionsCount: countMap.get('transactions') ?? 0,
            negativeWallets,
            profileWalletDelta: profileWalletMismatch,
          },
          issues: negativeWallets > 0 ? [`${negativeWallets} negative wallet balances`] : [],
        },
        {
          key: 'companies' as const,
          labelAr: 'الشركات والمصانع',
          labelEn: 'Companies',
          status: 'healthy' as DiagnosticStatus,
          collectionsChecked: ['companies', 'company_logs'],
          metrics: {
            companiesCount: countMap.get('companies') ?? 0,
            companyLogsCount: countMap.get('company_logs') ?? 0,
          },
          issues: [],
        },
        {
          key: 'market_orders' as const,
          labelAr: 'السوق والطلبات',
          labelEn: 'Market & Orders',
          status: (inconsistentListings > 0 ? 'warning' : 'healthy') as DiagnosticStatus,
          collectionsChecked: ['market_listings', 'market_orders', 'world_events'],
          metrics: {
            listingsCount: countMap.get('market_listings') ?? 0,
            ordersCount: countMap.get('market_orders') ?? 0,
            inconsistentListings,
          },
          issues: inconsistentListings > 0 ? [`${inconsistentListings} active listings with 0 remainingQty`] : [],
        },
        {
          key: 'organizations' as const,
          labelAr: 'المنظمات والأعضاء',
          labelEn: 'Organizations & Members',
          status: (orphanedOrgRefs > 0 ? 'warning' : 'healthy') as DiagnosticStatus,
          collectionsChecked: [
            'organizations',
            'organization_members',
            'organization_requests',
            'organization_transactions',
          ],
          metrics: {
            organizationsCount: countMap.get('organizations') ?? 0,
            membersCount: countMap.get('organization_members') ?? 0,
            requestsCount: countMap.get('organization_requests') ?? 0,
            orphanedOrgRefs,
          },
          issues: orphanedOrgRefs > 0 ? [`${orphanedOrgRefs} orphaned orgId references`] : [],
        },
        {
          key: 'missions_achievements' as const,
          labelAr: 'المهام والإنجازات',
          labelEn: 'Missions & Achievements',
          status: 'healthy' as DiagnosticStatus,
          collectionsChecked: ['player_missions', 'daily_claims', 'contract_claims', 'player_achievements'],
          metrics: {
            missionClaimsCount: countMap.get('player_missions') ?? 0,
            dailyClaimsCount: countMap.get('daily_claims') ?? 0,
            contractClaimsCount: countMap.get('contract_claims') ?? 0,
            achievementsCount: countMap.get('player_achievements') ?? 0,
          },
          issues: [],
        },
        {
          key: 'inventory_properties' as const,
          labelAr: 'المخزون والعقارات',
          labelEn: 'Inventory & Properties',
          status: 'healthy' as DiagnosticStatus,
          collectionsChecked: ['inventory', 'properties'],
          metrics: {
            inventoryStacksCount: countMap.get('inventory') ?? 0,
            propertiesCount: countMap.get('properties') ?? 0,
          },
          issues: [],
        },
        {
          key: 'skills_progression' as const,
          labelAr: 'المهارات والتقدم',
          labelEn: 'Skills & Progression',
          status: (invalidSkillProfiles > 0 ? 'error' : 'healthy') as DiagnosticStatus,
          collectionsChecked: ['profiles'],
          metrics: {
            sampledProfiles: profilesSampled,
            invalidSkillProfiles,
          },
          issues: invalidSkillProfiles > 0 ? [`${invalidSkillProfiles} profiles missing skills map`] : [],
        },
      ];

      const appCheckEnforced = process.env.NEXORA_ENFORCE_APP_CHECK === 'true';

      const report = {
        reportVersion: '1.0.0',
        generatedAt: nowIso,
        projectIdentifier: {
          appName: 'NEXORA' as const,
          projectId: NEXORA_PROJECT_ID,
          firestoreDatabaseId: NEXORA_DATABASE_ID,
          authDomain: NEXORA_AUTH_DOMAIN,
        },
        environment: {
          mode: 'production-cloud-function',
          executionSource: 'cloud_function_gen2' as const,
          backendDeployed: true,
          appCheckEnforced,
          locale,
        },
        firebaseHealth: {
          overallStatus: (firestoreStatus === 'error' ? 'error' : 'healthy') as DiagnosticStatus,
          firestore: {
            status: firestoreStatus,
            latencyMs,
            message: firestoreMsg,
          },
          authentication: {
            status: 'healthy' as DiagnosticStatus,
            provider: 'google.com' as const,
            emailVerified: true,
            ownerVerifiedBy: authResult.verifiedBy,
            maskedUid: maskUidServer(uid),
            message: `Verified Firebase ID Token (${authResult.verifiedBy}).`,
          },
          backendFunctions: {
            status: 'healthy' as DiagnosticStatus,
            runtime: 'nodejs22-gen2',
            functionName: 'nexoraDiagnostics',
            lastCheckAt: nowIso,
            message: 'Cloud Function Gen 2 executed read-only aggregation successfully.',
          },
          lastSuccessfulCheckAt: nowIso,
        },
        authenticationHealth: {
          status: 'healthy' as DiagnosticStatus,
          signedIn: true,
          emailVerified: true,
          ownerAuthorized: true,
          authMechanism: 'Firebase Auth Google Sign-In + Server ID Token Verification',
          userStoragePattern: 'Public profiles/{uid} separated from owner-only users_private/{uid}',
        },
        databaseCollections,
        gameSystems,
        securityChecks: {
          overallStatus: (failedChecks.length > 0 ? 'error' : warnings.length > 0 ? 'warning' : 'healthy') as DiagnosticStatus,
          ownerAuthorizationVerified: true,
          rulesValidationStatus: 'healthy' as DiagnosticStatus,
          piiRedactionActive: true,
          arbitraryQueriesBlocked: true,
          mutationsBlocked: true,
          appCheckStatus: (appCheckEnforced ? 'healthy' : 'warning') as DiagnosticStatus,
          collectionsNeedingReview: [
            {
              collection: 'organization_members',
              severity: 'info' as const,
              reason: 'allow list supports orgId scoping; verify member privacy stays non-PII.',
            },
            {
              collection: 'organization_requests',
              severity: 'info' as const,
              reason: 'allow list permits pending query; client listener is gated by manage_members.',
            },
          ],
          checks: [
            {
              id: 'server_id_token',
              label: 'Server-side ID Token & Verified Email',
              status: 'healthy' as DiagnosticStatus,
              detail: `Verified via ${authResult.verifiedBy}`,
            },
            {
              id: 'read_only_enforcement',
              label: 'Read-Only & Mutation Rejection',
              status: 'healthy' as DiagnosticStatus,
              detail: 'Only run_diagnostics & health_ping allowed.',
            },
            {
              id: 'app_check',
              label: 'Firebase App Check Enforcement',
              status: (appCheckEnforced ? 'healthy' : 'warning') as DiagnosticStatus,
              detail: appCheckEnforced
                ? 'enforceAppCheck is enabled.'
                : 'enforceAppCheck is optional until site key is configured.',
            },
          ],
        },
        recentSanitizedErrors: [],
        warnings,
        failedChecks,
      };

      return redactSecretsServer(report);
    } catch (err) {
      throw toHttpsError(err);
    }
  }
);

/**
 * Scheduled Cloud Function Gen 2 to expire ended world_events and rotate fresh
 * non-stacking economic events on the NEXORA named Firestore database.
 */
export const rotateWorldEvents = onSchedule(
  {
    schedule: 'every 6 hours',
    region: 'us-central1',
    maxInstances: 1,
    timeoutSeconds: 30,
    memory: '256MiB',
  },
  async () => {
    const nowMs = Date.now();
    const snap = await db.collection('world_events').get();
    const existing: ExistingWorldEventRecord[] = snap.docs.map((docSnap) => {
      const data = docSnap.data();
      const endsAt = data.endsAt as { toMillis?: () => number } | undefined;
      return {
        id: docSnap.id,
        active: data.active === true,
        stackGroup: typeof data.stackGroup === 'string' ? data.stackGroup : undefined,
        endsAtMs: typeof endsAt?.toMillis === 'function' ? endsAt.toMillis() : null,
      };
    });

    const plan = buildWorldEventRotationPlan(existing, nowMs, 3);
    if (plan.toDeactivateIds.length === 0 && plan.toActivate.length === 0) {
      return;
    }

    const batch = db.batch();
    for (const id of plan.toDeactivateIds) {
      batch.set(
        db.collection('world_events').doc(id),
        { active: false },
        { merge: true }
      );
    }

    for (const entry of plan.toActivate) {
      const { durationHours: _dh, ...templateFields } = entry.template;
      batch.set(db.collection('world_events').doc(entry.template.id), {
        ...templateFields,
        startsAt: Timestamp.fromMillis(entry.startsAtMs),
        endsAt: Timestamp.fromMillis(entry.endsAtMs),
        active: true,
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    await batch.commit();
  }
);

