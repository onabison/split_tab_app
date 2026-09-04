import { useMemo, useState } from 'react';
import { Stack, useLocalSearchParams } from 'expo-router';
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

import { useAuth } from '@/lib/auth/AuthProvider';
import { powersync } from '@/lib/powersync/system';
import { uuidv4 } from '@/lib/uuid';

type TripRow = {
  id: string;
  name: string;
  type: string;
  starts_at: string;
  ends_at: string | null;
};

type MemberRow = { person_id: string; name: string };
type ExpenseRow = { id: string; description: string | null; total: number; paid_by: string };
type ItemRow = { id: string; expense_id: string; description: string | null; price: number };
type ClaimRow = { id: string; item_id: string; participant_person_id: string };

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatMoney(n: number): string {
  return `$${Math.abs(n).toFixed(2)}`;
}

// Milestone 2's walking skeleton: a manual expense, itemized-style claiming
// (even split among whoever claims), and a running tally -- the simplest
// version of the core loop, proven before OCR (Milestone 3) is built on
// top of it. Each manual expense gets exactly one expense_item representing
// its full amount; OCR will produce multiple items per expense, at which
// point this screen needs a per-item list instead of one row per expense.
export default function TripDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const tripId = Array.isArray(params.id) ? params.id[0] : params.id ?? '';
  const { session } = useAuth();
  const currentUserId = session?.user.id;

  const { data: tripRows } = useQuery<TripRow>(
    'SELECT id, name, type, starts_at, ends_at FROM trip WHERE id = ?',
    [tripId]
  );
  const trip = tripRows?.[0];

  const { data: members } = useQuery<MemberRow>(
    `SELECT tm.person_id as person_id, p.name as name
     FROM trip_membership tm JOIN person p ON p.id = tm.person_id
     WHERE tm.trip_id = ?`,
    [tripId]
  );

  const { data: expenses, isLoading: expensesLoading } = useQuery<ExpenseRow>(
    'SELECT id, description, total, paid_by FROM expense WHERE trip_id = ? ORDER BY created_at DESC',
    [tripId]
  );

  const { data: items } = useQuery<ItemRow>(
    `SELECT ei.id as id, ei.expense_id as expense_id, ei.description as description, ei.price as price
     FROM expense_item ei JOIN expense e ON e.id = ei.expense_id
     WHERE e.trip_id = ?`,
    [tripId]
  );

  const { data: claims } = useQuery<ClaimRow>(
    `SELECT c.id as id, c.item_id as item_id, c.participant_person_id as participant_person_id
     FROM claim c
     JOIN expense_item ei ON ei.id = c.item_id
     JOIN expense e ON e.id = ei.expense_id
     WHERE e.trip_id = ?`,
    [tripId]
  );

  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [payerId, setPayerId] = useState<string | undefined>(currentUserId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const memberName = useMemo(() => {
    const map = new Map((members ?? []).map((m) => [m.person_id, m.name]));
    return (personId: string) => map.get(personId) ?? 'Someone';
  }, [members]);

  // One item per expense for now -- see the file-level comment above.
  const itemByExpense = useMemo(() => {
    const map = new Map<string, ItemRow>();
    for (const item of items ?? []) {
      if (!map.has(item.expense_id)) map.set(item.expense_id, item);
    }
    return map;
  }, [items]);

  const claimsByItem = useMemo(() => {
    const map = new Map<string, ClaimRow[]>();
    for (const claim of claims ?? []) {
      const list = map.get(claim.item_id) ?? [];
      list.push(claim);
      map.set(claim.item_id, list);
    }
    return map;
  }, [claims]);

  // Running tally (Stage 1 core loop): each person's net float is what
  // they've paid across expenses, minus their even share of whatever
  // they've claimed. Positive = they're owed money; negative = they owe.
  // An item nobody has claimed yet doesn't count against anyone -- it's an
  // open liability, not automatically split across the whole trip.
  const balances = useMemo(() => {
    const map = new Map<string, number>();
    for (const member of members ?? []) map.set(member.person_id, 0);
    for (const expense of expenses ?? []) {
      map.set(expense.paid_by, (map.get(expense.paid_by) ?? 0) + expense.total);
    }
    for (const item of items ?? []) {
      const itemClaims = claimsByItem.get(item.id) ?? [];
      if (itemClaims.length === 0) continue;
      const share = item.price / itemClaims.length;
      for (const claim of itemClaims) {
        map.set(claim.participant_person_id, (map.get(claim.participant_person_id) ?? 0) - share);
      }
    }
    return map;
  }, [members, expenses, items, claimsByItem]);

  async function addExpense() {
    const desc = description.trim();
    const amountNum = Number(amount);
    if (!desc) {
      setError('Enter a description.');
      return;
    }
    if (!amountNum || amountNum <= 0) {
      setError('Enter an amount greater than 0.');
      return;
    }
    if (!payerId) {
      setError('Pick who paid.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const now = new Date().toISOString();
      const expenseId = uuidv4();
      // One local transaction for both rows -- a manual expense isn't
      // useful without its item, so they should land together or not at all.
      await powersync.writeTransaction(async (tx) => {
        await tx.execute(
          `INSERT INTO expense
             (id, trip_id, paid_by, description, expense_date, type, status, total, tax, tip, needs_review, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [expenseId, tripId, payerId, desc, now, 'manual', 'pending', amountNum, 0, 0, 0, now]
        );
        await tx.execute(
          `INSERT INTO expense_item (id, expense_id, description, price, quantity, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [uuidv4(), expenseId, desc, amountNum, 1, now]
        );
      });
      setDescription('');
      setAmount('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Self-claim only -- the database only allows inserting a claim for
  // yourself (or as a declared sponsor, Stage 1c, not built yet), so each
  // trip member checks off their own share on their own device rather than
  // the expense creator claiming on everyone's behalf (that's the
  // group-activity tagging feature, deliberately deferred to Milestone 6).
  async function toggleClaim(item: ItemRow) {
    if (!currentUserId) return;
    const existing = (claimsByItem.get(item.id) ?? []).find(
      (c) => c.participant_person_id === currentUserId
    );
    if (existing) {
      await powersync.execute('DELETE FROM claim WHERE id = ?', [existing.id]);
    } else {
      await powersync.execute(
        'INSERT INTO claim (id, item_id, participant_person_id, created_at) VALUES (?, ?, ?, ?)',
        [uuidv4(), item.id, currentUserId, new Date().toISOString()]
      );
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: trip?.name ?? 'Trip' }} />
      <FlatList
        style={styles.container}
        data={expenses}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={
          <View>
            {trip ? (
              <Text style={styles.subtitle}>
                {trip.type} · {formatDate(trip.starts_at)}
                {trip.ends_at ? ` – ${formatDate(trip.ends_at)}` : ''}
              </Text>
            ) : null}

            <Text style={styles.sectionTitle}>Running tally</Text>
            {(members ?? []).map((member) => {
              const balance = balances.get(member.person_id) ?? 0;
              const settled = Math.abs(balance) < 0.005;
              return (
                <View key={member.person_id} style={styles.balanceRow}>
                  <Text style={styles.balanceName}>{member.name}</Text>
                  <Text
                    style={[
                      styles.balanceAmount,
                      !settled && balance > 0 && styles.balancePositive,
                      !settled && balance < 0 && styles.balanceNegative,
                    ]}
                  >
                    {settled
                      ? 'settled up'
                      : balance > 0
                        ? `is owed ${formatMoney(balance)}`
                        : `owes ${formatMoney(balance)}`}
                  </Text>
                </View>
              );
            })}

            <Text style={styles.sectionTitle}>Add an expense</Text>
            <TextInput
              style={styles.input}
              placeholder="Description"
              value={description}
              onChangeText={setDescription}
              editable={!busy}
            />
            <TextInput
              style={styles.input}
              placeholder="Amount"
              keyboardType="decimal-pad"
              value={amount}
              onChangeText={setAmount}
              editable={!busy}
            />
            <Text style={styles.label}>Paid by</Text>
            <View style={styles.typeRow}>
              {(members ?? []).map((member) => (
                <Pressable
                  key={member.person_id}
                  style={[styles.typeButton, payerId === member.person_id && styles.typeButtonSelected]}
                  onPress={() => setPayerId(member.person_id)}
                  disabled={busy}
                >
                  <Text
                    style={[
                      styles.typeButtonText,
                      payerId === member.person_id && styles.typeButtonTextSelected,
                    ]}
                  >
                    {member.name}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Pressable style={styles.button} onPress={addExpense} disabled={busy}>
              {busy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>Add expense</Text>
              )}
            </Pressable>

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <Text style={styles.sectionTitle}>Expenses</Text>
            {expensesLoading ? <ActivityIndicator style={{ marginTop: 12 }} /> : null}
          </View>
        }
        ListEmptyComponent={
          !expensesLoading ? <Text style={styles.empty}>No expenses yet -- add one above.</Text> : null
        }
        renderItem={({ item }) => {
          const expenseItem = itemByExpense.get(item.id);
          const itemClaims = expenseItem ? claimsByItem.get(expenseItem.id) ?? [] : [];
          const youClaimed = itemClaims.some((c) => c.participant_person_id === currentUserId);
          const claimantNames = itemClaims.map((c) => memberName(c.participant_person_id)).join(', ');

          return (
            <View style={styles.expenseCard}>
              <View style={styles.expenseHeader}>
                <Text style={styles.expenseDescription}>{item.description ?? 'Expense'}</Text>
                <Text style={styles.expenseAmount}>{formatMoney(item.total)}</Text>
              </View>
              <Text style={styles.expenseMeta}>Paid by {memberName(item.paid_by)}</Text>
              <Text style={styles.expenseMeta}>
                {itemClaims.length === 0 ? 'Not claimed yet' : `Claimed by ${claimantNames}`}
              </Text>
              {expenseItem ? (
                <Pressable
                  style={[styles.smallButton, youClaimed && styles.cancelButton]}
                  onPress={() => toggleClaim(expenseItem)}
                >
                  <Text style={styles.buttonText}>
                    {youClaimed ? "This wasn't mine" : 'This was mine'}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          );
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 20, paddingTop: 16 },
  subtitle: { color: '#666', fontSize: 14, marginBottom: 16 },
  sectionTitle: { fontSize: 15, fontWeight: '700', marginTop: 16, marginBottom: 8, color: '#333' },
  label: { fontSize: 12, color: '#666', marginBottom: 4 },
  balanceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  balanceName: { fontSize: 15, fontWeight: '500' },
  balanceAmount: { fontSize: 14, color: '#666' },
  balancePositive: { color: '#1a8f4c' },
  balanceNegative: { color: '#d33' },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 10,
    fontSize: 15,
    marginBottom: 10,
  },
  typeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  typeButton: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
  },
  typeButtonSelected: { backgroundColor: '#2f6fed', borderColor: '#2f6fed' },
  typeButtonText: { color: '#333', fontWeight: '600', fontSize: 13 },
  typeButtonTextSelected: { color: '#fff' },
  button: {
    backgroundColor: '#2f6fed',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  smallButton: {
    backgroundColor: '#2f6fed',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    alignSelf: 'flex-start',
    marginTop: 8,
  },
  cancelButton: { backgroundColor: '#999' },
  buttonText: { color: '#fff', fontWeight: '600' },
  error: { color: '#d33', marginBottom: 8, marginTop: 4 },
  empty: { color: '#888', textAlign: 'center', marginTop: 24 },
  expenseCard: {
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
  },
  expenseHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  expenseDescription: { fontSize: 16, fontWeight: '600', flexShrink: 1 },
  expenseAmount: { fontSize: 16, fontWeight: '700' },
  expenseMeta: { color: '#666', marginTop: 2, fontSize: 13 },
});
