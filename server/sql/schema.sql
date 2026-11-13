-- ════════════════════════════════════════════════════════════════════
-- TiVBook — database schema (Supabase / PostgreSQL)
-- Applied automatically by the TiVBook Staff setup wizard.
-- Safe to re-run: every statement is idempotent.
--
-- Security model:
--   • Apps READ through Row Level Security policies below (live via Realtime).
--   • Apps never write directly: there are no insert/update/delete policies.
--     Every write goes through the `api` server function, which checks roles,
--     approved devices and business rules inside database transactions.
-- ════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ───────── helpers: who is calling (from the login token) ─────────
create or replace function public.tv_role() returns text language sql stable as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', 'anon')
$$;
create or replace function public.tv_player() returns text language sql stable as $$
  select auth.jwt() -> 'app_metadata' ->> 'player_id'
$$;
create or replace function public.tv_is_staff() returns boolean language sql stable as $$
  select public.tv_role() in ('super_admin','manager','tournament_director','cashier','floor_supervisor','dealer','front_desk')
$$;
create or replace function public.tv_has_role(roles text[]) returns boolean language sql stable as $$
  select public.tv_role() = any(roles)
$$;

-- ───────── system ─────────
create table if not exists counters (name text primary key, value bigint not null);
insert into counters(name, value) values ('player_seq', 1) on conflict do nothing;

create table if not exists settings (key text primary key, value jsonb not null, updated_at timestamptz not null default now());
insert into settings(key, value) values
  ('booking_calendar', '{"weekStartWeekday":1,"openWeekday":0,"openTime":"10:00","closedDates":[],"openingOverrides":{}}'),
  ('waiting_list', '{"policy":"fifo","offerMinutes":5}'),
  ('eligibility', '{"minimumAge":18}'),
  ('payout_limits', '{"dailyCashCapCents":50000000}')
on conflict do nothing;

-- WhatsApp / push credentials entered in the staff software (server only — no app can read them).
create table if not exists integration_settings (key text primary key, value text not null, updated_by uuid, updated_at timestamptz not null default now());

create table if not exists idempotency (key text primary key, result jsonb not null, by_user uuid, created_at timestamptz not null default now());

create table if not exists audit_logs (
  id bigserial primary key, actor text not null, action text not null, entity text not null,
  authorizer text, before jsonb, after jsonb, device_id text, at timestamptz not null default now()
);
create index if not exists audit_logs_at on audit_logs(at desc);

-- ───────── staff ─────────
create table if not exists staff (
  user_id uuid primary key, email text not null unique, display_name text not null,
  role text not null check (role in ('super_admin','manager','tournament_director','cashier','floor_supervisor','dealer','front_desk')),
  active boolean not null default true, must_change_password boolean not null default true,
  created_by text, created_at timestamptz not null default now(), password_changed_at timestamptz
);
create table if not exists staff_devices (
  device_id text primary key check (device_id ~ '^[A-Za-z0-9_-]{16,64}$'), name text not null default '', platform text not null default '',
  status text not null check (status in ('pending','approved','revoked')),
  requested_by uuid, requested_at timestamptz not null default now(),
  approved_by uuid, approved_at timestamptz, revoked_by uuid, revoked_at timestamptz
);

-- ───────── players ─────────
create table if not exists players (
  player_id text primary key check (player_id ~ '^[0-9]{3,}$'),
  seq bigint not null unique,
  surname text not null, first_names text not null,
  phone_e164 text not null unique, phone_verified_at timestamptz,
  address text not null default '', country_of_residence text not null default '', nationality text not null default '',
  date_of_birth date not null,
  id_doc_type text not null check (id_doc_type in ('national_id','passport')),
  id_doc_number_hash text not null unique,
  id_images text[] not null default '{}',
  status text not null default 'active' check (status in ('active','suspended')),
  kyc_status text not null default 'unverified' check (kyc_status in ('unverified','verified','rejected')),
  kyc_reason text, kyc_by uuid, kyc_at timestamptz,
  language text not null default 'en',
  search_tokens text[] not null default '{}',
  auth_user_id uuid unique,
  terms_accepted_at timestamptz not null default now(),
  created_at timestamptz not null default now(), created_by text, source text
);
create index if not exists players_search on players using gin(search_tokens);

-- Identity numbers: never visible to the player app; selected staff only.
create table if not exists player_identity (
  player_id text primary key references players on delete cascade,
  id_doc_type text not null, id_doc_number text not null,
  verified_by uuid, verified_at timestamptz, status text
);

create table if not exists identity_documents (
  id uuid primary key default gen_random_uuid(),
  player_id text not null references players on delete cascade,
  kind text not null check (kind in ('id_front','id_back','passport')),
  storage_path text not null, content_type text not null, size_bytes int not null,
  uploaded_by text not null, uploaded_at timestamptz not null default now(), replaced_by uuid
);
create index if not exists identity_documents_player on identity_documents(player_id) where replaced_by is null;

create table if not exists player_devices (
  token text primary key, player_id text not null references players on delete cascade,
  platform text not null default '', updated_at timestamptz not null default now()
);

-- Login account behind each verified phone (server only).
create table if not exists player_auth (phone_e164 text primary key, user_id uuid not null unique, created_at timestamptz not null default now());

-- WhatsApp OTP (server only)
create table if not exists otp_challenges (
  phone_hash text primary key, code_hash text not null, created_at bigint not null, expires_at bigint not null,
  attempts int not null default 0, consumed boolean not null default false, sends bigint[] not null default '{}'
);
create table if not exists otp_ip (ip_hash text primary key, sends bigint[] not null default '{}');
-- "Code from the cashier": when WhatsApp is not set up, staff read the code to the player in person.
alter table otp_challenges add column if not exists delivery text not null default 'whatsapp';
alter table otp_challenges add column if not exists desk_phone text;
alter table otp_challenges add column if not exists desk_code text;

-- ───────── cash games ─────────
create table if not exists cash_tables (
  table_id text primary key, name text not null, game_type text not null default 'NLH',
  small_blind_cents bigint not null default 0, big_blind_cents bigint not null default 0,
  min_buy_in_cents bigint not null, max_buy_in_cents bigint not null, default_capacity int not null default 9,
  active boolean not null default true
);
create table if not exists table_days (
  id text primary key, table_id text not null references cash_tables, table_name text not null,
  date date not null, status text not null default 'open' check (status in ('open','closed')),
  capacity int not null default 9 check (capacity between 1 and 12),
  active_count int not null default 0 check (active_count >= 0),
  held_count int not null default 0 check (held_count >= 0),
  waiting_count int not null default 0 check (waiting_count >= 0),
  cutoff_at timestamptz not null,
  waiting_policy text, offer_minutes numeric, last_served_type text,
  unique (table_id, date),
  check (active_count + held_count <= capacity)  -- overbooking is impossible at database level
);
create table if not exists cash_reservations (
  id uuid primary key default gen_random_uuid(),
  player_id text not null references players, table_day_id text not null references table_days,
  table_id text not null, date date not null,
  status text not null check (status in ('reserved','checked_in','seated','cancelled','expired','no_show','left')),
  cutoff_at timestamptz not null, source text not null, offer_id uuid,
  created_at timestamptz not null default now(), created_by text, released_at timestamptz, released_by text
);
-- One active reservation per player per date — enforced by the database.
create unique index if not exists one_reservation_per_date on cash_reservations(player_id, date)
  where status in ('reserved','checked_in','seated');
create index if not exists reservations_cutoff on cash_reservations(cutoff_at) where status = 'reserved';

create table if not exists waiting_lists (
  id uuid primary key default gen_random_uuid(),
  table_day_id text not null references table_days, player_id text not null references players,
  list_type text not null check (list_type in ('new_player','movement')),
  movement_request_id uuid, requested_at timestamptz not null default now(),
  status text not null check (status in ('waiting','offered','accepted','declined','expired','skipped','cancelled','fulfilled')),
  priority_override int, current_offer_id uuid
);
create unique index if not exists one_waiting_entry on waiting_lists(table_day_id, player_id) where status in ('waiting','offered');

create table if not exists waiting_offers (
  id uuid primary key default gen_random_uuid(),
  waiting_entry_id uuid not null references waiting_lists, table_day_id text not null references table_days,
  player_id text not null references players, list_type text not null,
  status text not null check (status in ('pending','accepted','declined','expired','cancelled')),
  created_at timestamptz not null, expires_at timestamptz not null, responded_at timestamptz,
  notifications jsonb not null default '[]'
);
create index if not exists offers_due on waiting_offers(expires_at) where status = 'pending';

create table if not exists table_movement_requests (
  id uuid primary key default gen_random_uuid(), player_id text not null references players,
  status text not null, offer_id uuid, history jsonb not null default '[]', created_at timestamptz not null default now()
);

-- ───────── tournaments ─────────
create table if not exists festivals (id text primary key, name text not null, description text, start_date date, end_date date);
create table if not exists tournaments (
  id text primary key, festival_id text references festivals, name text not null,
  config jsonb not null,  -- buy-in, chips, re-entry, rebuy, add-on, bonus, late-reg… (see core/tournament.ts)
  status text not null default 'scheduled',
  preregistered int not null default 0, paid int not null default 0, unique_players int not null default 0,
  total_entries int not null default 0, reentries int not null default 0, rebuys int not null default 0,
  addons int not null default 0, bonuses int not null default 0, entered int not null default 0,
  pending_chip_deliveries int not null default 0, chip_deliveries int not null default 0,
  revenue_cents bigint not null default 0
);
create table if not exists tournament_players (
  tournament_id text references tournaments, player_id text references players,
  paid_entries int not null default 0, rebuys int not null default 0, addons int not null default 0,
  has_active_entry boolean not null default false, has_undelivered_entry boolean not null default false,
  current_entry_id uuid, primary key (tournament_id, player_id)
);
create table if not exists tournament_preregistrations (
  id uuid primary key default gen_random_uuid(), tournament_id text not null references tournaments,
  player_id text not null references players, status text not null default 'preregistered',
  options jsonb not null default '{}', entry_id uuid, created_at timestamptz not null default now()
);
create table if not exists tournament_entries (
  id uuid primary key default gen_random_uuid(), tournament_id text not null references tournaments,
  player_id text not null references players, entry_number int not null,
  status text not null check (status in ('payment_pending','paid','awaiting_chips','entered','cancelled','refunded')),
  preregistration_id uuid, paid_at timestamptz, cashier_id uuid, entered_at timestamptz
);
create table if not exists entitlements (
  id uuid primary key default gen_random_uuid(), entry_id uuid not null references tournament_entries,
  tournament_id text not null, player_id text not null,
  kind text not null check (kind in ('buy_in','reentry','rebuy','addon','bonus')),
  price_cents bigint not null, chips int not null, payment_txn_id uuid not null, ticket_id text not null
);
create table if not exists tickets (
  id text primary key, entitlement_id uuid not null unique references entitlements,
  entry_id uuid not null, tournament_id text not null, player_id text not null,
  kind text not null, chips int not null, token_hash text not null,
  status text not null default 'valid' check (status in ('valid','used','void')),
  paid boolean not null, printed_count int not null default 0, created_at timestamptz not null default now()
);
-- Primary key = entitlement: chips can physically only be delivered once per paid item.
create table if not exists chip_deliveries (
  entitlement_id uuid primary key references entitlements, ticket_id text not null,
  chips int not null, scanned_by uuid not null, device_id text, scanned_at timestamptz not null default now()
);

-- ───────── money ─────────
create table if not exists cashier_shifts (
  id uuid primary key default gen_random_uuid(), cashier_id uuid not null, station_id text,
  status text not null check (status in ('open','closed')), opened_at timestamptz not null default now(),
  opening_float_cents bigint not null default 0, closed_at timestamptz,
  declared_cents bigint, expected_cents bigint, variance_cents bigint
);
create unique index if not exists one_open_shift on cashier_shifts(cashier_id) where status = 'open';

create table if not exists ledger (
  id uuid primary key default gen_random_uuid(),
  player_id text not null references players, type text not null,
  amount_cents bigint not null check (amount_cents > 0),
  direction text not null check (direction in ('in','out','non_cash')),
  currency text not null default 'MUR', method text not null,
  ref jsonb not null default '{}', cashier_id uuid, station_id text, shift_id uuid references cashier_shifts,
  status text not null default 'completed', idempotency_key text unique,
  reverses_txn_id uuid references ledger, reversed_by_txn_id uuid references ledger,
  auth_ref text, notes text, created_at timestamptz not null default now()
);
create index if not exists ledger_player on ledger(player_id, created_at desc);
create index if not exists ledger_shift on ledger(shift_id, created_at);

-- Completed financial records can never be edited or deleted (only linked to a reversal).
create or replace function ledger_append_only() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'Ledger entries cannot be deleted'; end if;
  if (to_jsonb(new) - 'reversed_by_txn_id') is distinct from (to_jsonb(old) - 'reversed_by_txn_id')
     or old.reversed_by_txn_id is not null then
    raise exception 'Ledger entries cannot be changed';
  end if;
  return new;
end $$;
drop trigger if exists ledger_append_only on ledger;
create trigger ledger_append_only before update or delete on ledger for each row execute function ledger_append_only();

-- ════════ Row Level Security (read access) ════════
do $$
declare t text;
begin
  foreach t in array array['counters','settings','integration_settings','idempotency','audit_logs','staff','staff_devices','players','player_identity',
    'identity_documents','player_devices','player_auth','otp_challenges','otp_ip','cash_tables','table_days','cash_reservations','waiting_lists',
    'waiting_offers','table_movement_requests','festivals','tournaments','tournament_players','tournament_preregistrations',
    'tournament_entries','entitlements','tickets','chip_deliveries','cashier_shifts','ledger']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tv_read on %I', t);
  end loop;
end $$;

-- Public information
create policy tv_read on cash_tables for select using (true);
create policy tv_read on table_days for select using (true);
create policy tv_read on festivals for select using (true);
create policy tv_read on tournaments for select using (true);
create policy tv_read on settings for select using (key in ('booking_calendar') or tv_is_staff());
-- Own records or staff
create policy tv_read on players for select using (player_id = tv_player() or tv_is_staff());
create policy tv_read on cash_reservations for select using (player_id = tv_player() or tv_is_staff());
create policy tv_read on waiting_lists for select using (player_id = tv_player() or tv_is_staff());
create policy tv_read on waiting_offers for select using (player_id = tv_player() or tv_is_staff());
create policy tv_read on table_movement_requests for select using (player_id = tv_player() or tv_is_staff());
create policy tv_read on tournament_preregistrations for select using (player_id = tv_player() or tv_is_staff());
create policy tv_read on tournament_entries for select using (player_id = tv_player() or tv_is_staff());
create policy tv_read on tournament_players for select using (player_id = tv_player() or tv_is_staff());
create policy tv_read on player_devices for select using (player_id = tv_player());
create policy tv_read on identity_documents for select using (player_id = tv_player() or tv_has_role(array['super_admin','manager','cashier','front_desk']));
-- Restricted staff data
create policy tv_read on player_identity for select using (tv_has_role(array['super_admin','manager','cashier','front_desk']));
create policy tv_read on staff for select using (user_id = auth.uid() or tv_has_role(array['super_admin','manager']));
create policy tv_read on staff_devices for select using (tv_has_role(array['super_admin','manager']));
create policy tv_read on ledger for select using (player_id = tv_player() or tv_has_role(array['super_admin','manager','cashier']));
create policy tv_read on cashier_shifts for select using (cashier_id = auth.uid() or tv_has_role(array['super_admin','manager']));
create policy tv_read on tickets for select using (tv_has_role(array['super_admin','manager','cashier','tournament_director','floor_supervisor','dealer']));
create policy tv_read on entitlements for select using (tv_is_staff());
create policy tv_read on chip_deliveries for select using (tv_is_staff());
create policy tv_read on audit_logs for select using (tv_has_role(array['super_admin']));
-- counters, integration_settings, idempotency, player_auth, otp_challenges, otp_ip: no policy → nobody can read them from an app.

-- ════════ Live sync (Realtime) ════════
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['players','staff','staff_devices','identity_documents','table_days','cash_reservations',
      'waiting_lists','waiting_offers','tournaments','tournament_entries','chip_deliveries']
    loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = t) then
        execute format('alter publication supabase_realtime add table %I', t);
      end if;
    end loop;
  end if;
end $$;

-- ════════ Private file storage for ID photos ════════
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('identity', 'identity', false, 7340032) on conflict (id) do nothing;
  end if;
end $$;
