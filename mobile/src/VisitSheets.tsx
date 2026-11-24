import { useEffect, useMemo, useState } from 'react';
import { agoText, parseNumberText } from './format';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { captureOnce, locationIssueMessage } from './location';
import { getDeviceId } from './device';
import { randomUUID } from './tracking';
import { colors, fonts, radius, space } from './theme';
import { Body, Button, Card, Empty, Field, Row, Sheet } from './ui';
import type { FieldBundle } from './useField';
import { customerStageLabels, visitPurposeLabels, type Customer, type User, type Visit, type VisitPurpose } from './types';

const purposes: VisitPurpose[] = ['visit', 'order', 'collection', 'note', 'issue', 'other'];
const haptic = () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined); };

/** How many rows the picker shows before it asks for a search instead of making him scroll. */
const PICKER_LIMIT = 12;

/**
 * اختيار العميل — the picker a visit and an order share, down to the sentence they must share:
 * «ما تتسجلش على اسم مكتوب بإيدك» is the same rule for both, and two copies of it would drift.
 *
 * The list is the office's book as the server scoped it to this engineer, kept from the last good
 * read when the field has no bars. Search matches name, phone, village and district; past
 * PICKER_LIMIT rows the term has to narrow it — scrolling a farm list with gloves on is not a flow.
 */
export function CustomerPicker({ field, selected, search, onSearch, onSelect }: {
  field: FieldBundle;
  selected: Customer | null;
  search: string;
  onSearch: (value: string) => void;
  onSelect: (customer: Customer | null) => void;
}) {
  const customers = field.customers;
  const matches = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return customers;
    return customers.filter(row => `${row.name} ${row.phone} ${row.village} ${row.district}`.toLowerCase().includes(term));
  }, [customers, search]);
  const shown = matches.slice(0, PICKER_LIMIT);
  if (selected) {
    return (
      <Card tone="mint" style={{ gap: 3 }}>
        <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <Text style={styles.pickName}>{selected.name}</Text>
          <Pressable onPress={() => { haptic(); onSelect(null); }} accessibilityRole="button">
            <Text style={styles.retry}>اختار واحد تاني</Text>
          </Pressable>
        </Row>
        <Text style={styles.pickSub}>
          {[selected.governorate, selected.district, selected.village].filter(Boolean).join(' · ') || 'من غير عنوان في القائمة'}
        </Text>
        {selected.phone ? <Text style={styles.pickPhone}>{selected.phone}</Text> : null}
        <Text style={styles.pickSub}>
          {customerStageLabels[selected.stage] ?? 'عميل'} · {selected.visitCount ? `${selected.visitCount} زيارة` : 'ما اتزارش قبل كده'}
          {selected.lastVisitAt ? ` · آخرها ${agoText(selected.lastVisitAt)}` : ''}
        </Text>
        {selected.notes ? <Text style={styles.pickNote}>ملاحظة المكتب: {selected.notes}</Text> : null}
      </Card>
    );
  }
  if (customers.length === 0) {
    return (
      <Empty
        title={field.customersLoading ? 'جارٍ تحميل قائمتك…' : 'مفيش عملاء في قائمتك'}
        hint={field.customersLoading
          ? 'لو الشبكة ضعيفة، آخر قائمة اتحمّلت هتفضل محفوظة.'
          : 'مدير المبيعات هو اللي بيضيف العملاء في قائمة الشركة وبيحدد مين يخدم كل عميل. اطلب منه يضيفك لهم، وبعدها ارجع هنا.'}
      />
    );
  }
  return (
    <>
      {field.customersNotice ? <Text style={styles.notice}>{field.customersNotice}</Text> : null}
      <Field label="دوّر بالاسم أو التليفون" value={search} onChangeText={onSearch} placeholder="مثال: محمود أو 010" autoCapitalize="none" />
      {matches.length === 0 ? (
        <Text style={styles.error}>مفيش عميل في قائمتك بالاسم ده. لو ده عميل جديد، لازم المكتب يضيفه الأول — الطلبية والزيارة ما يتسجلوش على اسم مكتوب بإيدك.</Text>
      ) : null}
      {shown.map(row => (
        <Pressable key={row.id} onPress={() => onSelect(row)} accessibilityRole="button" style={({ pressed }) => [styles.pickRow, pressed && styles.pickRowPressed]}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.pickName}>{row.name}</Text>
            <Text style={styles.pickSub}>
              {[row.district, row.village].filter(Boolean).join(' · ') || 'من غير منطقة'}
              {row.visitCount ? ` · ${row.visitCount} زيارة` : ' · ما اتزارش'}{row.lastVisitAt ? ` · ${agoText(row.lastVisitAt)}` : ''}
            </Text>
          </View>
          <Text style={styles.pickChev}>◂</Text>
        </Pressable>
      ))}
      {matches.length > shown.length ? <Text style={styles.notice}>في {matches.length - shown.length} عميل تاني — كمّل كتابة في البحث.</Text> : null}
    </>
  );
}

export function CheckInSheet({ visible, onClose, field, user }: { visible: boolean; onClose: () => void; field: FieldBundle; user: User }) {
  const [customerId, setCustomerId] = useState('');
  const [search, setSearch] = useState('');
  const [purpose, setPurpose] = useState<VisitPurpose>('visit');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // The office's list, scoped to this engineer by the server. Nothing here is typed as a name.
  const customers = field.customers;
  const selected = useMemo(() => customers.find(row => row.id === customerId) ?? null, [customers, customerId]);

  useEffect(() => {
    if (!visible) return;
    setCustomerId(''); setSearch(''); setPurpose('visit'); setNotes(''); setError('');
    // Asked for on every open, so a customer the office handed over this morning is on the list before
    // the engineer walks in; if the network is down, loadCustomers keeps the last good copy.
    // The position is read once, at the press that commits — a preview reading on open would make the
    // engineer wait for the satellite twice for one visit, and the fix that matters is the one taken
    // at the moment of the check-in (that is also when the mock-location bit is checked).
    void field.loadCustomers();
  }, [visible]);

  async function submit() {
    if (!selected) { setError('اختار العميل من قائمتك الأول — الزيارة بتتسجل على عميل من قائمة الشركة.'); return; }
    setSaving(true); setError('');
    try {
      // The one and only GPS read of this sheet, taken at the press that commits: maxAgeMs 0 refuses
      // any cached fix, so the mock-location bit is checked at commit time, not at some earlier moment.
      const location = await captureOnce({ maxAgeMs: 0 });
      if (!location) throw new Error(locationIssueMessage() || 'GPS مطلوب — فعّل الموقع وانتظر حتى تثبت الإشارة قبل تسجيل الزيارة.');
      const deviceId = await getDeviceId();
      // The name, phone and area are not sent at all: the server reads them from the customer's row,
      // so a visit and the book cannot end up describing two different farms.
      await field.checkIn({
        id: randomUUID(), customerId: selected.id, purpose, notes: notes.trim(),
        location: { lat: location.lat, lng: location.lng, accuracy: location.accuracy },
        deviceId,
      });
      haptic();
      onClose();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }

  return (
    <Sheet visible={visible} onClose={onClose} title="تسجيل زيارة جديدة">
      <View style={{ gap: 6 }}>
        <Text style={styles.label}>العميل من قائمتك *</Text>
        <CustomerPicker
          field={field}
          selected={selected}
          search={search}
          onSearch={setSearch}
          onSelect={row => { if (!row) { setCustomerId(''); setSearch(''); return; } haptic(); setCustomerId(row.id); }}
        />
      </View>
      <View style={{ gap: 6 }}>
        <Text style={styles.label}>نوع الزيارة</Text>
        <View style={styles.chips}>
          {purposes.map(item => (
            <Pressable key={item} onPress={() => { haptic(); setPurpose(item); }} style={[styles.chip, purpose === item && styles.chipActive]} accessibilityRole="button" accessibilityState={{ selected: purpose === item }}>
              <Text style={[styles.chipText, purpose === item && styles.chipTextActive]}>{visitPurposeLabels[item]}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <Field label="ملاحظات" value={notes} onChangeText={setNotes} multiline placeholder="ملخص سريع قبل الدخول" style={{ minHeight: 70 }} />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button label={saving ? 'جارٍ التسجيل…' : 'تسجيل الحضور في الزيارة'} onPress={submit} loading={saving} icon="✓" />
      <Body muted style={{ fontSize: 11.5 }}>الزيارة المفتوحة واحدة فقط؛ أنهِها قبل تسجيل زيارة جديدة. كل زيارة تُسجَّل بموافقة ضمن ورديتك المفتوحة.</Body>
      <Body muted style={{ fontSize: 11.5 }}>عنوان العميل وتليفونه بيتقروا من قائمة الشركة — لو فيهم غلط، بلّغ المكتب يعدّلهم من شاشة العملاء.</Body>
    </Sheet>
  );
}

export function CheckOutSheet({ visit, onClose, field }: { visit: Visit | null; onClose: () => void; field: FieldBundle }) {
  const [outcome, setOutcome] = useState('');
  const [notes, setNotes] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { setOutcome(''); setNotes(''); setAmount(''); setError(''); }, [visit?.id]);

  if (!visit) return null;
  const isMoney = visit.purpose === 'collection' || visit.purpose === 'order';
  // A visit the system closed (the shift ended, or the phone died) never got its result. The
  // same sheet records it now — the row is already closed, so only the text and the amount go.
  const late = visit.status === 'closed' && Boolean(visit.pendingResult || visit.autoClosed);

  async function submit() {
    // The label already says "*": closing a visit with no result leaves the manager's timeline
    // with a visit that has no outcome, which is the one thing the audit trail needs.
    if (outcome.trim().length < 2) { setError(late ? 'اكتب نتيجة الزيارة.' : 'اكتب نتيجة الزيارة قبل الإنهاء.'); return; }
    setSaving(true); setError('');
    try {
      const location = await captureOnce();
      const locationError = locationIssueMessage();
      if (locationError) throw new Error(locationError);
      const parsedAmount = parseNumberText(amount);
      if (amount.trim() !== '' && (parsedAmount === null || parsedAmount < 0)) throw new Error('المبلغ غير صحيح — اكتب رقمًا (مثال: ٥٠٠ أو 500).');
      await field.checkOut(visit!.id, {
        outcome: outcome.trim(), notes: notes.trim(), amount: parsedAmount,
        location: location ? { lat: location.lat, lng: location.lng, accuracy: location.accuracy } : null,
      });
      haptic();
      onClose();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }

  return (
    <Sheet visible={Boolean(visit)} onClose={onClose} title={`${late ? 'تسجيل نتيجة الزيارة' : 'إنهاء زيارة'} · ${visit.customerName}`}>
      <Field label="نتيجة الزيارة *" value={outcome} onChangeText={setOutcome} multiline placeholder="اتفقنا على توريد ٢٠ كرتونة الأسبوع القادم" style={{ minHeight: 80 }} />
      {isMoney && <Field label="المبلغ المحصَّل (ج.م)" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" style={styles.ltr} hint="يُضاف تلقائيًا إلى تقارير التحصيل في لوحة المدير." />}
      <Field label="ملاحظات إضافية" value={notes} onChangeText={setNotes} multiline style={{ minHeight: 60 }} />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button label={saving ? 'جارٍ الحفظ…' : late ? 'حفظ النتيجة' : 'إنهاء الزيارة وإرسال النتيجة'} onPress={submit} loading={saving} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  label: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.muted, textAlign: 'right' },
  chips: { flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: colors.white },
  chipActive: { backgroundColor: colors.green700, borderColor: colors.green700 },
  chipText: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.green900 },
  chipTextActive: { color: '#fdf8ec' },
  ltr: { textAlign: 'left', writingDirection: 'ltr' },
  retry: { fontFamily: fonts.medium, fontSize: 12, color: colors.green700 },
  error: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.danger, textAlign: 'right' },
  notice: { fontFamily: fonts.regular, fontSize: 12, color: colors.amber, textAlign: 'right' },
  pickRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: space.sm, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, padding: space.md, backgroundColor: colors.white },
  pickRowPressed: { backgroundColor: colors.mint, borderColor: colors.green500 },
  pickName: { fontFamily: fonts.bold, fontSize: 15, color: colors.green900, textAlign: 'right' },
  pickSub: { fontFamily: fonts.regular, fontSize: 12, color: colors.muted, textAlign: 'right' },
  pickPhone: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.green700, textAlign: 'right', writingDirection: 'ltr' },
  pickNote: { fontFamily: fonts.regular, fontSize: 12, color: colors.green900, textAlign: 'right' },
  pickChev: { fontFamily: fonts.medium, fontSize: 15, color: colors.green500 },
});
