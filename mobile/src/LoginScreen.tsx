import { useState } from 'react';
import { Image, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { login } from './api';
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
            <Text style={styles.loginHint}>الحساب بيتعمل من مدير المتابعة، ولو نسيت كلمة المرور كلّم المدير يعملها لك من جديد.</Text>
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
  loginHint: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.muted, textAlign: 'right', lineHeight: 20 },
  card: {
    backgroundColor: colors.white, borderRadius: radius.lg, padding: space.lg, gap: space.md,
    ...(shadow as object),
  },
  cardTitle: { fontFamily: fonts.bold, fontSize: 15.5, color: colors.green900, textAlign: 'right' },
  ltr: { textAlign: 'left', writingDirection: 'ltr' },
  error: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.danger, textAlign: 'right' },
  hint: {
    borderRadius: radius.md, padding: space.md, gap: 3,
    backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)',
  },
  hintTitle: { fontFamily: fonts.bold, fontSize: 12, color: '#e7ce86', textAlign: 'right' },
  hintBody: { fontFamily: fonts.regular, fontSize: 12, color: '#eaf1f7', textAlign: 'right' },
  hintNote: { fontFamily: fonts.regular, fontSize: 11.5, color: 'rgba(226,238,247,0.72)', textAlign: 'right', lineHeight: 18 },
  mono: { fontFamily: fonts.medium, writingDirection: 'ltr' },
});
