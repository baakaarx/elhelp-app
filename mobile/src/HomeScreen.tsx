import { useEffect, useState } from 'react';
import { Image, Platform, Pressable, ScrollView, StyleSheet, Text, View, TextInput } from 'react-native';
import { colors, fonts, radius, space } from './theme';
import { Body, Button, Card, Empty, Heading, Pill, Row, SectionTitle, Sheet, Stat } from './ui';
import { CheckInSheet, CheckOutSheet } from './VisitSheets';
import OrderSheet from './OrderSheet';
import { clockText, hhmmss, timeText } from './format';
import { visitPurposeLabels, type User, type Visit } from './types';
import type { FieldBundle } from './useField';
import { captureOnce, locationIssueMessage } from './location';
import { getDeviceId } from './device';
import { reportIdle } from './api';

type Props = {
  user: User;
  field: FieldBundle;
  onOpenVisits: () => void;
};

export default function HomeScreen({ user, field, onOpenVisits }: Props) {
  const [now, setNow] = useState(Date.now());
  const [consentOpen, setConsentOpen] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [checkInOpen, setCheckInOpen] = useState(false);
  const [checkOutVisit, setCheckOutVisit] = useState<Visit | null>(null);
  const [orderOpen, setOrderOpen] = useState(false);
  const [orderMessage, setOrderMessage] = useState('');
  const [orderVisit, setOrderVisit] = useState<Visit | null>(null);

  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);

  const summary = field.summary;
  // Every label on this screen uses the installation's clock, exactly like the manager's copy
  // of the same record — never the phone's own zone.
  const timeZone = summary?.timezone;
  const shift = summary?.shift ?? null;
  const openVisit = summary?.openVisit ?? null;
  const shiftElapsed = shift ? hhmmss(now - shift.started_at) : null;
  const openElapsed = openVisit ? hhmmss(now - openVisit.checkedInAt) : null;

  return (
    <>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.hello}>أهلاً {user.name.split(' ')[0]} 👋</Text>
            <Text style={styles.date}>{clockText(now, timeZone)}</Text>
          </View>
          {/* Company mark instead of a bare initial: the engineer sees the ElHelp identity
              next to their own name, and the greeting already carries their first name. */}
          <View style={styles.avatar}>
            <Image source={require('../assets/elhelb-logo.gif')} style={styles.avatarImage} accessibilityLabel="شعار الهلب جروب" />
          </View>
        </View>

        <Card tone="dark" style={styles.hero}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Pill label={shift ? (field.trackingActive ? 'الوردية شغالة' : 'الوردية مفتوحة · التتبع متوقف') : 'خارج الوردية'} tone={shift && field.trackingActive ? 'dark' : 'warn'} />
            <Text style={styles.heroTimer}>{shift ? shiftElapsed : '—:—:—'}</Text>
          </Row>
          <Text style={styles.heroHint}>
            {shift
              ? `بدأت ${timeText(Number(shift.started_at), timeZone)} · ${field.trackingActive ? 'يتم تسجيل موقعك' : 'استأنف تسجيل الموقع'}`
              : 'ابدأ الوردية ليبدأ تسجيل موقعك ويظهر مسارك للمدير.'}
          </Text>
          <View style={styles.heroStats}>
            <Stat tone="dark" label="كم اليوم" value={(Number(summary?.distanceMeters ?? 0) / 1000).toFixed(1)} />
            <View style={styles.heroDivider} />
            <Stat tone="dark" label="زيارات" value={String(summary?.visitsTotal ?? 0)} />
          </View>
          {shift && !field.trackingActive ? <Button label="استئناف تسجيل الموقع" onPress={() => setResumeOpen(true)} loading={field.busy} /> : null}
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
          // The same threshold the server alerts on, so the phone and the manager agree.
          const idleLimitMs = (summary?.idleReasonMinutes ?? 60) * 60000;
          const showIdle = shift && idleMs !== null && idleMs > idleLimitMs;
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
              {visitPurposeLabels[openVisit.purpose] ?? 'زيارة'} · بدأت {timeText(openVisit.checkedInAt, timeZone)}
              {openVisit.governorate ? ` · ${openVisit.governorate}` : ''}
            </Body>
            <Row style={{ gap: space.sm, marginTop: 4 }}>
              <Button style={{ flex: 1 }} label="إنهاء الزيارة" onPress={() => setCheckOutVisit(openVisit)} />
              <Button style={{ flex: 1 }} label="طلبية للعميل" variant="ghost" onPress={() => { setOrderVisit(openVisit); setOrderOpen(true); }} />
            </Row>
          </Card>
        ) : null}

        <View style={styles.actions}>
          <ActionTile icon="◉" label="زيارة جديدة" hint="تسجيل حضور" onPress={() => { if (!shift) { setConsentOpen(true); return; } setCheckInOpen(true); }} />
          <ActionTile icon="₪" label="تسجيل طلبية" hint="كميات على العميل" onPress={() => { setOrderVisit(null); setOrderOpen(true); }} />
        </View>

        {orderMessage ? <Card tone="mint"><Row style={{ justifyContent: 'space-between' }}>
          <Text style={{ flex: 1, color: colors.green900 }}>{orderMessage}</Text>
          <Pressable onPress={() => setOrderMessage('')} accessibilityRole="button" accessibilityLabel="إخفاء رسالة الطلبية"><Text style={styles.link}>إخفاء</Text></Pressable>
        </Row></Card> : null}

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
                  {visitPurposeLabels[visit.purpose] ?? 'زيارة'} · {timeText(visit.checkedInAt, timeZone)}
                  {visit.status === 'open' ? ' · مفتوحة'
                    : visit.durationSeconds !== null ? ` · ${Math.max(1, Math.round(visit.durationSeconds / 60))} دقيقة`
                    : visit.autoClosed ? ' · أُغلقت تلقائيًا' : ' · منتهية'}
                </Text>
              </View>
              {visit.status === 'open' && <Pressable onPress={() => setCheckOutVisit(visit)}><Text style={styles.link}>إنهاء</Text></Pressable>}
            </View>
          ))}
        </Card>

      </ScrollView>

      <ConsentSheet
        mode="resume"
        retentionDays={field.summary?.retentionDays ?? 365}
        visible={resumeOpen}
        onClose={() => { if (!field.busy) { setResumeOpen(false); field.clearError(); } }}
        onStart={async (background) => { try { await field.resumeTracking({ background }); setResumeOpen(false); } catch { /* keep the sheet open with the reason */ } }}
        busy={field.busy}
        error={field.error}
      />
      <ConsentSheet
        retentionDays={field.summary?.retentionDays ?? 365}
        visible={consentOpen}
        onClose={() => { if (!field.busy) { setConsentOpen(false); field.clearError(); } }}
        onStart={async (background) => { try { await field.beginShift({ background }); setConsentOpen(false); } catch { /* Keep the sheet open with the error. */ } }}
        busy={field.busy}
        error={field.error}
      />
      <CheckInSheet visible={checkInOpen} onClose={() => setCheckInOpen(false)} field={field} user={user} />
      <OrderSheet visible={orderOpen} onClose={() => setOrderOpen(false)} field={field} visit={orderVisit}
        onSubmitted={result => setOrderMessage(result === 'queued' ? 'الطلبية محفوظة على الهاتف، ولم نتأكد من وصولها للمكتب بعد. راجع المزامنة ولا تكرر الطلبية.' : 'الطلبية وصلت للمكتب وبقت مستنية المراجعة.')} />
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

function ConsentSheet({ visible, onClose, onStart, busy, error, retentionDays, mode = 'start' }: {
  visible: boolean; onClose: () => void; onStart: (background: boolean) => void;
  busy: boolean; error: string; retentionDays: number; mode?: 'start' | 'resume';
}) {
  const [agreed, setAgreed] = useState(false);
  const [background, setBackground] = useState(true);
  useEffect(() => { if (visible) { setAgreed(false); setBackground(true); } }, [visible]);
  return (
    <ConsentSheetShell mode={mode} visible={visible} onClose={onClose} agreed={mode === 'resume' || agreed} setAgreed={setAgreed}
      background={background} setBackground={setBackground} onStart={() => onStart(background)} busy={busy} error={error}
      retentionDays={retentionDays} />
  );
}

function ConsentSheetShell({ visible, onClose, agreed, setAgreed, background, setBackground, onStart, busy, error, retentionDays, mode = 'start' }: {
  visible: boolean; onClose: () => void; agreed: boolean; setAgreed: (value: boolean) => void;
  background: boolean; setBackground: (value: boolean) => void; onStart: () => void; busy: boolean; error: string;
  retentionDays: number;
  mode?: 'start' | 'resume';
}) {
  const resume = mode === 'resume';
  return (
    <Sheet visible={visible} onClose={onClose} title={resume ? 'استئناف تسجيل الموقع' : 'قبل أن نبدأ تتبع الموقع'}>
      {resume ? (
        <>
          <Body>الوردية مفتوحة لكن تسجيل الموقع متوقف — غالبًا لأن التطبيق أُغلق أو أوقف النظام التتبع في الخلفية.</Body>
          <Body muted>بالضغط هنا يرجع التتبع على نفس الوردية بدون بدء وردية جديدة وبدون انتظار إشارة GPS.</Body>
        </>
      ) : (
        <>
          <Body>
            أثناء الوردية فقط، يسجّل التطبيق موقعك كل ثانية تقريبًا ويُرسله إلى لوحة متابعة الهلب.
            تُستخدم بيانات الموقع لعرض خط سيرك للمدير، وتُحذف تلقائيًا بعد {retentionDays} يومًا.
          </Body>
          <Body muted>يمكنك إيقاف التتبع في أي لحظة من الزر الأحمر، ويُسجَّل كل بدء/إيقاف في سجل التدقيق.</Body>
        </>
      )}
      {Platform.OS === 'web' ? <Body muted>على المتصفح قد يتوقف تسجيل الموقع عند إغلاق الصفحة أو قفل الشاشة.</Body> : <Toggle checked={background} onChange={() => setBackground(!background)} label="السماح بالتسجيل في الخلفية (موصى به حتى لو الشاشة مقفولة)" />}
      {resume ? null : <Toggle checked={agreed} onChange={() => setAgreed(!agreed)} label="أوافق على تسجيل موقعي طوال الوردية وأقر بأن هذا توقيعي على الموافقة." />}
      {error ? <Text accessibilityRole="alert" style={{ color: colors.danger, textAlign: 'right', fontFamily: fonts.regular }}>{error}</Text> : null}
      <Button label={resume ? 'استئناف التتبع' : 'موافق، ابدأ الوردية'} onPress={onStart} disabled={!agreed || busy} loading={busy} />
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
          <Text style={{ fontFamily: fonts.bold, color: colors.amber }}>سكون {minutes} دقيقة</Text>
        </Row>
        <Body>لم يتحرك هاتفك منذ {minutes} دقيقة — يجب كتابة سبب الوقوف ليصل للمدير.</Body>
        <Button label="كتابة سبب الوقوف" variant="primary" onPress={() => setOpen(true)} />
      </Card>
    );
  }
  return <IdleSheet minutes={minutes} onClose={() => setOpen(false)} />;
}

function IdleSheet({ minutes, onClose }: { minutes: number; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (reason.trim().length < 5) { setError('اكتب سبب الوقوف (٥ أحرف على الأقل).'); return; }
    setSaving(true); setError('');
    try {
      const fix = await captureOnce({ maxAgeMs: 0 });
      if (!fix) throw new Error(locationIssueMessage() || 'GPS مطلوب — فعّل الموقع لإرسال تبرير الوقوف.');
      const deviceId = await getDeviceId();
      await reportIdle(reason.trim(), { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy }, deviceId);
      onClose();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };
  return (
    <Sheet visible={true} onClose={onClose} title={`تبرير الوقوف — سكون ${minutes} دقيقة`}>
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
  avatar: { width: 46, height: 46, borderRadius: 15, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', backgroundColor: '#fdf8ec' },
  avatarImage: { width: 46, height: 46, resizeMode: 'cover' },
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
