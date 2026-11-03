import { useState } from 'react';
import { Image, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View, Pressable } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Path } from 'react-native-svg';
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

  function handleSocial() {
    setError('تسجيل الدخول بـ Google وApple غير مفعّل حالياً.');
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
              <Pressable onPress={handleSocial} style={({ pressed }) => [styles.socialBtn, styles.googleBtn, pressed && { opacity: 0.85 }]}>
                <Svg width={20} height={20} viewBox="0 0 24 24" accessible={false}>
                  <Path fill="#4285F4" d="M21.35 12.25c0-.72-.06-1.4-.18-2.06H12v3.9h5.24a4.48 4.48 0 0 1-1.95 2.94v2.54h3.17c1.85-1.71 2.89-4.22 2.89-7.32z" />
                  <Path fill="#34A853" d="M12 21.75c2.64 0 4.86-.87 6.48-2.36l-3.17-2.46c-.88.59-2.01.94-3.31.94-2.55 0-4.71-1.72-5.48-4.04H3.25v2.53A9.75 9.75 0 0 0 12 21.75z" />
                  <Path fill="#FBBC05" d="M6.52 13.83a5.86 5.86 0 0 1 0-3.66V7.64H3.25a9.75 9.75 0 0 0 0 8.72l3.27-2.53z" />
                  <Path fill="#EA4335" d="M12 6.13c1.44 0 2.73.5 3.75 1.47l2.81-2.81A9.36 9.36 0 0 0 12 2.25a9.75 9.75 0 0 0-8.75 5.39l3.27 2.53C7.29 7.85 9.45 6.13 12 6.13z" />
                </Svg>
                <Text style={styles.googleText}>المتابعة بـ Google (Gmail)</Text>
              </Pressable>
              <Pressable onPress={handleSocial} style={({ pressed }) => [styles.socialBtn, styles.appleBtn, pressed && { opacity: 0.85 }]}>
                <Svg width={20} height={20} viewBox="0 0 24 24" accessible={false}><Path fill="#fff" d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" /></Svg>
                <Text style={styles.appleText}>المتابعة بـ Apple (iCloud)</Text>
              </Pressable>
              <Text style={styles.socialHint}>تسجيل الدخول بـ Google وApple غير مفعّل حالياً.</Text>
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
  socialBtn: { borderRadius: 10, paddingVertical: 12, paddingHorizontal: 12, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, borderWidth: 1 },
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
