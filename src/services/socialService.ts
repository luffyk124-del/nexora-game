import { auth } from '../lib/firebase';

const ECONOMY_URL = 'https://dmeupqmhsyojxlgalxrc.supabase.co/functions/v1/nexora-economy';

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
  socialRequest<PublicPlayer>('get_public_player_profile', { targetUid });
export const searchPlayers = async (prefix: string) =>
  (await socialRequest<{ players: PublicPlayer[] }>('search_players', { prefix })).players;
export const listBlockedPlayers = async () =>
  (await socialRequest<{ blockedUids: string[] }>('list_blocked_players')).blockedUids;
export const listDirectConversations = async () =>
  (await socialRequest<{ conversations: SocialConversation[] }>('list_direct_conversations')).conversations;
export const listDirectMessages = async (conversationId: string) =>
  (await socialRequest<{ messages: SocialDirectMessage[] }>('list_direct_messages', { conversationId })).messages;
export const listGlobalChatMessages = async () =>
  (await socialRequest<{ messages: SocialGlobalMessage[] }>('list_global_chat_messages')).messages;
export const listOrganizationInvites = async () =>
  (await socialRequest<{ invites: SocialOrgInvite[] }>('list_organization_invites')).invites;

export const openDirectConversation = (targetUid: string) =>
  socialRequest<{ conversationId: string }>('open_direct_conversation', { targetUid });
export const sendDirectMessage = (targetUid: string, text: string) =>
  socialRequest<{ ok: boolean }>('send_direct_message', { targetUid, text, requestId: crypto.randomUUID() });
export const sendGlobalChatMessage = (text: string) =>
  socialRequest<{ ok: boolean }>('send_global_chat_message', { text, requestId: crypto.randomUUID() });
export const blockPlayer = (targetUid: string) =>
  socialRequest<{ ok: boolean }>('block_player', { targetUid });
export const unblockPlayer = (targetUid: string) =>
  socialRequest<{ ok: boolean }>('unblock_player', { targetUid });
export const reportPlayer = (targetUid: string, reason: string) =>
  socialRequest<{ ok: boolean }>('submit_player_report', { targetUid, reason, requestId: crypto.randomUUID() });
export const invitePlayerToOrganization = (targetUid: string) =>
  socialRequest<{ ok: boolean }>('invite_player_to_organization', { targetUid });
export const respondOrganizationInvite = (inviteId: string, response: 'accept' | 'decline') =>
  socialRequest<{ ok: boolean; status: string }>('respond_organization_invite', { inviteId, response });
