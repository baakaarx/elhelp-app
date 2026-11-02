import { useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import * as Location from 'expo-location';
import { sendDailyReport } from './api';
import { enqueueDailyReport, flushOutbox } from './reports';
import { randomUUID } from './tracking';
import { styles, colors } from './styles';
import type { DailyReportInput, DailyVisitInput, User } from './types';

const emptyVisit = (): DailyVisitInput => ({
  customerName: '', governorate: '', district: '', village: '', phone: '',
  areaFeddan: null, crops: '', recommendations: '', outcome: '',
});
function todayInCairo() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(Date.now());
}
function dayName(date: string) {
  const parsed = new Date(`${date}T12:00:00Z`);
  return new Intl.DateTimeFormat('ar-EG', { weekday: 'long', timeZone: 'Africa/Cairo' }).format(parsed);
}
const timeOk = (value: string) => value === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

export default function DailyReports({ user, onDone }: { user: User; onDone?: () => void }) {
  const [engineerName, setEngineerName] = useState(user.name);
  const [reportDate, setReportDate] = useState(todayInCairo());
  const [leftAt, setLeftAt] = useState('');
  const [returnedAt, setReturnedAt] = useState('');
  const [circumstances, setCircumstances] = useState('');
  const [visits, setVisits] = useState<DailyVisitInput[]>([emptyVisit()]);
  const [signedName, setSignedName] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [location, setLocation] = useState<DailyReportInput['location']>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [openVisit, setOpenVisit] = useState(0);
  const dateValid = useMemo(() => /^\d{4}-\d{2}-\d{2}$/.test(reportDate) && reportDate <= todayInCairo(), [reportDate]);

  function update(index: number, patch: Partial<DailyVisitInput>) {
    setVisits(list => list.map((visit, i) => (i === index ? { ...visit, ...patch } : visit)));
  }
  async function capture() {
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') { setError('لم يتم منح صلاحية الموقع.'); return; }
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setLocation({ lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy ?? null });
    } catch { setError('تعذر قراءة الموقع الحالي. يمكنك إرسال التقرير بدون موقع.'); }
  }
  function validate(): string | null {
    if (engineerName.trim().length < 2) return 'اكتب اسم المهندس.';
    if (!dateValid) return 'التاريخ غير صحيح أو في المستقبل.';
    if (!timeOk(leftAt) || !timeOk(returnedAt)) return 'الوقت بصيغة 24 ساعة، مثل 08:30.';
    const valid = visits.filter(v => v.customerName.trim().length >= 2);
    if (!valid.length) return 'أضف زيارة واحدة على الأقل مع اسم العميل / المزرعة.';
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
      signedName: signedName.trim(), confirmed: true, location,
    };
    try {
      await sendDailyReport(payload);
      setMessage('تم إرسال التقرير اليومي بنجاح.');
      setVisits([emptyVisit()]); setCircumstances(''); setLeftAt(''); setReturnedAt(''); setSignedName(''); setConfirmed(false);
      onDone?.();
    } catch (e) {
      const status = (e as { status?: number }).status ?? 0;
      if (status === 0) {
        await enqueueDailyReport(payload);
        setMessage('لا يوجد اتصال. تم حفظ التقرير وسيُرسل تلقائيًا عند عودة الشبكة.');
        setConfirmed(false);
      } else {
        setError((e as Error).message);
      }
    } finally { setBusy(false); }
  }

  return (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>تقرير عمل يومي</Text>
      <Text style={styles.muted}>تقرير واحد لكل يوم، بعدد زيارات غير محدود (حتى ٣٠ زيارة). التوقيع الإلكتروني إلزامي.</Text>
      <View style={styles.card}>
        <Text style={styles.label}>اسم المهندس</Text>
        <TextInput style={styles.input} value={engineerName} onChangeText={setEngineerName} placeholder="الاسم بالكامل" placeholderTextColor="#9aa79f" />
        <View style={styles.between}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>التاريخ (سنة-شهر-يوم)</Text>
            <TextInput style={[styles.input, styles.inputLtr]} value={reportDate} onChangeText={setReportDate} placeholder="2026-05-04" keyboardType="numbers-and-punctuation" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>اليوم</Text>
            <Text style={styles.text}>{dateValid ? dayName(reportDate) : '—'}</Text>
          </View>
        </View>
        <View style={styles.between}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>الخروج للعمل</Text>
            <TextInput style={[styles.input, styles.inputLtr]} value={leftAt} onChangeText={setLeftAt} placeholder="08:30" keyboardType="numbers-and-punctuation" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>الرجوع من العمل</Text>
            <TextInput style={[styles.input, styles.inputLtr]} value={returnedAt} onChangeText={setReturnedAt} placeholder="17:00" keyboardType="numbers-and-punctuation" />
          </View>
        </View>
        <Text style={styles.label}>ظروف طارئة / إجازات</Text>
        <TextInput style={[styles.input, { minHeight: 64 }]} value={circumstances} onChangeText={setCircumstances} multiline placeholder="لا يوجد" placeholderTextColor="#9aa79f" />
      </View>

      {visits.map((visit, index) => (
        <View key={index} style={styles.card}>
          <View style={styles.between}>
            <Text style={styles.h2}>زيارة {index + 1}</Text>
            <View style={styles.row}>
              {visits.length > 1 && (
                <Pressable style={styles.chip} onPress={() => { setVisits(list => list.filter((_, i) => i !== index)); setOpenVisit(0); }}>
                  <Text style={[styles.chipText, { color: colors.danger }]}>حذف</Text>
                </Pressable>
              )}
              <Pressable style={styles.chip} onPress={() => setOpenVisit(openVisit === index ? -1 : index)}>
                <Text style={styles.chipText}>{openVisit === index ? 'إخفاء' : 'تعديل'}</Text>
              </Pressable>
            </View>
          </View>
          {(openVisit === index || visit.customerName.length === 0) && (
            <>
              <Text style={styles.label}>اسم العميل / المزرعة *</Text>
              <TextInput style={styles.input} value={visit.customerName} onChangeText={text => update(index, { customerName: text })} placeholder="مزرعة النور" placeholderTextColor="#9aa79f" />
              <View style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>المحافظة</Text>
                  <TextInput style={styles.input} value={visit.governorate} onChangeText={text => update(index, { governorate: text })} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>المركز</Text>
                  <TextInput style={styles.input} value={visit.district} onChangeText={text => update(index, { district: text })} />
                </View>
              </View>
              <View style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>قرية / منطقة</Text>
                  <TextInput style={styles.input} value={visit.village} onChangeText={text => update(index, { village: text })} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>الهاتف</Text>
                  <TextInput style={[styles.input, styles.inputLtr]} value={visit.phone} onChangeText={text => update(index, { phone: text })} keyboardType="phone-pad" />
                </View>
              </View>
              <View style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>المساحة بالفدان</Text>
                  <TextInput style={[styles.input, styles.inputLtr]} value={visit.areaFeddan === null ? '' : String(visit.areaFeddan)} keyboardType="decimal-pad"
                    onChangeText={text => update(index, { areaFeddan: text.trim() === '' ? null : Number(text) || 0 })} />
                </View>
                <View style={{ flex: 2 }}>
                  <Text style={styles.label}>أهم المحاصيل</Text>
                  <TextInput style={styles.input} value={visit.crops} onChangeText={text => update(index, { crops: text })} placeholder="قمح، برسيم" placeholderTextColor="#9aa79f" />
                </View>
              </View>
              <Text style={styles.label}>التوصيات</Text>
              <TextInput style={[styles.input, { minHeight: 60 }]} value={visit.recommendations} onChangeText={text => update(index, { recommendations: text })} multiline />
              <Text style={styles.label}>نتيجة الزيارة</Text>
              <TextInput style={[styles.input, { minHeight: 60 }]} value={visit.outcome} onChangeText={text => update(index, { outcome: text })} multiline />
            </>
          )}
          {openVisit !== index && visit.customerName.length > 0 && (
            <Text style={styles.muted}>{visit.customerName} · {visit.governorate || 'بدون محافظة'} · {visit.areaFeddan ?? '—'} فدان</Text>
          )}
        </View>
      ))}
      <Pressable style={styles.buttonGhost} onPress={() => { setVisits(list => [...list, emptyVisit()]); setOpenVisit(visits.length); }}>
        <Text style={styles.buttonGhostText}>+ إضافة زيارة</Text>
      </Pressable>

      <View style={styles.card}>
        <Text style={styles.h2}>الموقع والتوقيع</Text>
        <Pressable style={styles.buttonGhost} onPress={capture}>
          <Text style={styles.buttonGhostText}>{location ? `الموقع: ${location.lat.toFixed(5)}, ${location.lng.toFixed(5)} · دقة ${location.accuracy ? Math.round(location.accuracy) : '—'} م` : 'إرفاق موقعي الحالي (اختياري)'}</Text>
        </Pressable>
        <Text style={styles.label}>التوقيع الإلكتروني: اكتب اسمك *</Text>
        <TextInput style={styles.input} value={signedName} onChangeText={setSignedName} placeholder="الاسم كما سيظهر في التقرير" placeholderTextColor="#9aa79f" />
        <Pressable style={styles.row} onPress={() => setConfirmed(value => !value)}>
          <View style={[styles.chip, confirmed && { backgroundColor: colors.green700, borderColor: colors.green700 }]}>
            <Text style={[styles.chipText, confirmed && { color: '#fdf8ec' }]}>{confirmed ? '✓' : ''}</Text>
          </View>
          <Text style={[styles.muted, { flex: 1 }]}>أقر بأن البيانات صحيحة وأن هذا توقيعي الإلكتروني على التقرير.</Text>
        </Pressable>
      </View>

      {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
      {message ? <Text style={styles.ok}>{message}</Text> : null}
      <Pressable style={styles.button} onPress={submit} disabled={busy}>
        {busy ? <ActivityIndicator color="#fdf8ec" /> : <Text style={styles.buttonText}>إرسال التقرير اليومي</Text>}
      </Pressable>
      <Pressable style={styles.buttonGhost} onPress={async () => {
        const result = await flushOutbox();
        Alert.alert('المزامنة', result.pending ? `تم إرسال ${result.sent} وبقي ${result.pending} في الانتظار.` : 'كل البيانات مُرسلة.');
      }}>
        <Text style={styles.buttonGhostText}>مزامنة ما لم يُرسل بعد</Text>
      </Pressable>
    </ScrollView>
  );
}
