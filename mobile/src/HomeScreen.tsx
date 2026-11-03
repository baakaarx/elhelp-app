import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, TextInput } from 'react-native';
import { colors, fonts, radius, space } from './theme';
import { Body, Button, Card, Empty, Heading, Pill, Row, SectionTitle, Sheet, Stat } from './ui';
import RouteMap from './RouteMap';
import { CheckInSheet, CheckOutSheet } from './VisitSheets';
import { agoText, clockText, hhmmss } from './format';
import { visitPurposeLabels, type User, type Visit } from './types';
import type { FieldBundle } from './useField';
import { captureOnce } from './location';
import { getDeviceId } from './device';
import { reportIdle } from './api';

type Props = {
  user: User;
  field: FieldBundle;
  onOpenVisits: () => void;
  onOpenReports: () => void;
  onOpenDaily: () => void;
};

export default function HomeScreen({ user, field, onOpenVisits, onOpenReports, onOpenDaily }: Props) {
  const [now, setNow] = useState(Date.now());
  const [consentOpen, setConsentOpen] = useState(false);
  const [checkInOpen, setCheckInOpen] = useState(false);
  const [checkOutVisit, setCheckOutVisit] = useState<Visit | null>(null);

  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);

  const summary = field.summary;
  const shift = summary?.shift ?? null;
  const openVisit = summary?.openVisit ?? null;
  const shiftElapsed = shift ? hhmmss(now - shift.started_at) : null;
  const openElapsed = openVisit ? hhmmss(now - openVisit.checkedInAt) : null;
  const daily = summary?.dailyReport ?? null;

  return (
    <>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.hello}>أهلاً {user.name.split(' ')[0]} 👋</Text>
            <Text style={styles.date}>{clockText(now)}</Text>
          </View>
          <View style={[styles.avatar, { backgroundColor: user.color || colors.green700 }]}>
            <Text style={styles.avatarText}>{user.name.trim().charAt(0)}</Text>
          </View>
        </View>

        <Card tone="dark" style={styles.hero}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Pill label={shift ? 'الوردية شغالة' : 'خارج الوردية'} tone={shift ? 'dark' : 'warn'} />
            <Text style={styles.heroTimer}>{shift ? shiftElapsed : '—:—:—'}</Text>
          </Row>
          <Text style={styles.heroHint}>
            {shift
              ? `بدأت ${new Date(shift.started_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })} · يتم تسجيل موقعك كل ثانية`
              : 'ابدأ الوردية ليبدأ تسجيل موقعك ويظهر مسارك للمدير.'}
          </Text>
          <View style={styles.heroStats}>
            <Stat tone="dark" label="كم اليوم" value={(Number(summary?.distanceMeters ?? 0) / 1000).toFixed(1)} />
            <View style={styles.heroDivider} />
            <Stat tone="dark" label="زيارات" value={String(summary?.visitsTotal ?? 0)} />
            <View style={styles.heroDivider} />
            <Stat tone="dark" label="تحصيل (ج.م)" value={(summary?.collectionAmount ?? 0).toLocaleString('ar-EG')} />
          </View>
          {shift ? (
            <Button label="إيقاف التتبع وإنهاء الوردية" variant="soft" onPress={async () => { await field.finishShift().catch(() => undefined); }} loading={field.busy} />
          ) : (
            <Button label="بدء الوردية وتسجيل الموقع" onPress={() => setConsentOpen(true)} loading={field.busy} />
          )}
          {field.error ? <Text style={styles.error}>{field.error}</Text> : null}
        </Card>

        {(() => {
          const lastFix = summary?.lastFixAt ? Number(summary.lastFixAt) : null;
          const idleMs = lastFix ? now - lastFix : null;
          const showIdle = shift && idleMs !== null && idleMs > 60 * 60 * 1000;
          if (!showIdle) return null;
          return <IdleBanner now={now} lastFixAt={lastFix!} />;
        })()}

        {openVisit ? (
          <Card tone="mint" style={styles.openVisit}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Pill label="زيارة مفتوحة" tone="warn" />
              <Text style={styles.openTimer}>{openElapsed}</Text>
            </Row>
            <Heading>{openVisit.customerName}</Heading>
            <Body muted>
              {visitPurposeLabels[openVisit.purpose]} · بدأت {new Date(openVisit.checkedInAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}
              {openVisit.governorate ? ` · ${openVisit.governorate}` : ''}
            </Body>
            <Row style={{ gap: space.sm, marginTop: 4 }}>
              <Button style={{ flex: 1 }} label="إنهاء الزيارة" onPress={() => setCheckOutVisit(openVisit)} />
              <Button style={{ flex: 1 }} label="تفاصيل" variant="ghost" onPress={onOpenVisits} />
            </Row>
          </Card>
        ) : null}

        <View style={styles.actions}>
          <ActionTile icon="◉" label="زيارة جديدة" hint="تسجيل حضور" onPress={() => { if (!shift) { setConsentOpen(true); return; } setCheckInOpen(true); }} />
          <ActionTile icon="✎" label="تقرير سريع" hint="زيارة/طلبية" onPress={onOpenReports} />
          <ActionTile icon="▤" label="التقرير اليومي" hint={daily ? 'تم الإرسال' : 'لم يُرسل'} onPress={onOpenDaily} tone={daily ? 'done' : 'todo'} />
        </View>

        <Card>
          <SectionTitle title="خط سير اليوم" action={<Pressable onPress={onOpenVisits}><Text style={styles.link}>الزيارات</Text></Pressable>} />
          <RouteMap route={field.route} />
          <Row style={{ justifyContent: 'space-between', marginTop: 6 }}>
            <Text style={styles.meta}>{(Number(summary?.distanceMeters ?? 0) / 1000).toFixed(1)} كم</Text>
            <Text style={styles.meta}>{summary?.pointCount ?? 0} نقطة موقع</Text>
            <Text style={styles.meta}>{summary?.lastFixAt ? agoText(summary.lastFixAt) : 'لا إشارة'}</Text>
          </Row>
        </Card>

        <Card>
          <SectionTitle title="آخر الزيارات" action={<Pressable onPress={onOpenVisits}><Text style={styles.link}>الكل</Text></Pressable>} />
          {(field.visits.length === 0) ? (
            <Empty title="لا زيارات اليوم" hint="سجّل زيارتك الأولى من زر «زيارة جديدة»." />
          ) : field.visits.slice(0, 4).map(visit => (
            <View key={visit.id} style={styles.visitRow}>
              <View style={[styles.visitDot, { backgroundColor: visit.status === 'open' ? colors.amber : colors.green500 }]} />
              <View style={{ flex: 1 }}>
                <Text style={styles.visitName}>{visit.customerName}</Text>
                <Text style={styles.meta}>
                  {visitPurposeLabels[visit.purpose]} · {new Date(visit.checkedInAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}
                  {visit.status === 'closed' && visit.durationSeconds !== null ? ` · ${Math.max(1, Math.round(visit.durationSeconds / 60))} دقيقة` : ' · مفتوحة'}
                </Text>
              </View>
              {visit.status === 'open' && <Pressable onPress={() => setCheckOutVisit(visit)}><Text style={styles.link}>إنهاء</Text></Pressable>}
            </View>
          ))}
        </Card>

        <Card tone={daily ? 'plain' : 'mint'}>
          <SectionTitle title="التقرير اليومي" action={<Pill label={daily ? (daily.status === 'reviewed' ? 'تمت المراجعة' : 'بانتظار المراجعة') : 'مطلوب'} tone={daily ? 'mint' : 'warn'} />} />
          <Body muted>
            {daily
              ? 'تقريرك اليومي وصل للمدير. يمكنك إرسال تقرير إضافي إن طرأ تغيير.'
              : 'أرسل تقرير اليوم بزياراته وتوقيعك الإلكتروني قبل نهاية اليوم.'}
          </Body>
          <Button label={daily ? 'عرض/إرسال تقرير آخر' : 'إرسال التقرير اليومي'} variant={daily ? 'ghost' : 'primary'} onPress={onOpenDaily} />
        </Card>
      </ScrollView>

      <ConsentSheet
        visible={consentOpen}
        onClose={() => setConsentOpen(false)}
        onStart={async (background) => { setConsentOpen(false); await field.beginShift({ background }).catch(() => undefined); }}
        busy={field.busy}
      />
      <CheckInSheet visible={checkInOpen} onClose={() => setCheckInOpen(false)} field={field} user={user} />
      <CheckOutSheet visit={checkOutVisit} onClose={() => setCheckOutVisit(null)} field={field} />
    </>
  );
}

function ActionTile({ icon, label, hint, onPress, tone = 'plain' }: { icon: string; label: string; hint: string; onPress: () => void; tone?: 'plain' | 'done' | 'todo' }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.action, pressed && { transform: [{ scale: 0.98 }] }]} accessibilityRole="button" accessibilityLabel={label}>
      <View style={[styles.actionIcon, tone === 'done' && { backgroundColor: colors.mint }, tone === 'todo' && { backgroundColor: colors.amberSoft }]}>
        <Text style={[styles.actionIconText, tone === 'todo' && { color: colors.amber }]}>{icon}</Text>
      </View>
      <Text style={styles.actionLabel}>{label}</Text>
      <Text style={styles.actionHint}>{hint}</Text>
    </Pressable>
  );
}

function ConsentSheet({ visible, onClose, onStart, busy }: { visible: boolean; onClose: () => void; onStart: (background: boolean) => void; busy: boolean }) {
  const [agreed, setAgreed] = useState(false);
  const [background, setBackground] = useState(true);
  useEffect(() => { if (visible) { setAgreed(false); setBackground(true); } }, [visible]);
  return (
    <ConsentSheetShell visible={visible} onClose={onClose} agreed={agreed} setAgreed={setAgreed} background={background} setBackground={setBackground} onStart={() => onStart(background)} busy={busy} />
  );
}

function ConsentSheetShell({ visible, onClose, agreed, setAgreed, background, setBackground, onStart, busy }: {
  visible: boolean; onClose: () => void; agreed: boolean; setAgreed: (value: boolean) => void;
  background: boolean; setBackground: (value: boolean) => void; onStart: () => void; busy: boolean;
}) {
  return (
    <Sheet visible={visible} onClose={onClose} title="قبل أن نبدأ تتبع الموقع">
      <Body>
        أثناء الوردية فقط، يسجّل التطبيق موقعك كل ثانية تقريبًا ويُرسله إلى لوحة متابعة الهلب.
        تُستخدم البيانات لعرض خط سيرك للمدير ولإعداد تقاريرك، وتُحذف تلقائيًا بعد ٣٠ يومًا.
      </Body>
      <Body muted>يمكنك إيقاف التتبع في أي لحظة من الزر الأحمر، ويُسجَّل كل بدء/إيقاف في سجل التدقيق.</Body>
      <Toggle checked={background} onChange={() => setBackground(!background)} label="السماح بالتسجيل في الخلفية (موصى به حتى لو الشاشة مقفولة)" />
      <Toggle checked={agreed} onChange={() => setAgreed(!agreed)} label="أوافق على تسجيل موقعي طوال الوردية وأقر بأن هذا توقيعي على الموافقة." />
      <Button label="موافق، ابدأ الوردية" onPress={onStart} disabled={!agreed} loading={busy} />
    </Sheet>
  );
}

function IdleBanner({ now, lastFixAt }: { now: number; lastFixAt: number }) {
  const [open, setOpen] = useState(false);
  const minutes = Math.max(0, Math.round((now - lastFixAt) / 60000));
  if (!open) {
    return (
      <Card tone="mint" style={{ borderColor: '#f0c27a', backgroundColor: '#fff8e6' }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Pill label="تنبيه" tone="warn" />
          <Text style={{ fontFamily: fonts.bold, color: colors.amber }}>سكون ${minutes} دقيقة</Text>
        </Row>
        <Body>لم يتحرك هاتفك منذ ${minutes} دقيقة — يجب كتابة سبب الوقوف ليصل للمدير.</Body>
        <Button label="كتابة سبب الوقوف" variant="primary" onPress={() => setOpen(true)} />
      </Card>
    );
  }
  return <IdleSheet onClose={() => setOpen(false)} />;
}

function IdleSheet({ onClose }: { onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (reason.trim().length < 5) { setError('اكتب سبب الوقوف (٥ أحرف على الأقل).'); return; }
    setSaving(true); setError('');
    try {
      const fix = await captureOnce({ maxAgeMs: 0 });
      if (!fix) throw new Error('GPS مطلوب — فعّل الموقع لإرسال تبرير الوقوف.');
      const deviceId = await getDeviceId();
      await reportIdle(reason.trim(), { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy }, deviceId);
      onClose();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };
  return (
    <Sheet visible={true} onClose={onClose} title="تبرير الوقوف — ساعة بلا حركة">
      <Body muted>مربوط بهاتفك تلقائيًا — سيظهر للمدير مع موقعك الآن.</Body>
      <View style={{ gap: 6 }}>
        <Text style={styles.toggleLabel}>السبب</Text>
        <TextInput value={reason} onChangeText={setReason} placeholder="انتظار عميل، عطل سيارة، استراحة…" multiline style={{ minHeight: 80, borderWidth: 1, borderColor: colors.line, borderRadius: 10, padding: 10, textAlign: 'right', fontFamily: fonts.regular }} />
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button label={saving ? 'جارٍ الإرسال…' : 'إرسال التبرير'} onPress={submit} loading={saving} />
    </Sheet>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <Pressable onPress={onChange} style={styles.toggle} accessibilityRole="checkbox" accessibilityState={{ checked }}>
      <View style={[styles.checkbox, checked && styles.checkboxOn]}><Text style={styles.checkboxMark}>{checked ? '✓' : ''}</Text></View>
      <Text style={styles.toggleLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: space.lg, paddingBottom: 40, gap: space.md },
  header: { flexDirection: 'row-reverse', alignItems: 'center', gap: space.md },
  hello: { fontFamily: fonts.bold, fontSize: 21, color: colors.green900, textAlign: 'right' },
  date: { fontFamily: fonts.regular, fontSize: 12, color: colors.muted, textAlign: 'right' },
  avatar: { width: 44, height: 44, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontFamily: fonts.bold, fontSize: 19, color: '#fdf8ec' },
  hero: { gap: space.sm, paddingVertical: space.xl },
  heroTimer: { fontFamily: fonts.bold, fontSize: 20, color: '#fdf8ec', writingDirection: 'ltr' },
  heroHint: { fontFamily: fonts.regular, fontSize: 12, color: 'rgba(253,248,236,0.72)', textAlign: 'right', lineHeight: 20 },
  heroStats: { flexDirection: 'row-reverse', alignItems: 'center', marginVertical: space.sm },
  heroDivider: { width: StyleSheet.hairlineWidth, height: 30, backgroundColor: 'rgba(255,255,255,0.18)' },
  openVisit: { borderColor: '#cfdcc9' },
  openTimer: { fontFamily: fonts.bold, fontSize: 16, color: colors.amber, writingDirection: 'ltr' },
  actions: { flexDirection: 'row-reverse', gap: space.sm },
  action: { flex: 1, backgroundColor: colors.white, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.md, alignItems: 'center', gap: 4 },
  actionIcon: { width: 34, height: 34, borderRadius: 12, backgroundColor: colors.mint, alignItems: 'center', justifyContent: 'center' },
  actionIconText: { fontSize: 16, color: colors.green700 },
  actionLabel: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.green900, textAlign: 'center' },
  actionHint: { fontFamily: fonts.regular, fontSize: 10.5, color: colors.muted, textAlign: 'center' },
  link: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.green700 },
  meta: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.muted },
  visitRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: space.sm, paddingVertical: 7 },
  visitDot: { width: 8, height: 8, borderRadius: 4 },
  visitName: { fontFamily: fonts.medium, fontSize: 13.5, color: colors.ink, textAlign: 'right' },
  error: { fontFamily: fonts.regular, fontSize: 12, color: '#ffd7d7', textAlign: 'right' },
  toggle: { flexDirection: 'row-reverse', alignItems: 'flex-start', gap: space.sm },
  checkbox: { width: 22, height: 22, borderRadius: 7, borderWidth: 1.5, borderColor: colors.line, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.white },
  checkboxOn: { backgroundColor: colors.green700, borderColor: colors.green700 },
  checkboxMark: { color: '#fdf8ec', fontSize: 13, fontFamily: fonts.bold },
  toggleLabel: { flex: 1, fontFamily: fonts.regular, fontSize: 12.5, color: colors.ink, textAlign: 'right', lineHeight: 20 },
});
