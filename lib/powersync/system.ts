import { PowerSyncDatabase } from '@powersync/react-native';
import { AppSchema } from './schema';
import { SupabaseConnector } from './connector';
import { supabase } from '../supabase';

export const powersync = new PowerSyncDatabase({
  schema: AppSchema,
  database: {
    dbFilename: 'split_tab_app.db'
  }
});

const connector = new SupabaseConnector();

let connected = false;

// Call once at app startup, and again any time auth state changes --
// PowerSync needs a fresh connect() after sign-in (no session yet before
// that) and should disconnect on sign-out so a device stops pulling
// another person's data after switching accounts.
export async function connectPowerSync() {
  if (connected) return;
  connected = true;
  await powersync.connect(connector);
}

export async function disconnectPowerSync() {
  if (!connected) return;
  connected = false;
  await powersync.disconnect();
}

supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
    connectPowerSync();
  } else if (event === 'SIGNED_OUT') {
    disconnectPowerSync();
  }
});

// onAuthStateChange only fires on a CHANGE -- if the app is reopened with
// an already-persisted session, nothing fires it, so check explicitly.
supabase.auth.getSession().then(({ data }) => {
  if (data.session) connectPowerSync();
});
