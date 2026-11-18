import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  COMPANY_SECTORS,
  ITEM_MAP,
  MANUFACTURING_RECIPES,
  MISSIONS,
  PROPERTY_SPECS,
  ROLE_DEFAULT_PERMISSIONS,
  SEED_MARKET_LISTINGS,
  SEED_WORLD_EVENTS,
  SKILL_DEFINITIONS,
  STARTING_CREDITS,
  TRADE_CONTRACTS,
} from '../data/catalog';
import {
  calculateAccruedPayout,
  calculateContractPayout,
  calculateDailyStipend,
  calculateLevelProgress,
  calculateManufacturingCost,
  calculatePropertyHourlyNet,
  canManageOrgMember,
  getAchievementProgress,
  getMissionProgress,
  hasOrgPermission,
  isValidUsername,
  LISTING_MAX_PRICE,
  LISTING_MAX_QTY,
  PROPERTY_MAX_LEVEL,
  timestampToMs as parseTimestampMs,
  validateTransfer,
} from '../lib/economy';
import { auth, db, functions, handleFirestoreError, OperationType } from '../lib/firebase';
import { httpsCallable } from 'firebase/functions';
import type {
  Company,
  CompanySector,
  InventoryItem,
  Language,
  MarketListing,
  Organization,
  OrganizationMember,
  OrgRole,
  PlayerProfile,
  PropertyAsset,
  PropertyType,
  SkillKey,
  SkillsMap,
  Wallet,
} from '../types/game';

function genId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now()}_${rand}`;
}

export function getUtcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function timestampToMs(ts: unknown): number {
  return parseTimestampMs(ts, Date.now());
}

function applyXpAndLevel(
  profile: PlayerProfile,
  xpGain: number,
  reputationGain = 0,
  influenceGain = 0
) {
  const nextXp = profile.xp + Math.max(0, Math.round(xpGain));
  const prog = calculateLevelProgress(nextXp);
  const levelsGained = Math.max(0, prog.level - profile.level);
  const leadershipBonus = 1 + (profile.skills.leadership || 0) * 0.1;
  return {
    xp: nextXp,
    level: prog.level,
    skillPoints: profile.skillPoints + levelsGained * 2,
    reputation: profile.reputation + Math.round(reputationGain * leadershipBonus),
    influence: profile.influence + Math.round(influenceGain * leadershipBonus),
  };
}

export async function ensureBootstrapWorldData(): Promise<void> {
  try {
    const nowMs = Date.now();
    for (const evt of SEED_WORLD_EVENTS) {
      const ref = doc(db, 'world_events', evt.id);
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        const { durationHours, ...eventPayload } = evt;
        await setDoc(ref, {
          ...eventPayload,
          startsAt: Timestamp.fromMillis(nowMs),
          endsAt: Timestamp.fromMillis(nowMs + durationHours * 3_600_000),
          createdAt: serverTimestamp(),
        });
      }
    }

    for (const seed of SEED_MARKET_LISTINGS) {
      const ref = doc(db, 'market_listings', seed.id);
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        await setDoc(ref, {
          id: seed.id,
          sellerUid: 'SYSTEM',
          sellerName: 'NEXORA Reserve',
          itemId: seed.itemId,
          quantity: seed.quantity,
          remainingQty: seed.quantity,
          unitPrice: seed.unitPrice,
          status: 'active',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    }
  } catch (error) {
    console.warn('Bootstrap world data check skipped or partially seeded:', error);
  }
}

export async function isUsernameAvailable(username: string): Promise<boolean> {
  const clean = username.trim().toLowerCase();
  if (!isValidUsername(username)) return false;
  if (import.meta.env.VITE_NEXORA_SUPABASE_ACCOUNT === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.isAnonymous) throw new Error('UNAUTHENTICATED');
    const idToken = await currentUser.getIdToken();
    const response = await fetch('https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy', {
      method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'check_username', username: clean }),
      cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok || typeof payload?.available !== 'boolean') throw new Error(payload?.error || 'USERNAME_CHECK_FAILED');
    return payload.available;
  }
  const snap = await getDoc(doc(db, 'usernames', clean));
  return !snap.exists();
}

export async function createPlayerCharacter(
  uid: string,
  email: string,
  username: string,
  avatarId: string,
  language: Language
): Promise<void> {
  const trimmed = username.trim();
  if (!isValidUsername(trimmed)) {
    throw new Error('INVALID_USERNAME');
  }
  const usernameLower = trimmed.toLowerCase();
  const initTxId = `init_${uid}`;
  const notifId = genId('ntf');

  const initialSkills: SkillsMap = {
    trade: 0,
    management: 0,
    industry: 0,
    negotiation: 0,
    finance: 0,
    leadership: 0,
  };

  if (import.meta.env.VITE_NEXORA_SUPABASE_ACCOUNT === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid !== uid || currentUser.isAnonymous || !currentUser.emailVerified) {
      throw new Error('UNAUTHENTICATED');
    }
    const idToken = await currentUser.getIdToken();
    const response = await fetch('https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy', {
      method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create_player_character', username: trimmed, avatarId, language }),
      cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'PLAYER_CREATION_FAILED');
    return;
  }

  try {
    await runTransaction(db, async (tx) => {
      const unameRef = doc(db, 'usernames', usernameLower);
      const profileRef = doc(db, 'profiles', uid);
      const privateRef = doc(db, 'users_private', uid);
      const walletRef = doc(db, 'wallets', uid);

      const [unameSnap, profileSnap] = await Promise.all([
        tx.get(unameRef),
        tx.get(profileRef),
      ]);

      if (profileSnap.exists()) {
        throw new Error('PROFILE_EXISTS');
      }
      if (unameSnap.exists()) {
        throw new Error('USERNAME_TAKEN');
      }

      tx.set(unameRef, {
        uid,
        username: trimmed,
        createdAt: serverTimestamp(),
      });

      tx.set(profileRef, {
        uid,
        username: trimmed,
        usernameLower,
        avatarId,
        title: language === 'ar' ? 'مؤسس طموح' : 'Executive Founder',
        level: 1,
        xp: 0,
        reputation: 10,
        influence: 5,
        skillPoints: 3,
        skills: initialSkills,
        stats: {
          missionsCompleted: 0,
          tradesCount: 0,
          companiesOwned: 0,
          propertiesOwned: 0,
          totalProduced: 0,
        },
        orgId: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      tx.set(privateRef, {
        uid,
        email,
        language,
        notificationsEnabled: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      tx.set(walletRef, {
        uid,
        balance: STARTING_CREDITS,
        totalEarned: STARTING_CREDITS,
        totalSpent: 0,
        lastTxId: initTxId,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      tx.set(doc(db, 'notifications', notifId), {
        id: notifId,
        uid,
        title: language === 'ar' ? 'مرحباً بك في NEXORA' : 'Welcome to NEXORA',
        body:
          language === 'ar'
            ? `تم إيداع $${STARTING_CREDITS.toLocaleString()} في محفظتك وتخصيص 3 نقاط مهارة.`
            : `$${STARTING_CREDITS.toLocaleString()} and 3 skill points credited to your account.`,
        type: 'system',
        read: false,
        createdAt: serverTimestamp(),
      });
    });
  } catch (error) {
    if (error instanceof Error && ['INVALID_USERNAME', 'USERNAME_TAKEN', 'PROFILE_EXISTS'].includes(error.message)) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, `profiles/${uid}`);
  }
}

export async function claimDailyStipend(uid: string): Promise<number> {
  const dateKey = getUtcDateKey();
  const claimId = `${uid}_${dateKey}`;
  const txId = genId('tx');
  const notifId = genId('ntf');

  // Opt-in migration route. Firebase remains the default until complete economy parity QA.
  if (import.meta.env.VITE_NEXORA_SUPABASE_DAILY_STIPEND === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid !== uid || currentUser.isAnonymous) {
      throw new Error('UNAUTHENTICATED');
    }
    const idToken = await currentUser.getIdToken();
    const response = await fetch(
      'https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${idToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'claim_daily_stipend' }),
        cache: 'no-store',
      }
    );
    const payload = await response.json();
    if (!response.ok || !payload?.ok || !Number.isFinite(payload.amount)) {
      throw new Error(payload?.error || 'DAILY_STIPEND_FAILED');
    }
    return Number(payload.amount);
  }

  try {
    let credited = 0;
    await runTransaction(db, async (tx) => {
      const claimRef = doc(db, 'daily_claims', claimId);
      const walletRef = doc(db, 'wallets', uid);
      const profileRef = doc(db, 'profiles', uid);

      const [claimSnap, walletSnap, profileSnap] = await Promise.all([
        tx.get(claimRef),
        tx.get(walletRef),
        tx.get(profileRef),
      ]);

      if (claimSnap.exists()) throw new Error('ALREADY_CLAIMED_TODAY');
      if (!walletSnap.exists() || !profileSnap.exists()) throw new Error('ACCOUNT_NOT_FOUND');

      const wallet = walletSnap.data() as Wallet;
      const profile = profileSnap.data() as PlayerProfile;
      const amount = calculateDailyStipend(profile.level, profile.skills.finance || 0);
      credited = amount;

      const xpUpdate = applyXpAndLevel(profile, 40, 2, 1);

      tx.set(claimRef, {
        uid,
        dateKey,
        amount,
        claimedAt: serverTimestamp(),
      });

      tx.set(doc(db, 'transactions', txId), {
        id: txId,
        fromUid: 'SYSTEM',
        toUid: uid,
        amount,
        fee: 0,
        netAmount: amount,
        type: 'daily_stipend',
        referenceId: claimId,
        description: `Daily operational stipend (${dateKey})`,
        status: 'completed',
        createdAt: serverTimestamp(),
      });

      tx.update(walletRef, {
        balance: wallet.balance + amount,
        totalEarned: wallet.totalEarned + amount,
        lastTxId: txId,
        updatedAt: serverTimestamp(),
      });

      tx.update(profileRef, {
        ...xpUpdate,
        updatedAt: serverTimestamp(),
      });

      tx.set(doc(db, 'notifications', notifId), {
        id: notifId,
        uid,
        title: 'Daily Stipend Credited',
        body: `+$${amount} & +40 XP`,
        type: 'economy',
        read: false,
        createdAt: serverTimestamp(),
      });
    });
    return credited;
  } catch (error) {
    if (error instanceof Error && error.message === 'ALREADY_CLAIMED_TODAY') throw error;
    handleFirestoreError(error, OperationType.WRITE, `daily_claims/${claimId}`);
  }
}

export async function upgradeSkill(uid: string, skillKey: SkillKey): Promise<void> {
  const def = SKILL_DEFINITIONS.find((s) => s.key === skillKey);
  if (!def) throw new Error('INVALID_SKILL');

  if (import.meta.env.VITE_NEXORA_SUPABASE_SKILLS === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid !== uid || currentUser.isAnonymous) {
      throw new Error('UNAUTHENTICATED');
    }
    const idToken = await currentUser.getIdToken();
    const response = await fetch(
      'https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${idToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'upgrade_skill', skillKey }),
        cache: 'no-store',
      }
    );
    const payload = await response.json();
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || 'SKILL_UPGRADE_FAILED');
    }
    return;
  }

  try {
    await runTransaction(db, async (tx) => {
      const profileRef = doc(db, 'profiles', uid);
      const snap = await tx.get(profileRef);
      if (!snap.exists()) throw new Error('ACCOUNT_NOT_FOUND');
      const profile = snap.data() as PlayerProfile;

      if (profile.skillPoints < 1) throw new Error('NO_SKILL_POINTS');
      const currentVal = profile.skills[skillKey] || 0;
      if (currentVal >= def.maxLevel) throw new Error('SKILL_MAXED');

      tx.update(profileRef, {
        skillPoints: profile.skillPoints - 1,
        skills: {
          ...profile.skills,
          [skillKey]: currentVal + 1,
        },
        updatedAt: serverTimestamp(),
      });
    });
  } catch (error) {
    if (error instanceof Error && ['NO_SKILL_POINTS', 'SKILL_MAXED', 'INVALID_SKILL'].includes(error.message)) {
      throw error;
    }
    handleFirestoreError(error, OperationType.UPDATE, `profiles/${uid}`);
  }
}

export async function transferCredits(
  fromUid: string,
  recipientUsername: string,
  amountRaw: number,
  note: string
): Promise<void> {
  const amount = Math.floor(amountRaw);
  const cleanName = recipientUsername.trim().toLowerCase();
  if (!cleanName) throw new Error('RECIPIENT_NOT_FOUND');

  // Explicit opt-in only. Firebase remains the default until transfer parity QA is complete.
  if (import.meta.env.VITE_NEXORA_SUPABASE_TRANSFERS === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid !== fromUid || currentUser.isAnonymous) {
      throw new Error('UNAUTHENTICATED');
    }
    const idToken = await currentUser.getIdToken();
    const response = await fetch(
      'https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${idToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          recipientUsername: cleanName,
          amount,
          note: note.trim().slice(0, 180),
          requestId: crypto.randomUUID(),
        }),
        cache: 'no-store',
      }
    );
    const payload = await response.json();
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || 'TRANSFER_FAILED');
    }
    return;
  }

  const unameSnap = await getDoc(doc(db, 'usernames', cleanName));
  if (!unameSnap.exists()) throw new Error('RECIPIENT_NOT_FOUND');
  const toUid = (unameSnap.data() as { uid: string }).uid;

  const txId = genId('tx');
  const logId = genId('aud');
  const notifId = genId('ntf');

  try {
    await runTransaction(db, async (tx) => {
      const fromWalletRef = doc(db, 'wallets', fromUid);
      const toWalletRef = doc(db, 'wallets', toUid);
      const [fromSnap, toSnap] = await Promise.all([tx.get(fromWalletRef), tx.get(toWalletRef)]);

      if (!fromSnap.exists() || !toSnap.exists()) throw new Error('RECIPIENT_NOT_FOUND');

      const fromWallet = fromSnap.data() as Wallet;
      const toWallet = toSnap.data() as Wallet;

      const validation = validateTransfer(fromUid, toUid, fromWallet.balance, amount);
      if (!validation.valid) {
        throw new Error(validation.reason || 'INVALID_TRANSFER');
      }

      tx.set(doc(db, 'transactions', txId), {
        id: txId,
        fromUid,
        toUid,
        amount,
        fee: 0,
        netAmount: amount,
        type: 'transfer',
        referenceId: toUid,
        description: note.trim() || `Transfer to ${recipientUsername.trim()}`,
        status: 'completed',
        createdAt: serverTimestamp(),
      });

      tx.update(fromWalletRef, {
        balance: fromWallet.balance - amount,
        totalSpent: fromWallet.totalSpent + amount,
        lastTxId: txId,
        updatedAt: serverTimestamp(),
      });

      tx.update(toWalletRef, {
        balance: toWallet.balance + amount,
        totalEarned: toWallet.totalEarned + amount,
        lastTxId: txId,
        updatedAt: serverTimestamp(),
      });

      tx.set(doc(db, 'audit_logs', logId), {
        id: logId,
        uid: fromUid,
        action: 'wallet_transfer',
        entityType: 'transaction',
        entityId: txId,
        createdAt: serverTimestamp(),
      });

      tx.set(doc(db, 'notifications', notifId), {
        id: notifId,
        uid: fromUid,
        title: 'Transfer Sent',
        body: `-$${amount.toLocaleString()} -> ${recipientUsername.trim()}`,
        type: 'economy',
        read: false,
        createdAt: serverTimestamp(),
      });
    });
  } catch (error) {
    if (
      error instanceof Error &&
      ['RECIPIENT_NOT_FOUND', 'SELF_OR_MISSING_RECIPIENT', 'INVALID_AMOUNT', 'INSUFFICIENT_FUNDS'].includes(
        error.message
      )
    ) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, `transactions/${txId}`);
  }
}

export async function createMarketListing(
  uid: string,
  username: string,
  itemId: string,
  qtyRaw: number,
  unitPriceRaw: number
): Promise<void> {
  const qty = Number.isFinite(qtyRaw) ? Math.floor(qtyRaw) : 0;
  const unitPrice = Number.isFinite(unitPriceRaw) ? Math.round(unitPriceRaw) : 0;
  if (!ITEM_MAP[itemId]) throw new Error('INVALID_ITEM');
  if (qty < 1 || qty > LISTING_MAX_QTY || unitPrice < 1 || unitPrice > LISTING_MAX_PRICE) {
    throw new Error('INVALID_LISTING_PARAMS');
  }

  if (import.meta.env.VITE_NEXORA_SUPABASE_MARKET === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid !== uid || currentUser.isAnonymous) throw new Error('UNAUTHENTICATED');
    const idToken = await currentUser.getIdToken();
    const response = await fetch('https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy', {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create_market_listing', itemId, quantity: qty, unitPrice, requestId: crypto.randomUUID() }),
      cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'MARKET_LISTING_FAILED');
    return;
  }

  const invDocId = `${uid}_${itemId}`;
  const listingId = genId('lst');

  try {
    await runTransaction(db, async (tx) => {
      const invRef = doc(db, 'inventory', invDocId);
      const invSnap = await tx.get(invRef);
      if (!invSnap.exists()) throw new Error('INSUFFICIENT_INVENTORY');
      const inv = invSnap.data() as InventoryItem;
      if (inv.quantity < qty) throw new Error('INSUFFICIENT_INVENTORY');

      tx.update(invRef, {
        quantity: inv.quantity - qty,
        updatedAt: serverTimestamp(),
      });

      tx.set(doc(db, 'market_listings', listingId), {
        id: listingId,
        sellerUid: uid,
        sellerName: username,
        itemId,
        quantity: qty,
        remainingQty: qty,
        unitPrice,
        status: 'active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    });
  } catch (error) {
    if (error instanceof Error && ['INVALID_ITEM', 'INVALID_LISTING_PARAMS', 'INSUFFICIENT_INVENTORY'].includes(error.message)) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, `market_listings/${listingId}`);
  }
}

export async function buyMarketListing(
  buyerUid: string,
  listingId: string,
  buyQtyRaw: number,
  taxRate: number
): Promise<void> {
  const buyQty = Math.floor(buyQtyRaw);
  if (buyQty < 1) throw new Error('INVALID_QUANTITY');

  if (import.meta.env.VITE_NEXORA_SUPABASE_MARKET === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid !== buyerUid || currentUser.isAnonymous) throw new Error('UNAUTHENTICATED');
    const idToken = await currentUser.getIdToken();
    const response = await fetch('https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy', {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'buy_market_listing', listingId, quantity: buyQty, requestId: crypto.randomUUID() }),
      cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'MARKET_PURCHASE_FAILED');
    return;
  }

  const txId = genId('tx');
  const orderId = `ord_${txId}`;

  try {
    await runTransaction(db, async (tx) => {
      const listingRef = doc(db, 'market_listings', listingId);
      const buyerWalletRef = doc(db, 'wallets', buyerUid);
      const buyerProfileRef = doc(db, 'profiles', buyerUid);

      const [listingSnap, buyerWalletSnap, buyerProfileSnap] = await Promise.all([
        tx.get(listingRef),
        tx.get(buyerWalletRef),
        tx.get(buyerProfileRef),
      ]);

      if (!listingSnap.exists()) throw new Error('LISTING_NOT_FOUND');
      if (!buyerWalletSnap.exists() || !buyerProfileSnap.exists()) throw new Error('ACCOUNT_NOT_FOUND');

      const listing = listingSnap.data() as MarketListing;
      if (listing.status !== 'active' || listing.remainingQty < buyQty) {
        throw new Error('INSUFFICIENT_LISTING_QTY');
      }
      if (listing.sellerUid === buyerUid) {
        throw new Error('CANNOT_BUY_OWN_LISTING');
      }

      const buyerWallet = buyerWalletSnap.data() as Wallet;
      const buyerProfile = buyerProfileSnap.data() as PlayerProfile;

      const totalPrice = listing.unitPrice * buyQty;
      if (buyerWallet.balance < totalPrice) {
        throw new Error('INSUFFICIENT_FUNDS');
      }

      const fee = Math.round(totalPrice * taxRate);
      const netAmount = totalPrice - fee;

      const invDocId = `${buyerUid}_${listing.itemId}`;
      const invRef = doc(db, 'inventory', invDocId);
      const invSnap = await tx.get(invRef);

      let sellerWalletSnap = null;
      const sellerWalletRef = doc(db, 'wallets', listing.sellerUid);
      if (listing.sellerUid !== 'SYSTEM') {
        sellerWalletSnap = await tx.get(sellerWalletRef);
      }

      const newRemaining = listing.remainingQty - buyQty;

      tx.set(doc(db, 'transactions', txId), {
        id: txId,
        fromUid: buyerUid,
        toUid: listing.sellerUid,
        amount: totalPrice,
        fee,
        netAmount,
        type: 'market_buy',
        referenceId: listingId,
        description: `Market buy: ${buyQty}x ${listing.itemId}`,
        status: 'completed',
        createdAt: serverTimestamp(),
      });

      tx.update(buyerWalletRef, {
        balance: buyerWallet.balance - totalPrice,
        totalSpent: buyerWallet.totalSpent + totalPrice,
        lastTxId: txId,
        updatedAt: serverTimestamp(),
      });

      if (sellerWalletSnap && sellerWalletSnap.exists()) {
        const sw = sellerWalletSnap.data() as Wallet;
        tx.update(sellerWalletRef, {
          balance: sw.balance + netAmount,
          totalEarned: sw.totalEarned + netAmount,
          lastTxId: txId,
          updatedAt: serverTimestamp(),
        });
      }

      tx.update(listingRef, {
        remainingQty: newRemaining,
        status: newRemaining === 0 ? 'sold' : 'active',
        updatedAt: serverTimestamp(),
      });

      tx.set(doc(db, 'market_orders', orderId), {
        id: orderId,
        listingId,
        buyerUid,
        sellerUid: listing.sellerUid,
        itemId: listing.itemId,
        quantity: buyQty,
        unitPrice: listing.unitPrice,
        totalPrice,
        taxAmount: fee,
        txId,
        createdAt: serverTimestamp(),
      });

      if (invSnap.exists()) {
        const prevQty = (invSnap.data() as InventoryItem).quantity;
        tx.update(invRef, {
          quantity: prevQty + buyQty,
          updatedAt: serverTimestamp(),
        });
      } else {
        tx.set(invRef, {
          uid: buyerUid,
          itemId: listing.itemId,
          quantity: buyQty,
          updatedAt: serverTimestamp(),
        });
      }

      const xpUpdate = applyXpAndLevel(buyerProfile, 25 + Math.min(50, buyQty * 2), 2, 1);
      tx.update(buyerProfileRef, {
        ...xpUpdate,
        stats: {
          ...buyerProfile.stats,
          tradesCount: buyerProfile.stats.tradesCount + 1,
        },
        updatedAt: serverTimestamp(),
      });
    });
  } catch (error) {
    if (
      error instanceof Error &&
      [
        'INVALID_QUANTITY',
        'LISTING_NOT_FOUND',
        'INSUFFICIENT_LISTING_QTY',
        'CANNOT_BUY_OWN_LISTING',
        'INSUFFICIENT_FUNDS',
      ].includes(error.message)
    ) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, `market_listings/${listingId}`);
  }
}

export async function cancelMarketListing(uid: string, listingId: string): Promise<void> {
  if (import.meta.env.VITE_NEXORA_SUPABASE_MARKET === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid !== uid || currentUser.isAnonymous) throw new Error('UNAUTHENTICATED');
    const idToken = await currentUser.getIdToken();
    const response = await fetch('https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy', {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel_market_listing', listingId }),
      cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'MARKET_CANCELLATION_FAILED');
    return;
  }
  try {
    await runTransaction(db, async (tx) => {
      const listingRef = doc(db, 'market_listings', listingId);
      const listingSnap = await tx.get(listingRef);
      if (!listingSnap.exists()) throw new Error('LISTING_NOT_FOUND');

      const listing = listingSnap.data() as MarketListing;
      if (listing.sellerUid !== uid || listing.status !== 'active') {
        throw new Error('CANNOT_CANCEL_LISTING');
      }

      const invRef = doc(db, 'inventory', `${uid}_${listing.itemId}`);
      const invSnap = await tx.get(invRef);

      tx.update(listingRef, {
        remainingQty: 0,
        status: 'cancelled',
        updatedAt: serverTimestamp(),
      });

      if (invSnap.exists()) {
        const prev = (invSnap.data() as InventoryItem).quantity;
        tx.update(invRef, {
          quantity: prev + listing.remainingQty,
          lastListingId: listingId,
          updatedAt: serverTimestamp(),
        });
      } else {
        tx.set(invRef, {
          uid,
          itemId: listing.itemId,
          quantity: listing.remainingQty,
          lastListingId: listingId,
          updatedAt: serverTimestamp(),
        });
      }
    });
  } catch (error) {
    if (error instanceof Error && ['LISTING_NOT_FOUND', 'CANNOT_CANCEL_LISTING'].includes(error.message)) {
      throw error;
    }
    handleFirestoreError(error, OperationType.UPDATE, `market_listings/${listingId}`);
  }
}

export async function manufactureRecipe(uid: string, recipeId: string, batchQuantity = 1): Promise<void> {
  const recipe = MANUFACTURING_RECIPES.find((r) => r.id === recipeId);
  if (!recipe) throw new Error('INVALID_RECIPE');
  if (!Number.isInteger(batchQuantity) || batchQuantity < 1 || batchQuantity > 999) throw new Error('INVALID_QUANTITY');
  if (import.meta.env.VITE_NEXORA_SUPABASE_MANUFACTURING === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid !== uid || currentUser.isAnonymous) throw new Error('UNAUTHENTICATED');
    const idToken = await currentUser.getIdToken();
    const response = await fetch('https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy', {
      method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'manufacture_recipe', recipeId, batchQuantity, requestId: crypto.randomUUID() }),
      cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'MANUFACTURING_FAILED');
    return;
  }

  const txId = genId('tx');

  try {
    await runTransaction(db, async (tx) => {
      const profileRef = doc(db, 'profiles', uid);
      const walletRef = doc(db, 'wallets', uid);
      const outInvRef = doc(db, 'inventory', `${uid}_${recipe.outputItemId}`);

      const inputRefs = recipe.inputs.map((inp) => doc(db, 'inventory', `${uid}_${inp.itemId}`));
      const [profileSnap, walletSnap, outInvSnap, ...inputSnaps] = await Promise.all([
        tx.get(profileRef),
        tx.get(walletRef),
        tx.get(outInvRef),
        ...inputRefs.map((ref) => tx.get(ref)),
      ]);

      if (!profileSnap.exists() || !walletSnap.exists()) throw new Error('ACCOUNT_NOT_FOUND');
      const profile = profileSnap.data() as PlayerProfile;
      const wallet = walletSnap.data() as Wallet;

      if ((profile.skills.industry || 0) < recipe.requiredIndustrySkill) {
        throw new Error('INDUSTRY_SKILL_TOO_LOW');
      }

      const cost = calculateManufacturingCost(recipe, profile.skills.industry || 0) * batchQuantity;
      if (wallet.balance < cost) throw new Error('INSUFFICIENT_FUNDS');

      for (let i = 0; i < recipe.inputs.length; i++) {
        const inp = recipe.inputs[i];
        const snap = inputSnaps[i];
        if (!snap.exists() || (snap.data() as InventoryItem).quantity < inp.qty * batchQuantity) {
          throw new Error('MISSING_INPUTS');
        }
      }

      tx.set(doc(db, 'transactions', txId), {
        id: txId,
        fromUid: uid,
        toUid: 'SYSTEM',
        amount: cost,
        fee: 0,
        netAmount: cost,
        type: 'manufacturing',
        referenceId: recipeId,
        description: `Manufactured ${recipe.outputQty * batchQuantity}x ${recipe.outputItemId} (${batchQuantity} batches)`,
        status: 'completed',
        createdAt: serverTimestamp(),
      });

      tx.update(walletRef, {
        balance: wallet.balance - cost,
        totalSpent: wallet.totalSpent + cost,
        lastTxId: txId,
        updatedAt: serverTimestamp(),
      });

      for (let i = 0; i < recipe.inputs.length; i++) {
        const inp = recipe.inputs[i];
        const prev = (inputSnaps[i].data() as InventoryItem).quantity;
        tx.update(inputRefs[i], {
          quantity: prev - inp.qty * batchQuantity,
          updatedAt: serverTimestamp(),
        });
      }

      if (outInvSnap.exists()) {
        const prevOut = (outInvSnap.data() as InventoryItem).quantity;
        tx.update(outInvRef, {
          quantity: prevOut + recipe.outputQty * batchQuantity,
          updatedAt: serverTimestamp(),
        });
      } else {
        tx.set(outInvRef, {
          uid,
          itemId: recipe.outputItemId,
          quantity: recipe.outputQty * batchQuantity,
          updatedAt: serverTimestamp(),
        });
      }

      const xpUpdate = applyXpAndLevel(profile, recipe.xpReward * batchQuantity, 3, 2);
      tx.update(profileRef, {
        ...xpUpdate,
        stats: {
          ...profile.stats,
          totalProduced: profile.stats.totalProduced + recipe.outputQty * batchQuantity,
        },
        updatedAt: serverTimestamp(),
      });
    });
  } catch (error) {
    if (
      error instanceof Error &&
      ['INVALID_RECIPE', 'INVALID_QUANTITY', 'INDUSTRY_SKILL_TOO_LOW', 'INSUFFICIENT_FUNDS', 'MISSING_INPUTS'].includes(
        error.message
      )
    ) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, `manufacturing/${recipeId}`);
  }
}

export async function fulfillTradeContract(uid: string, contractId: string): Promise<number> {
  const contract = TRADE_CONTRACTS.find((c) => c.id === contractId);
  if (!contract) throw new Error('INVALID_CONTRACT');

  if (import.meta.env.VITE_NEXORA_SUPABASE_CONTRACTS === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid !== uid || currentUser.isAnonymous) throw new Error('UNAUTHENTICATED');
    const idToken = await currentUser.getIdToken();
    const response = await fetch('https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy', {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'fulfill_trade_contract', contractId }),
      cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok || !Number.isFinite(payload.payout)) {
      throw new Error(payload?.error || 'CONTRACT_FULFILL_FAILED');
    }
    return Number(payload.payout);
  }

  const dateKey = getUtcDateKey();
  const claimId = `${uid}_${contractId}_${dateKey}`;
  const txId = genId('tx');

  try {
    let payout = 0;
    await runTransaction(db, async (tx) => {
      const claimRef = doc(db, 'contract_claims', claimId);
      const invRef = doc(db, 'inventory', `${uid}_${contract.requiredItemId}`);
      const walletRef = doc(db, 'wallets', uid);
      const profileRef = doc(db, 'profiles', uid);

      const [claimSnap, invSnap, walletSnap, profileSnap] = await Promise.all([
        tx.get(claimRef),
        tx.get(invRef),
        tx.get(walletRef),
        tx.get(profileRef),
      ]);

      if (claimSnap.exists()) throw new Error('CONTRACT_ALREADY_FULFILLED');
      if (!invSnap.exists() || (invSnap.data() as InventoryItem).quantity < contract.requiredQty) {
        throw new Error('MISSING_INPUTS');
      }
      if (!walletSnap.exists() || !profileSnap.exists()) throw new Error('ACCOUNT_NOT_FOUND');

      const wallet = walletSnap.data() as Wallet;
      const profile = profileSnap.data() as PlayerProfile;
      payout = calculateContractPayout(
        contract.payoutCredits,
        profile.skills.negotiation || 0,
        profile.reputation
      );

      tx.set(claimRef, {
        uid,
        contractId: `${contractId}_${dateKey}`,
        amount: payout,
        claimedAt: serverTimestamp(),
      });

      tx.set(doc(db, 'transactions', txId), {
        id: txId,
        fromUid: 'SYSTEM',
        toUid: uid,
        amount: payout,
        fee: 0,
        netAmount: payout,
        type: 'contract_deal',
        referenceId: claimId,
        description: `Contract fulfilled: ${contract.titleEn}`,
        status: 'completed',
        createdAt: serverTimestamp(),
      });

      tx.update(walletRef, {
        balance: wallet.balance + payout,
        totalEarned: wallet.totalEarned + payout,
        lastTxId: txId,
        updatedAt: serverTimestamp(),
      });

      tx.update(invRef, {
        quantity: (invSnap.data() as InventoryItem).quantity - contract.requiredQty,
        updatedAt: serverTimestamp(),
      });

      const xpUpdate = applyXpAndLevel(
        profile,
        contract.xpReward,
        contract.reputationReward,
        5
      );
      tx.update(profileRef, {
        ...xpUpdate,
        stats: {
          ...profile.stats,
          tradesCount: profile.stats.tradesCount + 1,
        },
        updatedAt: serverTimestamp(),
      });
    });
    return payout;
  } catch (error) {
    if (
      error instanceof Error &&
      ['INVALID_CONTRACT', 'CONTRACT_ALREADY_FULFILLED', 'MISSING_INPUTS'].includes(error.message)
    ) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, `contract_claims/${claimId}`);
  }
}

export async function createCompanyAuction(
  uid: string,
  companyId: string,
  startingPrice: number
): Promise<{ auctionId: string; endsAt: number; minPrice: number; maxPrice: number }> {
  if (auth.currentUser?.uid !== uid) throw new Error('AUTH_SESSION_MISMATCH');
  const create = httpsCallable<
    { companyId: string; startingPrice: number },
    { ok: boolean; auctionId: string; endsAt: number; minPrice: number; maxPrice: number }
  >(functions, 'createCompanyAuctionSecure');
  const result = await create({ companyId, startingPrice });
  return result.data;
}

export async function placeCompanyAuctionBid(
  uid: string,
  auctionId: string,
  bidAmount: number
): Promise<{ ok: boolean; currentBid: number; nextMinimumBid: number }> {
  if (auth.currentUser?.uid !== uid) throw new Error('AUTH_SESSION_MISMATCH');
  const placeBid = httpsCallable<
    { auctionId: string; bidAmount: number },
    { ok: boolean; currentBid: number; nextMinimumBid: number }
  >(functions, 'placeCompanyAuctionBidSecure');
  const result = await placeBid({ auctionId, bidAmount });
  return result.data;
}

export async function foundCompany(
  uid: string,
  ownerName: string,
  name: string,
  sector: CompanySector
): Promise<void> {
  const cleanName = name.trim();
  if (cleanName.length < 2 || cleanName.length > 48) throw new Error('INVALID_NAME');
  const spec = COMPANY_SECTORS.find((s) => s.sector === sector);
  if (!spec) throw new Error('INVALID_SECTOR');

  if (import.meta.env.VITE_NEXORA_SUPABASE_COMPANIES === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid !== uid || currentUser.isAnonymous) throw new Error('UNAUTHENTICATED');
    const idToken = await currentUser.getIdToken();
    const response = await fetch('https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy', {
      method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'found_company', name: cleanName, sector, requestId: crypto.randomUUID() }),
      cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'COMPANY_FOUNDING_FAILED');
    return;
  }

  const companyId = genId('cmp');
  const txId = genId('tx');
  const logId = genId('clog');

  try {
    await runTransaction(db, async (tx) => {
      const walletRef = doc(db, 'wallets', uid);
      const profileRef = doc(db, 'profiles', uid);
      const [walletSnap, profileSnap] = await Promise.all([
        tx.get(walletRef),
        tx.get(profileRef),
      ]);

      if (!walletSnap.exists() || !profileSnap.exists()) throw new Error('ACCOUNT_NOT_FOUND');
      const wallet = walletSnap.data() as Wallet;
      const profile = profileSnap.data() as PlayerProfile;
      const playerLevel = Math.max(1, Math.min(100, Math.floor(profile.level || 1)));
      const ownershipLimit = Math.min(10, 1 + Math.floor(((playerLevel - 1) * 9) / 49));
      const ownedCompanies = Math.max(0, Math.floor(profile.stats?.companiesOwned || 0));
      if (ownedCompanies >= ownershipLimit) throw new Error('COMPANY_OWNERSHIP_LIMIT');

      if (wallet.balance < spec.foundingCost) throw new Error('INSUFFICIENT_FUNDS');

      tx.set(doc(db, 'companies', companyId), {
        id: companyId,
        ownerUid: uid,
        ownerName,
        name: cleanName,
        sector,
        level: 1,
        capital: spec.foundingCost,
        baseRevenuePerHour: spec.baseRevenuePerHour,
        expensePerHour: spec.baseExpensePerHour,
        totalRevenue: 0,
        vaultLevel: 1,
        vaultBalance: 0,
        lastCollectedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      tx.set(doc(db, 'transactions', txId), {
        id: txId,
        fromUid: uid,
        toUid: 'SYSTEM',
        amount: spec.foundingCost,
        fee: 0,
        netAmount: spec.foundingCost,
        type: 'company_create',
        referenceId: companyId,
        description: `Founded company: ${cleanName}`,
        status: 'completed',
        createdAt: serverTimestamp(),
      });

      tx.update(walletRef, {
        balance: wallet.balance - spec.foundingCost,
        totalSpent: wallet.totalSpent + spec.foundingCost,
        lastTxId: txId,
        updatedAt: serverTimestamp(),
      });

      const xpUpdate = applyXpAndLevel(profile, 100, 10, 8);
      tx.update(profileRef, {
        ...xpUpdate,
        stats: {
          ...profile.stats,
          companiesOwned: profile.stats.companiesOwned + 1,
        },
        updatedAt: serverTimestamp(),
      });

      tx.set(doc(db, 'company_logs', logId), {
        id: logId,
        companyId,
        ownerUid: uid,
        action: 'founded',
        amount: -spec.foundingCost,
        details: `Company established in ${sector} sector`,
        createdAt: serverTimestamp(),
      });
    });
  } catch (error) {
    if (error instanceof Error && ['INVALID_NAME', 'INVALID_SECTOR', 'INSUFFICIENT_FUNDS', 'COMPANY_OWNERSHIP_LIMIT'].includes(error.message)) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, `companies/${companyId}`);
  }
}

export async function upgradeCompany(uid: string, companyId: string): Promise<void> {
  if (import.meta.env.VITE_NEXORA_SUPABASE_COMPANIES === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid !== uid || currentUser.isAnonymous) throw new Error('UNAUTHENTICATED');
    const idToken = await currentUser.getIdToken();
    const response = await fetch('https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy', {
      method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'company_upgrade', companyId, requestId: crypto.randomUUID() }),
      cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'COMPANY_OPERATION_FAILED');
    return;
  }
  await callCompanyVault<{ ok: boolean }>(uid, 'company_upgrade', companyId);
}

async function callCompanyVault<T>(
  uid: string,
  action: 'upgrade' | 'collect' | 'company_upgrade' | 'company_complete' | 'vault_complete',
  companyId: string
): Promise<T> {
  const currentUser = auth.currentUser;
  if (!currentUser || currentUser.uid !== uid) throw new Error('UNAUTHORIZED');

  const idToken = await currentUser.getIdToken();
  const response = await fetch('/api/company-vault', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action, companyId }),
  });
  const payload = await response.json().catch(() => ({})) as { error?: unknown } & Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string' ? payload.error : 'COMPANY_VAULT_OPERATION_FAILED');
  }
  return payload as T;
}

export async function upgradeCompanyVault(uid: string, companyId: string): Promise<void> {
  if (import.meta.env.VITE_NEXORA_SUPABASE_COMPANIES === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid !== uid || currentUser.isAnonymous) throw new Error('UNAUTHENTICATED');
    const idToken = await currentUser.getIdToken();
    const response = await fetch('https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy', {
      method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'company_vault_upgrade', companyId, requestId: crypto.randomUUID() }),
      cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'COMPANY_OPERATION_FAILED');
    return;
  }
  await callCompanyVault<{ ok: boolean }>(uid, 'upgrade', companyId);
}

export async function completeCompanyUpgrade(uid: string, companyId: string): Promise<void> {
  if (import.meta.env.VITE_NEXORA_SUPABASE_COMPANIES === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid !== uid || currentUser.isAnonymous) throw new Error('UNAUTHENTICATED');
    const idToken = await currentUser.getIdToken();
    const response = await fetch('https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy', {
      method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'company_complete', companyId }),
      cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'COMPANY_OPERATION_FAILED');
    return;
  }
  await callCompanyVault<{ ok: boolean }>(uid, 'company_complete', companyId);
}

export async function completeCompanyVaultUpgrade(uid: string, companyId: string): Promise<void> {
  if (import.meta.env.VITE_NEXORA_SUPABASE_COMPANIES === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid !== uid || currentUser.isAnonymous) throw new Error('UNAUTHENTICATED');
    const idToken = await currentUser.getIdToken();
    const response = await fetch('https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy', {
      method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'company_vault_complete', companyId }),
      cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'COMPANY_OPERATION_FAILED');
    return;
  }
  await callCompanyVault<{ ok: boolean }>(uid, 'vault_complete', companyId);
}

export async function collectCompanyRevenue(uid: string, companyId: string): Promise<number> {
  if (import.meta.env.VITE_NEXORA_SUPABASE_COMPANIES === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid !== uid || currentUser.isAnonymous) throw new Error('UNAUTHENTICATED');
    const idToken = await currentUser.getIdToken();
    const response = await fetch('https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy', {
      method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'company_collect', companyId, requestId: crypto.randomUUID() }),
      cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'COMPANY_OPERATION_FAILED');
    return Number(payload.payout);
  }
  const result = await callCompanyVault<{ ok: boolean; payout: number }>(uid, 'collect', companyId);
  return result.payout;
}

export async function buyProperty(
  uid: string,
  name: string,
  type: PropertyType
): Promise<void> {
  const cleanName = name.trim();
  if (cleanName.length < 2 || cleanName.length > 48) throw new Error('INVALID_NAME');
  const spec = PROPERTY_SPECS.find((p) => p.type === type);
  if (!spec) throw new Error('INVALID_PROPERTY_TYPE');

  if (import.meta.env.VITE_NEXORA_SUPABASE_PROPERTIES === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid !== uid || currentUser.isAnonymous) throw new Error('UNAUTHENTICATED');
    const idToken = await currentUser.getIdToken();
    const response = await fetch('https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy', {
      method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'buy_property', name: cleanName, propertyType: type, requestId: crypto.randomUUID() }),
      cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'PROPERTY_PURCHASE_FAILED');
    return;
  }

  const propId = genId('prop');
  const txId = genId('tx');

  try {
    await runTransaction(db, async (tx) => {
      const walletRef = doc(db, 'wallets', uid);
      const profileRef = doc(db, 'profiles', uid);
      const [walletSnap, profileSnap] = await Promise.all([
        tx.get(walletRef),
        tx.get(profileRef),
      ]);

      if (!walletSnap.exists() || !profileSnap.exists()) throw new Error('ACCOUNT_NOT_FOUND');
      const wallet = walletSnap.data() as Wallet;
      const profile = profileSnap.data() as PlayerProfile;
      if (wallet.balance < spec.purchasePrice) throw new Error('INSUFFICIENT_FUNDS');

      tx.set(doc(db, 'properties', propId), {
        id: propId,
        ownerUid: uid,
        name: cleanName,
        type,
        level: 1,
        purchasePrice: spec.purchasePrice,
        rentPerHour: spec.rentPerHour,
        maintenancePerHour: spec.maintenancePerHour,
        isRented: true,
        lastCollectedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      tx.set(doc(db, 'transactions', txId), {
        id: txId,
        fromUid: uid,
        toUid: 'SYSTEM',
        amount: spec.purchasePrice,
        fee: 0,
        netAmount: spec.purchasePrice,
        type: 'property_buy',
        referenceId: propId,
        description: `Acquired property: ${cleanName}`,
        status: 'completed',
        createdAt: serverTimestamp(),
      });

      tx.update(walletRef, {
        balance: wallet.balance - spec.purchasePrice,
        totalSpent: wallet.totalSpent + spec.purchasePrice,
        lastTxId: txId,
        updatedAt: serverTimestamp(),
      });

      const xpUpdate = applyXpAndLevel(profile, 90, 8, 6);
      tx.update(profileRef, {
        ...xpUpdate,
        stats: {
          ...profile.stats,
          propertiesOwned: profile.stats.propertiesOwned + 1,
        },
        updatedAt: serverTimestamp(),
      });
    });
  } catch (error) {
    if (error instanceof Error && ['INVALID_NAME', 'INVALID_PROPERTY_TYPE', 'INSUFFICIENT_FUNDS'].includes(error.message)) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, `properties/${propId}`);
  }
}

export async function togglePropertyLease(uid: string, propertyId: string, nextState: boolean): Promise<void> {
  if (import.meta.env.VITE_NEXORA_SUPABASE_PROPERTIES === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid !== uid || currentUser.isAnonymous) throw new Error('UNAUTHENTICATED');
    const idToken = await currentUser.getIdToken();
    const response = await fetch('https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy', {
      method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'toggle_property_lease', propertyId, isRented: nextState }),
      cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'PROPERTY_OPERATION_FAILED');
    return;
  }
  try {
    await updateDoc(doc(db, 'properties', propertyId), {
      isRented: nextState,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `properties/${propertyId}`);
  }
}

export async function upgradeProperty(uid: string, propertyId: string): Promise<void> {
  if (import.meta.env.VITE_NEXORA_SUPABASE_PROPERTIES === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid !== uid || currentUser.isAnonymous) throw new Error('UNAUTHENTICATED');
    const idToken = await currentUser.getIdToken();
    const response = await fetch('https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy', {
      method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'upgrade_property', propertyId, requestId: crypto.randomUUID() }),
      cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'PROPERTY_OPERATION_FAILED');
    return;
  }
  const txId = genId('tx');
  try {
    await runTransaction(db, async (tx) => {
      const propRef = doc(db, 'properties', propertyId);
      const walletRef = doc(db, 'wallets', uid);
      const [propSnap, walletSnap] = await Promise.all([tx.get(propRef), tx.get(walletRef)]);
      if (!propSnap.exists()) throw new Error('PROPERTY_NOT_FOUND');
      const prop = propSnap.data() as PropertyAsset;
      if (prop.ownerUid !== uid) throw new Error('UNAUTHORIZED');
      if (prop.level >= PROPERTY_MAX_LEVEL) throw new Error('MAX_LEVEL');

      const cost = prop.level * 480;
      const wallet = walletSnap.data() as Wallet;
      if (wallet.balance < cost) throw new Error('INSUFFICIENT_FUNDS');

      tx.set(doc(db, 'transactions', txId), {
        id: txId,
        fromUid: uid,
        toUid: 'SYSTEM',
        amount: cost,
        fee: 0,
        netAmount: cost,
        type: 'property_upgrade',
        referenceId: propertyId,
        description: `Upgraded property ${prop.name} to Lv.${prop.level + 1}`,
        status: 'completed',
        createdAt: serverTimestamp(),
      });

      tx.update(walletRef, {
        balance: wallet.balance - cost,
        totalSpent: wallet.totalSpent + cost,
        lastTxId: txId,
        updatedAt: serverTimestamp(),
      });

      tx.update(propRef, {
        level: prop.level + 1,
        updatedAt: serverTimestamp(),
      });
    });
  } catch (error) {
    if (error instanceof Error && ['PROPERTY_NOT_FOUND', 'UNAUTHORIZED', 'MAX_LEVEL', 'INSUFFICIENT_FUNDS'].includes(error.message)) {
      throw error;
    }
    handleFirestoreError(error, OperationType.UPDATE, `properties/${propertyId}`);
  }
}

export async function collectPropertyRent(uid: string, propertyId: string): Promise<number> {
  if (import.meta.env.VITE_NEXORA_SUPABASE_PROPERTIES === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid !== uid || currentUser.isAnonymous) throw new Error('UNAUTHENTICATED');
    const idToken = await currentUser.getIdToken();
    const response = await fetch('https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy', {
      method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'collect_property_rent', propertyId, requestId: crypto.randomUUID() }),
      cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok || !Number.isFinite(payload.payout)) {
      throw new Error(payload?.error || 'PROPERTY_OPERATION_FAILED');
    }
    return Number(payload.payout);
  }
  const txId = genId('tx');
  try {
    let payout = 0;
    await runTransaction(db, async (tx) => {
      const propRef = doc(db, 'properties', propertyId);
      const walletRef = doc(db, 'wallets', uid);
      const profileRef = doc(db, 'profiles', uid);
      const [propSnap, walletSnap, profileSnap] = await Promise.all([
        tx.get(propRef),
        tx.get(walletRef),
        tx.get(profileRef),
      ]);
      if (!propSnap.exists()) throw new Error('PROPERTY_NOT_FOUND');
      const prop = propSnap.data() as PropertyAsset;
      if (prop.ownerUid !== uid) throw new Error('UNAUTHORIZED');
      if (!prop.isRented) throw new Error('PROPERTY_VACANT');

      const nowMs = Date.now();
      const lastCollectedMs = timestampToMs(prop.lastCollectedAt);
      if (nowMs - lastCollectedMs < 60_000) {
        throw new Error('NOTHING_TO_COLLECT');
      }

      const wallet = walletSnap.data() as Wallet;
      const profile = profileSnap.data() as PlayerProfile;
      const { netHourly } = calculatePropertyHourlyNet(prop, profile.skills.negotiation || 0);
      if (netHourly <= 0) throw new Error('PROPERTY_VACANT');

      const rawAccrued = calculateAccruedPayout(netHourly, lastCollectedMs, nowMs);
      payout = Math.min(15000, rawAccrued);
      if (payout < 1) throw new Error('NOTHING_TO_COLLECT');

      tx.set(doc(db, 'transactions', txId), {
        id: txId,
        fromUid: 'SYSTEM',
        toUid: uid,
        amount: payout,
        fee: 0,
        netAmount: payout,
        type: 'property_collect',
        referenceId: propertyId,
        description: `Collected rent from ${prop.name}`,
        status: 'completed',
        createdAt: serverTimestamp(),
      });

      tx.update(walletRef, {
        balance: wallet.balance + payout,
        totalEarned: wallet.totalEarned + payout,
        lastTxId: txId,
        updatedAt: serverTimestamp(),
      });

      tx.update(propRef, {
        lastCollectedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    });
    return payout;
  } catch (error) {
    if (error instanceof Error && ['PROPERTY_NOT_FOUND', 'UNAUTHORIZED', 'PROPERTY_VACANT', 'NOTHING_TO_COLLECT'].includes(error.message)) {
      throw error;
    }
    handleFirestoreError(error, OperationType.UPDATE, `properties/${propertyId}`);
  }
}

export async function claimMissionReward(uid: string, missionId: string): Promise<void> {
  const mission = MISSIONS.find((m) => m.id === missionId);
  if (!mission) throw new Error('INVALID_MISSION');

  if (import.meta.env.VITE_NEXORA_SUPABASE_MISSIONS === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid !== uid || currentUser.isAnonymous) throw new Error('UNAUTHENTICATED');
    const idToken = await currentUser.getIdToken();
    const response = await fetch('https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy', {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'claim_mission_reward', missionId }),
      cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'MISSION_REWARD_FAILED');
    return;
  }

  const claimDocId = `${uid}_${missionId}`;
  const txId = genId('tx');

  try {
    await runTransaction(db, async (tx) => {
      const claimRef = doc(db, 'player_missions', claimDocId);
      const walletRef = doc(db, 'wallets', uid);
      const profileRef = doc(db, 'profiles', uid);
      const [claimSnap, walletSnap, profileSnap] = await Promise.all([
        tx.get(claimRef),
        tx.get(walletRef),
        tx.get(profileRef),
      ]);

      if (claimSnap.exists()) throw new Error('MISSION_ALREADY_CLAIMED');
      if (!walletSnap.exists() || !profileSnap.exists()) throw new Error('ACCOUNT_NOT_FOUND');

      const wallet = walletSnap.data() as Wallet;
      const profile = profileSnap.data() as PlayerProfile;

      const currentProgress = getMissionProgress(mission.metric, profile);

      if (currentProgress < mission.targetCount) {
        throw new Error('MISSION_NOT_COMPLETE');
      }

      tx.set(claimRef, {
        uid,
        missionId,
        category: mission.category,
        rewardCredits: mission.rewardCredits,
        rewardXp: mission.rewardXp,
        claimedAt: serverTimestamp(),
      });

      tx.set(doc(db, 'transactions', txId), {
        id: txId,
        fromUid: 'SYSTEM',
        toUid: uid,
        amount: mission.rewardCredits,
        fee: 0,
        netAmount: mission.rewardCredits,
        type: 'mission_reward',
        referenceId: claimDocId,
        description: `Mission reward: ${mission.titleEn}`,
        status: 'completed',
        createdAt: serverTimestamp(),
      });

      tx.update(walletRef, {
        balance: wallet.balance + mission.rewardCredits,
        totalEarned: wallet.totalEarned + mission.rewardCredits,
        lastTxId: txId,
        updatedAt: serverTimestamp(),
      });

      const xpUpdate = applyXpAndLevel(profile, mission.rewardXp, mission.rewardReputation, 5);
      tx.update(profileRef, {
        ...xpUpdate,
        stats: {
          ...profile.stats,
          missionsCompleted: profile.stats.missionsCompleted + 1,
        },
        updatedAt: serverTimestamp(),
      });
    });
  } catch (error) {
    if (error instanceof Error && ['INVALID_MISSION', 'MISSION_ALREADY_CLAIMED', 'MISSION_NOT_COMPLETE'].includes(error.message)) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, `player_missions/${claimDocId}`);
  }
}

export async function createOrganization(
  uid: string,
  _username: string,
  name: string,
  tag: string,
  description: string
): Promise<string> {
  const cleanName = name.trim();
  const cleanTag = tag.trim().toUpperCase();
  if (cleanName.length < 3 || cleanName.length > 40) throw new Error('INVALID_NAME');
  if (cleanTag.length < 2 || cleanTag.length > 6) throw new Error('INVALID_TAG');

  const currentUser = auth.currentUser;
  if (!currentUser || currentUser.uid !== uid) throw new Error('AUTH_SESSION_MISMATCH');
  if (!currentUser.emailVerified) throw new Error('EMAIL_NOT_VERIFIED');

  if (import.meta.env.VITE_NEXORA_SUPABASE_ORGANIZATIONS === 'true') {
    const idToken = await currentUser.getIdToken(true);
    const response = await fetch('https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy', {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create_organization', name: cleanName, tag: cleanTag,
        description: description.trim().slice(0, 240), requestId: crypto.randomUUID() }),
      cache: 'no-store',
    });
    const payload = await response.json().catch(() => ({})) as { error?: unknown; orgId?: unknown; ok?: boolean };
    if (!response.ok || payload.ok !== true || typeof payload.orgId !== 'string' || !payload.orgId) {
      throw new Error(typeof payload.error === 'string' ? payload.error : 'ORGANIZATION_CREATE_FAILED');
    }
    return payload.orgId;
  }

  const idToken = await currentUser.getIdToken(true);
  const response = await fetch('/api/organization-create', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: cleanName,
      tag: cleanTag,
      description: description.trim().slice(0, 240),
    }),
  });
  const payload = await response.json().catch(() => ({})) as {
    error?: unknown;
    orgId?: unknown;
  };
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string' ? payload.error : 'ORGANIZATION_CREATE_FAILED');
  }
  if (typeof payload.orgId !== 'string' || !payload.orgId) {
    throw new Error('ORGANIZATION_CREATE_FAILED');
  }
  return payload.orgId;
}

export async function requestJoinOrganization(
  uid: string,
  _username: string,
  orgId: string
): Promise<'joined' | 'requested'> {
  if (auth.currentUser?.uid !== uid) throw new Error('AUTH_SESSION_MISMATCH');
  const join = httpsCallable<{ orgId: string }, { status: 'joined' | 'requested' }>(functions, 'joinOrganizationSecure');
  const result = await join({ orgId });
  if (result.data.status !== 'joined' && result.data.status !== 'requested') {
    throw new Error('ORGANIZATION_JOIN_FAILED');
  }
  return result.data.status;
}

export async function setOrganizationJoinMode(
  uid: string,
  orgId: string,
  mode: 'open' | 'request' | 'closed'
): Promise<void> {
  if (auth.currentUser?.uid !== uid) throw new Error('AUTH_SESSION_MISMATCH');
  const updateMode = httpsCallable<{ orgId: string; mode: 'open' | 'request' | 'closed' }, { ok: boolean }>(
    functions,
    'setOrganizationJoinModeSecure'
  );
  await updateMode({ orgId, mode });
}

export async function handleOrgJoinRequest(
  orgId: string,
  reqId: string,
  applicantUid: string,
  _applicantUsername: string,
  decision: 'approved' | 'rejected'
): Promise<void> {
  const handleRequest = httpsCallable(functions, 'approveOrganizationJoinRequestSecure');
  await handleRequest({ orgId, reqId, applicantUid, decision });
}

export async function syncSelfOrgMembership(uid: string, orgId: string | null): Promise<void> {
  if (import.meta.env.VITE_NEXORA_SUPABASE_ORGANIZATIONS === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid !== uid || currentUser.isAnonymous) throw new Error('UNAUTHENTICATED');
    const idToken = await currentUser.getIdToken();
    const response = await fetch('https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy', {
      method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'sync_org_membership', orgId }),
      cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'ORG_MEMBERSHIP_SYNC_FAILED');
    return;
  }
  try {
    await updateDoc(doc(db, 'profiles', uid), {
      orgId,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `profiles/${uid}`);
  }
}

export async function updateOrgMemberRole(
  orgId: string,
  targetUid: string,
  newRole: Exclude<OrgRole, 'leader'>
): Promise<void> {
  if (import.meta.env.VITE_NEXORA_SUPABASE_ORGANIZATIONS === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.isAnonymous) throw new Error('UNAUTHENTICATED');
    const idToken = await currentUser.getIdToken();
    const response = await fetch('https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy', {
      method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update_org_member_role', orgId, targetUid, newRole }),
      cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'ORG_ROLE_UPDATE_FAILED');
    return;
  }
  try {
    await updateDoc(doc(db, 'organization_members', `${orgId}_${targetUid}`), {
      role: newRole,
      permissions: ROLE_DEFAULT_PERMISSIONS[newRole],
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `organization_members/${orgId}_${targetUid}`);
  }
}

export async function leaveOrganization(uid: string, orgId: string): Promise<void> {
  if (!uid || auth.currentUser?.uid !== uid) throw new Error('UNAUTHENTICATED');
  const leave = httpsCallable(functions, 'leaveOrganizationSecure');
  await leave({ orgId });
}

export async function kickOrgMember(
  actorUid: string,
  orgId: string,
  targetUid: string
): Promise<void> {
  if (!actorUid || actorUid === targetUid) throw new Error('CANNOT_KICK_SELF');
  if (auth.currentUser?.uid !== actorUid) throw new Error('UNAUTHENTICATED');
  const removeMember = httpsCallable(functions, 'kickOrganizationMemberSecure');
  await removeMember({ orgId, targetUid });
}

async function callOrganizationUpgrade(orgId: string, action: 'start' | 'complete' | 'research', researchId?: string) {
  const user = auth.currentUser;
  if (!user) throw new Error('UNAUTHENTICATED');
  const token = await user.getIdToken();
  const response = await fetch('/api/organization-upgrade', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ orgId, action, researchId }),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : 'ORGANIZATION_UPGRADE_FAILED');
  return payload;
}

export async function upgradeOrganization(
  _uid: string,
  _username: string,
  orgId: string
): Promise<{ targetLevel: number; endsAt: number; cost: number }> {
  if (import.meta.env.VITE_NEXORA_SUPABASE_ORGANIZATIONS === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.isAnonymous) throw new Error('UNAUTHENTICATED');
    const idToken = await currentUser.getIdToken();
    const response = await fetch('https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy', {
      method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start_org_upgrade', orgId }),
      cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'ORGANIZATION_UPGRADE_FAILED');
    return { targetLevel: Number(payload.targetLevel), endsAt: Number(payload.endsAt), cost: Number(payload.cost) };
  }

  const result = await callOrganizationUpgrade(orgId, 'start');
  return {
    targetLevel: Number(result.targetLevel),
    endsAt: Number(result.endsAt),
    cost: Number(result.cost),
  };
}

export async function completeOrganizationUpgrade(orgId: string): Promise<void> {
  if (import.meta.env.VITE_NEXORA_SUPABASE_ORGANIZATIONS === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.isAnonymous) throw new Error('UNAUTHENTICATED');
    const idToken = await currentUser.getIdToken();
    const response = await fetch('https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy', {
      method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'complete_org_upgrade', orgId }),
      cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'ORGANIZATION_UPGRADE_FAILED');
    return;
  }

  await callOrganizationUpgrade(orgId, 'complete');
}

export async function researchOrganization(orgId: string, researchId: 'commerce' | 'engineering' | 'expansion' | 'finance' | 'diplomacy'): Promise<{ level: number; cost: number }> {
  if (import.meta.env.VITE_NEXORA_SUPABASE_ORGANIZATIONS === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.isAnonymous) throw new Error('UNAUTHENTICATED');
    const idToken = await currentUser.getIdToken();
    const response = await fetch('https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy', {
      method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'research_org', orgId, researchId }),
      cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'ORGANIZATION_UPGRADE_FAILED');
    return { level: Number(payload.level), cost: Number(payload.cost) };
  }

  const result = await callOrganizationUpgrade(orgId, 'research', researchId);
  return { level: Number(result.level), cost: Number(result.cost) };
}

export async function depositToOrgTreasury(
  uid: string,
  username: string,
  orgId: string,
  amountRaw: number
): Promise<void> {
  const amount = Math.floor(amountRaw);
  if (!Number.isFinite(amountRaw) || amount <= 0 || amount > 10_000_000) throw new Error('INVALID_AMOUNT');
  const txId = genId('tx');
  const orgTxId = genId('otx');

  if (import.meta.env.VITE_NEXORA_SUPABASE_ORG_TREASURY === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid !== uid || currentUser.isAnonymous) throw new Error('UNAUTHENTICATED');
    const idToken = await currentUser.getIdToken();
    const response = await fetch('https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy', {
      method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'deposit_org_treasury', orgId, amount, requestId: crypto.randomUUID() }),
      cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'ORG_TREASURY_OPERATION_FAILED');
    return;
  }
  try {
    await runTransaction(db, async (tx) => {
      const walletRef = doc(db, 'wallets', uid);
      const orgRef = doc(db, 'organizations', orgId);
      const memberRef = doc(db, 'organization_members', `${orgId}_${uid}`);
      const [walletSnap, orgSnap, memberSnap] = await Promise.all([tx.get(walletRef), tx.get(orgRef), tx.get(memberRef)]);
      if (!walletSnap.exists() || !orgSnap.exists()) throw new Error('NOT_FOUND');
      if (!memberSnap.exists()) throw new Error('UNAUTHORIZED');

      const wallet = walletSnap.data() as Wallet;
      const org = orgSnap.data() as Organization;
      if (wallet.balance < amount) throw new Error('INSUFFICIENT_FUNDS');

      tx.set(doc(db, 'transactions', txId), {
        id: txId,
        fromUid: uid,
        toUid: 'ORG',
        amount,
        fee: 0,
        netAmount: amount,
        type: 'org_deposit',
        referenceId: orgId,
        description: `Org treasury deposit [${org.tag}]`,
        status: 'completed',
        createdAt: serverTimestamp(),
      });

      tx.update(walletRef, {
        balance: wallet.balance - amount,
        totalSpent: wallet.totalSpent + amount,
        lastTxId: txId,
        updatedAt: serverTimestamp(),
      });

      tx.update(orgRef, {
        treasuryBalance: org.treasuryBalance + amount,
        reputation: org.reputation + Math.max(1, Math.floor((amount / 100) * (1 + Math.min(10, org.research?.diplomacy ?? 0) * 0.01))),
        updatedAt: serverTimestamp(),
      });

      tx.set(doc(db, 'organization_transactions', orgTxId), {
        id: orgTxId,
        orgId,
        uid,
        username,
        type: 'deposit',
        amount,
        note: `Deposit by ${username}`,
        createdAt: serverTimestamp(),
      });
    });
  } catch (error) {
    if (error instanceof Error && ['INVALID_AMOUNT', 'INSUFFICIENT_FUNDS', 'UNAUTHORIZED'].includes(error.message)) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, `organizations/${orgId}`);
  }
}

export async function withdrawFromOrgTreasury(
  uid: string,
  username: string,
  orgId: string,
  amountRaw: number
): Promise<void> {
  const amount = Math.floor(amountRaw);
  if (!Number.isFinite(amountRaw) || amount <= 0 || amount > 10_000_000) throw new Error('INVALID_AMOUNT');
  const txId = genId('tx');
  const orgTxId = genId('otx');

  if (import.meta.env.VITE_NEXORA_SUPABASE_ORG_TREASURY === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid !== uid || currentUser.isAnonymous) throw new Error('UNAUTHENTICATED');
    const idToken = await currentUser.getIdToken();
    const response = await fetch('https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy', {
      method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'withdraw_org_treasury', orgId, amount, requestId: crypto.randomUUID() }),
      cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'ORG_TREASURY_OPERATION_FAILED');
    return;
  }
  try {
    await runTransaction(db, async (tx) => {
      const walletRef = doc(db, 'wallets', uid);
      const orgRef = doc(db, 'organizations', orgId);
      const memberRef = doc(db, 'organization_members', `${orgId}_${uid}`);
      const [walletSnap, orgSnap, memberSnap] = await Promise.all([tx.get(walletRef), tx.get(orgRef), tx.get(memberRef)]);
      if (!walletSnap.exists() || !orgSnap.exists()) throw new Error('NOT_FOUND');
      if (!memberSnap.exists() || !hasOrgPermission(memberSnap.data() as OrganizationMember, 'manage_treasury')) {
        throw new Error('UNAUTHORIZED');
      }

      const wallet = walletSnap.data() as Wallet;
      const org = orgSnap.data() as Organization;
      if (org.treasuryBalance < amount) throw new Error('INSUFFICIENT_TREASURY');

      tx.set(doc(db, 'transactions', txId), {
        id: txId,
        fromUid: 'ORG',
        toUid: uid,
        amount,
        fee: 0,
        netAmount: amount,
        type: 'org_withdraw',
        referenceId: orgId,
        description: `Org treasury withdrawal [${org.tag}]`,
        status: 'completed',
        createdAt: serverTimestamp(),
      });

      tx.update(walletRef, {
        balance: wallet.balance + amount,
        totalEarned: wallet.totalEarned + amount,
        lastTxId: txId,
        updatedAt: serverTimestamp(),
      });

      tx.update(orgRef, {
        treasuryBalance: org.treasuryBalance - amount,
        updatedAt: serverTimestamp(),
      });

      tx.set(doc(db, 'organization_transactions', orgTxId), {
        id: orgTxId,
        orgId,
        uid,
        username,
        type: 'withdraw',
        amount,
        note: `Withdrawal by ${username}`,
        createdAt: serverTimestamp(),
      });
    });
  } catch (error) {
    if (error instanceof Error && ['INVALID_AMOUNT', 'INSUFFICIENT_TREASURY', 'UNAUTHORIZED'].includes(error.message)) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, `organizations/${orgId}`);
  }
}

export async function updatePlayerSettings(
  uid: string,
  language: Language,
  notificationsEnabled: boolean
): Promise<void> {
  if (import.meta.env.VITE_NEXORA_SUPABASE_PROFILE === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid !== uid || currentUser.isAnonymous) throw new Error('UNAUTHENTICATED');
    const idToken = await currentUser.getIdToken();
    const response = await fetch('https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy', {
      method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update_player_settings', language, notificationsEnabled }),
      cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'PLAYER_UPDATE_FAILED');
    return;
  }
  try {
    await updateDoc(doc(db, 'users_private', uid), {
      language,
      notificationsEnabled,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `users_private/${uid}`);
  }
}

export async function updatePlayerAvatar(uid: string, avatarId: string): Promise<void> {
  if (import.meta.env.VITE_NEXORA_SUPABASE_PROFILE === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid !== uid || currentUser.isAnonymous) throw new Error('UNAUTHENTICATED');
    const idToken = await currentUser.getIdToken();
    const response = await fetch('https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy', {
      method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update_player_avatar', avatarId }),
      cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'PLAYER_UPDATE_FAILED');
    return;
  }
  try {
    await updateDoc(doc(db, 'profiles', uid), {
      avatarId,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `profiles/${uid}`);
  }
}

export async function markNotificationRead(notifId: string): Promise<void> {
  if (import.meta.env.VITE_NEXORA_SUPABASE_PROFILE === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.isAnonymous) throw new Error('UNAUTHENTICATED');
    const idToken = await currentUser.getIdToken();
    const response = await fetch('https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy', {
      method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'mark_notification_read', notificationId: notifId }),
      cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'PLAYER_UPDATE_FAILED');
    return;
  }
  try {
    await updateDoc(doc(db, 'notifications', notifId), { read: true });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `notifications/${notifId}`);
  }
}

export async function markAllNotificationsRead(notifIds: string[]): Promise<void> {
  if (!notifIds.length) return;
  if (import.meta.env.VITE_NEXORA_SUPABASE_PROFILE === 'true') {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.isAnonymous) throw new Error('UNAUTHENTICATED');
    const idToken = await currentUser.getIdToken();
    const response = await fetch('https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy', {
      method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'mark_notifications_read', notificationIds: notifIds }),
      cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'PLAYER_UPDATE_FAILED');
    return;
  }
  try {
    const batch = writeBatch(db);
    for (const id of notifIds) {
      batch.update(doc(db, 'notifications', id), { read: true });
    }
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, 'notifications');
  }
}

export async function fetchLeaderboards(): Promise<{
  players: PlayerProfile[];
  companies: Company[];
  organizations: Organization[];
}> {
  const [pSnap, cSnap, oSnap] = await Promise.all([
    getDocs(query(collection(db, 'profiles'), where('influence', '>=', 0), orderBy('influence', 'desc'), limit(20))),
    getDocs(query(collection(db, 'companies'), where('totalRevenue', '>=', 0), orderBy('totalRevenue', 'desc'), limit(20))),
    getDocs(query(collection(db, 'organizations'), where('reputation', '>=', 0), orderBy('reputation', 'desc'), limit(20))),
  ]);

  return {
    players: pSnap.docs.map((d) => d.data() as PlayerProfile),
    companies: cSnap.docs.map((d) => d.data() as Company),
    organizations: oSnap.docs.map((d) => d.data() as Organization),
  };
}

export async function checkAndUnlockAchievements(
  uid: string,
  profile: PlayerProfile,
  unlockedIds: Set<string>,
  achievements: {
    id: string;
    metric: 'trades' | 'companies' | 'properties' | 'produced' | 'level' | 'reputation';
    threshold: number;
  }[]
): Promise<string[]> {
  const eligible = achievements.filter((ach) => {
    if (unlockedIds.has(ach.id)) return false;
    return getAchievementProgress(ach.metric, profile) >= ach.threshold;
  });

  if (eligible.length === 0) return [];

  const unlockedNow: string[] = [];
  await Promise.allSettled(
    eligible.map(async (ach) => {
      const docId = `${uid}_${ach.id}`;
      await setDoc(doc(db, 'player_achievements', docId), {
        uid,
        achievementId: ach.id,
        unlockedAt: serverTimestamp(),
      });
      unlockedNow.push(ach.id);
    })
  );
  return unlockedNow;
}

export async function fetchOrgPendingRequests(orgId: string) {
  const q = query(
    collection(db, 'organization_requests'),
    where('orgId', '==', orgId),
    where('status', '==', 'pending')
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data());
}
