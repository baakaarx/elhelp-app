import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useState } from 'react';
import { apiBase, pingServer, resetServerAddress, saveServerAddress, SERVER_EDITABLE, unconfigured, usingCustomServer } from './api';
import { colors, fonts, radius, space } from './theme';
import { Button, Field } from './ui';

/**
 * Where the phone dials.
 *
 * A test build freezes the LAN address at build time, so the day the router hands out a new one
 * every login starts failing — and the app's own message ("كلمة المرور غير صحيحة", or a reply from
 * whatever else answers on that address) points at the password instead of at the network. Rebuilding
 * the APK per IP was not workable, so the address can be retyped on the phone and is stored next to
 * the session token.
 *
 * It stays out of the way: hidden on the web, collapsed to one line elsewhere, and an engineer who
 * never opens it talks to exactly the server the build shipped with.
 */
export default function ServerAddressCard() {
  const [server, setServer] = useState(apiBase());
  const [open, setOpen] = useState(unconfigured());
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  async function apply(value: string) {
    try {
      setServer(await saveServerAddress(value));
      setOpen(false);
      setNote('');
      Alert.alert('تم الحفظ', 'التطبيق هيتصل بالسيرفر ده من دلوقتي على التليفون ده.');
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'تعذر حفظ العنوان.');
    } finally { setBusy(false); }
  }

  async function save() {
    const value = draft.trim();
    if (!value) { setNote('اكتب عنوان السيرفر الأول، مثل 192.168.1.5:3000'); return; }
    setBusy(true); setNote('');
    const check = await pingServer(value);
    if (!check.ok) {
      // Keeping a dead address is still better than nothing — the server may merely be offline right
      // now — but it must never be saved silently, so the engineer confirms it.
      Alert.alert('العنوان ده ماردش', check.error || 'لم يستجب السيرفر.', [
        { text: 'إلغاء', style: 'cancel' },
        { text: 'احفظ رغم ذلك', onPress: () => { void apply(value); } },
      ]);
      setBusy(false);
      return;
    }
    await apply(value);
  }

  async function restoreBuildServer() {
    await resetServerAddress();
    setServer(apiBase());
    setOpen(false);
    setNote('');
  }

  if (!SERVER_EDITABLE) return null;

  return (
    <View style={styles.box}>
      <View style={styles.head}>
        <Text style={styles.label}>عنوان السيرفر</Text>
        <Pressable
          onPress={() => { setDraft(server); setOpen(v => !v); setNote(''); }}
          accessibilityRole="button"
          accessibilityLabel="تغيير عنوان السيرفر"
          hitSlop={8}
        >
          <Text style={styles.edit}>{open ? 'إغلاق' : 'تغيير'}</Text>
        </Pressable>
      </View>
      <Text style={styles.value}>{server || 'غير مضبوط'}</Text>
      <Text style={styles.hint}>
        {usingCustomServer() ? 'العنوان مكتوب على التليفون ده (مش المبني في النسخة).' : 'مأخوذ من النسخة المثبَّتة.'}
      </Text>
      {open ? (
        <View style={styles.form}>
          <Field
            label="اكتب عنوان السيرفر على الشبكة"
            value={draft}
            onChangeText={setDraft}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="192.168.1.5:3000"
            style={styles.ltr}
            hint="لو السيرفر على نت الشركة اكتبه كامل: https://api.example.com"
          />
          {note ? <Text style={styles.error}>{note}</Text> : null}
          <Button label={busy ? 'جارٍ التجربة…' : 'احفظ وجرّب الاتصال'} onPress={() => void save()} loading={busy} variant="soft" />
          {usingCustomServer() ? (
            <Pressable onPress={() => void restoreBuildServer()} accessibilityRole="button" hitSlop={6}>
              <Text style={styles.edit}>ارجع للعنوان المبني في النسخة</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.cream, padding: space.md, gap: 2 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  label: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.green900 },
  edit: { fontFamily: fonts.medium, fontSize: 12, color: colors.green700 },
  value: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.ink, writingDirection: 'ltr', textAlign: 'left' },
  hint: { fontFamily: fonts.regular, fontSize: 11, color: colors.muted, textAlign: 'right' },
  error: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.danger, textAlign: 'right' },
  form: { gap: space.sm, marginTop: space.sm, paddingTop: space.sm, borderTopWidth: 1, borderTopColor: colors.line },
  ltr: { textAlign: 'left', writingDirection: 'ltr' },
});
