import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import './src/trackingTask';
import DailyReports from './src/DailyReports';
import { get, login, logout, me, sendReport, shiftState, startShift, stopShift } from './src/api';
import { enqueueReport, flushOutbox } from './src/reports';
import { getActiveShift, getToken } from './src/storage';
import { colors, styles } from './src/styles';
import { currentBattery, onPoint, randomUUID, requestPermissions, startTracking, stopTracking, CONSENT_VERSION } from './src/tracking';
import type { GeoPoint, ReportInput, ReportType, Shift, Snapshot, User } from './src/types';

type Tab = 'track' | 'report' | 'daily' | 'settings';
const reportTypes: { id: ReportType; label: string }[] = [
  { id: 'visit', label: 'زيارة' }, { id: 'order', label: 'طلبية' }, { id: 'collection', label: 'تحصيل' },
  { id: 'note', label: 'ملاحظة' }, { id: 'issue', label: 'مشكلة' }, { id: 'other', label: 'أخرى' },
];
const formatNumber = (value: number) => new Intl.NumberFormat('ar-EG').format(Math.round(value));
const hhmmss = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
};

export default function App() {
  return (
    <SafeAreaProvider>
      <Root />
    </SafeAreaProvider>
  );
}

function Root() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>('track');
  const [shift, setShift] = useState<Shift | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [pending, setPending] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const state = await shiftState();
      setShift(state.shift);
      setSnapshot(state.snapshot);
      if (state.shift) {
        const active = await getActiveShift();
        if (active !== state.shift.id) await startTracking(state.shift.id, { background: true });
      }
      setError('');
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 401) { setUser(null); await stopTracking(); }
      else setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const token = await getToken();
      if (!token) { setUser(null); return; }
      try {
        const found = await me();
        setUser(found);
      } catch { setUser(null); }
    })();
  }, []);

  useEffect(() => {
    if (user) { void refresh(); }
  }, [user, refresh]);

  useEffect(() => {
    if (!shift) { setElapsed(0); return; }
    const timer = setInterval(() => setElapsed(Date.now() - shift.started_at), 1000);
    setElapsed(Date.now() - shift.started_at);
    return () => clearInterval(timer);
  }, [shift]);

  useEffect(() => {
    const update = setInterval(async () => {
      const result = await flushOutbox().catch(() => null);
      if (result) setPending(result.pending);
      if (user && shift) { void refresh(); }
    }, 15000);
    return () => clearInterval(update);
  }, [user, shift, refresh]);

  if (user === undefined) {
    return <View style={styles.center}><ActivityIndicator color={colors.green700} /><Text style={styles.muted}>جارٍ التحقق من الجلسة…</Text></View>;
  }
  if (!user) return <LoginScreen onLogin={setUser} />;

  return (
    <View style={styles.screen}>
      <StatusBar style="dark" />
      <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
        <View style={{ flex: 1 }}>
          {shift ? (
            <View style={styles.live}>
              <Text style={styles.liveText}>● تسجيل الموقع جارٍ · {hhmmss(elapsed)} · {formatNumber(snapshot?.pointCount ?? 0)} نقطة{pending ? ` · ${formatNumber(pending)} في الانتظار` : ''}</Text>
            </View>
          ) : null}
          {error ? <View style={styles.banner}><Text style={styles.bannerText}>{error}</Text></View> : null}
          {tab === 'track' && <TrackingScreen user={user} shift={shift} snapshot={snapshot} pending={pending} elapsed={elapsed} onChanged={refresh} onError={setError} />}
          {tab === 'report' && <ReportScreen user={user} onPending={setPending} />}
          {tab === 'daily' && <DailyReports user={user} />}
          {tab === 'settings' && <SettingsScreen user={user} pending={pending} onPending={setPending} onLogout={async () => { await stopTracking(); await logout(); setUser(null); }} />}
        </View>
      </SafeAreaView>
      <View style={styles.tabBar}>
        {([
          { id: 'track', label: 'تتبعي', icon: '◎' },
          { id: 'report', label: 'تقرير سريع', icon: '✎' },
          { id: 'daily', label: 'التقرير اليومي', icon: '▤' },
          { id: 'settings', label: 'إعداداتي', icon: '⚙' },
        ] as { id: Tab; label: string; icon: string }[]).map(item => (
          <Pressable key={item.id} style={styles.tab} onPress={() => setTab(item.id)} accessibilityRole="tab" accessibilityState={{ selected: tab === item.id }}>
            <Text style={{ fontSize: 18, color: tab === item.id ? colors.green900 : colors.muted }}>{item.icon}</Text>
            <Text style={[styles.tabText, tab === item.id && styles.tabTextActive]}>{item.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function LoginScreen({ onLogin }: { onLogin: (user: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); setError('');
    try { onLogin(await login(email, password)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.screen}>
        <ScrollView contentContainerStyle={[styles.center, { flexGrow: 1 }]} keyboardShouldPersistTaps="handled">
          <View style={{ width: 62, height: 62, borderRadius: 20, backgroundColor: colors.green700, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: '#fdf8ec', fontSize: 30, fontWeight: '700' }}>ه</Text>
          </View>
          <Text style={styles.title}>مهندس مبيعات الهلب</Text>
          <Text style={styles.muted}>سجّل الدخول لبدء وردية الميدان وإرسال التقارير.</Text>
          <View style={[styles.card, { width: '100%' }]}>
            <Text style={styles.label}>البريد الإلكتروني</Text>
            <TextInput style={[styles.input, styles.inputLtr]} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" placeholder="rep@company.com" placeholderTextColor="#9aa79f" />
            <Text style={styles.label}>كلمة المرور</Text>
            <TextInput style={[styles.input, styles.inputLtr]} value={password} onChangeText={setPassword} secureTextEntry placeholder="••••••••" placeholderTextColor="#9aa79f" />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Pressable style={styles.button} onPress={submit} disabled={busy}>
              {busy ? <ActivityIndicator color="#fdf8ec" /> : <Text style={styles.buttonText}>دخول</Text>}
            </Pressable>
          </View>
          <Text style={styles.muted}>لتجربة التتبع الحقيقي: rep@mandoub.test / Demo1234!</Text>
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function TrackingScreen({ user, shift, snapshot, pending, elapsed, onChanged, onError }: {
  user: User; shift: Shift | null; snapshot: Snapshot | null; pending: number; elapsed: number;
  onChanged: () => void; onError: (message: string) => void;
}) {
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [point, setPoint] = useState<GeoPoint | null>(null);
  const lastFix = useRef<number>(0);
  const [battery, setBattery] = useState<number | null>(null);

  useEffect(() => {
    const unsubscribe = onPoint(next => {
      setPoint(next);
      lastFix.current = Date.now();
    });
    void currentBattery().then(setBattery);
    return unsubscribe;
  }, []);

  async function begin() {
    if (!consent) { onError('يجب الموافقة على تسجيل الموقع أثناء الوردية أولًا.'); return; }
    setBusy(true);
    try {
      const permission = await requestPermissions();
      if (!permission.foreground) { onError('لم يتم منح صلاحية الموقع. لا يمكن بدء التتبع بدونها.'); return; }
      const res = await startShift(CONSENT_VERSION);
      await startTracking(res.shift.id, { background: permission.background });
      onChanged();
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function end() {
    setBusy(true);
    try {
      await stopShift();
      await stopTracking();
      await flushOutbox();
      onChanged();
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  }

  const batteryText = battery === null ? '—' : `${formatNumber(battery)}٪`;
  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <View style={styles.between}>
        <Text style={styles.title}>وردية اليوم</Text>
        <View style={styles.row}><View style={[styles.dot, shift && styles.dotLive]} /><Text style={styles.muted}>{shift ? 'تسجيل' : 'متوقف'}</Text></View>
      </View>
      <View style={styles.card}>
        <View style={styles.between}>
          <Text style={styles.h2}>{user.name}</Text>
          <Text style={styles.muted}>{user.region || 'بدون منطقة'}</Text>
        </View>
        <View style={styles.row}>
          <View style={styles.stat}><Text style={styles.statValue}>{shift ? hhmmss(elapsed) : '—'}</Text><Text style={styles.statLabel}>مدة الوردية</Text></View>
          <View style={styles.stat}><Text style={styles.statValue}>{formatNumber((snapshot?.distanceMeters ?? 0) / 1000)}</Text><Text style={styles.statLabel}>كم اليوم</Text></View>
          <View style={styles.stat}><Text style={styles.statValue}>{formatNumber(snapshot?.pointCount ?? 0)}</Text><Text style={styles.statLabel}>نقطة مسجلة</Text></View>
        </View>
        <Text style={styles.muted}>
          {point
            ? `آخر إشارة: ${point.lat.toFixed(5)}, ${point.lng.toFixed(5)} · دقة ${point.accuracy ? Math.round(point.accuracy) : '—'} م · ${new Date(point.recordedAt).toLocaleTimeString('ar-EG')}`
            : snapshot?.location
              ? `آخر موقع محفوظ: ${snapshot.location.lat.toFixed(5)}, ${snapshot.location.lng.toFixed(5)}`
              : 'لم يتم تسجيل موقع بعد.'}
          {'\n'}البطارية: {batteryText}{pending ? ` · ${formatNumber(pending)} عنصر بانتظار الإرسال` : ''}
        </Text>
      </View>

      {!shift ? (
        <View style={styles.card}>
          <Text style={styles.h2}>موافقة صريحة قبل التتبع</Text>
          <Text style={styles.muted}>
            أثناء الوردية فقط، يسجّل التطبيق موقعك كل ثانية تقريبًا ويُرسله إلى لوحة متابعة الهلب. تُحفظ البيانات
            لمدة الاحتفاظ المعلنة (٣٠ يومًا افتراضيًا) ثم تُحذف. يمكنك إيقاف التتبع في أي وقت من هذا الزر،
            ويستمر التسجيل في الخلفية إذا منحت الصلاحية الدائمة.
          </Text>
          <Pressable style={styles.row} onPress={() => setConsent(value => !value)} accessibilityRole="checkbox" accessibilityState={{ checked: consent }}>
            <View style={[styles.chip, consent && { backgroundColor: colors.green700, borderColor: colors.green700 }]}>
              <Text style={[styles.chipText, consent && { color: '#fdf8ec' }]}>{consent ? '✓' : ''}</Text>
            </View>
            <Text style={[styles.muted, { flex: 1 }]}>أوافق على تسجيل موقعي طوال الوردية (إصدار الموافقة {CONSENT_VERSION}).</Text>
          </Pressable>
          <Pressable style={styles.button} onPress={begin} disabled={busy}>
            {busy ? <ActivityIndicator color="#fdf8ec" /> : <Text style={styles.buttonText}>بدء الوردية وتسجيل الموقع</Text>}
          </Pressable>
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.h2}>الوردية مفتوحة</Text>
          <Text style={styles.muted}>بدأت {new Date(shift.started_at).toLocaleTimeString('ar-EG')} · نسخة الموافقة {shift.consent_version}</Text>
          <Pressable style={styles.buttonDanger} onPress={end} disabled={busy}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>إيقاف التتبع وإنهاء الوردية</Text>}
          </Pressable>
        </View>
      )}
      <Pressable style={styles.buttonGhost} onPress={async () => {
        const permission = await Location.getForegroundPermissionsAsync();
        Alert.alert('حالة الصلاحيات', `الموقع: ${permission.status === 'granted' ? 'مسموح' : 'غير مسموح'}\nالمزامنة: ${pending ? `${pending} في الانتظار` : 'كل البيانات مُرسلة'}`);
      }}>
        <Text style={styles.buttonGhostText}>حالة الصلاحيات والمزامنة</Text>
      </Pressable>
    </ScrollView>
  );
}

function ReportScreen({ user, onPending }: { user: User; onPending: (value: number) => void }) {
  const [type, setType] = useState<ReportType>('visit');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [customer, setCustomer] = useState('');
  const [amount, setAmount] = useState('');
  const [withLocation, setWithLocation] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<{ id: string; title: string; status: string }[]>([]);

  useEffect(() => {
    void get<{ reports: { id: string; title: string; status: string }[] }>('/api/reports')
      .then(res => setRecent(res.reports.slice(0, 5))).catch(() => undefined);
  }, [message]);

  async function submit() {
    if (title.trim().length < 2) { setError('اكتب عنوانًا قصيرًا للتقرير.'); return; }
    setBusy(true); setError(''); setMessage('');
    let location: ReportInput['location'] = null;
    if (withLocation) {
      try {
        const permission = await Location.getForegroundPermissionsAsync();
        if (permission.status !== 'granted') await requestPermissions();
        const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        location = { lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy ?? null };
      } catch { location = null; }
    }
    const payload: ReportInput = {
      id: randomUUID(), type, title: title.trim(), body: body.trim(), customer: customer.trim(),
      amount: amount.trim() === '' ? null : Number(amount) || 0, location,
    };
    try {
      await sendReport(payload);
      setMessage('تم إرسال التقرير.');
      setTitle(''); setBody(''); setCustomer(''); setAmount('');
    } catch (e) {
      const status = (e as { status?: number }).status ?? 0;
      if (status === 0) {
        await enqueueReport(payload);
        const result = await flushOutbox().catch(() => null);
        onPending(result?.pending ?? 0);
        setMessage('لا يوجد اتصال. تم حفظ التقرير وسيُرسل تلقائيًا.');
        setTitle(''); setBody(''); setCustomer(''); setAmount('');
      } else setError((e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>تقرير سريع</Text>
      <Text style={styles.muted}>زيارة، طلبية، تحصيل، أو ملاحظة — يُرسل فورًا ويظهر في لوحة المتابعة.</Text>
      <View style={styles.card}>
        <Text style={styles.label}>نوع التقرير</Text>
        <View style={[styles.row, { flexWrap: 'wrap' }]}>
          {reportTypes.map(item => (
            <Pressable key={item.id} style={[styles.chip, type === item.id && styles.chipActive]} onPress={() => setType(item.id)}>
              <Text style={[styles.chipText, type === item.id && styles.chipTextActive]}>{item.label}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.label}>العنوان *</Text>
        <TextInput style={styles.input} value={title} onChangeText={setTitle} placeholder="زيارة مزرعة النور" placeholderTextColor="#9aa79f" />
        <Text style={styles.label}>التفاصيل</Text>
        <TextInput style={[styles.input, { minHeight: 80 }]} value={body} onChangeText={setBody} multiline placeholder="ملخص ما تم في الزيارة" placeholderTextColor="#9aa79f" />
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>العميل</Text>
            <TextInput style={styles.input} value={customer} onChangeText={setCustomer} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>المبلغ (ج.م)</Text>
            <TextInput style={[styles.input, styles.inputLtr]} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
          </View>
        </View>
        <Pressable style={styles.row} onPress={() => setWithLocation(value => !value)}>
          <View style={[styles.chip, withLocation && { backgroundColor: colors.green700, borderColor: colors.green700 }]}>
            <Text style={[styles.chipText, withLocation && { color: '#fdf8ec' }]}>{withLocation ? '✓' : ''}</Text>
          </View>
          <Text style={[styles.muted, { flex: 1 }]}>إرفاق موقعي الحالي مع التقرير</Text>
        </Pressable>
        {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
        {message ? <Text style={styles.ok}>{message}</Text> : null}
        <Pressable style={styles.button} onPress={submit} disabled={busy}>
          {busy ? <ActivityIndicator color="#fdf8ec" /> : <Text style={styles.buttonText}>إرسال التقرير</Text>}
        </Pressable>
      </View>
      <View style={styles.card}>
        <Text style={styles.h2}>آخر تقاريري</Text>
        {recent.length === 0 ? <Text style={styles.muted}>لا توجد تقارير بعد.</Text> : recent.map(item => (
          <View key={item.id} style={styles.tableRow}>
            <Text style={styles.cell}>{item.title}</Text>
            <Text style={[styles.cell, { flex: 0.4, color: item.status === 'new' ? colors.amber : colors.green700 }]}>{item.status === 'new' ? 'جديد' : 'تمت المراجعة'}</Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function SettingsScreen({ user, pending, onPending, onLogout }: { user: User; pending: number; onPending: (value: number) => void; onLogout: () => void }) {
  const pendingText = useMemo(() => (pending ? `${formatNumber(pending)} عنصر بانتظار الإرسال` : 'كل البيانات مُرسلة'), [pending]);
  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <Text style={styles.title}>إعداداتي</Text>
      <View style={styles.card}>
        <Text style={styles.h2}>{user.name}</Text>
        <Text style={styles.muted}>{user.email} · {user.role === 'rep' ? 'مهندس مبيعات' : 'متابعة'}</Text>
        <Text style={styles.muted}>{user.region || 'بدون منطقة'} · {user.phone || 'بدون هاتف'}</Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.h2}>المزامنة</Text>
        <Text style={styles.muted}>{pendingText}</Text>
        <Pressable style={styles.buttonGhost} onPress={async () => {
          const result = await flushOutbox();
          onPending(result.pending);
          Alert.alert('المزامنة', `تم إرسال ${result.sent}${result.pending ? `، وبقي ${result.pending}` : ''}.`);
        }}>
          <Text style={styles.buttonGhostText}>مزامنة الآن</Text>
        </Pressable>
      </View>
      <View style={styles.card}>
        <Text style={styles.h2}>الخصوصية</Text>
        <Text style={styles.muted}>
          يُجمع الموقع أثناء الوردية فقط بعد موافقتك، ويُستخدم لمتابعة المسار الميداني وإعداد التقارير. تُحذف
          النقاط تلقائيًا بعد مدة الاحتفاظ (٣٠ يومًا افتراضيًا). يمكنك إيقاف التتبع في أي وقت، ويُسجَّل كل
          إجراء حساس في سجل التدقيق. لا تُدرج بيانات عملاء حقيقية في الحسابات التجريبية.
        </Text>
      </View>
      <Pressable style={styles.buttonGhost} onPress={onLogout}>
        <Text style={[styles.buttonGhostText, { color: colors.danger }]}>تسجيل الخروج وإيقاف التتبع</Text>
      </Pressable>
      <Text style={[styles.muted, { textAlign: 'center' }]}>الهلب · مهندس مبيعات · إصدار 1.0.0</Text>
    </ScrollView>
  );
}
