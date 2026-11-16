import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, fonts, space } from './theme';
import { Body, Button, Card, Empty, Heading, Pill, Row, SectionTitle } from './ui';
import { CheckInSheet, CheckOutSheet } from './VisitSheets';
import { hhmmss, timeText } from './format';
import { visitPurposeLabels, type User, type Visit } from './types';
import type { FieldBundle } from './useField';

export default function VisitsScreen({ user, field }: { user: User; field: FieldBundle }) {
  const [now, setNow] = useState(Date.now());
  const [filter, setFilter] = useState<'all' | 'open' | 'closed'>('all');
  const [checkInOpen, setCheckInOpen] = useState(false);
  const [checkOutVisit, setCheckOutVisit] = useState<Visit | null>(null);

  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);

  const timeZone = field.summary?.timezone;
  const shift = field.summary?.shift ?? null;
  const visits = useMemo(() => (filter === 'all' ? field.visits : field.visits.filter(v => v.status === filter)), [field.visits, filter]);
  const open = field.summary?.openVisit ?? null;
  const closed = field.visits.filter(v => v.status === 'closed');
  const avgMinutes = closed.length ? Math.round(closed.reduce((sum, v) => sum + (v.durationSeconds ?? 0), 0) / closed.length / 60) : 0;

  return (
    <>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>زيارات اليوم</Text>
            <Text style={styles.sub}>{field.visits.length} زيارة · {open ? 'واحدة مفتوحة' : 'لا زيارة مفتوحة'}{closed.length ? ` · متوسط ${avgMinutes} دقيقة` : ''}</Text>
          </View>
          <View style={styles.count}><Text style={styles.countText}>{field.visits.length}</Text></View>
        </View>

        {!shift && (
          <Card tone="mint">
            <Body>لازم تبدأ الوردية الأول عشان تقدر تسجّل زيارة — التسجيل مربوط بورديتك وموقعك.</Body>
          </Card>
        )}

        {open ? (
          <Card tone="mint" style={styles.openCard}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Pill label="مفتوحة الآن" tone="warn" />
              <Text style={styles.timer}>{hhmmss(now - open.checkedInAt)}</Text>
            </Row>
            <Heading>{open.customerName}</Heading>
            <Body muted>
              {visitPurposeLabels[open.purpose]} · دخلت {timeText(open.checkedInAt, timeZone)}
              {open.inAccuracy ? ` · دقة ±${Math.round(open.inAccuracy)} م` : ''}
            </Body>
            <Row style={{ gap: space.sm }}>
              <Button style={{ flex: 1 }} label="إنهاء وتسجيل النتيجة" onPress={() => setCheckOutVisit(open)} />
            </Row>
          </Card>
        ) : (
          <Button label={shift ? '+ تسجيل زيارة جديدة' : 'ابدأ الوردية من الرئيسية'} onPress={() => { if (shift) setCheckInOpen(true); }} disabled={!shift} icon="◎" />
        )}

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
                    {visitPurposeLabels[visit.purpose]} · {timeText(visit.checkedInAt, timeZone)}
                    {visit.status === 'closed' && visit.durationSeconds !== null ? ` ← ${timeText(visit.checkedOutAt ?? visit.checkedInAt, timeZone)} · ${Math.max(1, Math.round(visit.durationSeconds / 60))} د` : ' · جارية'}
                  </Text>
                  {visit.outcome ? <Text style={styles.outcome} numberOfLines={2}>{visit.outcome}</Text> : null}
                  {visit.village || visit.district ? <Text style={styles.meta}>{[visit.governorate, visit.district, visit.village].filter(Boolean).join(' · ')}</Text> : null}
                </View>
                <Pill label={visit.status === 'open' ? 'مفتوحة' : 'منتهية'} tone={visit.status === 'open' ? 'warn' : 'mint'} />
              </View>
            ))}
          </Card>
        )}
        <Text style={styles.footnote}>كل زيارة تُسجَّل بالموقع والدقة وتظهر فورًا في لوحة المدير.</Text>
      </ScrollView>

      <CheckInSheet visible={checkInOpen} onClose={() => setCheckInOpen(false)} field={field} user={user} />
      <CheckOutSheet visit={checkOutVisit} onClose={() => setCheckOutVisit(null)} field={field} />
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
  outcome: { fontFamily: fonts.regular, fontSize: 12, color: colors.green900, textAlign: 'right', lineHeight: 19 },
  footnote: { fontFamily: fonts.regular, fontSize: 11, color: colors.muted, textAlign: 'center' },
});
