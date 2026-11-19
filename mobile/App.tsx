import { Component, useCallback, useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

// Show JS errors on screen (even in release builds) so crashes are diagnosable.
type ErrorHandler = (error: unknown, isFatal?: boolean) => void;
const errorUtils = (global as unknown as { ErrorUtils?: { setGlobalHandler: (fn: ErrorHandler) => void; getGlobalHandler?: () => ErrorHandler } }).ErrorUtils;
const originalHandler = errorUtils?.getGlobalHandler?.();
errorUtils?.setGlobalHandler((error, isFatal) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error('[app] fatal error', message);
  Alert.alert('خطأ في التطبيق', message.slice(0, 500), [{ text: 'حسناً' }]);
  originalHandler?.(error, isFatal);
});
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useFonts, NotoNaskhArabic_400Regular, NotoNaskhArabic_500Medium, NotoNaskhArabic_700Bold } from '@expo-google-fonts/noto-naskh-arabic';
import './src/trackingTask';
import './src/watchdogTask';
import LoginScreen from './src/LoginScreen';
import HomeScreen from './src/HomeScreen';
import VisitsScreen from './src/VisitsScreen';
import ReportScreen from './src/ReportScreen';
import DailyReports from './src/DailyReports';
import SettingsScreen from './src/SettingsScreen';
import { UNCONFIGURED, me, logout } from './src/api';
import { clearDeviceData, getToken } from './src/storage';
import { activateOutboxUser, clearOutbox, deactivateOutboxUser, flushOutbox } from './src/reports';
import { hhmmss } from './src/format';
import { stopTracking } from './src/tracking';
import { useField } from './src/useField';
import { onMockLocationDetected, MOCK_LOCATION_MESSAGE } from './src/location';
import { initializePushHandling } from './src/push';
import { colors, fonts, radius, space } from './src/theme';
import type { User } from './src/types';

type Tab = 'home' | 'visits' | 'reports' | 'daily' | 'settings';
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'home', label: 'الرئيسية', icon: '◉' },
  { id: 'visits', label: 'الزيارات', icon: '☷' },
  { id: 'reports', label: 'التقارير', icon: '✎' },
  { id: 'daily', label: 'اليومي', icon: '▤' },
  { id: 'settings', label: 'حسابي', icon: '⚙' },
];

/**
 * A render error in one tab must not take the whole app down. The boundary keeps the
 * bottom navigation alive and sends the engineer back to the home tab instead.
 */
class ScreenBoundary extends Component<{ children: ReactNode; onReset: () => void }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.warn('[app] screen error', error); }
  render() {
    if (this.state.error) {
      return (
        <View style={styles.screenError}>
          <Text style={styles.screenErrorTitle}>تعذر فتح هذه الشاشة</Text>
          <Text style={styles.screenErrorText}>حدثت مشكلة أثناء عرض البيانات. ارجع للرئيسية وحاول مرة أخرى.</Text>
          <Pressable
            onPress={() => { this.setState({ error: null }); this.props.onReset(); }}
            accessibilityRole="button"
            accessibilityLabel="العودة للرئيسية"
            style={styles.screenErrorButton}
          >
            <Text style={styles.screenErrorButtonText}>العودة للرئيسية</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const [fontsLoaded] = useFonts({ NotoNaskhArabic_400Regular, NotoNaskhArabic_500Medium, NotoNaskhArabic_700Bold });
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {/* Expo can render a local web preview during development, but production engineers use
          the native phone app; keep the preview phone-sized if a developer opens it on desktop. */}
      <View style={styles.shell}>
        <View style={styles.frame}>
          {fontsLoaded ? <Root /> : (
            <View style={styles.loading}><ActivityIndicator color={colors.green700} size="large" /></View>
          )}
        </View>
      </View>
    </SafeAreaProvider>
  );
}

function Root() {
  const insets = useSafeAreaInsets();
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>('home');
  const [pushRefresh, setPushRefresh] = useState(0);
  const [checking, setChecking] = useState(true);

  const onSessionExpired = useCallback(async () => {
    await stopTracking();
    await deactivateOutboxUser();
    setUser(null);
  }, []);
  const field = useField(user ?? null, onSessionExpired);
  const selectTab = useCallback((next: Tab) => {
    setTab(next);
    // Visits and reports are the tabs engineers open most; refresh them on entry so a
    // stale poll never looks like a broken button.
    if (next === 'visits' || next === 'reports') void field.refresh();
  }, [field.refresh]);

  const completeLogout = useCallback(async () => {
    await stopTracking().catch(() => undefined);
    // If the phone is offline the server call can fail, but logout() still erases the local token.
    try { await logout(); } catch { /* the next login remains available without a network call */ }
    try { await clearOutbox(); } catch { /* no queue or local store unavailable */ }
    await clearDeviceData();
    setUser(null);
  }, []);

  const requestLogout = useCallback(async (ownerId: string) => {
    const result = await flushOutbox(ownerId).catch(() => null);
    if (!result || result.pending > 0) {
      const detail = result
        ? `ما زال هناك ${result.pending} عنصر محفوظ على الهاتف ولم يصل إلى السيرفر. ابقَ داخل الحساب وجرّب المزامنة، أو سجّل الخروج بعد تأكيد حذف البيانات المعلّقة.`
        : 'تعذر التأكد من حالة المزامنة. يمكنك البقاء داخل الحساب والمحاولة لاحقًا، أو تسجيل الخروج بعد تأكيد حذف البيانات المعلّقة.';
      Alert.alert('بيانات لم تتم مزامنتها', detail, [
        { text: 'البقاء في الحساب', style: 'cancel' },
        { text: 'تسجيل الخروج وحذف المعلّق', style: 'destructive', onPress: () => { void completeLogout(); } },
      ]);
      return;
    }
    await completeLogout();
  }, [completeLogout]);

  useEffect(() => {
    const unsubscribe = onMockLocationDetected(() => Alert.alert('تم اكتشاف موقع محاكى', MOCK_LOCATION_MESSAGE));
    void initializePushHandling().catch(() => undefined);
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    let active = true;
    let subscription: { remove: () => void } | undefined;
    const openForNotification = (response: import('expo-notifications').NotificationResponse) => {
      const data = response.notification.request.content.data as { type?: string };
      if (data.type === 'report_reviewed') { setTab('reports'); setPushRefresh(value => value + 1); }
      else if (data.type === 'daily_report_reviewed') setTab('daily');
      void field.refresh();
    };
    void import('expo-notifications').then(async Notifications => {
      if (!active) return;
      subscription = Notifications.addNotificationResponseReceivedListener(openForNotification);
      const last = await Notifications.getLastNotificationResponseAsync();
      if (active && last) {
        openForNotification(last);
        await Notifications.clearLastNotificationResponseAsync();
      }
    }).catch(() => undefined);
    return () => { active = false; subscription?.remove(); };
  }, [field.refresh]);

  useEffect(() => {
    (async () => {
      try {
        const token = await getToken();
        if (!token) { await deactivateOutboxUser(); setUser(null); return; }
        const signedIn = await me();
        await activateOutboxUser(signedIn.id);
        setUser(signedIn);
      } catch { await deactivateOutboxUser(); setUser(null); }
      finally { setChecking(false); }
    })();
  }, []);

  if (UNCONFIGURED) {
    return (
      <View style={styles.loading}>
        <Text style={[styles.loadingText, { maxWidth: 320, textAlign: 'center', fontSize: 14, lineHeight: 24 }]}>
          النسخة المثبَّتة دي مش مربوطة بسيرفر الشركة، فمش هينفع تسجّل الدخول.
          كلّم المسؤول عن نشر التطبيق يعيد بناءها بعنوان السيرفر.
        </Text>
      </View>
    );
  }

  if (checking || user === undefined) {
    return <View style={styles.loading}><ActivityIndicator color={colors.green700} /><Text style={styles.loadingText}>جارٍ التحقق من الجلسة…</Text></View>;
  }
  if (!user) {
    return (
      <SafeAreaView style={styles.screen} edges={['top', 'left', 'right', 'bottom']}>
        <StatusBar style="light" />
        <LoginScreen onLogin={value => {
          void activateOutboxUser(value.id).catch(() => undefined).then(() => { setUser(value); setTab('home'); });
        }} />
      </SafeAreaView>
    );
  }

  const shift = field.summary?.shift ?? null;
  return (
    <View style={styles.screen}>
      <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
        {shift ? <LiveBanner since={shift.started_at} pending={field.pending} trackingActive={field.trackingActive} /> : null}
        {/* The sync warning is app-wide (a phone clock the server refuses), so it lives in the
            top bar where every tab shows it — not inside one screen's card. */}
        {field.syncNotice || field.offlineNotice || field.backgroundNotice ? (
          <View style={[styles.errorBar, styles.noticeBar]}>
            <Text style={styles.noticeText}>⚠ {[field.syncNotice, field.offlineNotice, field.backgroundNotice].filter(Boolean).join(' ')}</Text>
          </View>
        ) : null}
        {field.error && <View style={styles.errorBar}><Text style={styles.errorText}>{field.error}</Text></View>}
        <View style={styles.body}>
          <ScreenBoundary key={tab} onReset={() => setTab('home')}>
            {tab === 'home' && (
              <HomeScreen
                user={user}
                field={field}
                onOpenVisits={() => selectTab('visits')}
                onOpenReports={() => selectTab('reports')}
                onOpenDaily={() => selectTab('daily')}
              />
            )}
            {tab === 'visits' && <VisitsScreen user={user} field={field} />}
            {tab === 'reports' && <ReportScreen ownerId={user.id} onPending={() => void field.refresh()} refreshKey={pushRefresh} />}
            {tab === 'daily' && <DailyReports user={user} onDone={() => void field.refresh()} timezone={field.summary?.timezone} />}
            {tab === 'settings' && (
              <SettingsScreen
                user={user}
                field={field}
                onLogout={() => { void requestLogout(user.id); }}
                // The server has deleted the account. Stop all producers before clearing its on-device work.
                onDeleted={async () => {
                  await stopTracking().catch(() => undefined);
                  await deactivateOutboxUser();
                  setUser(null);
                  let outboxCleared = true;
                  try { await clearOutbox(); } catch { outboxCleared = false; }
                  await clearDeviceData();
                  if (!outboxCleared) {
                    Alert.alert('تم حذف الحساب', 'لكن تعذر محو بعض البيانات المعلقة من الهاتف. لا تسجّل الدخول بحساب آخر على هذا الجهاز قبل التواصل مع المسؤول.');
                  }
                }}
              />
            )}
          </ScreenBoundary>
        </View>
      </SafeAreaView>
      <View style={[styles.tabBar, { paddingBottom: Math.max(8, insets.bottom) }]}>
        {TABS.map(item => {
          const active = tab === item.id;
          return (
            <Pressable
              key={item.id}
              style={({ pressed }) => [styles.tab, pressed && styles.tabPressed]}
              onPress={() => selectTab(item.id)}
              hitSlop={10}
              android_ripple={{ borderless: true }}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={item.label}
            >
              <View style={[styles.tabIconWrap, active && styles.tabIconActive]}>
                <Text style={[styles.tabIcon, active && styles.tabIconTextActive]}>{item.icon}</Text>
              </View>
              <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{item.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function LiveBanner({ since, pending, trackingActive }: { since: number; pending: number; trackingActive: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return (
    <View style={styles.liveBar}>
      <View style={styles.liveDot} />
      <Text style={styles.liveText}>{trackingActive ? 'تسجيل الموقع شغّال' : 'الوردية مفتوحة، استأنف تسجيل الموقع'} · {hhmmss(now - since)}</Text>
      {pending > 0 ? <Text style={styles.livePending}>{pending} بالانتظار</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  shell: { flex: 1, backgroundColor: '#dde6ee', alignItems: 'center' },
  frame: {
    flex: 1, width: '100%', maxWidth: 540, backgroundColor: colors.cream, overflow: 'hidden',
    ...(Platform.OS === 'web' ? { boxShadow: '0 26px 80px rgba(7,23,38,0.18)' } : null),
  },
  screen: { flex: 1, backgroundColor: colors.cream },
  safe: { flex: 1 },
  body: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.sm, backgroundColor: colors.cream },
  loadingText: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.muted },
  liveBar: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8, backgroundColor: colors.green900, paddingHorizontal: space.lg, paddingVertical: 7 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#7ee2a8' },
  liveText: { flex: 1, fontFamily: fonts.medium, fontSize: 12, color: '#e8f3ea', textAlign: 'right' },
  livePending: { fontFamily: fonts.regular, fontSize: 11, color: '#f5e6c8' },
  errorBar: { backgroundColor: colors.dangerSoft, paddingHorizontal: space.lg, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#efcaca' },
  errorText: { fontFamily: fonts.regular, fontSize: 12, color: colors.danger, textAlign: 'right' },
  noticeBar: { backgroundColor: '#fdf3d7', borderBottomColor: '#e8d08a' },
  noticeText: { fontFamily: fonts.regular, fontSize: 12, color: '#7a5a12', textAlign: 'right', lineHeight: 19 },
  screenError: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.sm, padding: space.xl, backgroundColor: colors.cream },
  screenErrorTitle: { fontFamily: fonts.bold, fontSize: 17, color: colors.green900, textAlign: 'center' },
  screenErrorText: { fontFamily: fonts.regular, fontSize: 13, color: colors.muted, textAlign: 'center', lineHeight: 22 },
  screenErrorButton: { marginTop: space.sm, borderRadius: radius.md, backgroundColor: colors.green700, paddingHorizontal: 18, paddingVertical: 12 },
  screenErrorButtonText: { fontFamily: fonts.bold, fontSize: 14, color: '#fdf8ec' },
  tabBar: {
    flexDirection: 'row-reverse', backgroundColor: colors.white, borderTopWidth: 1, borderTopColor: colors.line,
    paddingBottom: 8, paddingTop: 8, paddingHorizontal: 6, elevation: 8, zIndex: 10,
  },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, minHeight: 56, borderRadius: 12 },
  tabPressed: { backgroundColor: colors.mint },
  tabIconWrap: { width: 34, height: 26, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  tabIconActive: { backgroundColor: colors.mint },
  tabIcon: { fontSize: 16, color: colors.muted },
  tabIconTextActive: { color: colors.green700 },
  tabLabel: { fontFamily: fonts.regular, fontSize: 10.5, color: colors.muted },
  tabLabelActive: { fontFamily: fonts.bold, color: colors.green900 },
});
