import { useEffect, useState } from 'react';
import {
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from 'firebase/auth';
import { collection, doc, getDoc, getDocs, limit, orderBy, query, where } from 'firebase/firestore';
import { auth, db, googleAuthProvider } from '../../lib/firebase';

const SUPABASE_URL = 'https://dmeupqmhsyojxlgalxrc.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_PCsjX_kcS-D8FY4PobPl4w_2BwpeilC';

const COLLECTIONS = [
  'profiles',
  'usernames',
  'users_private',
  'wallets',
  'transactions',
  'inventory',
  'market_listings',
  'companies',
  'organizations',
  'conversations',
  'market_orders',
  'company_auctions',
  'company_logs',
  'properties',
  'organization_members',
  'organization_requests',
  'organization_transactions',
  'player_missions',
  'daily_claims',
  'contract_claims',
  'player_achievements',
  'notifications',
  'world_events',
  'audit_logs',
  'user_blocks',
  'chat_rate_limits',
  'global_chat_messages',
  'organization_invites',
  'player_reports',
] as const;

type ExportDocument = { id: string; path: string; fields: Record<string, unknown> };
type ExportPage = {
  ok: boolean;
  collection: string;
  count: number;
  documents: ExportDocument[];
  nextPageToken: string | null;
  hasMore: boolean;
  error?: string;
};
type RunMode = 'scan' | 'import';

type ParityRow = Record<string, unknown>;

function canonicalParityValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalParityValue).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalParityValue(record[key])]));
  }
  return value;
}

function projectParityRows(rows: unknown, keys: string[]): unknown[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const record = (row && typeof row === 'object' ? row : {}) as ParityRow;
    return Object.fromEntries(keys.map((key) => [key, record[key] ?? null]));
  }).map(canonicalParityValue).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function projectParityRow(row: unknown, keys: string[]): unknown {
  if (!row || typeof row !== 'object') return null;
  const record = row as ParityRow;
  return canonicalParityValue(Object.fromEntries(keys.map((key) => [key, record[key] ?? null])));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function MigrationConsole() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState('');
  const [running, setRunning] = useState(false);
  const [runMode, setRunMode] = useState<RunMode | null>(null);
  const [scanComplete, setScanComplete] = useState(false);
  const [importComplete, setImportComplete] = useState(false);
  const [currentTask, setCurrentTask] = useState('');
  const [totalDocuments, setTotalDocuments] = useState(0);
  const [importedDocuments, setImportedDocuments] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [logs, setLogs] = useState<string[]>([]);
  const [failure, setFailure] = useState('');
  const [parityRunning, setParityRunning] = useState(false);
  const [parityResults, setParityResults] = useState<{ section: string; match: boolean; sourceCount?: number; targetCount?: number }[]>([]);
  const [parityError, setParityError] = useState('');

  useEffect(() => {
    let active = true;
    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      if (!active) return;
      setUser(nextUser);
      setAuthReady(true);
    });
    getRedirectResult(auth).catch((error) => {
      if (active) setAuthError(errorMessage(error));
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    setScanComplete(false);
    setImportComplete(false);
    setCounts({});
    setLogs([]);
    setFailure('');
  }, [user?.uid]);

  const addLog = (message: string) => {
    setLogs((previous) => [...previous.slice(-79), message]);
  };

  async function signIn() {
    setAuthError('');
    try {
      await signInWithPopup(auth, googleAuthProvider);
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
      if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
        await signInWithRedirect(auth, googleAuthProvider);
        return;
      }
      setAuthError(errorMessage(error));
    }
  }

  async function verifyOwnerSession(activeUser: User): Promise<void> {
    await activeUser.reload();
    if (activeUser.isAnonymous || !activeUser.emailVerified) {
      throw new Error('يجب تسجيل الدخول بحساب موثّق البريد، ولا يمكن استخدام حساب ضيف.');
    }
  }

  async function exportPage(
    activeUser: User,
    collection: string,
    parentId: string,
    pageToken: string,
  ): Promise<ExportPage> {
    const token = await activeUser.getIdToken();
    const response = await fetch('/api/migration-export', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify({
        collection,
        parentId: parentId || undefined,
        pageSize: 100,
        pageToken: pageToken || undefined,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true) {
      throw new Error('تصدير ' + collection + ' فشل: ' + (result.error || ('HTTP ' + response.status)));
    }
    return result as ExportPage;
  }

  async function importPage(
    activeUser: User,
    collection: string,
    parentId: string,
    documents: ExportDocument[],
  ): Promise<number> {
    if (!documents.length) return 0;
    const token = await activeUser.getIdToken();
    const response = await fetch(SUPABASE_URL + '/functions/v1/nexora-migration-import', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        apikey: SUPABASE_PUBLISHABLE_KEY,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify({
        collection,
        parentId: parentId || undefined,
        documents,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true) {
      throw new Error('استيراد ' + collection + ' فشل: ' + (result.error || ('HTTP ' + response.status)));
    }
    return Number(result.imported ?? documents.length);
  }

  async function runMigration(mode: RunMode) {
    if (!user || running) return;
    setRunning(true);
    setRunMode(mode);
    setFailure('');
    setCurrentTask('');
    setTotalDocuments(0);
    setImportedDocuments(0);
    setCounts({});
    setLogs([]);
    if (mode === 'scan') {
      setScanComplete(false);
      setImportComplete(false);
    } else {
      setImportComplete(false);
    }

    try {
      await verifyOwnerSession(user);
      const conversationIds: string[] = [];
      let total = 0;
      let imported = 0;

      for (const collection of COLLECTIONS) {
        setCurrentTask(collection);
        let pageToken = '';
        let collectionCount = 0;

        do {
          const page = await exportPage(user, collection, '', pageToken);
          const documents = Array.isArray(page.documents) ? page.documents : [];
          collectionCount += documents.length;
          total += documents.length;
          setTotalDocuments(total);

          if (collection === 'conversations') {
            for (const document of documents) {
              if (document.id && !conversationIds.includes(document.id)) conversationIds.push(document.id);
            }
          }

          if (mode === 'import' && documents.length) {
            imported += await importPage(user, collection, '', documents);
            setImportedDocuments(imported);
          }

          pageToken = page.nextPageToken || '';
        } while (pageToken);

        setCounts((previous) => ({ ...previous, [collection]: collectionCount }));
        addLog(collection + ': ' + collectionCount + ' سجل');
      }

      setCurrentTask('conversation_messages');
      let messageCount = 0;
      for (let index = 0; index < conversationIds.length; index += 1) {
        const parentId = conversationIds[index];
        let pageToken = '';
        let parentCount = 0;
        do {
          const page = await exportPage(user, 'conversation_messages', parentId, pageToken);
          const documents = Array.isArray(page.documents) ? page.documents : [];
          parentCount += documents.length;
          messageCount += documents.length;
          total += documents.length;
          setTotalDocuments(total);

          if (mode === 'import' && documents.length) {
            imported += await importPage(user, 'conversation_messages', parentId, documents);
            setImportedDocuments(imported);
          }
          pageToken = page.nextPageToken || '';
        } while (pageToken);
        if (parentCount > 0) addLog('رسائل محادثة ' + (index + 1) + ': ' + parentCount);
      }

      setCounts((previous) => ({ ...previous, conversation_messages: messageCount }));
      addLog('conversation_messages: ' + messageCount + ' سجل');
      setImportedDocuments(imported);

      if (mode === 'scan') {
        setScanComplete(true);
        addLog('اكتمل الفحص دون كتابة أي بيانات في Supabase.');
      } else {
        setImportComplete(true);
        addLog('اكتمل استيراد الدفعات إلى nexora. Firebase ما زال المصدر النشط.');
      }
    } catch (error) {
      const message = errorMessage(error);
      setFailure(message);
      addLog('توقف التنفيذ: ' + message);
    } finally {
      setRunning(false);
      setCurrentTask('');
    }
  }

  async function runPlayerParityCheck() {
    if (!user || parityRunning) return;
    setParityRunning(true);
    setParityError('');
    setParityResults([]);
    try {
      await verifyOwnerSession(user);
      const token = await user.getIdToken();
      const response = await fetch(SUPABASE_URL + '/functions/v1/nexora-player-data', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: '{}',
        cache: 'no-store',
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok !== true || !payload?.player) {
        throw new Error(payload?.error || 'SUPABASE_PLAYER_READ_FAILED');
      }
      const target = payload.player as Record<string, unknown>;
      const uid = user.uid;
      const dateKey = new Date().toISOString().slice(0, 10);
      const [
        profileSnap, privateSnap, walletSnap, inventorySnap, sentSnap, receivedSnap,
        listingsSnap, ordersSnap, companiesSnap, auctionsSnap, logsSnap, propertiesSnap,
        organizationsSnap, membershipSnap, pendingSelfSnap, missionsSnap, dailySnap,
        contractsSnap, achievementsSnap, notificationsSnap, worldEventsSnap,
      ] = await Promise.all([
        getDoc(doc(db, 'profiles', uid)),
        getDoc(doc(db, 'users_private', uid)),
        getDoc(doc(db, 'wallets', uid)),
        getDocs(query(collection(db, 'inventory'), where('uid', '==', uid), limit(200))),
        getDocs(query(collection(db, 'transactions'), where('fromUid', '==', uid), limit(30))),
        getDocs(query(collection(db, 'transactions'), where('toUid', '==', uid), limit(30))),
        getDocs(query(collection(db, 'market_listings'), where('status', '==', 'active'), limit(100))),
        getDocs(query(collection(db, 'market_orders'), where('buyerUid', '==', uid), limit(25))),
        getDocs(query(collection(db, 'companies'), where('ownerUid', '==', uid), limit(50))),
        getDocs(query(collection(db, 'company_auctions'), where('status', '==', 'active'), limit(100))),
        getDocs(query(collection(db, 'company_logs'), where('ownerUid', '==', uid), limit(25))),
        getDocs(query(collection(db, 'properties'), where('ownerUid', '==', uid), limit(100))),
        getDocs(query(collection(db, 'organizations'), where('reputation', '>=', 0), orderBy('reputation', 'desc'), limit(40))),
        getDocs(query(collection(db, 'organization_members'), where('uid', '==', uid), limit(1))),
        getDocs(query(collection(db, 'organization_requests'), where('uid', '==', uid))),
        getDocs(query(collection(db, 'player_missions'), where('uid', '==', uid))),
        getDoc(doc(db, 'daily_claims', uid + '_' + dateKey)),
        getDocs(query(collection(db, 'contract_claims'), where('uid', '==', uid))),
        getDocs(query(collection(db, 'player_achievements'), where('uid', '==', uid))),
        getDocs(query(collection(db, 'notifications'), where('uid', '==', uid), limit(30))),
        getDocs(query(collection(db, 'world_events'), where('active', '==', true))),
      ]);
      const membership = membershipSnap.docs[0]?.data() ?? null;
      const orgId = typeof membership?.orgId === 'string' ? membership.orgId : '';
      const [orgMembersSnap, orgRequestsSnap, orgTransactionsSnap] = orgId
        ? await Promise.all([
            getDocs(query(collection(db, 'organization_members'), where('orgId', '==', orgId), limit(200))),
            getDocs(query(collection(db, 'organization_requests'), where('orgId', '==', orgId), where('status', '==', 'pending'), limit(100))),
            getDocs(query(collection(db, 'organization_transactions'), where('orgId', '==', orgId), limit(40))),
          ])
        : [null, null, null];
      const txMap = new Map<string, ParityRow>();
      [...sentSnap.docs, ...receivedSnap.docs].forEach((item) => txMap.set(item.id, item.data() as ParityRow));
      const source = {
        profile: profileSnap.exists() ? profileSnap.data() : null,
        privateData: privateSnap.exists() ? privateSnap.data() : null,
        wallet: walletSnap.exists() ? walletSnap.data() : null,
        inventory: inventorySnap.docs.map((item) => item.data()),
        transactions: [...txMap.values()],
        marketListings: listingsSnap.docs.map((item) => item.data()),
        marketOrders: ordersSnap.docs.map((item) => item.data()),
        companies: companiesSnap.docs.map((item) => item.data()),
        companyAuctions: auctionsSnap.docs.map((item) => item.data()),
        companyLogs: logsSnap.docs.map((item) => item.data()),
        properties: propertiesSnap.docs.map((item) => item.data()),
        organizations: organizationsSnap.docs.map((item) => item.data()),
        myOrgMember: membership,
        orgMembers: orgMembersSnap?.docs.map((item) => item.data()) ?? [],
        orgRequests: orgRequestsSnap?.docs.map((item) => item.data()) ?? [],
        myPendingOrgIds: pendingSelfSnap.docs.map((item) => (item.data() as ParityRow).orgId),
        orgTransactions: orgTransactionsSnap?.docs.map((item) => item.data()) ?? [],
        claimedMissions: missionsSnap.docs.map((item) => item.data()),
        claimedDailyToday: dailySnap.exists(),
        claimedContractsToday: contractsSnap.docs.map((item) => (item.data() as ParityRow).contractId),
        unlockedAchievements: achievementsSnap.docs.map((item) => (item.data() as ParityRow).achievementId),
        notifications: notificationsSnap.docs.map((item) => item.data()),
        worldEvents: worldEventsSnap.docs.map((item) => item.data()),
      };
      const checks: { section: string; source: unknown; target: unknown; keys?: string[] }[] = [
        { section: 'الملف الشخصي', source: source.profile, target: target.profile, keys: ['uid','username','usernameLower','avatarId','title','level','xp','reputation','influence','skillPoints','skills','stats','orgId'] },
        { section: 'البيانات الخاصة', source: source.privateData, target: target.privateData, keys: ['uid','email','language','notificationsEnabled'] },
        { section: 'المحفظة والأرصدة', source: source.wallet, target: target.wallet, keys: ['uid','balance','totalEarned','totalSpent','lastTxId'] },
        { section: 'المخزون والملكية', source: source.inventory, target: target.inventory, keys: ['uid','itemId','quantity','lastListingId'] },
        { section: 'سجل العمليات', source: source.transactions, target: target.transactions, keys: ['id','fromUid','toUid','amount','fee','netAmount','type','referenceId','description','status'] },
        { section: 'عروض السوق', source: source.marketListings, target: target.marketListings, keys: ['id','sellerUid','itemId','quantity','remainingQty','unitPrice','status'] },
        { section: 'طلبات السوق', source: source.marketOrders, target: target.marketOrders, keys: ['id','listingId','buyerUid','sellerUid','itemId','quantity','unitPrice','totalPrice','taxAmount','txId'] },
        { section: 'الشركات', source: source.companies, target: target.companies, keys: ['id','ownerUid','name','sector','level','capital','employeesCount','baseRevenuePerHour','expensePerHour','totalRevenue','vaultLevel','vaultBalance','auctionId','auctionEndsAt','auctionStatus'] },
        { section: 'مزادات الشركات', source: source.companyAuctions, target: target.companyAuctions, keys: ['id','companyId','sellerUid','startingPrice','currentBid','highestBidderUid','endsAt','status'] },
        { section: 'سجلات الشركات', source: source.companyLogs, target: target.companyLogs, keys: ['id','companyId','ownerUid','action','amount'] },
        { section: 'العقارات', source: source.properties, target: target.properties, keys: ['id','ownerUid','name','type','level','purchasePrice','rentPerHour','maintenancePerHour','isRented'] },
        { section: 'المنظمات', source: source.organizations, target: target.organizations, keys: ['id','name','tag','leaderUid','memberCount','reputation','level','memberCapacity','joinMode'] },
        { section: 'عضوية المنظمة', source: source.myOrgMember, target: target.myOrgMember, keys: ['orgId','uid','username','role','permissions'] },
        { section: 'أعضاء المنظمة', source: source.orgMembers, target: target.orgMembers, keys: ['orgId','uid','username','role','permissions'] },
        { section: 'طلبات الانضمام', source: source.orgRequests, target: target.orgRequests, keys: ['id','orgId','uid','username','status'] },
        { section: 'طلبات الانضمام المعلقة للاعب', source: source.myPendingOrgIds, target: target.myPendingOrgIds },
        { section: 'معاملات خزينة المنظمة', source: source.orgTransactions, target: target.orgTransactions, keys: ['id','orgId','uid','type','amount','note'] },
        { section: 'المهام المستلمة', source: source.claimedMissions, target: target.claimedMissions, keys: ['uid','missionId','category','rewardCredits','rewardXp'] },
        { section: 'المكافأة اليومية', source: source.claimedDailyToday, target: target.claimedDailyToday },
        { section: 'العقود المستلمة', source: source.claimedContractsToday, target: target.claimedContractsToday },
        { section: 'الإنجازات', source: source.unlockedAchievements, target: target.unlockedAchievements },
        { section: 'الإشعارات', source: source.notifications, target: target.notifications, keys: ['id','uid','title','body','type','read'] },
        { section: 'الأحداث العالمية', source: source.worldEvents, target: target.worldEvents, keys: ['id','effectType','targetItemId','priceMultiplier','taxDelta','active','revenueMultiplier','stackGroup'] },
      ];
      const results = checks.map((check) => {
        const sourceValue = check.keys
          ? Array.isArray(check.source)
            ? projectParityRows(check.source, check.keys)
            : projectParityRow(check.source, check.keys)
          : canonicalParityValue(check.source);
        const targetValue = check.keys
          ? Array.isArray(check.target)
            ? projectParityRows(check.target, check.keys)
            : projectParityRow(check.target, check.keys)
          : canonicalParityValue(check.target);
        return {
          section: check.section,
          match: JSON.stringify(sourceValue) === JSON.stringify(targetValue),
          sourceCount: Array.isArray(check.source) ? check.source.length : undefined,
          targetCount: Array.isArray(check.target) ? check.target.length : undefined,
        };
      });
      setParityResults(results);
      const mismatches = results.filter((item) => !item.match);
      if (mismatches.length) setParityError('هناك ' + mismatches.length + ' أقسام لا تتطابق. لا تفعّل تحويل القراءات بعد.');
    } catch (error) {
      setParityError(errorMessage(error));
    } finally {
      setParityRunning(false);
    }
  }

  if (!authReady) {
    return <main className="min-h-screen bg-[#0B0D12] text-white flex items-center justify-center p-6">جارٍ التحقق من جلسة Firebase…</main>;
  }

  return (
    <main dir="rtl" className="min-h-screen bg-[#0B0D12] text-slate-100 p-4 sm:p-8">
      <div className="mx-auto max-w-3xl space-y-5">
        <header className="rounded-2xl border border-slate-700 bg-[#141821] p-5">
          <p className="text-xs font-semibold tracking-[0.2em] text-cyan-300">NEXORA / MIGRATION CONTROL</p>
          <h1 className="mt-2 text-2xl font-bold">مركز نقل بيانات NEXORA</h1>
          <p className="mt-2 text-sm leading-7 text-slate-300">
            أداة إدارية محمية لنقل نسخة من بيانات Firestore إلى schema nexora فقط.
            لن تحذف بيانات Firebase ولن تبدّل اللعبة إلى Supabase.
          </p>
        </header>

        {!user ? (
          <section className="rounded-2xl border border-slate-700 bg-[#141821] p-5 space-y-4">
            <h2 className="text-lg font-semibold">تسجيل دخول المالك</h2>
            <p className="text-sm text-slate-300">سجّل الدخول بحساب Firebase نفسه الذي أرسلنا UID الخاص به. التحقق النهائي من صلاحية المالك يتم على الخادم.</p>
            <button onClick={signIn} className="w-full rounded-xl bg-cyan-400 px-4 py-3 font-bold text-slate-950">تسجيل الدخول عبر Google</button>
            {authError && <p className="text-sm text-rose-300">{authError}</p>}
          </section>
        ) : (
          <>
            <section className="rounded-2xl border border-slate-700 bg-[#141821] p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="font-semibold">جلسة Firebase الحالية</h2>
                  <p className="mt-1 text-sm text-slate-300">{user.email || 'بدون بريد إلكتروني'}</p>
                  <p className="mt-1 break-all text-xs text-slate-500">UID: {user.uid}</p>
                </div>
                <button onClick={() => signOut(auth)} disabled={running} className="rounded-lg border border-slate-600 px-3 py-2 text-sm">تسجيل الخروج</button>
              </div>
              {!user.emailVerified && <p className="rounded-lg bg-amber-500/10 p-3 text-sm text-amber-200">يجب توثيق البريد الإلكتروني لهذا الحساب أولاً.</p>}
            </section>

            <section className="rounded-2xl border border-emerald-500/30 bg-[#141821] p-5 space-y-3">
              <h2 className="text-lg font-semibold">مطابقة اللاعب الحقيقي</h2>
              <p className="text-sm leading-6 text-slate-300">اختبار قراءة فقط يقارن جلسة Firebase الحالية مع بيانات Supabase لنفس UID، بما فيها الرصيد والمخزون والمعاملات وملكية الشركات والعقارات والمزادات والمنظمات. لا ينفّذ أي تعديل.</p>
              <button onClick={runPlayerParityCheck} disabled={parityRunning || !user.emailVerified || user.isAnonymous} className="w-full rounded-xl border border-emerald-400/60 px-4 py-3 font-semibold text-emerald-200 disabled:opacity-40">
                {parityRunning ? 'جارٍ فحص مطابقة اللاعب…' : 'تشغيل فحص المطابقة الآن'}
              </button>
              {parityError && <p className="text-sm text-amber-200">{parityError}</p>}
              {parityResults.length > 0 && <div className="divide-y divide-slate-700 rounded-xl border border-slate-700">
                {parityResults.map((item) => <div key={item.section} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span>{item.section}</span>
                  <span className={item.match ? 'text-emerald-300' : 'text-rose-300'}>{item.match ? 'متطابق' : 'اختلاف'}</span>
                </div>)}
              </div>}
            </section>

            <section className="rounded-2xl border border-cyan-500/40 bg-[#141821] p-5 space-y-3">
              <h2 className="text-lg font-semibold text-cyan-200">المصدّر الجديد عبر GitHub Actions</h2>
              <p className="text-sm leading-7 text-slate-300">
                أُضيف مسار تصدير جديد يستخدم GitHub OIDC بدل اعتماد تشغيل التصدير على Vercel.
                يحتاج إعداد Workload Identity Federation في Google Cloud ومتغير المستودع الموضحين في دليل الإعداد.
                شغّل وضع scan أولاً، ولا تشغّل المسارين بالتوازي.
              </p>
              <div className="flex flex-wrap gap-3 text-sm">
                <a className="underline text-cyan-200" href="https://github.com/luffyk124-del/nexora-game/blob/feature/nexora-social-economy-mobile-overhaul/docs/GITHUB_OIDC_SETUP.md" target="_blank" rel="noreferrer">دليل إعداد GitHub OIDC</a>
                <a className="underline text-cyan-200" href="https://github.com/luffyk124-del/nexora-game/blob/feature/nexora-social-economy-mobile-overhaul/.github/workflows/nexora-firestore-export.yml" target="_blank" rel="noreferrer">ملف مهمة التصدير الجديدة</a>
              </div>
              <p className="text-xs leading-6 text-slate-400">
                ستظهر إمكانية تشغيل المهمة من تبويب Actions بعد وصول ملف workflow إلى الفرع الافتراضي. يبقى المصدّر الحالي احتياطياً فقط حتى نجاح أول فحص واستيراد عبر GitHub.
              </p>
            </section>

            <section className="rounded-2xl border border-amber-500/30 bg-[#141821] p-5 space-y-4">
              <div>
                <h2 className="text-lg font-semibold">المصدّر الاحتياطي القديم (Vercel)</h2>
                <p className="mt-1 text-sm leading-6 text-slate-300">هذا المسار مؤقت للرجوع فقط. استخدمه فقط عند تعذر مسار GitHub الجديد، ولا تشغّل التصديرين معاً. الفحص يقرأ المصدر فقط، والاستيراد يستخدم checksum وupsert.</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  onClick={() => runMigration('scan')}
                  disabled={running || !user.emailVerified || user.isAnonymous}
                  className="rounded-xl border border-cyan-400/60 px-4 py-3 font-semibold text-cyan-200 disabled:opacity-40"
                >
                  {running && runMode === 'scan' ? 'جارٍ فحص Firestore…' : '1) فحص المصدر فقط'}
                </button>
                <button
                  onClick={() => runMigration('import')}
                  disabled={running || !scanComplete || !user.emailVerified || user.isAnonymous}
                  className="rounded-xl bg-cyan-400 px-4 py-3 font-bold text-slate-950 disabled:opacity-40"
                >
                  {running && runMode === 'import' ? 'جارٍ الاستيراد…' : '2) استيراد البيانات إلى NEXORA'}
                </button>
              </div>
              {scanComplete && <p className="text-sm text-emerald-300">نجح فحص المصدر. يمكنك بدء الاستيراد.</p>}
              {importComplete && <p className="text-sm text-emerald-300">اكتمل استيراد الدفعات. يلزم بعده فحص المطابقة والوظائف قبل أي تحويل للتشغيل.</p>}
              {failure && <p className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">{failure}</p>}
            </section>

            {(running || logs.length > 0) && (
              <section className="rounded-2xl border border-slate-700 bg-[#141821] p-5 space-y-3">
                <div className="flex flex-wrap justify-between gap-2 text-sm">
                  <span className="text-slate-300">المهمة الحالية: {currentTask || '—'}</span>
                  <span className="tabular-nums">السجلات المفحوصة: {totalDocuments.toLocaleString('en-US')}</span>
                </div>
                {runMode === 'import' && <p className="text-sm text-cyan-200">السجلات المستوردة/المؤكدة: {importedDocuments.toLocaleString('en-US')}</p>}
                <div className="max-h-72 space-y-2 overflow-auto rounded-xl bg-[#0B0D12] p-3 text-xs">
                  {logs.map((line, index) => <p key={index} className="text-slate-300">{line}</p>)}
                </div>
              </section>
            )}

            {Object.keys(counts).length > 0 && (
              <section className="rounded-2xl border border-slate-700 bg-[#141821] p-5">
                <h2 className="mb-3 font-semibold">ملخص المجموعات</h2>
                <div className="divide-y divide-slate-700">
                  {Object.entries(counts).map(([name, count]) => (
                    <div key={name} className="flex justify-between gap-4 py-2 text-sm">
                      <span className="text-slate-300">{name}</span>
                      <span className="font-mono tabular-nums">{count.toLocaleString('en-US')}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
        <footer className="text-center text-xs leading-6 text-slate-500">
          لا تُغلق الصفحة أثناء التنفيذ. إذا انقطع الاتصال، أعد تشغيل الاستيراد؛ الدفعات السابقة قابلة للتكرار.
        </footer>
      </div>
    </main>
  );
}
