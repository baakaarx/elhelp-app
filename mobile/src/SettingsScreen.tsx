import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Location from 'expo-location';
import { useState } from 'react';
import { flushOutbox } from './reports';
import { colors, fonts, space } from './theme';
import { Body, Button, Card, Heading, Pill, Row, SectionTitle } from './ui';
import type { User } from './types';
import type { FieldBundle } from './useField';

export default function SettingsScreen({ user, field, onLogout }: { user: User; field: FieldBundle; onLogout: () => void }) {
  const [syncing, setSyncing] = useState(false);
  const [permission, setPermission] = useState<string | null>(null);

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
        {user.isDemo ? <Pill label="حساب تجريبي — بيانات محاكاة" tone="warn" /> : null}
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
          البيانات تُحذف تلقائيًا بعد ٣٠ يومًا، وكل إجراء حساس (بدء/إيقاف وردية، إيقاف حساب، تنزيل تقرير) يُسجَّل في سجل تدقيق.
        </Body>
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
  logout: { borderWidth: 1, borderColor: '#e6c9c9', backgroundColor: colors.dangerSoft, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  logoutText: { fontFamily: fonts.bold, fontSize: 14, color: colors.danger },
  footer: { fontFamily: fonts.regular, fontSize: 11, color: colors.muted, textAlign: 'center' },
});
