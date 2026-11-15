import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { get, sendReport } from './api';
import { captureOnce } from './location';
import { parseNumberText } from './format';
import { enqueueReport, flushOutbox } from './reports';
import { randomUUID } from './tracking';
import { colors, fonts, radius, space } from './theme';
import { Body, Button, Card, Empty, Field, Pill, Row, SectionTitle } from './ui';
import { agoText } from './format';
import type { ReportInput, ReportType } from './types';

const types: { id: ReportType; label: string; icon: string }[] = [
  { id: 'visit', label: 'زيارة', icon: '◉' },
  { id: 'order', label: 'طلبية', icon: '▣' },
  { id: 'collection', label: 'تحصيل', icon: '﷼' },
  { id: 'note', label: 'ملاحظة', icon: '✎' },
  { id: 'issue', label: 'مشكلة', icon: '!' },
  { id: 'other', label: 'أخرى', icon: '…' },
];
interface Recent { id: string; title: string; type: ReportType; status: 'new' | 'reviewed'; createdAt: number }

export default function ReportScreen({ onPending }: { onPending?: (value: number) => void }) {
  const [type, setType] = useState<ReportType>('visit');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [customer, setCustomer] = useState('');
  const [amount, setAmount] = useState('');
  const [withLocation, setWithLocation] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<Recent[]>([]);

  async function loadRecent() {
    try {
      const res = await get<{ reports: Recent[] }>('/api/reports');
      setRecent(res.reports.slice(0, 6));
    } catch { /* the form still works offline */ }
  }
  useEffect(() => { void loadRecent(); }, []);

  async function submit() {
    if (title.trim().length < 2) { setError('اكتب عنوانًا قصيرًا للتقرير.'); return; }
    setBusy(true); setError(''); setMessage('');
    const parsedAmount = parseNumberText(amount);
    if (amount.trim() !== '' && (parsedAmount === null || parsedAmount < 0)) {
      setError('المبلغ غير صحيح — اكتب رقمًا (مثال: ٥٠٠ أو 500).'); setBusy(false); return;
    }
    const fix = withLocation ? await captureOnce() : null;
    const payload: ReportInput = {
      id: randomUUID(), type, title: title.trim(), body: body.trim(), customer: customer.trim(),
      amount: parsedAmount,
      location: fix ? { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy } : null,
    };
    try {
      await sendReport(payload);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      setMessage('تم إرسال التقرير للمدير.');
      setTitle(''); setBody(''); setCustomer(''); setAmount('');
      await loadRecent();
    } catch (e) {
      const status = (e as { status?: number }).status ?? 0;
      if (status === 0) {
        await enqueueReport(payload);
        const result = await flushOutbox().catch(() => null);
        onPending?.(result?.pending ?? 0);
        setMessage('لا يوجد اتصال. حفظناه وسيُرسل تلقائيًا.');
        setTitle(''); setBody(''); setCustomer(''); setAmount('');
      } else setError((e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      <View>
        <Text style={styles.title}>تقرير سريع</Text>
        <Text style={styles.sub}>يوصل للمدير فورًا: زيارة، طلبية، تحصيل أو ملاحظة سوق.</Text>
      </View>

      <Card>
        <Text style={styles.label}>نوع التقرير</Text>
        <View style={styles.chips}>
          {types.map(item => (
            <Pressable key={item.id} onPress={() => { Haptics.selectionAsync().catch(() => undefined); setType(item.id); }} style={[styles.chip, type === item.id && styles.chipActive]} accessibilityRole="button" accessibilityState={{ selected: type === item.id }}>
              <Text style={[styles.chipText, type === item.id && styles.chipTextActive]}>{item.icon} {item.label}</Text>
            </Pressable>
          ))}
        </View>
        <Field label="العنوان *" value={title} onChangeText={setTitle} placeholder="زيارة مزرعة النور" />
        <Field label="التفاصيل" value={body} onChangeText={setBody} multiline placeholder="ما تم في الزيارة والخطوة التالية" style={{ minHeight: 84 }} />
        <Row style={{ gap: space.sm }}>
          <View style={{ flex: 1 }}><Field label="العميل" value={customer} onChangeText={setCustomer} placeholder="اسم العميل/المزرعة" /></View>
          <View style={{ flex: 1 }}><Field label="المبلغ (ج.م)" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" style={{ textAlign: 'left' }} /></View>
        </Row>
        <Pressable onPress={() => setWithLocation(!withLocation)} style={styles.toggle} accessibilityRole="checkbox" accessibilityState={{ checked: withLocation }}>
          <View style={[styles.checkbox, withLocation && styles.checkboxOn]}><Text style={styles.checkText}>{withLocation ? '✓' : ''}</Text></View>
          <Text style={styles.toggleLabel}>إرفاق موقعي الحالي مع التقرير</Text>
        </Pressable>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {message ? <Text style={styles.ok}>{message}</Text> : null}
        <Button label="إرسال التقرير" onPress={submit} loading={busy} icon="↗" />
      </Card>

      <Card>
        <SectionTitle title="آخر تقاريري" action={<Pill label={`${recent.length}`} />} />
        {recent.length === 0 ? <Empty title="لا تقارير بعد" hint="أول تقرير بيظهر هنا بحالته." /> : recent.map(item => (
          <View key={item.id} style={styles.recentRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.recentTitle}>{item.title}</Text>
              <Text style={styles.recentMeta}>{agoText(item.createdAt)} · {types.find(t => t.id === item.type)?.label ?? item.type}</Text>
            </View>
            <Pill label={item.status === 'new' ? 'جديد' : 'تمت المراجعة'} tone={item.status === 'new' ? 'warn' : 'mint'} />
          </View>
        ))}
      </Card>
      <Body muted style={{ textAlign: 'center', fontSize: 11 }}>التقارير المرسلة بدون اتصال تُخزَّن على جهازك وتُرسل تلقائيًا.</Body>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: space.lg, paddingBottom: 40, gap: space.md },
  title: { fontFamily: fonts.bold, fontSize: 22, color: colors.green900, textAlign: 'right' },
  sub: { fontFamily: fonts.regular, fontSize: 12, color: colors.muted, textAlign: 'right' },
  label: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.muted, textAlign: 'right' },
  chips: { flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: colors.white },
  chipActive: { backgroundColor: colors.green700, borderColor: colors.green700 },
  chipText: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.green900 },
  chipTextActive: { color: '#fdf8ec' },
  toggle: { flexDirection: 'row-reverse', alignItems: 'center', gap: space.sm, paddingVertical: 4 },
  checkbox: { width: 22, height: 22, borderRadius: 7, borderWidth: 1.5, borderColor: colors.line, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.white },
  checkboxOn: { backgroundColor: colors.green700, borderColor: colors.green700 },
  checkText: { color: '#fdf8ec', fontSize: 13, fontFamily: fonts.bold },
  toggleLabel: { flex: 1, fontFamily: fonts.regular, fontSize: 12.5, color: colors.ink, textAlign: 'right' },
  error: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.danger, textAlign: 'right' },
  ok: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.green700, textAlign: 'right' },
  recentRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: space.sm, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.line },
  recentTitle: { fontFamily: fonts.medium, fontSize: 13, color: colors.ink, textAlign: 'right' },
  recentMeta: { fontFamily: fonts.regular, fontSize: 11, color: colors.muted, textAlign: 'right' },
});
