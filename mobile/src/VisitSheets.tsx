import { useEffect, useMemo, useState } from 'react';
import { parseNumberText } from './format';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { captureOnce, locationIssueMessage, type Fix } from './location';
import { getDeviceId } from './device';
import { randomUUID } from './tracking';
import { colors, fonts, radius, space } from './theme';
import { Body, Button, Card, Field, Pill, Row, Sheet } from './ui';
import { useCustomers } from './useCustomers';
import type { FieldBundle } from './useField';
import { customerStageLabels, visitPurposeLabels, type Customer, type User, type Visit, type VisitPurpose } from './types';

const purposes: VisitPurpose[] = ['visit', 'order', 'collection', 'note', 'issue', 'other'];
const haptic = () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined); };

export function CheckInSheet({ visible, onClose, field, user, preset }: { visible: boolean; onClose: () => void; field: FieldBundle; user: User; preset?: Customer }) {
  const [customerName, setCustomerName] = useState('');
  /**
   * The customer row this visit is booked against. Editing the name after picking one clears it:
   * a linked visit takes its name from the master list, and letting a typed name sit in the box
   * while the server silently overwrites it is how an engineer stops trusting the form.
   */
  const [linked, setLinked] = useState<Customer | null>(null);
  const [picking, setPicking] = useState(false);
  const [pickQuery, setPickQuery] = useState('');
  const { customers, unsupported } = useCustomers(visible);
  const [purpose, setPurpose] = useState<VisitPurpose>('visit');
  const [governorate, setGovernorate] = useState('');
  const [district, setDistrict] = useState('');
  const [village, setVillage] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [fix, setFix] = useState<Fix | null>(null);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Twenty rows is what a phone screen can hold without an infinite list; the search box is the
  // way down a long list, and it runs on the copy already in memory so it works with no signal.
  const pickList = useMemo(() => {
    const needle = pickQuery.trim().toLowerCase();
    const list = needle ? customers.filter(item => `${item.name} ${item.phone} ${item.village}`.toLowerCase().includes(needle)) : customers;
    return list.slice(0, 20);
  }, [customers, pickQuery]);

  useEffect(() => {
    if (!visible) return;
    setCustomerName(preset?.name ?? ''); setLinked(preset ?? null); setPicking(false); setPickQuery('');
    setPurpose('visit');
    setGovernorate(preset?.governorate ?? ''); setDistrict(preset?.district ?? ''); setVillage(preset?.village ?? '');
    setPhone(preset?.phone ?? ''); setNotes(''); setError('');
    setLocating(true);
    void captureOnce({ maxAgeMs: 0 }).then(next => {
      setFix(next);
      if (!next) setError(locationIssueMessage() || 'GPS مطلوب — فعّل الموقع قبل تسجيل الزيارة.');
    }).catch(() => setError('تعذر قراءة الموقع. تحقق من أذونات GPS ثم حاول مرة أخرى.')).finally(() => setLocating(false));
  }, [visible]);

  async function submit() {
    if (customerName.trim().length < 2) { setError('اكتب اسم العميل أو المزرعة.'); return; }
    setSaving(true); setError('');
    try {
      // Never reuse the preview fix for the actual check-in: the OS mock bit must be checked at commit time.
      const location = await captureOnce({ maxAgeMs: 0 });
      if (!location) throw new Error(locationIssueMessage() || 'GPS مطلوب — فعّل الموقع وانتظر حتى تثبت الإشارة قبل تسجيل الزيارة.');
      const deviceId = await getDeviceId();
      await field.checkIn({
        id: randomUUID(), customerName: customerName.trim(), ...(linked ? { customerId: linked.id } : {}), purpose,
        governorate: governorate.trim(), district: district.trim(), village: village.trim(), phone: phone.trim(), notes: notes.trim(),
        location: { lat: location.lat, lng: location.lng, accuracy: location.accuracy },
        deviceId,
      } as any);
      haptic();
      onClose();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }

  return (
    <Sheet visible={visible} onClose={onClose} title="تسجيل زيارة جديدة">
      <Field
        label={linked ? 'العميل المختار من قايمعتك' : 'اسم العميل / المزرعة *'}
        value={customerName}
        onChangeText={value => { setCustomerName(value); if (linked && value.trim() !== linked.name) setLinked(null); }}
        placeholder="مزرعة النور" autoFocus
      />
      {!unsupported && customers.length > 0 ? (
        <View style={{ gap: 6 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Pressable onPress={() => { haptic(); setPicking(open => !open); }} accessibilityRole="button" style={styles.pickToggle}>
              <Text style={styles.pickToggleText}>{picking ? 'إلغاء الاختيار' : `اختار من قايمعتي (${customers.length})`}</Text>
            </Pressable>
            {linked ? <Pill label={`مرتبط: ${customerStageLabels[linked.stage]}`} tone="mint" /> : null}
          </Row>
          {picking ? (
            <>
              <Field label="دوّر" value={pickQuery} onChangeText={setPickQuery} placeholder="اسم أو تليفون" autoCorrect={false} />
              {pickList.length === 0 ? <Body muted>مافيش نتيجة في قايمعتك — سجّل الزيارة بالاسم عادي، أو ضيف العميل من تبويب «عملائي».</Body> : (
                <Card style={{ gap: 0, paddingVertical: 4 }}>
                  {pickList.map(item => (
                    <Pressable
                      key={item.id} accessibilityRole="button"
                      onPress={() => {
                        haptic();
                        setLinked(item); setCustomerName(item.name); setPicking(false); setPickQuery('');
                        setGovernorate(item.governorate); setDistrict(item.district); setVillage(item.village); setPhone(item.phone);
                      }}
                      style={styles.pickRow}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={styles.pickName}>{item.name}</Text>
                        <Text style={styles.meta}>
                          {[item.district, item.village].filter(Boolean).join(' · ')}{item.phone ? ` · ${item.phone}` : ''}
                          {` · ${item.visitCount} زيارة`}
                        </Text>
                      </View>
                      <Pill label={customerStageLabels[item.stage]} tone={item.stage === 'lost' ? 'danger' : 'mint'} />
                    </Pressable>
                  ))}
                </Card>
              )}
            </>
          ) : null}
        </View>
      ) : null}
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
      <Row style={{ gap: space.sm }}>
        <View style={{ flex: 1 }}><Field label="المحافظة" value={governorate} onChangeText={setGovernorate} /></View>
        <View style={{ flex: 1 }}><Field label="المركز" value={district} onChangeText={setDistrict} /></View>
      </Row>
      <Row style={{ gap: space.sm }}>
        <View style={{ flex: 1 }}><Field label="قرية / منطقة" value={village} onChangeText={setVillage} /></View>
        <View style={{ flex: 1 }}><Field label="الهاتف" value={phone} onChangeText={setPhone} keyboardType="phone-pad" style={styles.ltr} /></View>
      </Row>
      <Field label="ملاحظات" value={notes} onChangeText={setNotes} multiline placeholder="ملخص سريع قبل الدخول" style={{ minHeight: 70 }} />
      <View style={styles.fixRow}>
        <Pill label={locating ? 'جارٍ تحديد موقعك…' : fix ? `تم تثبيت الموقع ±${fix.accuracy ? Math.round(fix.accuracy) : '—'} م` : 'بدون موقع'} tone={fix ? 'mint' : 'warn'} />
        <Pressable onPress={async () => {
          setLocating(true); setError('');
          try {
            const next = await captureOnce({ maxAgeMs: 0 });
            setFix(next);
            if (!next) setError(locationIssueMessage() || 'GPS مطلوب — فعّل الموقع قبل تسجيل الزيارة.');
          } catch { setError('تعذر قراءة الموقع. تحقق من أذونات GPS ثم حاول مرة أخرى.'); }
          finally { setLocating(false); }
        }}>
          <Text style={styles.retry}>تحديث الموقع</Text>
        </Pressable>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button label={saving ? 'جارٍ التسجيل…' : 'تسجيل الحضور في الزيارة'} onPress={submit} loading={saving} icon="✓" />
      <Body muted style={{ fontSize: 11.5 }}>الزيارة المفتوحة واحدة فقط؛ أنهِها قبل تسجيل زيارة جديدة. كل زيارة تُسجَّل بموافقة ضمن ورديتك المفتوحة.</Body>
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
  pickToggle: { borderWidth: 1, borderColor: colors.green700, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 6 },
  pickToggleText: { fontFamily: fonts.medium, fontSize: 11.5, color: colors.green700 },
  pickRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: space.sm, paddingVertical: 9, borderTopWidth: 1, borderTopColor: colors.line },
  pickName: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.ink, textAlign: 'right' },
  meta: { fontFamily: fonts.regular, fontSize: 11, color: colors.muted, textAlign: 'right' },
  label: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.muted, textAlign: 'right' },
  chips: { flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: colors.white },
  chipActive: { backgroundColor: colors.green700, borderColor: colors.green700 },
  chipText: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.green900 },
  chipTextActive: { color: '#fdf8ec' },
  ltr: { textAlign: 'left', writingDirection: 'ltr' },
  fixRow: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' },
  retry: { fontFamily: fonts.medium, fontSize: 12, color: colors.green700 },
  error: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.danger, textAlign: 'right' },
});
