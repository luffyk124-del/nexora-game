import { auth, db, functions } from '../lib/firebase';
import { httpsCallable } from 'firebase/functions';
import { collection, getDocs, limit, orderBy, query, where } from 'firebase/firestore';

const ECONOMY_URL = 'https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy';
const useSupabaseSocial = () => import.meta.env.VITE_NEXORA_SUPABASE_SOCIAL === 'true';

async function firebaseCallable<T>(name: string, payload: Record<string, unknown> = {}): Promise<T> {
  const callable = httpsCallable<Record<string, unknown>, T>(functions, name);
  const result = await callable(payload);
  return result.data;
}

async function socialRequest<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const user = auth.currentUser;
  if (!user || user.isAnonymous) throw new Error('UNAUTHENTICATED');
  const token = await user.getIdToken();
  const response = await fetch(ECONOMY_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
    cache: 'no-store',
  });
  const result = await response.json().catch(() => ({})) as { error?: unknown };
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'SOCIAL_OPERATION_FAILED');
  return result as T;
}

export type PublicPlayer = {
  uid: string;
  username: string;
  avatarId: string;
  title: string;
  level: number;
  reputation: number;
  influence: number;
  orgId: string | null;
};
export type SocialConversation = {
  id: string;
  participants: string[];
  participantNames: Record<string, string>;
  participantAvatars?: Record<string, string>;
  lastMessage: string;
  lastMessageAt: unknown;
  lastSenderUid: string;
};
export type SocialDirectMessage = {
  id: string;
  senderUid: string;
  senderName: string;
  text: string;
  createdAt: unknown;
};
export type SocialGlobalMessage = {
  id: string;
  senderUid: string;
  senderName: string;
  avatarId: string;
  text: string;
  createdAt: unknown;
};
export type SocialOrgInvite = {
  id: string;
  orgId: string;
  orgName: string;
  orgTag: string;
  inviterName: string;
  status: string;
  targetUid: string;
};

export const getPublicPlayerProfile = (targetUid: string) =>
  useSupabaseSocial()
    ? socialRequest<PublicPlayer>('get_public_player_profile', { targetUid })
    : firebaseCallable<PublicPlayer>('getPublicPlayerProfileSecure', { targetUid });
export const searchPlayers = async (prefix: string) =>
  useSupabaseSocial()
    ? (await socialRequest<{ players: PublicPlayer[] }>('search_players', { prefix })).players
    : (await firebaseCallable<{ players: PublicPlayer[] }>('searchPlayersSecure', { prefix })).players;
export const listBlockedPlayers = async () =>
  useSupabaseSocial()
    ? (await socialRequest<{ blockedUids: string[] }>('list_blocked_players')).blockedUids
    : (await firebaseCallable<{ blockedUids: string[] }>('listBlockedPlayersSecure')).blockedUids;
export const listDirectConversations = async () => {
  if (useSupabaseSocial()) return (await socialRequest<{ conversations: SocialConversation[] }>('list_direct_conversations')).conversations;
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('UNAUTHENTICATED');
  const snap = await getDocs(query(collection(db, 'conversations'), where('participants', 'array-contains', uid), limit(50)));
  return snap.docs.map((item) => item.data() as SocialConversation);
};
export const listDirectMessages = async (conversationId: string) => {
  if (useSupabaseSocial()) return (await socialRequest<{ messages: SocialDirectMessage[] }>('list_direct_messages', { conversationId })).messages;
  const snap = await getDocs(query(collection(db, 'conversations', conversationId, 'messages'), orderBy('createdAt', 'desc'), limit(80)));
  return snap.docs.map((item) => item.data() as SocialDirectMessage).reverse();
};
export const listGlobalChatMessages = async () => {
  if (useSupabaseSocial()) return (await socialRequest<{ messages: SocialGlobalMessage[] }>('list_global_chat_messages')).messages;
  const snap = await getDocs(query(collection(db, 'global_chat_messages'), orderBy('createdAt', 'desc'), limit(60)));
  return snap.docs.map((item) => item.data() as SocialGlobalMessage).reverse();
};
export const listOrganizationInvites = async () => {
  if (useSupabaseSocial()) return (await socialRequest<{ invites: SocialOrgInvite[] }>('list_organization_invites')).invites;
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('UNAUTHENTICATED');
  const snap = await getDocs(query(collection(db, 'organization_invites'), where('targetUid', '==', uid), limit(20)));
  return snap.docs.map((item) => item.data() as SocialOrgInvite).filter((item) => item.status === 'pending');
};

export const openDirectConversation = (targetUid: string) =>
  useSupabaseSocial()
    ? socialRequest<{ conversationId: string }>('open_direct_conversation', { targetUid })
    : firebaseCallable<{ conversationId: string }>('openDirectConversationSecure', { targetUid });
export const sendDirectMessage = (targetUid: string, text: string) =>
  useSupabaseSocial()
    ? socialRequest<{ ok: boolean }>('send_direct_message', { targetUid, text, requestId: crypto.randomUUID() })
    : firebaseCallable<{ ok: boolean }>('sendDirectMessageSecure', { targetUid, text });
export const sendGlobalChatMessage = (text: string) =>
  useSupabaseSocial()
    ? socialRequest<{ ok: boolean }>('send_global_chat_message', { text, requestId: crypto.randomUUID() })
    : firebaseCallable<{ ok: boolean }>('sendGlobalChatMessageSecure', { text });
export const blockPlayer = (targetUid: string) =>
  useSupabaseSocial()
    ? socialRequest<{ ok: boolean }>('block_player', { targetUid })
    : firebaseCallable<{ ok: boolean }>('blockPlayerSecure', { targetUid });
export const unblockPlayer = (targetUid: string) =>
  useSupabaseSocial()
    ? socialRequest<{ ok: boolean }>('unblock_player', { targetUid })
    : firebaseCallable<{ ok: boolean }>('unblockPlayerSecure', { targetUid });
export const reportPlayer = (targetUid: string, reason: string) =>
  useSupabaseSocial()
    ? socialRequest<{ ok: boolean }>('submit_player_report', { targetUid, reason, requestId: crypto.randomUUID() })
    : firebaseCallable<{ ok: boolean }>('reportPlayerSecure', { targetUid, reason });
export const invitePlayerToOrganization = (targetUid: string) =>
  useSupabaseSocial()
    ? socialRequest<{ ok: boolean }>('invite_player_to_organization', { targetUid })
    : firebaseCallable<{ ok: boolean }>('invitePlayerToOrganizationSecure', { targetUid });
export const respondOrganizationInvite = (inviteId: string, response: 'accept' | 'decline') =>
  useSupabaseSocial()
    ? socialRequest<{ ok: boolean; status: string }>('respond_organization_invite', { inviteId, response })
    : firebaseCallable<{ ok: boolean; status: string }>('respondOrganizationInviteSecure', { inviteId, response });
