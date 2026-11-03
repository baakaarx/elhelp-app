import { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { sendDailyReport } from './api';
import { captureOnce } from './location';
import { enqueueDailyReport, flushOutbox } from './reports';
import { randomUUID } from './tracking';
import { colors, fonts, radius, space } from './theme';
import { Body, Button, Card, Field, Pill, Row, SectionTitle } from './ui';
import type { DailyReportInput, DailyVisitInput, User } from './types';

const emptyVisit = (): DailyVisitInput => ({
  customerName: '', governorate: '', district: '', village: '', phone: '',
  areaFeddan: null, crops: '', recommendations: '', outcome: '',
});
const todayInCairo = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(Date.now());
const dayName = (date: string) => new Intl.DateTimeFormat('ar-EG', { weekday: 'long', timeZone: 'Africa/Cairo' }).format(new Date(`${date}T12:00:00Z`));
const timeOk = (value: string) => value.trim().length === 0 || value.trim().length < 30;

export default function DailyReports({ user, onDone }: { user: User; onDone?: () => void }) {
  const [engineerName, setEngineerName] = useState(user.name);
  const [reportDate, setReportDate] = useState(todayInCairo());
  const [leftAt, setLeftAt] = useState('');
  const [returnedAt, setReturnedAt] = useState('');
  const [circumstances, setCircumstances] = useState('');
  const [visits, setVisits] = useState<DailyVisitInput[]>([emptyVisit()]);
  const [signedName, setSignedName] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [fix, setFix] = useState<{ lat: number; lng: number; accuracy: number | null } | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [openVisit, setOpenVisit] = useState(0);
  const dateValid = useMemo(() => /^\d{4}-\d{2}-\d{2}$/.test(reportDate) && reportDate <= todayInCairo(), [reportDate]);
  const filled = visits.filter(v => v.customerName.trim().length >= 2).length;

  function update(index: number, patch: Partial<DailyVisitInput>) {
    setVisits(list => list.map((visit, i) => (i === index ? { ...visit, ...patch } : visit)));
  }
  function validate(): string | null {
    if (engineerName.trim().length < 2) return 'اكتب اسم المهندس.';
    if (!dateValid) return 'التاريخ غير صحيح أو في المستقبل.';
    if (!timeOk(leftAt) || !timeOk(returnedAt)) return 'الوقت طويل جداً — اختصره.';
    if (!filled) return 'أضف زيارة واحدة على الأقل مع اسم العميل / المزرعة.';
    if (signedName.trim().length < 2) return 'اكتب اسمك في خانة التوقيع.';
    if (!confirmed) return 'أكد صحة البيانات ووقّع إلكترونيًا قبل الإرسال.';
    return null;
  }
  async function submit() {
    const problem = validate();
    if (problem) { setError(problem); return; }
    setBusy(true); setError(''); setMessage('');
    const payload: DailyReportInput = {
      version: 1, id: randomUUID(), engineerName: engineerName.trim(), reportDate,
      leftAt, returnedAt, circumstances: circumstances.trim(),
      visits: visits.filter(v => v.customerName.trim().length >= 2).map(v => ({
        ...v, customerName: v.customerName.trim(), governorate: v.governorate.trim(), district: v.district.trim(),
        village: v.village.trim(), phone: v.phone.trim(), crops: v.crops.trim(),
        recommendations: v.recommendations.trim(), outcome: v.outcome.trim(),
      })),
      signedName: signedName.trim(), confirmed: true, location: fix,
    };
    try {
      await sendDailyReport(payload);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      setMessage('تم إرسال التقرير اليومي للمدير ✅');
      setVisits([emptyVisit()]); setCircumstances(''); setLeftAt(''); setReturnedAt(''); setSignedName(''); setConfirmed(false); setFix(null);
      onDone?.();
    } catch (e) {
      const status = (e as { status?: number }).status ?? 0;
      if (status === 0) {
        await enqueueDailyReport(payload);
        setMessage('لا يوجد اتصال. حفظنا التقرير وسيُرسل تلقائيًا.');
        setConfirmed(false);
      } else setError((e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      <View>
        <Text style={styles.title}>التقرير اليومي</Text>
        <Text style={styles.sub}>نفس ورقة «تقرير عمل يومي» — بتوقيعك الإلكتروني وقابل للتحميل PDF عند المدير.</Text>
      </View>

      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <Pill label={`${filled} زيارة جاهزة`} tone={filled ? 'mint' : 'warn'} />
          <Text style={styles.datePreview}>{dateValid ? dayName(reportDate) : 'تاريخ غير صحيح'}</Text>
        </Row>
        <Field label="اسم المهندس" value={engineerName} onChangeText={setEngineerName} />
        <Row style={{ gap: space.sm }}>
          <View style={{ flex: 1 }}><Field label="التاريخ (YYYY-MM-DD)" value={reportDate} onChangeText={setReportDate} keyboardType="numbers-and-punctuation" style={styles.ltr} /></View>
          <View style={{ flex: 1 }}><Field label="الخروج" value={leftAt} onChangeText={setLeftAt} placeholder="08:30" keyboardType="numbers-and-punctuation" style={styles.ltr} /></View>
          <View style={{ flex: 1 }}><Field label="العودة" value={returnedAt} onChangeText={setReturnedAt} placeholder="17:00" keyboardType="numbers-and-punctuation" style={styles.ltr} /></View>
        </Row>
        <Field label="ظروف طارئة / إجازات" value={circumstances} onChangeText={setCircumstances} multiline placeholder="لا يوجد" style={{ minHeight: 56 }} />
      </Card>

      <SectionTitle title={`الزيارات (${visits.length})`} action={<Pill label="حتى ٣٠ زيارة" />} />
      {visits.map((visit, index) => {
        const open = openVisit === index || visit.customerName.trim().length === 0;
        return (
          <Card key={index} style={{ gap: space.sm }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.visitTitle}>{index + 1}. {visit.customerName.trim() || 'زيارة جديدة'}</Text>
              <Row style={{ gap: 6 }}>
                <Pressable onPress={() => setOpenVisit(open && visit.customerName.trim() ? -1 : index)} style={styles.miniBtn}><Text style={styles.miniBtnText}>{open && visit.customerName.trim() ? 'طي' : 'تعديل'}</Text></Pressable>
                {visits.length > 1 && <Pressable onPress={() => { setVisits(list => list.filter((_, i) => i !== index)); setOpenVisit(0); }} style={styles.miniBtn}><Text style={[styles.miniBtnText, { color: colors.danger }]}>حذف</Text></Pressable>}
              </Row>
            </Row>
            {open ? (
              <>
                <Field label="اسم العميل / المزرعة *" value={visit.customerName} onChangeText={text => update(index, { customerName: text })} placeholder="مزرعة النور" />
                <Row style={{ gap: space.sm }}>
                  <View style={{ flex: 1 }}><Field label="المحافظة" value={visit.governorate} onChangeText={text => update(index, { governorate: text })} /></View>
                  <View style={{ flex: 1 }}><Field label="المركز" value={visit.district} onChangeText={text => update(index, { district: text })} /></View>
                </Row>
                <Row style={{ gap: space.sm }}>
                  <View style={{ flex: 1 }}><Field label="قرية / منطقة" value={visit.village} onChangeText={text => update(index, { village: text })} /></View>
                  <View style={{ flex: 1 }}><Field label="الهاتف" value={visit.phone} onChangeText={text => update(index, { phone: text })} keyboardType="phone-pad" style={styles.ltr} /></View>
                </Row>
                <Row style={{ gap: space.sm }}>
                  <View style={{ flex: 1 }}><Field label="المساحة بالفدان" value={visit.areaFeddan === null ? '' : String(visit.areaFeddan)} keyboardType="decimal-pad" onChangeText={text => update(index, { areaFeddan: text.trim() === '' ? null : Number(text) || 0 })} style={styles.ltr} /></View>
                  <View style={{ flex: 2 }}><Field label="أهم المحاصيل" value={visit.crops} onChangeText={text => update(index, { crops: text })} placeholder="قمح، برسيم" /></View>
                </Row>
                <Field label="التوصيات" value={visit.recommendations} onChangeText={text => update(index, { recommendations: text })} multiline style={{ minHeight: 56 }} />
                <Field label="نتيجة الزيارة" value={visit.outcome} onChangeText={text => update(index, { outcome: text })} multiline style={{ minHeight: 56 }} />
              </>
            ) : (
              <Text style={styles.meta}>{visit.governorate || 'بدون محافظة'} · {visit.areaFeddan ?? '—'} فدان · {visit.outcome || 'بدون نتيجة مسجلة'}</Text>
            )}
          </Card>
        );
      })}
      <Button variant="ghost" label="+ إضافة زيارة للتقرير" onPress={() => { setVisits(list => [...list, emptyVisit()]); setOpenVisit(visits.length); }} />

      <Card tone="mint">
        <SectionTitle title="الموقع والتوقيع" />
        <Row style={{ gap: space.sm }}>
          <Button style={{ flex: 1 }} variant="ghost" label={fix ? `موقع مثبت ±${fix.accuracy ? Math.round(fix.accuracy) : '—'} م` : 'إرفاق موقعي'} onPress={async () => setFix(await captureOnce({ maxAgeMs: 0 }))} />
          {fix ? <Button style={{ flex: 1 }} variant="soft" label="مسح الموقع" onPress={() => setFix(null)} /> : null}
        </Row>
        <Field label="التوقيع الإلكتروني: اكتب اسمك *" value={signedName} onChangeText={setSignedName} placeholder="الاسم كما سيظهر في التقرير" />
        <Pressable onPress={() => setConfirmed(!confirmed)} style={styles.toggle} accessibilityRole="checkbox" accessibilityState={{ checked: confirmed }}>
          <View style={[styles.checkbox, confirmed && styles.checkboxOn]}><Text style={styles.checkText}>{confirmed ? '✓' : ''}</Text></View>
          <Text style={styles.toggleLabel}>أقر بأن البيانات صحيحة وأن هذا توقيعي الإلكتروني على التقرير.</Text>
        </Pressable>
      </Card>

      {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
      {message ? <Text style={styles.ok}>{message}</Text> : null}
      <Button label={busy ? 'جارٍ الإرسال…' : 'إرسال التقرير اليومي'} onPress={submit} loading={busy} icon="↗" />
      <Button variant="ghost" label="مزامنة ما لم يُرسل" onPress={async () => {
        const result = await flushOutbox();
        Alert.alert('المزامنة', result.pending ? `تم إرسال ${result.sent} وبقي ${result.pending}.` : 'كل البيانات مُرسلة.');
      }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: space.lg, paddingBottom: 40, gap: space.md },
  title: { fontFamily: fonts.bold, fontSize: 22, color: colors.green900, textAlign: 'right' },
  sub: { fontFamily: fonts.regular, fontSize: 12, color: colors.muted, textAlign: 'right', lineHeight: 20 },
  datePreview: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.green700 },
  visitTitle: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.ink, textAlign: 'right', flex: 1 },
  meta: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.muted, textAlign: 'right' },
  miniBtn: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, paddingHorizontal: 9, paddingVertical: 3, backgroundColor: colors.white },
  miniBtnText: { fontFamily: fonts.medium, fontSize: 11.5, color: colors.green900 },
  ltr: { textAlign: 'left', writingDirection: 'ltr' },
  toggle: { flexDirection: 'row-reverse', alignItems: 'flex-start', gap: space.sm },
  checkbox: { width: 22, height: 22, borderRadius: 7, borderWidth: 1.5, borderColor: colors.line, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.white },
  checkboxOn: { backgroundColor: colors.green700, borderColor: colors.green700 },
  checkText: { color: '#fdf8ec', fontSize: 13, fontFamily: fonts.bold },
  toggleLabel: { flex: 1, fontFamily: fonts.regular, fontSize: 12.5, color: colors.ink, textAlign: 'right', lineHeight: 20 },
  error: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.danger, textAlign: 'right' },
  ok: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.green700, textAlign: 'right' },
});
