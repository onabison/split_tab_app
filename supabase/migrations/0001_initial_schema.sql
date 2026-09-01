-- Initial schema for the vacation bill-splitting app (Milestone 1)
-- Reflects the draft data model in mvp-concept-and-decisions.md, updated for
-- lightweight passwordless identity: each Person is 1:1 with a Supabase
-- auth.users row created via email one-time-code sign-in (no password,
-- no account settings/recovery yet -- see Stage 1e correction, Aug 2026).

-- ============================================================
-- TABLES
-- ============================================================

create table person (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  name text not null,
  created_at timestamptz not null default now()
);

create table trip (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null check (type in ('vacation', 'dinner', 'outing')),
  starts_at timestamptz not null,
  ends_at timestamptz, -- null for dinner/outing (single date+time types)
  status text not null default 'open' check (status in ('open', 'closed', 'settled')),
  closed_at timestamptz,
  settled_at timestamptz,
  collector_person_id uuid references person(id),
  invite_code text not null unique,
  created_by uuid not null references person(id),
  created_at timestamptz not null default now()
);

create table trip_membership (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trip(id) on delete cascade,
  person_id uuid not null references person(id),
  joined_at timestamptz not null default now(),
  unique (trip_id, person_id)
);

create table expense (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trip(id) on delete cascade,
  paid_by uuid not null references person(id),
  photographed_by uuid references person(id),
  image_url text,
  merchant text,
  description text,
  expense_date timestamptz not null default now(),
  type text not null check (type in ('scanned', 'manual')),
  status text not null default 'pending' check (status in ('pending', 'finalized')),
  split_method text check (split_method in ('even', 'percent', 'fixed')),
  related_expense_id uuid references expense(id),
  total numeric(10, 2),
  tax numeric(10, 2) not null default 0,
  tip numeric(10, 2) not null default 0,
  -- Stage 3i: OCR misread detection
  needs_review boolean not null default false,
  flagged_fields jsonb,
  created_at timestamptz not null default now()
);

create table expense_item (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references expense(id) on delete cascade,
  description text not null,
  price numeric(10, 2) not null,
  quantity int not null default 1,
  split_from_item_id uuid references expense_item(id), -- Stage 1f traceability/undo
  created_at timestamptz not null default now()
);

create table claim (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references expense_item(id) on delete cascade,
  participant_person_id uuid not null references person(id),
  sponsor_person_id uuid references person(id), -- Stage 1c: sponsorship
  custom_share_value numeric(10, 2),
  custom_share_type text check (custom_share_type in ('percent', 'fixed')),
  created_at timestamptz not null default now(),
  unique (item_id, participant_person_id)
);

create table payment (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trip(id) on delete cascade,
  from_person_id uuid not null references person(id),
  to_person_id uuid not null references person(id),
  amount numeric(10, 2) not null,
  confirmed boolean not null default false,
  confirmed_by uuid references person(id),
  confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

-- ============================================================
-- HELPER FUNCTION (used inside RLS policies to avoid recursive
-- policy checks on trip_membership itself)
-- ============================================================

create or replace function is_trip_member(p_trip_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from trip_membership
    where trip_id = p_trip_id and person_id = auth.uid()
  );
$$;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table person enable row level security;
alter table trip enable row level security;
alter table trip_membership enable row level security;
alter table expense enable row level security;
alter table expense_item enable row level security;
alter table claim enable row level security;
alter table payment enable row level security;

-- person: you can see anyone who shares a trip with you; you can only edit yourself
create policy "select person via shared trip" on person
  for select using (
    id = auth.uid()
    or exists (
      select 1 from trip_membership tm1
      join trip_membership tm2 on tm2.trip_id = tm1.trip_id
      where tm1.person_id = auth.uid() and tm2.person_id = person.id
    )
  );
create policy "upsert own person row" on person
  for insert with check (id = auth.uid());
create policy "update own person row" on person
  for update using (id = auth.uid());

-- trip: visible/editable only to members
create policy "select trip if member" on trip
  for select using (is_trip_member(id));
create policy "insert trip as creator" on trip
  for insert with check (created_by = auth.uid());
create policy "update trip if member" on trip
  for update using (is_trip_member(id));

-- trip_membership: visible to any member of the same trip; inserts happen
-- through the join_trip()/create_trip() functions below (security definer),
-- not directly, since a joiner isn't a member yet at insert time.
create policy "select membership if trip member" on trip_membership
  for select using (is_trip_member(trip_id));

-- expense / expense_item / claim / payment: scoped to trip membership
create policy "select expense if member" on expense
  for select using (is_trip_member(trip_id));
create policy "insert expense if member" on expense
  for insert with check (is_trip_member(trip_id));
create policy "update expense if uploader" on expense
  for update using (photographed_by = auth.uid() or paid_by = auth.uid());

create policy "select item if member" on expense_item
  for select using (is_trip_member((select trip_id from expense where expense.id = expense_id)));
create policy "insert item if member" on expense_item
  for insert with check (is_trip_member((select trip_id from expense where expense.id = expense_id)));
create policy "update item if uploader" on expense_item
  for update using (
    exists (
      select 1 from expense
      where expense.id = expense_item.expense_id
      and (expense.photographed_by = auth.uid() or expense.paid_by = auth.uid())
    )
  );

create policy "select claim if member" on claim
  for select using (
    is_trip_member((select trip_id from expense e join expense_item ei on ei.expense_id = e.id where ei.id = item_id))
  );
create policy "insert own claim if member" on claim
  for insert with check (
    participant_person_id = auth.uid()
    and is_trip_member((select trip_id from expense e join expense_item ei on ei.expense_id = e.id where ei.id = item_id))
  );
create policy "sponsor can claim for others" on claim
  for insert with check (
    sponsor_person_id = auth.uid()
    and is_trip_member((select trip_id from expense e join expense_item ei on ei.expense_id = e.id where ei.id = item_id))
  );

create policy "select payment if member" on payment
  for select using (is_trip_member(trip_id));
create policy "insert payment if member" on payment
  for insert with check (is_trip_member(trip_id) and from_person_id = auth.uid());
create policy "confirm payment if recipient" on payment
  for update using (to_person_id = auth.uid());

-- ============================================================
-- RPCS (identity + trip creation/joining, Stage 1e)
-- ============================================================

-- Called right after email one-time-code verification to record the
-- person's display name against their new auth identity.
create or replace function upsert_person(p_name text)
returns person
language plpgsql
security definer
set search_path = public
as $$
declare
  result person;
begin
  insert into person (id, email, name)
  values (auth.uid(), auth.jwt() ->> 'email', p_name)
  on conflict (id) do update set name = excluded.name
  returning * into result;
  return result;
end;
$$;

create or replace function generate_invite_code()
returns text
language sql
as $$
  select upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
$$;

-- Creates a trip and adds the creator as its first member, in one step.
create or replace function create_trip(
  p_name text,
  p_type text,
  p_starts_at timestamptz,
  p_ends_at timestamptz default null
)
returns trip
language plpgsql
security definer
set search_path = public
as $$
declare
  result trip;
begin
  insert into trip (name, type, starts_at, ends_at, invite_code, created_by)
  values (p_name, p_type, p_starts_at, p_ends_at, generate_invite_code(), auth.uid())
  returning * into result;

  insert into trip_membership (trip_id, person_id)
  values (result.id, auth.uid());

  return result;
end;
$$;

-- Looks up a trip by invite code and adds the caller as a member.
-- No hard join cutoff (Stage 1h) -- this works at any point before closeout.
create or replace function join_trip(p_invite_code text)
returns trip
language plpgsql
security definer
set search_path = public
as $$
declare
  result trip;
begin
  select * into result from trip where invite_code = upper(p_invite_code);

  if result.id is null then
    raise exception 'No trip found for that invite code';
  end if;

  if result.status <> 'open' then
    raise exception 'This trip is no longer open to new members';
  end if;

  insert into trip_membership (trip_id, person_id)
  values (result.id, auth.uid())
  on conflict (trip_id, person_id) do nothing;

  return result;
end;
$$;
