import { UpdateType } from '@powersync/react-native';
import type {
  AbstractPowerSyncDatabase,
  CrudEntry,
  PowerSyncBackendConnector,
  PowerSyncCredentials
} from '@powersync/react-native';
import { supabase } from '../supabase';

// Postgres error codes that mean "this write is wrong and retrying won't
// help" (bad data, a constraint violation, or an RLS rejection) -- these
// get discarded rather than retried forever. Anything else (network
// blips, a temporary server error) gets thrown so PowerSync retries later.
// Source: PowerSync's official Supabase connector reference implementation.
const FATAL_RESPONSE_CODES = [
  new RegExp('^22...$'), // Class 22 - Data Exception (e.g. type mismatch)
  new RegExp('^23...$'), // Class 23 - Integrity Constraint Violation (NOT NULL, FK, UNIQUE)
  new RegExp('^42501$') // Insufficient privilege -- typically an RLS rejection
];

const powersyncUrl = process.env.EXPO_PUBLIC_POWERSYNC_URL!;

export class SupabaseConnector implements PowerSyncBackendConnector {
  async fetchCredentials(): Promise<PowerSyncCredentials> {
    const {
      data: { session },
      error
    } = await supabase.auth.getSession();

    if (!session || error) {
      throw new Error(`Could not fetch Supabase credentials: ${error?.message}`);
    }

    return {
      endpoint: powersyncUrl,
      token: session.access_token ?? ''
    };
  }

  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    const transaction = await database.getNextCrudTransaction();
    if (!transaction) return;

    let lastOp: CrudEntry | null = null;

    try {
      // Note: if a whole trip's worth of writes needs to land atomically,
      // that belongs in a Postgres function/RPC, not this loop -- this
      // applies each row's op independently.
      for (const op of transaction.crud) {
        lastOp = op;
        const table = supabase.from(op.table);
        let result: any;

        switch (op.op) {
          case UpdateType.PUT: {
            const record = { ...op.opData, id: op.id };
            result = await table.upsert(record);
            break;
          }
          case UpdateType.PATCH:
            result = await table.update(op.opData ?? {}).eq('id', op.id);
            break;
          case UpdateType.DELETE:
            result = await table.delete().eq('id', op.id);
            break;
        }

        if (result?.error) {
          result.error.message = `Could not update Supabase (${op.table}): ${result.error.message}`;
          throw result.error;
        }
      }

      await transaction.complete();
    } catch (ex: any) {
      if (typeof ex.code === 'string' && FATAL_RESPONSE_CODES.some((re) => re.test(ex.code))) {
        // This op is broken in a way retrying won't fix (bad data, an RLS
        // rejection, etc). Log it loudly and drop it rather than jamming
        // the upload queue forever -- see the source comment above for
        // the "this indicates an app bug" caveat.
        console.error('Discarding unrecoverable sync upload error:', lastOp, ex);
        await transaction.complete();
      } else {
        // Likely a network/transient error -- rethrow so PowerSync retries.
        throw ex;
      }
    }
  }
}
