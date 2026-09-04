-- Stage 1j: trip editing. Lets the creator fix a typo'd name, wrong type,
-- or wrong date after a trip is already created (e.g. a timezone mixup when
-- picking a date). Restricted to the creator only, matching the
-- edit-ownership pattern already used for receipts (Stage 3i) -- one
-- accountable person, no multi-editor coordination questions.

create or replace function update_trip(
  p_trip_id uuid,
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
  if p_type not in ('vacation', 'dinner', 'outing') then
    raise exception 'Invalid trip type: %', p_type;
  end if;

  update trip
  set name = p_name,
      type = p_type,
      starts_at = p_starts_at,
      ends_at = case when p_type = 'vacation' then p_ends_at else null end
  where id = p_trip_id
    and created_by = auth.uid()
  returning * into result;

  if result.id is null then
    raise exception 'Trip not found, or you are not its creator';
  end if;

  return result;
end;
$$;

-- Tighten trip updates to the creator only. The original policy
-- ("update trip if member") allowed any member to update the trip row via
-- a direct table update; no client code does that today (create_trip/
-- join_trip/update_trip are all security-definer RPCs that enforce their
-- own auth.uid() checks regardless of this policy), but tightening it keeps
-- the RLS policy consistent with the creator-only intent in case a direct
-- update path is ever added. Broader member-update rights (e.g. a collector
-- closing/settling a trip) will be revisited when that Stage 1b flow is built.
drop policy "update trip if member" on trip;
create policy "update trip if creator" on trip
  for update using (created_by = auth.uid());
