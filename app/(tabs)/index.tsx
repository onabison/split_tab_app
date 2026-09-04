import { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useQuery } from '@powersync/react';

import { powersync } from '@/lib/powersync/system';
import { supabase } from '@/lib/supabase';

// Not cryptographically secure -- fine here since these are just local
// primary keys, not anything security-sensitive. Avoids pulling in
// react-native-get-random-values / expo-crypto (native modules that would
// need a fresh `expo prebuild` + rebuild) just to generate an id.
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

type TripRow = {
  id: string;
  name: string;
  type: string;
  status: string;
  invite_code: string;
};

// Milestone 1 test screen: proves the whole pipeline end to end --
// creating/joining a trip via the online-only RPCs, reading trips back
// through PowerSync's local sync, and writing an expense straight to the
// local SQLite db (works offline) to confirm it uploads to Supabase via
// the connector. Not final UI -- just enough to see the round trip work.
export default function TripsScreen() {
  const { data: trips, isLoading } = useQuery<TripRow>(
    'SELECT id, name, type, status, invite_code FROM trip ORDER BY created_at DESC'
  );

  const [newTripName, setNewTripName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingExpenseFor, setAddingExpenseFor] = useState<string | null>(null);

  async function createTrip() {
    const name = newTripName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc('create_trip', {
      p_name: name,
      p_type: 'vacation',
      p_starts_at: new Date().toISOString(),
    });
    setBusy(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setNewTripName('');
  }

  async function joinTrip() {
    const code = inviteCode.trim();
    if (!code) return;
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc('join_trip', {
      p_invite_code: code,
    });
    setBusy(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setInviteCode('');
  }

  async function addTestExpense(tripId: string) {
    setAddingExpenseFor(tripId);
    setError(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');

      const now = new Date().toISOString();
      await powersync.execute(
        `INSERT INTO expense
           (id, trip_id, paid_by, merchant, description, expense_date, type, status, total, tax, tip, needs_review, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          tripId,
          session.user.id,
          'Test Merchant',
          'Offline test expense',
          now,
          'manual',
          'pending',
          12.34,
          0,
          0,
          0,
          now,
        ]
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAddingExpenseFor(null);
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Trips</Text>
        <Pressable onPress={() => supabase.auth.signOut()}>
          <Text style={styles.signOut}>Sign out</Text>
        </Pressable>
      </View>

      <View style={styles.row}>
        <TextInput
          style={styles.input}
          placeholder="New trip name"
          value={newTripName}
          onChangeText={setNewTripName}
          editable={!busy}
        />
        <Pressable style={styles.button} onPress={createTrip} disabled={busy}>
          <Text style={styles.buttonText}>Create</Text>
        </Pressable>
      </View>

      <View style={styles.row}>
        <TextInput
          style={styles.input}
          placeholder="Invite code"
          autoCapitalize="characters"
          value={inviteCode}
          onChangeText={setInviteCode}
          editable={!busy}
        />
        <Pressable style={styles.button} onPress={joinTrip} disabled={busy}>
          <Text style={styles.buttonText}>Join</Text>
        </Pressable>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {isLoading ? (
        <ActivityIndicator style={{ marginTop: 24 }} />
      ) : (
        <FlatList
          style={{ marginTop: 16 }}
          data={trips}
          keyExtractor={(item) => item.id}
          ListEmptyComponent={
            <Text style={styles.empty}>No trips yet -- create one above.</Text>
          }
          renderItem={({ item }) => (
            <View style={styles.tripCard}>
              <Text style={styles.tripName}>{item.name}</Text>
              <Text style={styles.tripMeta}>
                {item.type} · {item.status} · invite code {item.invite_code}
              </Text>
              <Pressable
                style={styles.smallButton}
                onPress={() => addTestExpense(item.id)}
                disabled={addingExpenseFor === item.id}
              >
                <Text style={styles.buttonText}>
                  {addingExpenseFor === item.id ? 'Adding…' : 'Add test expense ($12.34)'}
                </Text>
              </Pressable>
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, paddingTop: 60 },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  title: { fontSize: 28, fontWeight: '700' },
  signOut: { color: '#2f6fed', fontSize: 14 },
  row: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 10,
    fontSize: 15,
  },
  button: {
    backgroundColor: '#2f6fed',
    borderRadius: 8,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  smallButton: {
    backgroundColor: '#2f6fed',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    alignSelf: 'flex-start',
    marginTop: 8,
  },
  buttonText: { color: '#fff', fontWeight: '600' },
  error: { color: '#d33', marginBottom: 8 },
  empty: { color: '#888', textAlign: 'center', marginTop: 24 },
  tripCard: {
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
  },
  tripName: { fontSize: 17, fontWeight: '600' },
  tripMeta: { color: '#666', marginTop: 2, fontSize: 13 },
});
