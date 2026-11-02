-- Split checks, option 1 (decided 2026-11-01): one bill, several payers.
--
-- The person who scans the receipt is still expense.paid_by, and
-- expense.total is still what THEY paid (their part + their tip). Anyone
-- else who paid part of the same bill taps "Add my payment" on that
-- expense instead of scanning it again, which adds a row here. One item
-- list, everyone claims once, no second OCR call.
--
-- Money model (app/trip/[id].tsx): an expense's total paid =
-- expense.total + sum(expense_payment.amount + tip). Each item's cost is
-- scaled by (total paid / item sum), so tax and every payer's tip are
-- shared in proportion to what people claimed.

create table if not exists expense_payment (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references expense(id) on delete cascade,
  person_id uuid not null references person(id),
  amount numeric(10, 2) not null check (amount >= 0), -- their part, before tip
  tip numeric(10, 2) not null default 0 check (tip >= 0),
  created_at timestamptz not null default now()
);

create index if not exists expense_payment_expense_idx on expense_payment (expense_id);

alter table expense_payment enable row level security;

drop policy if exists "select payment row if member" on expense_payment;
create policy "select payment row if member" on expense_payment
  for select using (
    public.is_trip_member((select trip_id from expense where expense.id = expense_id))
  );

-- You can only record your own payment, on an expense in a trip you belong to.
drop policy if exists "insert own payment row if member" on expense_payment;
create policy "insert own payment row if member" on expense_payment
  for insert with check (
    person_id = auth.uid()
    and public.is_trip_member((select trip_id from expense where expense.id = expense_id))
  );

drop policy if exists "update own payment row" on expense_payment;
create policy "update own payment row" on expense_payment
  for update using (person_id = auth.uid()) with check (person_id = auth.uid());

drop policy if exists "delete own payment row" on expense_payment;
create policy "delete own payment row" on expense_payment
  for delete using (person_id = auth.uid());

-- PowerSync replication. Its publication and role were set up by hand in
-- the dashboard (not in these migrations), so handle both possibilities:
-- a publication that already covers all tables needs nothing; one that
-- lists tables needs this one added. Same for the replication role's read
-- access.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'powersync' and not puballtables)
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'powersync' and tablename = 'expense_payment') then
    execute 'alter publication powersync add table public.expense_payment';
  end if;
  if exists (select 1 from pg_roles where rolname = 'powersync_role') then
    execute 'grant select on public.expense_payment to powersync_role';
  end if;
end $$;
