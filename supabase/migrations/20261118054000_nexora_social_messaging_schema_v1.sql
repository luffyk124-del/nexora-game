-- Social and messaging collections used by trusted Firebase Functions.
-- Isolated to nexora; no public schema changes.

create table if not exists nexora.user_blocks (
  id text primary key,
  owner_uid text not null,
  target_uid text not null,
  created_at timestamptz,
  constraint user_blocks_distinct_users check (owner_uid <> target_uid)
);
create index if not exists user_blocks_owner_idx on nexora.user_blocks(owner_uid);
create index if not exists user_blocks_target_idx on nexora.user_blocks(target_uid);

create table if not exists nexora.chat_rate_limits (
  id text primary key,
  last_sent_at timestamptz
);

create table if not exists nexora.conversations (
  id text primary key,
  participants text[] not null default '{}'::text[],
  participant_names jsonb not null default '{}'::jsonb,
  participant_avatars jsonb not null default '{}'::jsonb,
  last_message text not null default '',
  last_message_at timestamptz,
  last_sender_uid text not null default '',
  created_at timestamptz,
  updated_at timestamptz,
  constraint conversations_participants_count check (cardinality(participants) = 2),
  constraint conversations_names_object check (jsonb_typeof(participant_names) = 'object'),
  constraint conversations_avatars_object check (jsonb_typeof(participant_avatars) = 'object')
);
create index if not exists conversations_participants_gin_idx on nexora.conversations using gin(participants);
create index if not exists conversations_last_message_at_idx on nexora.conversations(last_message_at desc);

create table if not exists nexora.conversation_messages (
  id text primary key,
  conversation_id text not null references nexora.conversations(id) on delete cascade,
  sender_uid text not null,
  sender_name text not null default 'Player',
  message_text text not null,
  created_at timestamptz
);
create index if not exists conversation_messages_conversation_created_idx
  on nexora.conversation_messages(conversation_id, created_at desc);

create table if not exists nexora.global_chat_messages (
  id text primary key,
  sender_uid text not null,
  sender_name text not null default 'Player',
  avatar_id text not null default 'default',
  message_text text not null,
  created_at timestamptz
);
create index if not exists global_chat_messages_created_idx on nexora.global_chat_messages(created_at desc);

create table if not exists nexora.organization_invites (
  id text primary key,
  org_id text not null,
  org_name text not null default '',
  org_tag text not null default '',
  target_uid text not null,
  inviter_uid text not null,
  inviter_name text not null default 'Player',
  status text not null check (status in ('pending','accepted','rejected','cancelled')),
  created_at timestamptz,
  responded_at timestamptz
);
create index if not exists organization_invites_target_status_idx
  on nexora.organization_invites(target_uid, status);

alter table nexora.user_blocks enable row level security;
alter table nexora.chat_rate_limits enable row level security;
alter table nexora.conversations enable row level security;
alter table nexora.conversation_messages enable row level security;
alter table nexora.global_chat_messages enable row level security;
alter table nexora.organization_invites enable row level security;

revoke all on table nexora.user_blocks, nexora.chat_rate_limits, nexora.conversations,
  nexora.conversation_messages, nexora.global_chat_messages, nexora.organization_invites
from public, anon, authenticated;
