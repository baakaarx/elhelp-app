import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { colors, fonts } from './theme';
import { Body, Button, Card, Field, Sheet } from './ui';
import { CustomerPicker } from './VisitSheets';
import { randomUUID } from './tracking';
import type { FieldBundle } from './useField';
import type { OrderView, Visit } from './types';
import { myOrders } from './api';

/** The engineer writes the recommendation; sales later selects and prices actual products. */
export default function OrderSheet({ visible, onClose, field, visit, onSubmitted }: { visible: boolean; onClose: () => void; field: FieldBundle; visit?: Visit | null; onSubmitted: (result: 'sent' | 'queued') => void }) {
  const [customerId, setCustomerId] = useState('');
  const [search, setSearch] = useState('');
  const [recommendation, setRecommendation] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const [history, setHistory] = useState<OrderView[]>([]);
  const [historyError, setHistoryError] = useState('');
  const selected = useMemo(() => field.customers.find(row => row.id === customerId) ?? null, [field.customers, customerId]);

  useEffect(() => {
    if (!visible) return;
    setCustomerId(visit?.customerId ?? ''); setSearch(''); setRecommendation(''); setNotes(''); setError('');
    void field.loadCustomers();
    let active = true;
    setHistory([]); setHistoryError('');
    void myOrders().then(result => { if (active) setHistory(result.orders); })
      .catch(() => { if (active) setHistoryError('تعذر تحميل الطلبيات السابقة — حاول لما الشبكة ترجع.'); });
    return () => { active = false; };
  }, [visible]);

  async function submit() {
    if (submitting.current) return;
    if (!selected) { setError('اختار العميل من قائمتك الأول.'); return; }
    if (!recommendation.trim()) { setError('اكتب ترشيحك والأصناف والكميات المطلوبة الأول.'); return; }
    submitting.current = true; setSaving(true); setError('');
    try {
      const result = await field.submitOrder({
        id: randomUUID(), customerId: selected.id, notes: notes.trim(), recommendation: recommendation.trim(), lines: [], send: true,
        ...(visit?.customerId === selected.id ? { visitId: visit.id } : {}),
      });
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
      onSubmitted(result); onClose();
    } catch (e) { setError((e as Error).message); }
    finally { submitting.current = false; setSaving(false); }
  }

  return <Sheet visible={visible} onClose={() => { if (!saving) onClose(); }} title="تسجيل طلبية">
    <View style={{ gap: 6 }}>
      <Text style={styles.label}>العميل من قائمتك *</Text>
      <CustomerPicker field={field} selected={selected} search={search} onSearch={setSearch} onSelect={row => { setCustomerId(row?.id ?? ''); if (!row) setSearch(''); }} />
    </View>
    <Field label="ترشيحك للعميل والأصناف والكميات المطلوبة *" value={recommendation} onChangeText={setRecommendation} multiline maxLength={4000} placeholder="مثال: ٢٠ مبيد حشري فرتاك" style={{ minHeight: 110, textAlignVertical: 'top' }} />
    <Body muted>اكتب الترشيح زي ما اتفقت مع العميل. المبيعات تختار الأصناف وتحدد الكميات والأسعار عند تجهيز الفاتورة.</Body>
    <Field label="ملاحظة على التسليم (اختياري)" value={notes} onChangeText={setNotes} multiline maxLength={2000} placeholder="مثال: التسليم السبت الصبح" style={{ minHeight: 60 }} />
    {error ? <Text style={styles.error}>{error}</Text> : null}
    <Button label={saving ? 'جارٍ الإرسال…' : 'ابعت الطلبية للمكتب'} onPress={submit} loading={saving} icon="➤" />
    <View style={{ gap: 6 }}>
      <Text style={styles.label}>طلبياتك السابقة</Text>
      {historyError ? <Text style={styles.notice}>{historyError}</Text> : null}
      {history.slice(0, 10).map(order => <Card key={order.id} tone="plain">
        <Text style={styles.name}>{order.customerName} · {order.sold ? 'اتسجلت لها فاتورة' : order.status === 'draft' ? 'مسودة' : 'اتبعتت للمكتب'}</Text>
        {order.recommendation ? <Text style={styles.detail}>{order.recommendation}</Text> : <Text style={styles.detail}>{order.lines.map(line => `${line.productName}: ${line.qty} ${line.unit} ${line.unitSize}`).join(' · ')}</Text>}
      </Card>)}
    </View>
    <Body muted>لو الشبكة قطعت، الطلبية محفوظة للمزامنة؛ لو السيرفر رفضها راجع الرسالة ولا تكررها.</Body>
  </Sheet>;
}
const styles = StyleSheet.create({
  label: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.green900, writingDirection: 'rtl' },
  notice: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.muted },
  error: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.danger, textAlign: 'right' },
  name: { fontFamily: fonts.bold, fontSize: 14, color: colors.ink, textAlign: 'right' },
  detail: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.muted, textAlign: 'right' },
});
