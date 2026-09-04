import { useState } from 'react';
import DateTimePicker from '@react-native-community/datetimepicker';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useQuery, useStatus } from '@powersync/react';

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

type TripType = 'vacation' | 'dinner' | 'outing';

const TRIP_TYPES: { value: TripType; label: string }[] = [
  { value: 'vacation', label: 'Vacation' },
  { value: 'dinner', label: 'Dinner' },
  { value: 'outing', label: 'Outing' },
];

type TripRow = {
  id: string;
  name: string;
  type: string;
  status: string;
  invite_code: string;
  starts_at: string;
  ends_at: string | null;
};

function formatTripDate(startsAt: string, endsAt: string | null): string {
  const start = new Date(startsAt);
  const startFull = start.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  if (!endsAt) return startFull;

  const end = new Date(endsAt);
  const startShort = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const endFull = end.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return `${startShort} – ${endFull}`;
}

// Milestone 1's Trips test screen, now with real create/join UI (Stage 1g's
// trip-type-adaptive fields) instead of the hardcoded 'vacation' placeholder.
// The debug status line and "add test expense" button are still here from
// Milestone 1 -- useful while Milestone 2 (real trip detail/expense UI) isn't
// built yet, and will go away once that replaces this screen.
export default function TripsScreen() {
  const status = useStatus();
  const { data: trips, isLoading } = useQuery<TripRow>(
    'SELECT id, name, type, status, invite_code, starts_at, ends_at FROM trip ORDER BY created_at DESC'
  );

  const [newTripName, setNewTripName] = useState('');
  const [tripType, setTripType] = useState<TripType>('vacation');
  const [startsAt, setStartsAt] = useState(new Date());
  const [endsAt, setEndsAt] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d;
  });
  const [inviteCode, setInviteCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingExpenseFor, setAddingExpenseFor] = useState<string | null>(null);

  async function createTrip() {
    const name = newTripName.trim();
    if (!name) {
      setError('Enter a trip name.');
      return;
    }
    if (tripType === 'vacation' && endsAt < startsAt) {
      setError('End date must be on or after the start date.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc('create_trip', {
      p_name: name,
      p_type: tripType,
      p_starts_at: startsAt.toISOString(),
      p_ends_at: tripType === 'vacation' ? endsAt.toISOString() : null,
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
    <FlatList
      style={styles.container}
      data={trips}
      keyExtractor={(item) => item.id}
      ListHeaderComponent={
        <View>
          <View style={styles.headerRow}>
            <Text style={styles.title}>Trips</Text>
            <Pressable onPress={() => supabase.auth.signOut()}>
              <Text style={styles.signOut}>Sign out</Text>
            </Pressable>
          </View>

          <Text style={styles.debug}>
            connected: {String(status.connected)} · connecting: {String(status.connecting)} ·
            hasSynced: {String(status.hasSynced)} · downloading: {String(status.downloading)}
            {'\n'}lastSyncedAt: {status.lastSyncedAt ? status.lastSyncedAt.toISOString() : 'never'}
            {status.downloadError ? `\ndownloadError: ${status.downloadError.message}` : ''}
            {status.uploadError ? `\nuploadError: ${status.uploadError.message}` : ''}
          </Text>

          <Text style={styles.sectionTitle}>Create a trip</Text>

          <TextInput
            style={styles.input}
            placeholder="Trip name"
            value={newTripName}
            onChangeText={setNewTripName}
            editable={!busy}
          />

          <View style={styles.typeRow}>
            {TRIP_TYPES.map((t) => (
              <Pressable
                key={t.value}
                style={[styles.typeButton, tripType === t.value && styles.typeButtonSelected]}
                onPress={() => setTripType(t.value)}
                disabled={busy}
              >
                <Text
                  style={[
                    styles.typeButtonText,
                    tripType === t.value && styles.typeButtonTextSelected,
                  ]}
                >
                  {t.label}
                </Text>
              </Pressable>
            ))}
          </View>

          {tripType === 'vacation' ? (
            <View style={styles.dateRow}>
              <View style={styles.dateField}>
                <Text style={styles.label}>Starts</Text>
                <DateTimePicker
                  value={startsAt}
                  mode="date"
                  display={Platform.OS === 'ios' ? 'compact' : 'default'}
                  onChange={(_event, date) => date && setStartsAt(date)}
                />
              </View>
              <View style={styles.dateField}>
                <Text style={styles.label}>Ends</Text>
                <DateTimePicker
                  value={endsAt}
                  mode="date"
                  display={Platform.OS === 'ios' ? 'compact' : 'default'}
                  onChange={(_event, date) => date && setEndsAt(date)}
                />
              </View>
            </View>
          ) : (
            <View style={styles.dateField}>
              <Text style={styles.label}>When</Text>
              <DateTimePicker
                value={startsAt}
                mode="datetime"
                display={Platform.OS === 'ios' ? 'compact' : 'default'}
                onChange={(_event, date) => date && setStartsAt(date)}
              />
            </View>
          )}

          <Pressable style={styles.button} onPress={createTrip} disabled={busy}>
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>
                Create {TRIP_TYPES.find((t) => t.value === tripType)?.label}
              </Text>
            )}
          </Pressable>

          <Text style={styles.sectionTitle}>Join a trip</Text>
          <Text style={styles.helperText}>
            Late joiners welcome — you'll only share expenses added after you join.
          </Text>
          <View style={styles.row}>
            <TextInput
              style={[styles.input, styles.rowInput]}
              placeholder="Invite code"
              autoCapitalize="characters"
              value={inviteCode}
              onChangeText={setInviteCode}
              editable={!busy}
            />
            <Pressable style={styles.joinButton} onPress={joinTrip} disabled={busy}>
              <Text style={styles.buttonText}>Join</Text>
            </Pressable>
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Text style={styles.sectionTitle}>Your trips</Text>
          {isLoading ? <ActivityIndicator style={{ marginTop: 12 }} /> : null}
        </View>
      }
      ListEmptyComponent={
        !isLoading ? <Text style={styles.empty}>No trips yet -- create one above.</Text> : null
      }
      renderItem={({ item }) => (
        <View style={styles.tripCard}>
          <Text style={styles.tripName}>{item.name}</Text>
          <Text style={styles.tripMeta}>
            {item.type} · {item.status} · invite code {item.invite_code}
          </Text>
          <Text style={styles.tripDate}>{formatTripDate(item.starts_at, item.ends_at)}</Text>
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
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 20, paddingTop: 60 },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  title: { fontSize: 28, fontWeight: '700' },
  signOut: { color: '#2f6fed', fontSize: 14 },
  debug: { fontSize: 11, color: '#999', marginBottom: 16, fontFamily: 'SpaceMono' },
  sectionTitle: { fontSize: 15, fontWeight: '700', marginTop: 16, marginBottom: 8, color: '#333' },
  helperText: { fontSize: 12, color: '#888', marginBottom: 8 },
  label: { fontSize: 12, color: '#666', marginBottom: 4 },
  row: { flexDirection: 'row', gap: 8 },
  rowInput: { flex: 1 },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 10,
    fontSize: 15,
    marginBottom: 10,
  },
  typeRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  typeButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  typeButtonSelected: { backgroundColor: '#2f6fed', borderColor: '#2f6fed' },
  typeButtonText: { color: '#333', fontWeight: '600', fontSize: 13 },
  typeButtonTextSelected: { color: '#fff' },
  dateRow: { flexDirection: 'row', gap: 16, marginBottom: 14 },
  dateField: { marginBottom: 14 },
  button: {
    backgroundColor: '#2f6fed',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  joinButton: {
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
  error: { color: '#d33', marginBottom: 8, marginTop: 4 },
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
  tripDate: { color: '#888', marginTop: 4, fontSize: 12 },
});
