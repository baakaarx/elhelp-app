import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Location from 'expo-location';
import { useState } from 'react';
import { API_BASE, changeMyPassword, deleteMyAccount } from './api';
import { clearDeviceData } from './storage';
import { createQueue } from './queue';
import { flushOutbox } from './reports';
import { colors, fonts, space } from './theme';
import { Body, Button, Card, Heading, Pill, Row, SectionTitle } from './ui';
import type { User } from './types';
import type { FieldBundle } from './useField';

export default function SettingsScreen({ user, field, onLogout, onDeleted }: { user: User; field: FieldBundle; onLogout: () => void; onDeleted: () => void }) {
  const [syncing, setSyncing] = useState(false);
  const [permission, setPermission] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [changing, setChanging] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState('');
  const [deleting, setDeleting] = useState(false);
  // Typing the account address is the confirmation step: the stores require a real in-app
  // deletion path, and an accidental tap must never erase a field engineer's history.
  const canDelete = !deleting && confirmEmail.trim().toLowerCase() === user.email.toLowerCase();

  async function eraseAccount() {
    setDeleting(true);
    try {
      await deleteMyAccount(user.email);
      await (await createQueue()).clear();
      await clearDeviceData();
      onDeleted();
    } catch (error) {
      Alert.alert('تعذر حذف الحساب', error instanceof Error ? error.message : 'حاول مرة أخرى.');
    } finally { setDeleting(false); }
  }

  function askConfirmDelete() {
    Alert.alert(
      'حذف الحساب نهائيًا',
      'هيتحذف حسابك وكل بياناتك: الموقع، الورديات، الزيارات، والتقارير. الخطوة دي مش ممكن التراجع عنها.',
      [
        { text: 'إلغاء', style: 'cancel' },
        { text: 'حذف نهائي', style: 'destructive', onPress: () => void eraseAccount() },
      ],
    );
  }

  // The manager hands out the first password, so the owner needs a way to replace it without
  // asking anyone to touch the server. Every other device is signed out by the server.
  const canChangePassword = !changing && currentPassword.length > 0 && nextPassword.length >= 10;

  async function savePassword() {
    setChanging(true);
    try {
      await changeMyPassword(currentPassword, nextPassword);
      setCurrentPassword(''); setNextPassword('');
      Alert.alert('تم تغيير كلمة المرور', 'استخدم كلمة المرور الجديدة في المرة القادمة. الأجهزة الأخرى تم تسجيل خروجها.');
    } catch (error) {
      Alert.alert('تعذر تغيير كلمة المرور', error instanceof Error ? error.message : 'حاول مرة أخرى.');
    } finally { setChanging(false); }
  }

  async function checkPermissions() {
    const foreground = await Location.getForegroundPermissionsAsync();
    let background = 'غير مطلوب على الويب';
    try {
      const bg = await Location.getBackgroundPermissionsAsync();
      background = bg.status === 'granted' ? 'مسموح' : 'غير مسموح';
    } catch { background = 'غير متاح على هذا الجهاز'; }
    setPermission(`الموقع أثناء الاستخدام: ${foreground.status === 'granted' ? 'مسموح' : 'غير مسموح'}\nالموقع في الخلفية: ${background}`);
  }

  return (
    <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      <View>
        <Text style={styles.title}>حسابي</Text>
        <Text style={styles.sub}>بياناتك، المزامنة، والتحكم في الخصوصية.</Text>
      </View>

      <Card>
        <Row style={{ gap: space.md }}>
          <View style={[styles.avatar, { backgroundColor: user.color || colors.green700 }]}><Text style={styles.avatarText}>{user.name.trim().charAt(0)}</Text></View>
          <View style={{ flex: 1 }}>
            <Heading>{user.name}</Heading>
            <Body muted>{user.email}</Body>
            <Text style={styles.meta}>{user.role === 'rep' ? 'مهندس مبيعات' : 'متابعة'}{user.region ? ` · ${user.region}` : ''}{user.phone ? ` · ${user.phone}` : ''}</Text>
          </View>
        </Row>
      </Card>

      <Card>
        <SectionTitle title="المزامنة" action={<Pill label={field.pending ? `${field.pending} بالانتظار` : 'كل شيء مُرسل'} tone={field.pending ? 'warn' : 'mint'} />} />
        <Body muted>
          {field.pending
            ? 'فيه بيانات محفوظة على جهازك (مواقع أو تقارير) وما اتبعتتش. هتتبعت تلقائيًا لما الشبكة ترجع.'
            : 'كل بياناتك مُرسلة للسيرفر. المزامنة التلقائية كل ١٥ ثانية.'}
        </Body>
        <Row style={{ gap: space.sm }}>
          <Button style={{ flex: 1 }} variant="soft" label={syncing ? 'جارٍ المزامنة…' : 'مزامنة الآن'} loading={syncing} onPress={async () => {
            setSyncing(true);
            try {
              const result = await flushOutbox();
              Alert.alert('المزامنة', result.pending ? `تم إرسال ${result.sent}، وباقي ${result.pending}.` : 'كل البيانات مُرسلة ✅');
              await field.refresh();
            } catch { Alert.alert('المزامنة', 'تعذر الاتصال بالسيرفر. حاول بعد قليل.'); }
            finally { setSyncing(false); }
          }} />
          <Button style={{ flex: 1 }} variant="ghost" label="تحديث البيانات" onPress={() => void field.refresh()} />
        </Row>
      </Card>

      <Card>
        <SectionTitle title="الأذونات" action={<Pill label="GPS" />} />
        <Body muted>التتبع يشتغل بس أثناء الوردية. لو منعت صلاحية الموقع، التطبيق هيوقف التسجيل ويظهر تنبيه للمدير.</Body>
        <Button variant="ghost" label="عرض حالة الأذونات" onPress={checkPermissions} />
        {permission ? <Text style={styles.mono}>{permission}</Text> : null}
      </Card>

      <Card tone="mint">
        <SectionTitle title="الخصوصية" />
        <Body>
          موقعك يُسجَّل أثناء الوردية فقط وبعد موافقتك الصريحة، ويُستخدم لمتابعة خط السير وإعداد التقارير.
          البيانات تُحذف تلقائيًا بعد {field.summary?.retentionDays ?? 365} يومًا، وكل إجراء حساس (بدء/إيقاف وردية، إيقاف حساب، تنزيل تقرير) يُسجَّل في سجل تدقيق.
        </Body>
        <Pressable onPress={() => void Linking.openURL(`${API_BASE}/privacy`)} accessibilityRole="link">
          <Text style={styles.link}>سياسة الخصوصية الكاملة ←</Text>
        </Pressable>
      </Card>

      <Card>
        <SectionTitle title="كلمة المرور" action={nextPassword.length >= 10 ? <Pill label="جاهزة" tone="mint" /> : <Pill label="١٠ أحرف على الأقل" />} />
        <Body muted>كلمة المرور الأولى يجعلها مدير المتابعة؛ غيّرها من هنا في أي وقت. الأجهزة الأخرى هتتسجّل خروجها تلقائيًا.</Body>
        <TextInput
          value={currentPassword}
          onChangeText={setCurrentPassword}
          placeholder="كلمة المرور الحالية"
          placeholderTextColor={colors.muted}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          editable={!changing}
          style={styles.confirmInput}
          accessibilityLabel="كلمة المرور الحالية"
        />
        <TextInput
          value={nextPassword}
          onChangeText={setNextPassword}
          placeholder="كلمة المرور الجديدة"
          placeholderTextColor={colors.muted}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          editable={!changing}
          style={styles.confirmInput}
          accessibilityLabel="كلمة المرور الجديدة"
        />
        <Button variant="soft" label={changing ? 'جارٍ الحفظ…' : 'تغيير كلمة المرور'} loading={changing} disabled={!canChangePassword} onPress={() => void savePassword()} />
      </Card>

      <Card>
        <SectionTitle title="حذف الحساب" action={<Pill label="نهائي" tone="warn" />} />
        <Body muted>
          حذف الحساب يمسح كل بياناتك من السيرفر فورًا (الموقع، الورديات، الزيارات، التقارير) ويلغي كل الجلسات.
          اكتب بريدك للتأكيد، أو راسل مسؤول الخصوصية لو محتاج مساعدة.
        </Body>
        <TextInput
          value={confirmEmail}
          onChangeText={setConfirmEmail}
          placeholder={user.email}
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          editable={!deleting}
          style={styles.confirmInput}
          accessibilityLabel="تأكيد البريد الإلكتروني"
        />
        <Button
          variant="danger"
          label={deleting ? 'جارٍ الحذف…' : 'حذف حسابي نهائيًا'}
          disabled={!canDelete}
          loading={deleting}
          onPress={askConfirmDelete}
        />
      </Card>

      <Pressable onPress={onLogout} style={styles.logout} accessibilityRole="button">
        <Text style={styles.logoutText}>تسجيل الخروج وإيقاف التتبع</Text>
      </Pressable>
      <Text style={styles.footer}>الهلب جروب · مهندس مبيعات · إصدار 1.1.0</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: space.lg, paddingBottom: 40, gap: space.md },
  title: { fontFamily: fonts.bold, fontSize: 22, color: colors.green900, textAlign: 'right' },
  sub: { fontFamily: fonts.regular, fontSize: 12, color: colors.muted, textAlign: 'right' },
  avatar: { width: 52, height: 52, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontFamily: fonts.bold, fontSize: 22, color: '#fdf8ec' },
  meta: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.muted, textAlign: 'right' },
  mono: { fontFamily: fonts.regular, fontSize: 12, color: colors.ink, textAlign: 'right', lineHeight: 20 },
  link: { fontFamily: fonts.bold, fontSize: 13, color: colors.green700, textAlign: 'right', paddingVertical: 6 },
  confirmInput: {
    borderWidth: 1, borderColor: colors.line, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10,
    fontFamily: fonts.regular, fontSize: 14, color: colors.ink, textAlign: 'left', direction: 'ltr',
  },
  logout: { borderWidth: 1, borderColor: '#e6c9c9', backgroundColor: colors.dangerSoft, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  logoutText: { fontFamily: fonts.bold, fontSize: 14, color: colors.danger },
  footer: { fontFamily: fonts.regular, fontSize: 11, color: colors.muted, textAlign: 'center' },
});
