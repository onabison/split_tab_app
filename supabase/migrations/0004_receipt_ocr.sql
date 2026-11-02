-- Milestone 3, step 2: turning a scanned receipt into an expense.
--
-- expense.receipt_total: the bill total printed on the receipt. For a split
--   check (each person scans the part they paid, decided 2026-11-01),
--   expense.total is what THIS payer actually paid (e.g. 113.00) while
--   receipt_total is the whole bill (226.00). expense.tip (already exists)
--   holds the tip the payer adds themselves.
-- expense_item.modifier_of_item_id: add-ons like "BC Olives" / "Add Cheddar"
--   stay separate claimable items (decided 2026-11-01) but remember which
--   item they were printed under, so the app can ask "did you order extra
--   BC Olives with your OV Martini?" when someone claims the parent item.
-- expense_item.line_order: keep items in printed order.
--
-- No RLS changes needed: the existing expense / expense_item policies apply
-- to the new columns. PowerSync's sync streams select expense.* and
-- expense_item.*, so the new columns sync without a stream change.

alter table expense
  add column if not exists receipt_total numeric(10, 2);

alter table expense_item
  add column if not exists modifier_of_item_id uuid references expense_item(id) on delete set null,
  add column if not exists line_order int;
