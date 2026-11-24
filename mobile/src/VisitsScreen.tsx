import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, fonts, space } from './theme';
import { Body, Button, Card, Empty, Heading, Pill, Row, SectionTitle } from './ui';
import { CheckInSheet, CheckOutSheet } from './VisitSheets';
import CatalogueSheet from './CatalogueSheet';
import { dayText, hhmmss, isToday, timeText } from './format';
import { customerStageLabels, visitPurposeLabels, type User, type Visit } from './types';
import type { FieldBundle } from './useField';

export default function VisitsScreen({ user, field }: { user: User; field: FieldBundle }) {
  const [now, setNow] = useState(Date.now());
  const [filter, setFilter] = useState<'all' | 'open' | 'closed'>('all');
  const [checkInOpen, setCheckInOpen] = useState(false);
  const [checkOutVisit, setCheckOutVisit] = useState<Visit | null>(null);
  const [catalogueOpen, setCatalogueOpen] = useState(false);

  // The ticking clock only exists for the open visit's stopwatch. It used to run on every
  // visit screen: a full re-render of the whole list every second, all day, on a phone that is
  // already tracking GPS — for a number that does not change when nothing is open.
  const openVisitId = field.summary?.openVisit?.id ?? null;
  // The book is asked for here as well as inside the sheet: this tab is where an engineer lands when
  // he is still in range of a network, and the list has to be in memory before he walks into a farm
  // with no signal.
  useEffect(() => { void field.loadCustomers(); }, [field.loadCustomers]);
  // Same reason for the catalogue: the «بتبيعوا كبريتات؟» question gets asked in the farm, not in the car.
  useEffect(() => { void field.loadProducts(); }, [field.loadProducts]);
  useEffect(() => {
    if (!openVisitId) return;
    // Start from the current second: the clock on this screen may be older than the visit.
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [openVisitId]);

  const timeZone = field.summary?.timezone;
  const shift = field.summary?.shift ?? null;
  const allVisits = Array.isArray(field.visits) ? field.visits : [];
  const visits = useMemo(() => (filter === 'all' ? allVisits : allVisits.filter(v => v.status === filter)), [allVisits, filter]);
  const open = field.summary?.openVisit ?? null;
  // The list also carries visits from the last two weeks: those whose result is still missing
  // (the system closed them) and one left open by a shift that ended somewhere else. Every
  // figure in the header is about today, so the average is not a mix of several days.
  const todayVisits = allVisits.filter(visit => isToday(visit.checkedInAt, timeZone));
  const measuredClosed = todayVisits.filter(v => v.status === 'closed' && !v.autoClosed && v.durationSeconds !== null);
  const avgMinutes = measuredClosed.length ? Math.round(measuredClosed.reduce((sum, v) => sum + Number(v.durationSeconds), 0) / measuredClosed.length / 60) : 0;
  const todayCount = todayVisits.length;
  const pendingCount = allVisits.filter(visit => visit.pendingResult).length;
  const earlierOpen = allVisits.some(visit => visit.status === 'open' && !isToday(visit.checkedInAt, timeZone));
  /** A row from an earlier day that is still open: nothing else can close it. */
  const canCloseFromRow = (visit: Visit) => Boolean(visit.pendingResult) || (visit.status === 'open' && !isToday(visit.checkedInAt, timeZone));

  return (
    <>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>زيارات اليوم</Text>
            <Text style={styles.sub}>{todayCount} زيارة · {open ? 'واحدة مفتوحة' : 'لا زيارة مفتوحة'} · قائمتك {field.customers.length} عميل{field.products.length ? ` · ${field.products.length} صنف` : ''}{measuredClosed.length ? ` · متوسط ${avgMinutes} دقيقة` : ''}{pendingCount ? ` · ${pendingCount} بدون نتيجة` : ''}{earlierOpen ? ' · زيارة قديمة مفتوحة' : ''}</Text>
          </View>
          <View style={styles.count}><Text style={styles.countText}>{todayCount}</Text></View>
        </View>

        {!shift && (
          <Card tone="mint">
            <Body>لازم تبدأ الوردية الأول عشان تقدر تسجّل زيارة — التسجيل مربوط بورديتك وموقعك.</Body>
          </Card>
        )}

        {shift && !field.customersLoading && field.customers.length === 0 && (
          <Card tone="mint">
            <Body>
              قائمتك فاضية من العملاء. مدير المبيعات هو اللي بيضيف عملاء الشركة وبيحدد مين يخدم كل
              عميل — من غير كده مفيش زيارة تتسجّل، لأن الزيارة بتتربط بعميل من القائمة مش باسم مكتوب.
            </Body>
            <Row style={{ marginTop: space.sm }}>
              <Button size="sm" variant="soft" label="أعد تحميل القائمة" onPress={() => { void field.loadCustomers(); }} />
            </Row>
          </Card>
        )}

        {field.customersNotice ? <Body muted style={{ fontSize: 12 }}>{field.customersNotice}</Body> : null}

        {open ? (
          <Card tone="mint" style={styles.openCard}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Pill label={isToday(open.checkedInAt, timeZone) ? 'مفتوحة الآن' : `مفتوحة من ${dayText(open.checkedInAt, timeZone)}`} tone="warn" />
              <Text style={styles.timer}>{hhmmss(now - open.checkedInAt)}</Text>
            </Row>
            <Heading>{open.customerName}</Heading>
            <Body muted>
              {visitPurposeLabels[open.purpose] ?? 'زيارة'} · دخلت {timeText(open.checkedInAt, timeZone)}
              {open.inAccuracy ? ` · دقة ±${Math.round(open.inAccuracy)} م` : ''}
            </Body>
            <Row style={{ gap: space.sm }}>
              <Button style={{ flex: 1 }} label={isToday(open.checkedInAt, timeZone) ? 'إنهاء وتسجيل النتيجة' : 'اقفل الزيارة القديمة'} onPress={() => setCheckOutVisit(open)} />
            </Row>
          </Card>
        ) : (
          <Button label={shift ? '+ تسجيل زيارة جديدة' : 'ابدأ الوردية من الرئيسية'} onPress={() => { if (shift) setCheckInOpen(true); }} disabled={!shift} icon="◎" />
        )}

        <Button label="قائمة الأصناف اللي بنبيعها" variant="soft" onPress={() => setCatalogueOpen(true)} icon="☷" />

        <SectionTitle title="السجل" action={
          <Row style={{ gap: 6 }}>
            {([['all', 'الكل'], ['open', 'مفتوحة'], ['closed', 'منتهية']] as const).map(([value, label]) => (
              <Pressable key={value} onPress={() => setFilter(value)} style={[styles.filter, filter === value && styles.filterActive]} accessibilityRole="button" accessibilityState={{ selected: filter === value }}>
                <Text style={[styles.filterText, filter === value && styles.filterTextActive]}>{label}</Text>
              </Pressable>
            ))}
          </Row>
        } />

        {visits.length === 0 ? (
          <Empty title="لا زيارات في هذا التصنيف" hint="كل زيارة تسجّلها تُضاف هنا بسجل الوقت والنتيجة." />
        ) : (
          <Card style={{ gap: 0 }}>
            {visits.map((visit, index) => (
              <View key={visit.id} style={[styles.row, index > 0 && styles.rowBorder]}>
                <View style={[styles.marker, { backgroundColor: visit.status === 'open' ? colors.amber : colors.green500 }]}>
                  <Text style={styles.markerText}>{visit.status === 'open' ? '●' : '✓'}</Text>
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.name}>{visit.customerName}</Text>
                  <Text style={styles.meta}>
                    {visitPurposeLabels[visit.purpose] ?? 'زيارة'} · {isToday(visit.checkedInAt, timeZone) ? '' : `${dayText(visit.checkedInAt, timeZone)} · `}{timeText(visit.checkedInAt, timeZone)}
                    {visit.status === 'open' ? ' · جارية'
                      : visit.durationSeconds === null ? (visit.autoClosed ? ' · أُغلقت تلقائيًا' : ' · منتهية')
                      : ` ← ${timeText(visit.checkedOutAt ?? visit.checkedInAt, timeZone)} · ${Math.max(1, Math.round(visit.durationSeconds / 60))} د`}
                  </Text>
                  {visit.outcome ? <Text style={styles.outcome} numberOfLines={2}>{visit.outcome}</Text> : null}
                  {visit.village || visit.district ? <Text style={styles.meta}>{[visit.governorate, visit.district, visit.village].filter(Boolean).join(' · ')}</Text> : null}
                  {/* Two rows the engineer alone can finish: one the system closed without a
                      result, and one left open by a shift that ended somewhere else — it is not
                      on the "today" list, so this row is the only place it can be closed. */}
                  {canCloseFromRow(visit) ? (
                    <Pressable onPress={() => setCheckOutVisit(visit)} accessibilityRole="button" style={styles.lateButton}>
                      <Text style={styles.lateText}>{visit.pendingResult ? 'سجّل نتيجة الزيارة' : 'اقفل الزيارة وتسجيل النتيجة'}</Text>
                    </Pressable>
                  ) : null}
                </View>
                <Pill label={visit.status === 'open' ? 'مفتوحة' : visit.pendingResult ? 'بدون نتيجة' : visit.autoClosed ? 'تلقائي' : 'منتهية'} tone={visit.status === 'open' || visit.pendingResult ? 'warn' : visit.autoClosed ? 'warn' : 'mint'} />
              </View>
            ))}
          </Card>
        )}
        <Text style={styles.footnote}>كل زيارة تُسجَّل بالموقع والدقة وتظهر فورًا في لوحة المدير.</Text>
      </ScrollView>

      <CheckInSheet visible={checkInOpen} onClose={() => setCheckInOpen(false)} field={field} user={user} />
      <CheckOutSheet visit={checkOutVisit} onClose={() => setCheckOutVisit(null)} field={field} />
      <CatalogueSheet visible={catalogueOpen} onClose={() => setCatalogueOpen(false)} field={field} />
    </>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: space.lg, paddingBottom: 40, gap: space.md },
  header: { flexDirection: 'row-reverse', alignItems: 'center', gap: space.md },
  title: { fontFamily: fonts.bold, fontSize: 22, color: colors.green900, textAlign: 'right' },
  sub: { fontFamily: fonts.regular, fontSize: 12, color: colors.muted, textAlign: 'right' },
  count: { width: 44, height: 44, borderRadius: 15, backgroundColor: colors.mint, alignItems: 'center', justifyContent: 'center' },
  countText: { fontFamily: fonts.bold, fontSize: 18, color: colors.green700 },
  openCard: { borderColor: '#cfdcc9' },
  timer: { fontFamily: fonts.bold, fontSize: 16, color: colors.amber, writingDirection: 'ltr' },
  filter: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white },
  filterActive: { backgroundColor: colors.green700, borderColor: colors.green700 },
  filterText: { fontFamily: fonts.medium, fontSize: 11.5, color: colors.green900 },
  filterTextActive: { color: '#fdf8ec' },
  row: { flexDirection: 'row-reverse', alignItems: 'flex-start', gap: space.sm, paddingVertical: space.md },
  rowBorder: { borderTopWidth: 1, borderTopColor: colors.line },
  marker: { width: 24, height: 24, borderRadius: 8, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  markerText: { color: '#fdf8ec', fontSize: 11, fontFamily: fonts.bold },
  name: { fontFamily: fonts.bold, fontSize: 14, color: colors.ink, textAlign: 'right' },
  meta: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.muted, textAlign: 'right' },
  lateButton: { alignSelf: 'flex-end', marginTop: 4, borderWidth: 1, borderColor: colors.green700, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 5 },
  lateText: { fontFamily: fonts.medium, fontSize: 11.5, color: colors.green700 },
  outcome: { fontFamily: fonts.regular, fontSize: 12, color: colors.green900, textAlign: 'right', lineHeight: 19 },
  footnote: { fontFamily: fonts.regular, fontSize: 11, color: colors.muted, textAlign: 'center' },
});
