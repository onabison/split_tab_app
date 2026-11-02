-- Fix (2026-11-01): un-claiming an item never worked on the server.
--
-- 0001 gave `claim` select and insert policies but no DELETE policy. With
-- RLS on, a DELETE that no policy allows silently matches 0 rows (no
-- error), so the app removed the claim locally, the server kept it, and
-- the next PowerSync sync restored it ("Not mine" flips back to "Mine").
--
-- Mirror the insert rules: you can remove a claim you made for yourself,
-- or one you made as a sponsor for someone else (Stage 1c).

drop policy if exists "delete own or sponsored claim" on claim;
create policy "delete own or sponsored claim" on claim
  for delete using (
    participant_person_id = auth.uid()
    or sponsor_person_id = auth.uid()
  );
