import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
} from 'firebase/firestore';
import { useCallback, useEffect, useState } from 'react';
import { ACHIEVEMENTS } from '../data/catalog';
import { hasOrgPermission } from '../lib/economy';
import { auth, db, googleAuthProvider, handleFirestoreError, OperationType } from '../lib/firebase';
import {
  checkAndUnlockAchievements,
  ensureBootstrapWorldData,
  getUtcDateKey,
  syncSelfOrgMembership,
} from '../services/gameService';
import type {
  Company,
  CompanyLog,
  GameNotification,
  InventoryItem,
  Language,
  MarketListing,
  MarketOrder,
  Organization,
  OrganizationMember,
  OrganizationRequest,
  OrganizationTransaction,
  PlayerMissionClaim,
  PlayerProfile,
  PropertyAsset,
  TransactionRecord,
  UserPrivate,
  Wallet,
  WorldEvent,
} from '../types/game';

export interface GameDataState {
  authUser: User | null;
  authReady: boolean;
  profile: PlayerProfile | null;
  profileLoading: boolean;
  userPrivate: UserPrivate | null;
  wallet: Wallet | null;
  inventory: InventoryItem[];
  transactions: TransactionRecord[];
  marketListings: MarketListing[];
  marketOrders: MarketOrder[];
  companies: Company[];
  companyLogs: CompanyLog[];
  properties: PropertyAsset[];
  organizations: Organization[];
  myOrgMember: OrganizationMember | null;
  orgMembers: OrganizationMember[];
  orgRequests: OrganizationRequest[];
  orgTransactions: OrganizationTransaction[];
  claimedMissions: PlayerMissionClaim[];
  claimedDailyToday: boolean;
  claimedContractsToday: Set<string>;
  unlockedAchievements: Set<string>;
  notifications: GameNotification[];
  worldEvents: WorldEvent[];
  language: Language;
  setLanguageLocal: (lang: Language) => void;
  loginWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
}

export function useGameData(): GameDataState {
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [userPrivate, setUserPrivate] = useState<UserPrivate | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [marketListings, setMarketListings] = useState<MarketListing[]>([]);
  const [marketOrders, setMarketOrders] = useState<MarketOrder[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyLogs, setCompanyLogs] = useState<CompanyLog[]>([]);
  const [properties, setProperties] = useState<PropertyAsset[]>([]);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [myOrgMember, setMyOrgMember] = useState<OrganizationMember | null>(null);
  const [orgMemberLoaded, setOrgMemberLoaded] = useState(false);
  const [orgMembers, setOrgMembers] = useState<OrganizationMember[]>([]);
  const [orgRequests, setOrgRequests] = useState<OrganizationRequest[]>([]);
  const [orgTransactions, setOrgTransactions] = useState<OrganizationTransaction[]>([]);
  const [claimedMissions, setClaimedMissions] = useState<PlayerMissionClaim[]>([]);
  const [claimedDailyToday, setClaimedDailyToday] = useState(false);
  const [claimedContractsToday, setClaimedContractsToday] = useState<Set<string>>(new Set());
  const [unlockedAchievements, setUnlockedAchievements] = useState<Set<string>>(new Set());
  const [notifications, setNotifications] = useState<GameNotification[]>([]);
  const [worldEvents, setWorldEvents] = useState<WorldEvent[]>([]);
  const [language, setLanguage] = useState<Language>('ar');

  const setLanguageLocal = useCallback((lang: Language) => {
    setLanguage(lang);
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
  }, [language]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      setAuthUser(user);
      setAuthReady(true);
      if (!user) {
        setProfile(null);
        setProfileLoading(false);
        setUserPrivate(null);
        setWallet(null);
        setInventory([]);
        setTransactions([]);
        setCompanies([]);
        setProperties([]);
        setMyOrgMember(null);
        setOrgMemberLoaded(false);
        setNotifications([]);
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!authUser) return;
    setProfileLoading(true);
    setOrgMemberLoaded(false);
    ensureBootstrapWorldData();

    const uid = authUser.uid;
    const unsubs: (() => void)[] = [];

    const onSnapErr = (path: string) => (error: unknown) => {
      try {
        handleFirestoreError(error, OperationType.GET, path);
      } catch {
        // Error already logged cleanly via handleFirestoreError
      }
    };

    unsubs.push(
      onSnapshot(
        doc(db, 'profiles', uid),
        (snap) => {
          setProfile(snap.exists() ? (snap.data() as PlayerProfile) : null);
          setProfileLoading(false);
        },
        (err) => {
          setProfileLoading(false);
          onSnapErr(`profiles/${uid}`)(err);
        }
      )
    );

    unsubs.push(
      onSnapshot(
        doc(db, 'users_private', uid),
        (snap) => {
          if (snap.exists()) {
            const data = snap.data() as UserPrivate;
            setUserPrivate(data);
            setLanguageLocal(data.language);
          }
        },
        onSnapErr(`users_private/${uid}`)
      )
    );

    unsubs.push(
      onSnapshot(
        doc(db, 'wallets', uid),
        (snap) => {
          setWallet(snap.exists() ? (snap.data() as Wallet) : null);
        },
        onSnapErr(`wallets/${uid}`)
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'inventory'), where('uid', '==', uid)),
        (snap) => {
          setInventory(snap.docs.map((d) => d.data() as InventoryItem));
        },
        onSnapErr('inventory')
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'transactions'), where('fromUid', '==', uid), limit(30)),
        (fromSnap) => {
          const sent = fromSnap.docs.map((d) => d.data() as TransactionRecord);
          setTransactions((prev) => {
            const receivedOnly = prev.filter((t) => t.toUid === uid && t.fromUid !== uid);
            return [...sent, ...receivedOnly].slice(0, 40);
          });
        },
        onSnapErr('transactions/fromUid')
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'transactions'), where('toUid', '==', uid), limit(30)),
        (toSnap) => {
          const received = toSnap.docs.map((d) => d.data() as TransactionRecord);
          setTransactions((prev) => {
            const sentOnly = prev.filter((t) => t.fromUid === uid);
            const map = new Map<string, TransactionRecord>();
            [...sentOnly, ...received].forEach((t) => map.set(t.id, t));
            return Array.from(map.values()).slice(0, 40);
          });
        },
        onSnapErr('transactions/toUid')
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'market_listings'), where('status', '==', 'active'), limit(100)),
        (snap) => {
          setMarketListings(snap.docs.map((d) => d.data() as MarketListing));
        },
        onSnapErr('market_listings')
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'market_orders'), where('buyerUid', '==', uid), limit(25)),
        (snap) => {
          setMarketOrders(snap.docs.map((d) => d.data() as MarketOrder));
        },
        onSnapErr('market_orders')
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'companies'), where('ownerUid', '==', uid)),
        (snap) => {
          setCompanies(snap.docs.map((d) => d.data() as Company));
        },
        onSnapErr('companies')
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'company_logs'), where('ownerUid', '==', uid), limit(25)),
        (snap) => {
          setCompanyLogs(snap.docs.map((d) => d.data() as CompanyLog));
        },
        onSnapErr('company_logs')
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'properties'), where('ownerUid', '==', uid)),
        (snap) => {
          setProperties(snap.docs.map((d) => d.data() as PropertyAsset));
        },
        onSnapErr('properties')
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'organizations'), where('reputation', '>=', 0), orderBy('reputation', 'desc'), limit(40)),
        (snap) => {
          setOrganizations(snap.docs.map((d) => d.data() as Organization));
        },
        onSnapErr('organizations')
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'organization_members'), where('uid', '==', uid), limit(1)),
        (snap) => {
          const member = snap.docs[0]?.data() as OrganizationMember | undefined;
          setMyOrgMember(member ?? null);
          setOrgMemberLoaded(true);
        },
        (err) => {
          setOrgMemberLoaded(true);
          onSnapErr('organization_members/self')(err);
        }
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'player_missions'), where('uid', '==', uid)),
        (snap) => {
          setClaimedMissions(snap.docs.map((d) => d.data() as PlayerMissionClaim));
        },
        onSnapErr('player_missions')
      )
    );

    const todayKey = getUtcDateKey();
    unsubs.push(
      onSnapshot(
        doc(db, 'daily_claims', `${uid}_${todayKey}`),
        (snap) => {
          setClaimedDailyToday(snap.exists());
        },
        onSnapErr(`daily_claims/${uid}_${todayKey}`)
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'contract_claims'), where('uid', '==', uid)),
        (snap) => {
          const ids = new Set<string>();
          snap.docs.forEach((d) => {
            const c = d.data() as { contractId: string };
            ids.add(c.contractId);
          });
          setClaimedContractsToday(ids);
        },
        onSnapErr('contract_claims')
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'player_achievements'), where('uid', '==', uid)),
        (snap) => {
          const ids = new Set<string>();
          snap.docs.forEach((d) => {
            const data = d.data() as { achievementId: string };
            ids.add(data.achievementId);
          });
          setUnlockedAchievements(ids);
        },
        onSnapErr('player_achievements')
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'notifications'), where('uid', '==', uid), limit(30)),
        (snap) => {
          setNotifications(snap.docs.map((d) => d.data() as GameNotification));
        },
        onSnapErr('notifications')
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'world_events'), where('active', '==', true)),
        (snap) => {
          setWorldEvents(snap.docs.map((d) => d.data() as WorldEvent));
        },
        onSnapErr('world_events')
      )
    );

    return () => {
      unsubs.forEach((fn) => fn());
    };
  }, [authUser, setLanguageLocal]);

  // Sync organization membership onto profile if approved while away
  useEffect(() => {
    if (!authUser || !profile || !orgMemberLoaded) return;
    if (myOrgMember && profile.orgId !== myOrgMember.orgId) {
      syncSelfOrgMembership(authUser.uid, myOrgMember.orgId);
    } else if (!myOrgMember && profile.orgId) {
      syncSelfOrgMembership(authUser.uid, null);
    }
  }, [authUser, profile, myOrgMember, orgMemberLoaded]);

  // Subscribe to current organization's members, requests, and treasury ledger
  useEffect(() => {
    if (!authUser || !myOrgMember?.orgId) {
      setOrgMembers([]);
      setOrgRequests([]);
      setOrgTransactions([]);
      return;
    }

    const onOrgErr = (path: string) => (error: unknown) => {
      try {
        handleFirestoreError(error, OperationType.GET, path);
      } catch {
        // Logged via handleFirestoreError
      }
    };

    const orgId = myOrgMember.orgId;
    const canManageMembers = hasOrgPermission(myOrgMember, 'manage_members');

    const u1 = onSnapshot(
      query(collection(db, 'organization_members'), where('orgId', '==', orgId)),
      (snap) => {
        setOrgMembers(snap.docs.map((d) => d.data() as OrganizationMember));
      },
      onOrgErr(`organization_members/${orgId}`)
    );

    const u2 = canManageMembers
      ? onSnapshot(
          query(
            collection(db, 'organization_requests'),
            where('orgId', '==', orgId),
            where('status', '==', 'pending')
          ),
          (snap) => {
            setOrgRequests(snap.docs.map((d) => d.data() as OrganizationRequest));
          },
          onOrgErr(`organization_requests/${orgId}`)
        )
      : (() => {
          setOrgRequests([]);
          return () => {};
        })();

    const u3 = onSnapshot(
      query(collection(db, 'organization_transactions'), where('orgId', '==', orgId), limit(30)),
      (snap) => {
        setOrgTransactions(snap.docs.map((d) => d.data() as OrganizationTransaction));
      },
      onOrgErr(`organization_transactions/${orgId}`)
    );

    return () => {
      u1();
      u2();
      u3();
    };
  }, [authUser, myOrgMember]);

  // Auto-unlock eligible achievements
  useEffect(() => {
    if (!authUser || !profile) return;
    checkAndUnlockAchievements(authUser.uid, profile, unlockedAchievements, ACHIEVEMENTS);
  }, [authUser, profile, unlockedAchievements]);

  const loginWithGoogle = useCallback(async () => {
    await signInWithPopup(auth, googleAuthProvider);
  }, []);

  const logout = useCallback(async () => {
    await signOut(auth);
  }, []);

  return {
    authUser,
    authReady,
    profile,
    profileLoading,
    userPrivate,
    wallet,
    inventory,
    transactions,
    marketListings,
    marketOrders,
    companies,
    companyLogs,
    properties,
    organizations,
    myOrgMember,
    orgMembers,
    orgRequests,
    orgTransactions,
    claimedMissions,
    claimedDailyToday,
    claimedContractsToday,
    unlockedAchievements,
    notifications,
    worldEvents,
    language,
    setLanguageLocal,
    loginWithGoogle,
    logout,
  };
}
