import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { login } from './api';
import { colors, fonts, radius, space } from './theme';
import { Button, Field } from './ui';
import type { User } from './types';

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
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.logo}><Text style={styles.logoText}>ه</Text></View>
        <Text style={styles.title}>مهندس مبيعات الهلب</Text>
        <Text style={styles.sub}>سجّل الدخول لبدء وردية الميدان وتسجيل زياراتك وتقاريرك.</Text>
        <View style={styles.card}>
          <Field label="البريد الإلكتروني" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" placeholder="rep@company.com" style={styles.ltr} />
          <Field label="كلمة المرور" value={password} onChangeText={setPassword} secureTextEntry placeholder="••••••••" style={styles.ltr} />
          {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
          <Button label={busy ? 'جارٍ الدخول…' : 'دخول'} onPress={submit} loading={busy} />
        </View>
        <View style={styles.hint}>
          <Text style={styles.hintTitle}>للتجربة</Text>
          <Text style={styles.hintBody}><Text style={styles.mono}>rep@mandoub.test</Text> / <Text style={styles.mono}>Demo1234!</Text></Text>
          <Text style={styles.hintBody}>هذا الحساب يسجّل موقعك الحقيقي أثناء الوردية.</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, justifyContent: 'center', padding: space.xl, gap: space.sm },
  logo: { width: 66, height: 66, borderRadius: 22, backgroundColor: colors.green800, alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
  logoText: { fontFamily: fonts.bold, fontSize: 30, color: '#fdf8ec' },
  title: { fontFamily: fonts.bold, fontSize: 24, color: colors.green900, textAlign: 'center', marginTop: space.sm },
  sub: { fontFamily: fonts.regular, fontSize: 13, color: colors.muted, textAlign: 'center', lineHeight: 22, marginBottom: space.md },
  card: { backgroundColor: colors.white, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.lg, gap: space.md },
  ltr: { textAlign: 'left', writingDirection: 'ltr' },
  error: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.danger, textAlign: 'right' },
  hint: { marginTop: space.md, backgroundColor: colors.mint, borderRadius: radius.md, padding: space.md, gap: 2 },
  hintTitle: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.green700, textAlign: 'right' },
  hintBody: { fontFamily: fonts.regular, fontSize: 12, color: colors.green900, textAlign: 'right' },
  mono: { fontFamily: fonts.medium, writingDirection: 'ltr' },
});
