import { useState } from 'react';
import DateTimePicker from '@react-native-community/datetimepicker';
import { router } from 'expo-router';
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

import { useAuth } from '@/lib/auth/AuthProvider';
import { supabase } from '@/lib/supabase';

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
  created_by: string;
};

// Always includes the year on both ends of a range (not just the closing
// date) -- with same-named trips recurring year over year (Stage 1i's
// "annual Summer Vacation" example), the year is exactly the detail that
// disambiguates them, so it shouldn't only show up half the time.
function formatTripDate(startsAt: string, endsAt: string | null): string {
  const dateOpts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
  const start = new Date(startsAt);
  const startFull = start.toLocaleDateString(undefined, dateOpts);
  if (!endsAt) return startFull;

  const end = new Date(endsAt);
  const endFull = end.toLocaleDateString(undefined, dateOpts);
  return `${startFull} – ${endFull}`;
}

type TripFormState = {
  name: string;
  type: TripType;
  startsAt: Date;
  endsAt: Date;
};

function defaultEndsAt() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d;
}

// The type picker + type-adaptive date field(s), shared between the create
// form and the edit-in-place form on a trip card so the two stay in sync.
function TripTypeAndDateFields({
  form,
  onChange,
  disabled,
}: {
  form: TripFormState;
  onChange: (next: Partial<TripFormState>) => void;
  disabled: boolean;
}) {
  return (
    <>
      <View style={styles.typeRow}>
        {TRIP_TYPES.map((t) => (
          <Pressable
            key={t.value}
            style={[styles.typeButton, form.type === t.value && styles.typeButtonSelected]}
            onPress={() => onChange({ type: t.value })}
            disabled={disabled}
          >
            <Text
              style={[styles.typeButtonText, form.type === t.value && styles.typeButtonTextSelected]}
            >
              {t.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {form.type === 'vacation' ? (
        <View style={styles.dateRow}>
          <View style={styles.dateField}>
            <Text style={styles.label}>Starts</Text>
            <DateTimePicker
              value={form.startsAt}
              mode="date"
              display={Platform.OS === 'ios' ? 'compact' : 'default'}
              onChange={(_event, date) => date && onChange({ startsAt: date })}
            />
          </View>
          <View style={styles.dateField}>
            <Text style={styles.label}>Ends</Text>
            <DateTimePicker
              value={form.endsAt}
              mode="date"
              display={Platform.OS === 'ios' ? 'compact' : 'default'}
              onChange={(_event, date) => date && onChange({ endsAt: date })}
            />
          </View>
        </View>
      ) : (
        <View style={styles.dateField}>
          <Text style={styles.label}>When</Text>
          <DateTimePicker
            value={form.startsAt}
            mode="datetime"
            display={Platform.OS === 'ios' ? 'compact' : 'default'}
            onChange={(_event, date) => date && onChange({ startsAt: date })}
          />
        </View>
      )}
    </>
  );
}

// Milestone 1's Trips test screen, now with real create/join UI (Stage 1g's
// trip-type-adaptive fields) and in-place trip editing (Stage 1j). Tapping a
// trip card now opens its real detail screen (Milestone 2) instead of the
// old "add test expense" placeholder button, which is gone now that there's
// somewhere real for expenses to live.
export default function TripsScreen() {
  const status = useStatus();
  const { session } = useAuth();
  const { data: trips, isLoading } = useQuery<TripRow>(
    'SELECT id, name, type, status, invite_code, starts_at, ends_at, created_by FROM trip ORDER BY created_at DESC'
  );

  const [createForm, setCreateForm] = useState<TripFormState>({
    name: '',
    type: 'vacation',
    startsAt: new Date(),
    endsAt: defaultEndsAt(),
  });
  const [inviteCode, setInviteCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Editing an existing trip in place on its card -- only the creator sees
  // the "Edit" action that sets this (Stage 1j).
  const [editingTripId, setEditingTripId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<TripFormState | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  function updateCreateForm(next: Partial<TripFormState>) {
    setCreateForm((prev) => ({ ...prev, ...next }));
  }

  function updateEditForm(next: Partial<TripFormState>) {
    setEditForm((prev) => (prev ? { ...prev, ...next } : prev));
  }

  async function createTrip() {
    const name = createForm.name.trim();
    if (!name) {
      setError('Enter a trip name.');
      return;
    }
    if (createForm.type === 'vacation' && createForm.endsAt < createForm.startsAt) {
      setError('End date must be on or after the start date.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc('create_trip', {
      p_name: name,
      p_type: createForm.type,
      p_starts_at: createForm.startsAt.toISOString(),
      p_ends_at: createForm.type === 'vacation' ? createForm.endsAt.toISOString() : null,
    });
    setBusy(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    updateCreateForm({ name: '' });
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

  function startEditing(item: TripRow) {
    setEditError(null);
    setEditingTripId(item.id);
    setEditForm({
      name: item.name,
      type: item.type as TripType,
      startsAt: new Date(item.starts_at),
      endsAt: item.ends_at ? new Date(item.ends_at) : defaultEndsAt(),
    });
  }

  function cancelEditing() {
    setEditingTripId(null);
    setEditForm(null);
    setEditError(null);
  }

  async function saveTripEdit() {
    if (!editingTripId || !editForm) return;
    const name = editForm.name.trim();
    if (!name) {
      setEditError('Enter a trip name.');
      return;
    }
    if (editForm.type === 'vacation' && editForm.endsAt < editForm.startsAt) {
      setEditError('End date must be on or after the start date.');
      return;
    }
    setEditBusy(true);
    setEditError(null);
    const { error: rpcError } = await supabase.rpc('update_trip', {
      p_trip_id: editingTripId,
      p_name: name,
      p_type: editForm.type,
      p_starts_at: editForm.startsAt.toISOString(),
      p_ends_at: editForm.type === 'vacation' ? editForm.endsAt.toISOString() : null,
    });
    setEditBusy(false);
    if (rpcError) {
      setEditError(rpcError.message);
      return;
    }
    cancelEditing();
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
            value={createForm.name}
            onChangeText={(name) => updateCreateForm({ name })}
            editable={!busy}
          />

          <TripTypeAndDateFields form={createForm} onChange={updateCreateForm} disabled={busy} />

          <Pressable style={styles.button} onPress={createTrip} disabled={busy}>
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>
                Create {TRIP_TYPES.find((t) => t.value === createForm.type)?.label}
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
      renderItem={({ item }) => {
        const isEditing = editingTripId === item.id;
        const canEdit = !!session && item.created_by === session.user.id;

        if (isEditing && editForm) {
          return (
            <View style={styles.tripCard}>
              <TextInput
                style={styles.input}
                placeholder="Trip name"
                value={editForm.name}
                onChangeText={(name) => updateEditForm({ name })}
                editable={!editBusy}
              />
              <TripTypeAndDateFields form={editForm} onChange={updateEditForm} disabled={editBusy} />
              {editError ? <Text style={styles.error}>{editError}</Text> : null}
              <View style={styles.row}>
                <Pressable
                  style={[styles.smallButton, styles.rowInput]}
                  onPress={saveTripEdit}
                  disabled={editBusy}
                >
                  {editBusy ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.buttonText}>Save</Text>
                  )}
                </Pressable>
                <Pressable
                  style={[styles.smallButton, styles.cancelButton, styles.rowInput]}
                  onPress={cancelEditing}
                  disabled={editBusy}
                >
                  <Text style={styles.buttonText}>Cancel</Text>
                </Pressable>
              </View>
            </View>
          );
        }

        return (
          <Pressable style={styles.tripCard} onPress={() => router.push(`/trip/${item.id}`)}>
            <View style={styles.tripCardHeader}>
              <Text style={styles.tripName}>{item.name}</Text>
              {canEdit ? (
                <Pressable onPress={() => startEditing(item)} hitSlop={8}>
                  <Text style={styles.editLink}>Edit</Text>
                </Pressable>
              ) : null}
            </View>
            <Text style={styles.tripMeta}>
              {item.type} · {item.status} · invite code {item.invite_code}
            </Text>
            <Text style={styles.tripDate}>{formatTripDate(item.starts_at, item.ends_at)}</Text>
          </Pressable>
        );
      }}
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
    alignItems: 'center',
  },
  cancelButton: { backgroundColor: '#999' },
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
  tripCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  editLink: { color: '#2f6fed', fontSize: 13, fontWeight: '600' },
  tripName: { fontSize: 17, fontWeight: '600' },
  tripMeta: { color: '#666', marginTop: 2, fontSize: 13 },
  tripDate: { color: '#888', marginTop: 4, fontSize: 12 },
});
