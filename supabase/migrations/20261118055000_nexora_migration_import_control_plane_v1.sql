create table if not exists nexora.migration_operators (
  firebase_uid text primary key,
  enabled boolean not null default false,
  role text not null default 'owner',
  created_at timestamptz not null default now(),
  enabled_at timestamptz,
  constraint migration_operators_uid_length check (char_length(firebase_uid) between 1 and 128),
  constraint migration_operators_owner_role check (role = 'owner')
);
create table if not exists nexora.migration_batches (
  id uuid primary key default gen_random_uuid(),
  source_collection text not null,
  source_parent_id text not null default '',
  row_count integer not null check (row_count >= 0 and row_count <= 100),
  checksum text not null,
  imported_at timestamptz not null default now(),
  imported_by_firebase_uid text not null,
  constraint migration_batches_checksum_length check (char_length(checksum) between 32 and 128)
);
create unique index if not exists migration_batches_idempotency_idx
  on nexora.migration_batches(source_collection, source_parent_id, checksum);
create index if not exists migration_batches_collection_imported_idx
  on nexora.migration_batches(source_collection, imported_at desc);
create table if not exists nexora.firestore_import_payloads (
  source_collection text not null,
  source_parent_id text not null default '',
  source_document_id text not null,
  source_path text not null,
  raw_fields jsonb not null,
  imported_at timestamptz not null default now(),
  primary key (source_collection, source_parent_id, source_document_id)
);
alter table nexora.migration_operators enable row level security;
alter table nexora.migration_batches enable row level security;
alter table nexora.firestore_import_payloads enable row level security;
revoke all on table nexora.migration_operators, nexora.migration_batches,
  nexora.firestore_import_payloads from public, anon, authenticated;
