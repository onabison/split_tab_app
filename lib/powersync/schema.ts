import { column, Schema, Table } from '@powersync/react-native';

// Client-side (SQLite) schema mirroring supabase/migrations/0001_initial_schema.sql.
// PowerSync's column types are just text / integer / real -- Postgres uuid,
// timestamptz, boolean, and jsonb all get flattened to one of those on the
// client (booleans as 0/1 integers, timestamps and JSON as text).
//
// person / trip / trip_membership are created via RPCs (upsert_person,
// create_trip, join_trip) and only ever synced DOWN to the client here --
// the app doesn't write to them through local PowerSync inserts. expense,
// expense_item, claim, and payment are the tables the app writes to
// locally (offline-capable), which then upload via the connector.

const person = new Table({
  email: column.text,
  name: column.text
});

const trip = new Table({
  name: column.text,
  type: column.text, // 'vacation' | 'dinner' | 'outing'
  starts_at: column.text,
  ends_at: column.text,
  status: column.text, // 'open' | 'closed' | 'settled'
  closed_at: column.text,
  settled_at: column.text,
  collector_person_id: column.text,
  invite_code: column.text,
  created_by: column.text,
  created_at: column.text
});

const trip_membership = new Table(
  {
    trip_id: column.text,
    person_id: column.text,
    joined_at: column.text
  },
  { indexes: { trip: ['trip_id'], person: ['person_id'] } }
);

const expense = new Table(
  {
    trip_id: column.text,
    paid_by: column.text,
    photographed_by: column.text,
    image_url: column.text,
    merchant: column.text,
    description: column.text,
    expense_date: column.text,
    type: column.text, // 'scanned' | 'manual'
    status: column.text, // 'pending' | 'finalized'
    split_method: column.text, // 'even' | 'percent' | 'fixed'
    related_expense_id: column.text,
    total: column.real,
    tax: column.real,
    tip: column.real,
    needs_review: column.integer, // 0/1 -- Stage 3i
    flagged_fields: column.text, // JSON-encoded array of field names
    created_at: column.text
  },
  { indexes: { trip: ['trip_id'] } }
);

const expense_item = new Table(
  {
    expense_id: column.text,
    description: column.text,
    price: column.real,
    quantity: column.integer,
    split_from_item_id: column.text, // Stage 1f traceability/undo
    created_at: column.text
  },
  { indexes: { expense: ['expense_id'] } }
);

const claim = new Table(
  {
    item_id: column.text,
    participant_person_id: column.text,
    sponsor_person_id: column.text, // Stage 1c sponsorship
    custom_share_value: column.real,
    custom_share_type: column.text, // 'percent' | 'fixed'
    created_at: column.text
  },
  { indexes: { item: ['item_id'], participant: ['participant_person_id'] } }
);

const payment = new Table(
  {
    trip_id: column.text,
    from_person_id: column.text,
    to_person_id: column.text,
    amount: column.real,
    confirmed: column.integer, // 0/1
    confirmed_by: column.text,
    confirmed_at: column.text,
    created_at: column.text
  },
  { indexes: { trip: ['trip_id'] } }
);

export const AppSchema = new Schema({
  person,
  trip,
  trip_membership,
  expense,
  expense_item,
  claim,
  payment
});

export type Database = (typeof AppSchema)['types'];
