create table if not exists nexora.user_identity_map (
  supabase_user_id uuid primary key references auth.users(id) on delete restrict,
  firebase_uid text not null unique,
  link_method text not null,
  verified_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint user_identity_map_firebase_uid_check
    check (char_length(firebase_uid) between 1 and 128),
  constraint user_identity_map_link_method_check
    check (link_method in ('firebase_id_token', 'admin_verified_recovery'))
);

create index if not exists user_identity_map_firebase_uid_idx
  on nexora.user_identity_map(firebase_uid);

alter table nexora.user_identity_map enable row level security;
revoke all on table nexora.user_identity_map from public, anon, authenticated;
