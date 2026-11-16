import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useFonts, NotoNaskhArabic_400Regular, NotoNaskhArabic_500Medium, NotoNaskhArabic_700Bold } from '@expo-google-fonts/noto-naskh-arabic';
import './src/trackingTask';
import LoginScreen from './src/LoginScreen';
import HomeScreen from './src/HomeScreen';
import VisitsScreen from './src/VisitsScreen';
import ReportScreen from './src/ReportScreen';
import DailyReports from './src/DailyReports';
import SettingsScreen from './src/SettingsScreen';
import { UNCONFIGURED, me, logout } from './src/api';
import { clearDeviceData, getToken } from './src/storage';
import { createQueue } from './src/queue';
import { flushOutbox } from './src/reports';
import { hhmmss } from './src/format';
import { stopTracking } from './src/tracking';
import { useField } from './src/useField';
import { colors, fonts, space } from './src/theme';
import type { User } from './src/types';

type Tab = 'home' | 'visits' | 'reports' | 'daily' | 'settings';
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'home', label: 'الرئيسية', icon: '◉' },
  { id: 'visits', label: 'الزيارات', icon: '☷' },
  { id: 'reports', label: 'التقارير', icon: '✎' },
  { id: 'daily', label: 'اليومي', icon: '▤' },
  { id: 'settings', label: 'حسابي', icon: '⚙' },
];

export default function App() {
  const [fontsLoaded] = useFonts({ NotoNaskhArabic_400Regular, NotoNaskhArabic_500Medium, NotoNaskhArabic_700Bold });
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {/* The same bundle is served as a web app under /app: keep it in a phone-width column
          instead of stretching edge to edge on a desktop viewport. */}
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
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>('home');
  const [checking, setChecking] = useState(true);

  const onSessionExpired = useCallback(async () => {
    await stopTracking();
    setUser(null);
  }, []);
  const field = useField(user ?? null, onSessionExpired);

  useEffect(() => {
    (async () => {
      try {
        const token = await getToken();
        if (!token) { setUser(null); return; }
        setUser(await me());
      } catch { setUser(null); }
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
        <LoginScreen onLogin={value => { setUser(value); setTab('home'); }} />
      </SafeAreaView>
    );
  }

  const shift = field.summary?.shift ?? null;
  return (
    <View style={styles.screen}>
      <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
        {shift ? <LiveBanner since={shift.started_at} pending={field.pending} trackingActive={field.trackingActive} /> : null}
        {field.error && <View style={styles.errorBar}><Text style={styles.errorText}>{field.error}</Text></View>}
        <View style={styles.body}>
          {tab === 'home' && (
            <HomeScreen
              user={user}
              field={field}
              onOpenVisits={() => setTab('visits')}
              onOpenReports={() => setTab('reports')}
              onOpenDaily={() => setTab('daily')}
            />
          )}
          {tab === 'visits' && <VisitsScreen user={user} field={field} />}
          {tab === 'reports' && <ReportScreen onPending={() => void field.refresh()} />}
          {tab === 'daily' && <DailyReports user={user} onDone={() => void field.refresh()} />}
          {tab === 'settings' && (
            <SettingsScreen
              user={user}
              field={field}
              onLogout={async () => {
                await stopTracking();
                // Anything still queued was written by THIS engineer. Sending it after the next
                // person signs in on the same phone filed their collections under the wrong
                // account, so the queue is drained best-effort and then emptied here.
                await flushOutbox().catch(() => null);
                await logout();
                try { await (await createQueue()).clear(); } catch { /* nothing queued */ }
                await clearDeviceData();
                setUser(null);
              }}
              // The account is already gone on the server, so there is nothing left to log out of.
              onDeleted={async () => { await stopTracking(); await clearDeviceData(); setUser(null); }}
            />
          )}
        </View>
      </SafeAreaView>
      <View style={styles.tabBar}>
        {TABS.map(item => {
          const active = tab === item.id;
          return (
            <Pressable key={item.id} style={styles.tab} onPress={() => setTab(item.id)} accessibilityRole="tab" accessibilityState={{ selected: active }} accessibilityLabel={item.label}>
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
  tabBar: {
    flexDirection: 'row-reverse', backgroundColor: colors.white, borderTopWidth: 1, borderTopColor: colors.line,
    paddingBottom: 8, paddingTop: 8, paddingHorizontal: 6,
  },
  tab: { flex: 1, alignItems: 'center', gap: 3 },
  tabIconWrap: { width: 34, height: 26, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  tabIconActive: { backgroundColor: colors.mint },
  tabIcon: { fontSize: 16, color: colors.muted },
  tabIconTextActive: { color: colors.green700 },
  tabLabel: { fontFamily: fonts.regular, fontSize: 10.5, color: colors.muted },
  tabLabelActive: { fontFamily: fonts.bold, color: colors.green900 },
});
