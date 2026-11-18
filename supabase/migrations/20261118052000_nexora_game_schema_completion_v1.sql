-- Complete the NEXORA destination schema for fields and collections already used by the game.
-- Additive and isolated to the nexora schema; no public/OneState objects are touched.

alter table nexora.companies
  add column if not exists owner_name text not null default '',
  add column if not exists vault_level integer not null default 1,
  add column if not exists vault_balance numeric not null default 0,
  add column if not exists level_upgrade_started_at bigint,
  add column if not exists level_upgrade_ends_at bigint,
  add column if not exists level_upgrade_target_level integer,
  add column if not exists level_upgrade_cost numeric,
  add column if not exists vault_upgrade_started_at bigint,
  add column if not exists vault_upgrade_ends_at bigint,
  add column if not exists vault_upgrade_target_level integer,
  add column if not exists auction_id text,
  add column if not exists auction_ends_at bigint,
  add column if not exists auction_status text;

alter table nexora.companies
  drop constraint if exists companies_vault_level_check,
  add constraint companies_vault_level_check check (vault_level >= 1 and vault_level <= 25),
  drop constraint if exists companies_vault_balance_check,
  add constraint companies_vault_balance_check check (vault_balance >= 0),
  drop constraint if exists companies_auction_status_check,
  add constraint companies_auction_status_check check (auction_status is null or auction_status = 'active');

alter table nexora.organizations
  add column if not exists member_capacity integer,
  add column if not exists join_mode text not null default 'request',
  add column if not exists research jsonb not null default '{}'::jsonb,
  add column if not exists upgrade_started_at bigint,
  add column if not exists upgrade_ends_at bigint,
  add column if not exists upgrade_target_level integer;

alter table nexora.organizations
  drop constraint if exists organizations_join_mode_check,
  add constraint organizations_join_mode_check check (join_mode in ('open', 'request', 'closed')),
  drop constraint if exists organizations_member_capacity_check,
  add constraint organizations_member_capacity_check check (member_capacity is null or member_capacity >= 1),
  drop constraint if exists organizations_research_object_check,
  add constraint organizations_research_object_check check (jsonb_typeof(research) = 'object');

alter table nexora.world_events
  add column if not exists description_ar text not null default '',
  add column if not exists description_en text not null default '',
  add column if not exists affected_sectors text[] not null default '{}'::text[],
  add column if not exists revenue_multiplier numeric,
  add column if not exists stack_group text;

alter table nexora.world_events
  drop constraint if exists world_events_revenue_multiplier_check,
  add constraint world_events_revenue_multiplier_check check (revenue_multiplier is null or revenue_multiplier > 0);

alter table nexora.transactions
  drop constraint if exists transactions_type_check,
  add constraint transactions_type_check check (
    type = any (array[
      'transfer','market_buy','mission_reward','daily_stipend',
      'company_create','company_upgrade','company_collect','company_vault_upgrade',
      'company_hire','company_auction_bid','company_auction_refund','company_auction_sale',
      'property_buy','property_upgrade','property_collect','manufacturing',
      'org_create','org_deposit','org_withdraw','contract_deal'
    ]::text[])
  );

create table if not exists nexora.usernames (
  username_lower text primary key,
  uid text not null unique,
  username text not null,
  created_at timestamptz not null default now(),
  constraint usernames_username_length_check check (char_length(username) between 3 and 24),
  constraint usernames_lowercase_check check (username_lower = lower(username_lower))
);

create table if not exists nexora.company_auctions (
  id text primary key,
  company_id text not null references nexora.companies(id) on delete restrict,
  company_name text not null,
  company_level integer not null check (company_level >= 1),
  seller_uid text not null,
  seller_name text not null,
  starting_price numeric not null check (starting_price > 0),
  current_bid numeric not null default 0 check (current_bid >= 0),
  highest_bidder_uid text,
  highest_bidder_name text,
  ends_at bigint not null,
  status text not null check (status in ('active','ended_sold','ended_no_bids','ended_refunded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists company_auctions_status_ends_at_idx on nexora.company_auctions(status, ends_at);
create index if not exists company_auctions_seller_uid_idx on nexora.company_auctions(seller_uid);
create unique index if not exists company_auctions_one_active_per_company_idx
  on nexora.company_auctions(company_id) where status = 'active';

alter table nexora.usernames enable row level security;
alter table nexora.company_auctions enable row level security;
revoke all on table nexora.usernames from public, anon, authenticated;
revoke all on table nexora.company_auctions from public, anon, authenticated;
