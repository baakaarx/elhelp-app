import { useState } from 'react';
import { Image, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View, Pressable } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { login, socialLogin } from './api';
import { getDeviceId, getDeviceName } from './device';
import { colors, fonts, radius, shadow, space } from './theme';
import { Button, Field } from './ui';
import type { User } from './types';

/**
 * Engineer sign-in.
 *
 * The engineer app is also shipped as a web build under /app, so the layout has to survive a
 * desktop viewport: everything lives in a centred column instead of stretching edge to edge.
 * On the phone the same column simply fills the screen.
 */
export default function LoginScreen({ onLogin }: { onLogin: (user: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!email.trim() || !password) { setError('أدخل البريد وكلمة المرور.'); return; }
    setBusy(true); setError('');
    try { onLogin(await login(email, password)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function handleSocial(provider: 'google' | 'apple') {
    // On web: Google Identity Services would provide id_token; on native: expo-auth-session
    // For now we prompt for token in dev, and show pending-approval guidance
    // In production, replace with proper OAuth flow using EXPO_PUBLIC_GOOGLE_CLIENT_ID
    setError('');
    // If running on web with GIS available, try to use it, otherwise prompt
    const w = typeof window !== 'undefined' ? (window as any) : null;
    if (w?.google?.accounts?.id && provider === 'google') {
      try { w.google.accounts.id.prompt(); return; } catch {}
    }
    // Fallback: simple prompt for testing — manager can later configure real OAuth
    const token = typeof window !== 'undefined' ? window.prompt(provider === 'google' ? 'الصق Google ID Token (للاختبار) — في الإنتاج سيُفتح تسجيل Google تلقائياً بعد إعداد VITE_GOOGLE_CLIENT_ID' : 'الصق Apple ID Token (للاختبار)') : null;
    if (!token) {
      setError(provider === 'google' ? 'لتفعيل Google ضع GOOGLE_CLIENT_ID في Vercel، أو الصق التوكن للاختبار' : 'لتفعيل Apple ضع Apple Client ID في Vercel');
      return;
    }
    setBusy(true);
    try {
      const deviceId = await getDeviceId();
      const deviceName = await getDeviceName();
      const user = await socialLogin(provider, token.trim(), deviceId, deviceName);
      onLogin(user);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.screen}>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Image source={require('../assets/login-scene.jpg')} style={styles.scene} resizeMode="cover" />
        <LinearGradient
          colors={['rgba(4,18,30,0.72)', 'rgba(4,18,30,0.93)', '#04121e']}
          locations={[0, 0.55, 1]}
          style={StyleSheet.absoluteFill}
        />
      </View>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.column}>
          <View style={styles.hero}>
            <View style={styles.logoRing}>
              <Image source={require('../assets/emblem.png')} style={styles.logo} accessibilityLabel="شعار الهلب جروب" />
            </View>
            <Text style={styles.title}>الهلب جروب</Text>
            <Text style={styles.tagline}>مبيدات وأسمدة زراعية · منذ ١٩٩٣</Text>
            <Text style={styles.sub}>سجّل الدخول لبدء وردية الميدان وتسجيل زياراتك وتقاريرك.</Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>دخول مهندس الميدان</Text>
            <Field label="البريد الإلكتروني" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" placeholder="rep@company.com" style={styles.ltr} />
            <Field label="كلمة المرور" value={password} onChangeText={setPassword} secureTextEntry placeholder="••••••••" style={styles.ltr} />
            {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
            <Button label={busy ? 'جارٍ الدخول…' : 'دخول'} onPress={submit} loading={busy} />
            <View style={styles.divider}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>أو بدون كلمة سر</Text>
              <View style={styles.dividerLine} />
            </View>
            <View style={{ gap: 10 }}>
              <Pressable onPress={() => handleSocial('google')} style={({ pressed }) => [styles.socialBtn, styles.googleBtn, pressed && { opacity: 0.85 }]}>
                <Text style={styles.googleText}>🔵 المتابعة بـ Google (Gmail)</Text>
              </Pressable>
              <Pressable onPress={() => handleSocial('apple')} style={({ pressed }) => [styles.socialBtn, styles.appleBtn, pressed && { opacity: 0.85 }]}>
                <Text style={styles.appleText}> المتابعة بـ Apple (iCloud)</Text>
              </Pressable>
              <Text style={styles.socialHint}>الدخول بـ Google/Apple ينشئ حسابك تلقائياً وينتظر <Text style={{ fontFamily: fonts.bold }}>موافقة المدير</Text> — بدون تسجيل يدوي.</Text>
            </View>
          </View>

          <View style={styles.hint}>
            <Text style={styles.hintTitle}>حساب تجريبي</Text>
            <Text style={styles.hintBody}><Text style={styles.mono}>rep@mandoub.test</Text>  /  <Text style={styles.mono}>Demo1234!</Text></Text>
            <Text style={styles.hintNote}>هذا الحساب يسجّل موقعك الحقيقي أثناء الوردية فقط.</Text>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#04121e' },
  scene: { width: '100%', height: '100%', opacity: 0.85 },
  scroll: { flexGrow: 1, justifyContent: 'center', paddingVertical: space.xxl, paddingHorizontal: space.lg },
  column: { width: '100%', maxWidth: 430, alignSelf: 'center', gap: space.md },
  hero: { alignItems: 'center', gap: 2, marginBottom: space.xs },
  logoRing: {
    width: 92, height: 92, borderRadius: 46, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.green800, borderWidth: 1.5, borderColor: 'rgba(201,162,39,0.7)', marginBottom: space.sm,
  },
  logo: { width: 82, height: 82, borderRadius: 41, resizeMode: 'cover' },
  title: { fontFamily: fonts.bold, fontSize: 27, color: '#f7fafc', textAlign: 'center' },
  tagline: { fontFamily: fonts.medium, fontSize: 13, color: '#e7ce86', textAlign: 'center' },
  sub: { fontFamily: fonts.regular, fontSize: 12.5, color: 'rgba(226,238,247,0.78)', textAlign: 'center', lineHeight: 21, marginTop: space.sm, maxWidth: 330 },
  card: {
    backgroundColor: colors.white, borderRadius: radius.lg, padding: space.lg, gap: space.md,
    ...(shadow as object),
  },
  cardTitle: { fontFamily: fonts.bold, fontSize: 15.5, color: colors.green900, textAlign: 'right' },
  ltr: { textAlign: 'left', writingDirection: 'ltr' },
  error: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.danger, textAlign: 'right' },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 2, opacity: 0.6 },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.line },
  dividerText: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.muted },
  socialBtn: { borderRadius: 10, paddingVertical: 12, alignItems: 'center', borderWidth: 1 },
  googleBtn: { backgroundColor: '#fff', borderColor: '#dadce0' },
  googleText: { fontFamily: fonts.medium, fontSize: 13.5, color: '#1f1f1f' },
  appleBtn: { backgroundColor: '#000', borderColor: '#000' },
  appleText: { fontFamily: fonts.medium, fontSize: 13.5, color: '#fff' },
  socialHint: { fontFamily: fonts.regular, fontSize: 11, color: colors.muted, textAlign: 'center', lineHeight: 16 },
  hint: {
    borderRadius: radius.md, padding: space.md, gap: 3,
    backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)',
  },
  hintTitle: { fontFamily: fonts.bold, fontSize: 12, color: '#e7ce86', textAlign: 'right' },
  hintBody: { fontFamily: fonts.regular, fontSize: 12, color: '#eaf1f7', textAlign: 'right' },
  hintNote: { fontFamily: fonts.regular, fontSize: 11.5, color: 'rgba(226,238,247,0.72)', textAlign: 'right', lineHeight: 18 },
  mono: { fontFamily: fonts.medium, writingDirection: 'ltr' },
});
