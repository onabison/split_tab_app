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
import * as ImagePicker from 'expo-image-picker';
import { useQuery } from '@powersync/react';
import { FunctionsHttpError } from '@supabase/supabase-js';

import { useAuth } from '@/lib/auth/AuthProvider';
import { powersync } from '@/lib/powersync/system';
import { supabase } from '@/lib/supabase';
import { uuidv4 } from '@/lib/uuid';

type TripRow = {
  id: string;
  name: string;
  type: string;
  starts_at: string;
  ends_at: string | null;
};

type MemberRow = { person_id: string; name: string };
type ExpenseRow = {
  id: string;
  description: string | null;
  merchant: string | null;
  total: number;
  receipt_total: number | null;
  tip: number | null;
  type: string;
  paid_by: string;
};
type ItemRow = {
  id: string;
  expense_id: string;
  description: string | null;
  price: number;
  quantity: number | null;
  modifier_of_item_id: string | null;
  line_order: number | null;
};
type ClaimRow = { id: string; item_id: string; participant_person_id: string };
type PaymentRow = { id: string; expense_id: string; person_id: string; amount: number; tip: number };

// Shape returned by the ocr-receipt Edge Function
// (supabase/functions/_shared/receipt-ocr.mjs RECEIPT_SCHEMA).
type OcrItem = {
  line: number;
  description: string;
  quantity: number;
  price: number;
  modifier_of_line: number | null;
  uncertain: boolean;
};
type OcrReceipt = {
  merchant: string | null;
  receipt_date: string | null;
  items: OcrItem[];
  subtotal: number | null;
  tax: number | null;
  tip: number | null;
  total: number | null;
  amount_charged: number | null;
  uncertain_fields: string[];
  notes: string | null;
};
type ScanResult = { path: string; receipt: OcrReceipt; problems: string[] };

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

function parseMoney(s: string): number | null {
  const t = s.trim();
  if (t === '') return 0;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

async function functionErrorMessage(error: unknown): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    try {
      const body = await error.context.json();
      if (body?.error) return String(body.error);
    } catch {
      // fall through to the generic message
    }
  }
  return error instanceof Error ? error.message : String(error);
}

// Trip detail: running tally, receipt scanning (Milestone 3), manual
// expenses (Milestone 2), and per-item claiming.
//
// Money model:
// - expense.total is what the payer actually paid, tip included. For a
//   split check (each person scans the part they paid -- decided
//   2026-11-01) that's their part, not the whole bill; the whole bill is
//   kept in expense.receipt_total.
// - Tax and tip are shared in proportion to what each person claimed
//   (Stage 1 #7): an item's effective cost is its printed price scaled by
//   (total paid) / (sum of the expense's item prices). For a manual
//   expense the scale is 1.
// - Split checks (option 1, decided 2026-11-01): other payers don't scan
//   the receipt again; they "Add my payment" to the existing expense
//   (expense_payment rows). Total paid = expense.total + those payments.
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
    `SELECT id, description, merchant, total, receipt_total, tip, type, paid_by
     FROM expense WHERE trip_id = ? ORDER BY created_at DESC`,
    [tripId]
  );

  const { data: items } = useQuery<ItemRow>(
    `SELECT ei.id as id, ei.expense_id as expense_id, ei.description as description,
            ei.price as price, ei.quantity as quantity,
            ei.modifier_of_item_id as modifier_of_item_id, ei.line_order as line_order
     FROM expense_item ei JOIN expense e ON e.id = ei.expense_id
     WHERE e.trip_id = ?
     ORDER BY ei.line_order, ei.created_at`,
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

  const { data: payments } = useQuery<PaymentRow>(
    `SELECT ep.id as id, ep.expense_id as expense_id, ep.person_id as person_id,
            ep.amount as amount, ep.tip as tip
     FROM expense_payment ep JOIN expense e ON e.id = ep.expense_id
     WHERE e.trip_id = ?
     ORDER BY ep.created_at`,
    [tripId]
  );

  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [payerId, setPayerId] = useState<string | undefined>(currentUserId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);

  const [scanBusy, setScanBusy] = useState<null | 'uploading' | 'reading' | 'saving'>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanPaid, setScanPaid] = useState('');
  const [scanTip, setScanTip] = useState('');
  const [scanPayerId, setScanPayerId] = useState<string | undefined>(currentUserId);

  // "Add my payment" form (split checks), open for at most one expense.
  const [payFor, setPayFor] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [payTip, setPayTip] = useState('');
  const [payBusy, setPayBusy] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  // Add-on suggestions the user answered "No" to (this session only).
  const [dismissedAddOns, setDismissedAddOns] = useState<Set<string>>(new Set());

  const memberName = useMemo(() => {
    const map = new Map((members ?? []).map((m) => [m.person_id, m.name]));
    return (personId: string) => map.get(personId) ?? 'Someone';
  }, [members]);

  const itemsByExpense = useMemo(() => {
    const map = new Map<string, ItemRow[]>();
    for (const item of items ?? []) {
      const list = map.get(item.expense_id) ?? [];
      list.push(item);
      map.set(item.expense_id, list);
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

  const paymentsByExpense = useMemo(() => {
    const map = new Map<string, PaymentRow[]>();
    for (const payment of payments ?? []) {
      const list = map.get(payment.expense_id) ?? [];
      list.push(payment);
      map.set(payment.expense_id, list);
    }
    return map;
  }, [payments]);

  const totalPaid = (expense: ExpenseRow) =>
    expense.total +
    (paymentsByExpense.get(expense.id) ?? []).reduce((s, p) => s + p.amount + p.tip, 0);

  // Part of a scanned bill (before tips) that no payer has covered yet.
  const uncovered = (expense: ExpenseRow) => {
    if (expense.type !== 'scanned' || expense.receipt_total == null) return 0;
    const covered =
      expense.total -
      (expense.tip ?? 0) +
      (paymentsByExpense.get(expense.id) ?? []).reduce((s, p) => s + p.amount, 0);
    const left = Math.round((expense.receipt_total - covered) * 100) / 100;
    return left > 0 ? left : 0;
  };

  // Running tally: what each person paid, minus their share of what they
  // claimed (tax/tip included proportionally -- see the money model above).
  // Unclaimed items don't count against anyone yet.
  const balances = useMemo(() => {
    const map = new Map<string, number>();
    for (const member of members ?? []) map.set(member.person_id, 0);
    for (const expense of expenses ?? []) {
      map.set(expense.paid_by, (map.get(expense.paid_by) ?? 0) + expense.total);
      for (const p of paymentsByExpense.get(expense.id) ?? []) {
        map.set(p.person_id, (map.get(p.person_id) ?? 0) + p.amount + p.tip);
      }
      const expenseItems = itemsByExpense.get(expense.id) ?? [];
      const itemSum = expenseItems.reduce((s, i) => s + i.price, 0);
      const scale = itemSum > 0 ? totalPaid(expense) / itemSum : 1;
      for (const item of expenseItems) {
        const itemClaims = claimsByItem.get(item.id) ?? [];
        if (itemClaims.length === 0) continue;
        const share = (item.price * scale) / itemClaims.length;
        for (const claim of itemClaims) {
          map.set(claim.participant_person_id, (map.get(claim.participant_person_id) ?? 0) - share);
        }
      }
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, expenses, itemsByExpense, claimsByItem, paymentsByExpense]);

  // What the current user owes for each expense: their claimed items'
  // prices, scaled for tax/tip exactly like the running tally above.
  const myShareByExpense = useMemo(() => {
    const map = new Map<string, number>();
    if (!currentUserId) return map;
    for (const expense of expenses ?? []) {
      const expenseItems = itemsByExpense.get(expense.id) ?? [];
      const itemSum = expenseItems.reduce((s, i) => s + i.price, 0);
      const scale = itemSum > 0 ? totalPaid(expense) / itemSum : 1;
      let mine = 0;
      for (const item of expenseItems) {
        const itemClaims = claimsByItem.get(item.id) ?? [];
        if (itemClaims.some((c) => c.participant_person_id === currentUserId)) {
          mine += (item.price * scale) / itemClaims.length;
        }
      }
      if (mine > 0) map.set(expense.id, mine);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserId, expenses, itemsByExpense, claimsByItem, paymentsByExpense]);

  // Milestone 3: upload the photo, then have the ocr-receipt Edge Function
  // read it, then show it for review before anything is saved.
  async function uploadReceiptPhoto(uri: string) {
    setScanBusy('uploading');
    setScanError(null);
    setScan(null);
    try {
      const response = await fetch(uri);
      const blob = await response.blob();
      const path = `${tripId}/${uuidv4()}.jpg`;
      const { error: uploadError } = await supabase.storage
        .from('receipts')
        .upload(path, blob, { contentType: 'image/jpeg' });
      if (uploadError) throw uploadError;

      setScanBusy('reading');
      const { data, error: fnError } = await supabase.functions.invoke('ocr-receipt', {
        body: { path },
      });
      if (fnError) throw new Error(await functionErrorMessage(fnError));
      const receipt = data.receipt as OcrReceipt;
      const itemSum = receipt.items.reduce((s, i) => s + i.price, 0);
      const paid = receipt.amount_charged ?? receipt.total ?? itemSum;
      setScan({ path, receipt, problems: data.problems ?? [] });
      setScanPaid(paid.toFixed(2));
      setScanTip(receipt.tip != null ? receipt.tip.toFixed(2) : '');
      setScanPayerId(currentUserId);
    } catch (e) {
      setScanError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanBusy(null);
    }
  }

  async function saveScan() {
    if (!scan) return;
    const paid = parseMoney(scanPaid);
    const tip = parseMoney(scanTip);
    if (paid == null || paid <= 0) {
      setScanError('Enter the amount you paid (before tip).');
      return;
    }
    if (tip == null) {
      setScanError('Tip must be a number (or leave it empty).');
      return;
    }
    if (!scanPayerId) {
      setScanError('Pick who paid.');
      return;
    }
    const r = scan.receipt;
    if (r.items.length === 0) {
      setScanError('No items were found on this receipt.');
      return;
    }

    setScanBusy('saving');
    setScanError(null);
    try {
      const now = new Date().toISOString();
      const parsedDate = r.receipt_date ? new Date(r.receipt_date) : null;
      const expenseDate =
        parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : now;
      const expenseId = uuidv4();
      const idByLine = new Map(r.items.map((i) => [i.line, uuidv4()]));
      // Main items before add-ons, so an add-on's modifier_of_item_id always
      // points at a row that was already inserted (and uploaded) first.
      const ordered = [
        ...r.items.filter((i) => i.modifier_of_line == null || !idByLine.has(i.modifier_of_line)),
        ...r.items.filter((i) => i.modifier_of_line != null && idByLine.has(i.modifier_of_line)),
      ];
      const flagged = [
        ...r.uncertain_fields,
        ...r.items.filter((i) => i.uncertain).map((i) => `item:${i.line}`),
      ];

      await powersync.writeTransaction(async (tx) => {
        await tx.execute(
          `INSERT INTO expense
             (id, trip_id, paid_by, photographed_by, image_url, merchant, description, expense_date,
              type, status, total, receipt_total, tax, tip, needs_review, flagged_fields, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            expenseId,
            tripId,
            scanPayerId,
            currentUserId ?? null,
            scan.path,
            r.merchant,
            r.merchant ?? 'Receipt',
            expenseDate,
            'scanned',
            'pending',
            Math.round((paid + tip) * 100) / 100,
            r.total,
            r.tax ?? 0,
            tip,
            scan.problems.length > 0 ? 1 : 0,
            flagged.length > 0 ? JSON.stringify(flagged) : null,
            now,
          ]
        );
        for (const i of ordered) {
          await tx.execute(
            `INSERT INTO expense_item
               (id, expense_id, description, price, quantity, modifier_of_item_id, line_order, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              idByLine.get(i.line),
              expenseId,
              i.description,
              i.price,
              Math.max(1, Math.round(i.quantity || 1)),
              i.modifier_of_line != null ? idByLine.get(i.modifier_of_line) ?? null : null,
              i.line,
              now,
            ]
          );
        }
      });
      setScan(null);
    } catch (e) {
      setScanError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanBusy(null);
    }
  }

  async function takePhoto() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      setScanError('Camera permission is required to scan a receipt.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.8 });
    if (!result.canceled && result.assets[0]) {
      await uploadReceiptPhoto(result.assets[0].uri);
    }
  }

  async function pickPhoto() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setScanError('Photo library permission is required to choose a receipt.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ quality: 0.8 });
    if (!result.canceled && result.assets[0]) {
      await uploadReceiptPhoto(result.assets[0].uri);
    }
  }

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
          `INSERT INTO expense_item (id, expense_id, description, price, quantity, line_order, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [uuidv4(), expenseId, desc, amountNum, 1, 1, now]
        );
      });
      setDescription('');
      setAmount('');
      setShowManual(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function openPayForm(expense: ExpenseRow) {
    setPayFor(expense.id);
    setPayAmount(uncovered(expense).toFixed(2));
    setPayTip('');
    setPayError(null);
  }

  async function addMyPayment(expense: ExpenseRow) {
    if (!currentUserId) return;
    const amt = parseMoney(payAmount);
    const tip = parseMoney(payTip);
    if (amt == null || amt <= 0) {
      setPayError('Enter the amount you paid (before tip).');
      return;
    }
    if (tip == null) {
      setPayError('Tip must be a number (or leave it empty).');
      return;
    }
    setPayBusy(true);
    setPayError(null);
    try {
      await powersync.execute(
        `INSERT INTO expense_payment (id, expense_id, person_id, amount, tip, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [uuidv4(), expense.id, currentUserId, amt, tip, new Date().toISOString()]
      );
      setPayFor(null);
    } catch (e) {
      setPayError(e instanceof Error ? e.message : String(e));
    } finally {
      setPayBusy(false);
    }
  }

  async function removeMyPayment(payment: PaymentRow) {
    await powersync.execute('DELETE FROM expense_payment WHERE id = ?', [payment.id]);
  }

  // Self-claim only -- the database only allows inserting a claim for
  // yourself (or as a declared sponsor, Stage 1c, not built yet), so each
  // trip member checks off their own items on their own device.
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

  const youClaimed = (itemId: string) =>
    (claimsByItem.get(itemId) ?? []).some((c) => c.participant_person_id === currentUserId);

  function renderScanReview() {
    if (!scan) return null;
    const r = scan.receipt;
    const byLine = new Map(r.items.map((i) => [i.line, i]));
    const saving = scanBusy === 'saving';
    return (
      <View style={styles.reviewCard}>
        <Text style={styles.expenseDescription}>{r.merchant ?? 'Receipt'}</Text>
        {r.items.map((i) => (
          <View key={i.line} style={[styles.itemRow, i.modifier_of_line != null && styles.addOnRow]}>
            <Text style={styles.itemText}>
              {i.modifier_of_line != null ? '+ ' : ''}
              {i.quantity > 1 ? `${i.quantity} × ` : ''}
              {i.description}
              {i.uncertain ? '  ⚠️' : ''}
            </Text>
            <Text style={styles.itemPrice}>{i.price.toFixed(2)}</Text>
          </View>
        ))}
        <Text style={styles.expenseMeta}>
          {r.subtotal != null ? `Subtotal ${r.subtotal.toFixed(2)} · ` : ''}
          {r.tax != null ? `Tax ${r.tax.toFixed(2)} · ` : ''}
          {r.total != null ? `Total ${r.total.toFixed(2)}` : ''}
        </Text>
        {r.items.some((i) => i.modifier_of_line != null && byLine.has(i.modifier_of_line)) ? (
          <Text style={styles.expenseMeta}>Add-ons (+) can be claimed separately.</Text>
        ) : null}
        {scan.problems.map((p) => (
          <Text key={p} style={styles.error}>
            ⚠️ {p}
          </Text>
        ))}
        {r.items.some((i) => i.uncertain) ? (
          <Text style={styles.warning}>⚠️ marks lines that were hard to read. Check them against the receipt.</Text>
        ) : null}
        {r.notes ? <Text style={styles.expenseMeta}>{r.notes}</Text> : null}

        <Text style={[styles.label, { marginTop: 12 }]}>Paid by</Text>
        <View style={styles.typeRow}>
          {(members ?? []).map((member) => (
            <Pressable
              key={member.person_id}
              style={[styles.typeButton, scanPayerId === member.person_id && styles.typeButtonSelected]}
              onPress={() => setScanPayerId(member.person_id)}
              disabled={saving}
            >
              <Text
                style={[
                  styles.typeButtonText,
                  scanPayerId === member.person_id && styles.typeButtonTextSelected,
                ]}
              >
                {member.name}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.label}>Amount paid, before tip</Text>
        {r.amount_charged != null && r.total != null && r.amount_charged !== r.total ? (
          <Text style={styles.warning}>
            Split check: this receipt shows {formatMoney(r.amount_charged)} charged of a{' '}
            {formatMoney(r.total)} bill.
          </Text>
        ) : (
          <Text style={styles.expenseMeta}>Split the bill? Enter just the part you paid.</Text>
        )}
        <TextInput
          style={styles.input}
          keyboardType="decimal-pad"
          value={scanPaid}
          onChangeText={setScanPaid}
          editable={!saving}
        />
        <Text style={styles.label}>Tip you added</Text>
        <TextInput
          style={styles.input}
          keyboardType="decimal-pad"
          placeholder="0.00"
          value={scanTip}
          onChangeText={setScanTip}
          editable={!saving}
        />
        <View style={styles.typeRow}>
          <Pressable
            style={[styles.button, styles.halfButton, styles.cancelButton]}
            onPress={() => setScan(null)}
            disabled={saving}
          >
            <Text style={styles.buttonText}>Discard</Text>
          </Pressable>
          <Pressable style={[styles.button, styles.halfButton]} onPress={saveScan} disabled={saving}>
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Save expense</Text>}
          </Pressable>
        </View>
      </View>
    );
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

            <Text style={styles.sectionTitle}>Scan a receipt</Text>
            <View style={styles.typeRow}>
              <Pressable
                style={[styles.button, styles.halfButton]}
                onPress={takePhoto}
                disabled={scanBusy != null}
              >
                <Text style={styles.buttonText}>Take photo</Text>
              </Pressable>
              <Pressable
                style={[styles.button, styles.halfButton]}
                onPress={pickPhoto}
                disabled={scanBusy != null}
              >
                <Text style={styles.buttonText}>Choose photo</Text>
              </Pressable>
            </View>
            {scanBusy === 'uploading' || scanBusy === 'reading' ? (
              <View style={styles.busyRow}>
                <ActivityIndicator />
                <Text style={styles.expenseMeta}>
                  {scanBusy === 'uploading' ? 'Uploading photo…' : 'Reading receipt… (about 10 seconds)'}
                </Text>
              </View>
            ) : null}
            {scanError ? <Text style={styles.error}>{scanError}</Text> : null}
            {renderScanReview()}

            {!showManual ? (
              <Pressable style={styles.secondaryButton} onPress={() => setShowManual(true)}>
                <Text style={styles.secondaryButtonText}>+ Add a cash expense (no receipt)</Text>
              </Pressable>
            ) : (
            <View>
            <Text style={styles.sectionTitle}>Add a cash expense</Text>
            <Text style={styles.expenseMeta}>For things without a receipt, like a cash tip or a taxi.</Text>
            <TextInput
              style={[styles.input, { marginTop: 8 }]}
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

            <Pressable
              style={[styles.secondaryButton, { marginTop: 8 }]}
              onPress={() => {
                setShowManual(false);
                setError(null);
              }}
              disabled={busy}
            >
              <Text style={styles.secondaryButtonText}>Cancel</Text>
            </Pressable>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            </View>
            )}

            <Text style={styles.sectionTitle}>Expenses</Text>
            {expensesLoading ? <ActivityIndicator style={{ marginTop: 12 }} /> : null}
          </View>
        }
        ListEmptyComponent={
          !expensesLoading ? <Text style={styles.empty}>No expenses yet -- add one above.</Text> : null
        }
        renderItem={({ item: expense }) => {
          const expenseItems = itemsByExpense.get(expense.id) ?? [];
          const itemById = new Map(expenseItems.map((i) => [i.id, i]));
          const extraPayments = paymentsByExpense.get(expense.id) ?? [];
          const left = uncovered(expense);
          const iPaid =
            expense.paid_by === currentUserId ||
            extraPayments.some((p) => p.person_id === currentUserId);

          return (
            <View style={styles.expenseCard}>
              <View style={styles.expenseHeader}>
                <Text style={styles.expenseDescription}>
                  {expense.merchant ?? expense.description ?? 'Expense'}
                </Text>
                <Text style={styles.expenseAmount}>{formatMoney(totalPaid(expense))}</Text>
              </View>
              <Text style={styles.expenseMeta}>
                Paid by {memberName(expense.paid_by)}
                {extraPayments.length > 0 ? ` ${formatMoney(expense.total)}` : ''}
                {expense.tip ? ` · incl. ${formatMoney(expense.tip)} tip` : ''}
              </Text>
              {extraPayments.map((p) => (
                <View key={p.id} style={styles.payerRow}>
                  <Text style={styles.expenseMeta}>
                    Paid by {memberName(p.person_id)} {formatMoney(p.amount + p.tip)}
                    {p.tip ? ` · incl. ${formatMoney(p.tip)} tip` : ''}
                  </Text>
                  {p.person_id === currentUserId ? (
                    <Pressable onPress={() => removeMyPayment(p)}>
                      <Text style={styles.linkText}>Remove</Text>
                    </Pressable>
                  ) : null}
                </View>
              ))}
              {myShareByExpense.has(expense.id) ? (
                <Text style={styles.yourShare}>
                  Your share: {formatMoney(myShareByExpense.get(expense.id)!)}
                  {expenseItems.length > 1 ? ' (incl. tax & tip)' : ''}
                </Text>
              ) : null}
              {left > 0 ? (
                <Text style={styles.warning}>
                  Split check · whole bill {formatMoney(expense.receipt_total!)} ·{' '}
                  {formatMoney(left)} not paid yet
                </Text>
              ) : null}
              {left > 0 && !iPaid && payFor !== expense.id ? (
                <Pressable style={styles.secondaryButtonSmall} onPress={() => openPayForm(expense)}>
                  <Text style={styles.secondaryButtonText}>Add my payment</Text>
                </Pressable>
              ) : null}
              {payFor === expense.id ? (
                <View style={styles.addOnPrompt}>
                  <Text style={styles.label}>Amount you paid, before tip</Text>
                  <TextInput
                    style={styles.input}
                    keyboardType="decimal-pad"
                    value={payAmount}
                    onChangeText={setPayAmount}
                    editable={!payBusy}
                  />
                  <Text style={styles.label}>Tip you added</Text>
                  <TextInput
                    style={styles.input}
                    keyboardType="decimal-pad"
                    placeholder="0.00"
                    value={payTip}
                    onChangeText={setPayTip}
                    editable={!payBusy}
                  />
                  {payError ? <Text style={styles.error}>{payError}</Text> : null}
                  <View style={styles.typeRow}>
                    <Pressable
                      style={[styles.claimButton, styles.cancelButton]}
                      onPress={() => setPayFor(null)}
                      disabled={payBusy}
                    >
                      <Text style={styles.buttonText}>Cancel</Text>
                    </Pressable>
                    <Pressable
                      style={styles.claimButton}
                      onPress={() => addMyPayment(expense)}
                      disabled={payBusy}
                    >
                      <Text style={styles.buttonText}>Save payment</Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}

              {expenseItems.map((it) => {
                const itemClaims = claimsByItem.get(it.id) ?? [];
                const mine = youClaimed(it.id);
                const names = itemClaims.map((c) => memberName(c.participant_person_id)).join(', ');
                const isAddOn = it.modifier_of_item_id != null && itemById.has(it.modifier_of_item_id);
                // Nave's idea (2026-11-01): when you claim an item that has
                // add-ons printed under it, ask whether you had them too.
                const addOnPrompts = mine
                  ? expenseItems.filter(
                      (a) =>
                        a.modifier_of_item_id === it.id &&
                        !youClaimed(a.id) &&
                        !dismissedAddOns.has(a.id)
                    )
                  : [];
                return (
                  <View key={it.id}>
                    <View style={[styles.itemRow, isAddOn && styles.addOnRow]}>
                      <View style={{ flexShrink: 1 }}>
                        <Text style={styles.itemText}>
                          {isAddOn ? '+ ' : ''}
                          {(it.quantity ?? 1) > 1 ? `${it.quantity} × ` : ''}
                          {it.description ?? 'Item'}
                          {'  '}
                          <Text style={styles.itemPrice}>{it.price.toFixed(2)}</Text>
                        </Text>
                        {names ? <Text style={styles.claimedBy}>{names}</Text> : null}
                      </View>
                      <Pressable
                        style={[styles.claimButton, mine && styles.cancelButton]}
                        onPress={() => toggleClaim(it)}
                      >
                        <Text style={styles.buttonText}>{mine ? 'Not mine' : 'Mine'}</Text>
                      </Pressable>
                    </View>
                    {addOnPrompts.map((a) => (
                      <View key={a.id} style={styles.addOnPrompt}>
                        <Text style={styles.itemText}>
                          Did you also have the {a.description} (+{formatMoney(a.price)})?
                        </Text>
                        <View style={styles.typeRow}>
                          <Pressable style={styles.claimButton} onPress={() => toggleClaim(a)}>
                            <Text style={styles.buttonText}>Yes</Text>
                          </Pressable>
                          <Pressable
                            style={[styles.claimButton, styles.cancelButton]}
                            onPress={() => setDismissedAddOns((s) => new Set(s).add(a.id))}
                          >
                            <Text style={styles.buttonText}>No</Text>
                          </Pressable>
                        </View>
                      </View>
                    ))}
                  </View>
                );
              })}
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
  halfButton: { flex: 1 },
  typeButtonText: { color: '#333', fontWeight: '600', fontSize: 13 },
  typeButtonTextSelected: { color: '#fff' },
  button: {
    backgroundColor: '#2f6fed',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  claimButton: {
    backgroundColor: '#2f6fed',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  cancelButton: { backgroundColor: '#999' },
  secondaryButton: {
    borderWidth: 1,
    borderColor: '#2f6fed',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: 16,
  },
  secondaryButtonText: { color: '#2f6fed', fontWeight: '600' },
  secondaryButtonSmall: {
    borderWidth: 1,
    borderColor: '#2f6fed',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
    alignSelf: 'flex-start',
    marginTop: 6,
    marginBottom: 4,
  },
  payerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  linkText: { color: '#2f6fed', fontSize: 13, fontWeight: '600' },
  yourShare: { color: '#2f6fed', fontWeight: '700', marginTop: 4, fontSize: 14 },
  buttonText: { color: '#fff', fontWeight: '600' },
  error: { color: '#d33', marginBottom: 8, marginTop: 4 },
  warning: { color: '#b26a00', marginBottom: 6, marginTop: 2, fontSize: 13 },
  empty: { color: '#888', textAlign: 'center', marginTop: 24 },
  busyRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  reviewCard: {
    borderWidth: 1,
    borderColor: '#2f6fed',
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
  },
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
  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
  },
  addOnRow: { paddingLeft: 16 },
  itemText: { fontSize: 14, color: '#222' },
  itemPrice: { fontSize: 14, color: '#666' },
  claimedBy: { fontSize: 12, color: '#1a8f4c', marginTop: 2 },
  addOnPrompt: {
    backgroundColor: '#f3f6ff',
    borderRadius: 8,
    padding: 10,
    marginTop: 6,
    marginBottom: 4,
    marginLeft: 16,
  },
});
