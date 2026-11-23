import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, fonts, radius, space } from './theme';
import { Body, Button, Card, Empty, Field, Heading, Pill, Row, SectionTitle, Sheet } from './ui';
import { CheckInSheet } from './VisitSheets';
import { agoText, dayText } from './format';
import { useCustomers } from './useCustomers';
import { customerStageLabels, type Customer, type User } from './types';
import type { FieldBundle } from './useField';

/**
 * «My customers» — the list an engineer keeps for himself, from the field.
 *
 * The manager's dashboard reviews this list and moves it between engineers; only this screen owns
 * adding to it, because the man standing in front of the farm is the one who knows it exists. A
 * visit booked from here carries the customer's id, which is what lets sales be counted per
 * customer later; a visit typed by hand still works and simply joins the list when the name matches.
 */
const STAGES: Customer['stage'][] = ['new', 'following', 'active', 'dormant', 'lost'];
const STAGE_TONE: Record<Customer['stage'], 'mint' | 'warn' | 'danger' | 'dark'> = {
  new: 'dark', following: 'mint', active: 'mint', dormant: 'warn', lost: 'danger',
};
const emptyForm = { name: '', phone: '', governorate: '', district: '', village: '', notes: '', stage: 'new' as Customer['stage'], lostReason: '' };

export default function CustomersScreen({ user, field }: { user: User; field: FieldBundle }) {
  const { customers, loading, error, unsupported, refresh, add, setStage } = useCustomers();
  const [query, setQuery] = useState('');
  const [stage, setStageFilter] = useState<'all' | Customer['stage']>('all');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState<Customer | null>(null);
  const [checkingIn, setCheckingIn] = useState<Customer | null>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return customers.filter(item => (stage === 'all' || item.stage === stage)
      && (!needle || `${item.name} ${item.phone} ${item.district} ${item.village}`.toLowerCase().includes(needle)));
  }, [customers, query, stage]);
  const cooling = useMemo(() => customers.filter(item => item.stage === 'dormant').length, [customers]);

  const closeForm = useCallback(() => { setAdding(false); setForm(emptyForm); setFormError(''); }, []);
  async function submit() {
    if (form.name.trim().length < 2) { setFormError('اكتب اسم العميل أو المزرعة.'); return; }
    setSaving(true); setFormError('');
    const created = await add({ ...form, name: form.name.trim(), lostReason: form.stage === 'lost' ? form.lostReason.trim() : '' });
    setSaving(false);
    // `add` swallows the server's reason into `error`; show whichever one it answered with.
    if (!created) { setFormError(formError || error || 'تعذر الحفظ. حاول تاني.'); return; }
    closeForm();
  }

  return (
    <>
      <ScrollView
        contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh()} tintColor={colors.green700} />}
      >
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>عملائي</Text>
            <Text style={styles.sub}>
              {unsupported ? 'السيرفر ده لسه ما فيهوش قايمعة عملاء.'
                : `${customers.length} عميل${cooling ? ` · ${cooling} محتاج متابعة` : ''}`}
            </Text>
          </View>
          <Pressable onPress={() => setAdding(true)} accessibilityRole="button" accessibilityLabel="إضافة عميل" style={styles.add}>
            <Text style={styles.addText}>+ عميل</Text>
          </Pressable>
        </View>

        {error ? <Card tone="mint"><Body style={styles.errorText}>⚠ {error}</Body></Card> : null}

        {!unsupported && (
          <>
            <Field label="دوّر بالاسم أو التليفون" value={query} onChangeText={setQuery} placeholder="مزرعة النور" autoCorrect={false} />
            <View style={styles.chips}>
              {(['all', ...STAGES] as const).map(item => (
                <Pressable
                  key={item} onPress={() => setStageFilter(item)} accessibilityRole="button"
                  accessibilityState={{ selected: stage === item }}
                  style={[styles.chip, stage === item && styles.chipActive]}
                >
                  <Text style={[styles.chipText, stage === item && styles.chipTextActive]}>
                    {item === 'all' ? 'الكل' : customerStageLabels[item]}
                  </Text>
                </Pressable>
              ))}
            </View>
          </>
        )}

        {visible.length === 0 ? (
          <Empty
            title={customers.length ? 'مفيش عملاء بالبحث ده' : 'قايمعتك فاضية'}
            hint={customers.length ? 'جرّب اسم تاني أو صفّي على مرحلة.' : 'ضيف العميل من زر «+ عميل»، أو سجّل زيارتك الأولى باسمه وهيظهر هنا.'}
          />
        ) : (
          <Card style={{ gap: 0 }}>
            {visible.map((item, index) => (
              <Pressable
                key={item.id} onPress={() => { setOpen(item); setFormError(''); }} accessibilityRole="button"
                style={[styles.row, index > 0 && styles.rowBorder]}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.name}>{item.name}</Text>
                  <Text style={styles.meta}>
                    {[item.governorate, item.district, item.village].filter(Boolean).join(' · ') || 'من غير عنوان'}
                    {item.phone ? ` · ${item.phone}` : ''}
                  </Text>
                  <Text style={styles.meta}>
                    {item.lastVisitAt ? `آخر زيارة ${item.lastVisitAt ? dayText(item.lastVisitAt, field.summary?.timezone) : ''} · ${agoText(item.lastVisitAt)}` : 'لسه من غير زيارة'}
                    {` · ${item.visitCount} زيارة`}
                  </Text>
                </View>
                <View style={{ alignItems: 'flex-end', gap: 4 }}>
                  <Pill label={customerStageLabels[item.stage]} tone={STAGE_TONE[item.stage]} />
                  {item.openVisits ? <Text style={styles.openTag}>زيارة مفتوحة</Text> : null}
                </View>
              </Pressable>
            ))}
          </Card>
        )}
        <Text style={styles.footnote}>القايمعة دي بتاعتك إنت: مهندس تاني ما بيشوفهاش، والمدير براجعها من اللوحة.</Text>
      </ScrollView>

      <Sheet visible={adding} onClose={closeForm} title="عميل جديد">
        <Field label="اسم العميل / المزرعة *" value={form.name} onChangeText={value => setForm(f => ({ ...f, name: value }))} autoFocus />
        <Row style={{ gap: space.sm }}>
          <View style={{ flex: 1 }}><Field label="الهاتف" value={form.phone} onChangeText={value => setForm(f => ({ ...f, phone: value }))} keyboardType="phone-pad" style={styles.ltr} /></View>
        </Row>
        <Row style={{ gap: space.sm }}>
          <View style={{ flex: 1 }}><Field label="المحافظة" value={form.governorate} onChangeText={value => setForm(f => ({ ...f, governorate: value }))} /></View>
          <View style={{ flex: 1 }}><Field label="المركز" value={form.district} onChangeText={value => setForm(f => ({ ...f, district: value }))} /></View>
        </Row>
        <Field label="قرية / منطقة" value={form.village} onChangeText={value => setForm(f => ({ ...f, village: value }))} />
        <View style={{ gap: 6 }}>
          <Text style={styles.label}>المرحلة</Text>
          <View style={styles.chips}>
            {STAGES.map(item => (
              <Pressable key={item} onPress={() => setForm(f => ({ ...f, stage: item }))} style={[styles.chip, form.stage === item && styles.chipActive]}>
                <Text style={[styles.chipText, form.stage === item && styles.chipTextActive]}>{customerStageLabels[item]}</Text>
              </Pressable>
            ))}
          </View>
        </View>
        {form.stage === 'lost' && (
          <Field label="سبب الرفض *" value={form.lostReason} onChangeText={value => setForm(f => ({ ...f, lostReason: value }))} placeholder="السعر أعلى من السوق" />
        )}
        <Field label="ملاحظات" value={form.notes} onChangeText={value => setForm(f => ({ ...f, notes: value }))} multiline style={{ minHeight: 64 }} />
        {formError ? <Text style={styles.error}>{formError}</Text> : null}
        <Button label={saving ? 'جارٍ الحفظ…' : 'حفظ العميل'} onPress={submit} loading={saving} icon="✓" />
      </Sheet>

      <Sheet visible={Boolean(open)} onClose={() => setOpen(null)} title={open?.name ?? ''}>
        {open ? (
          <>
            <Row style={{ justifyContent: 'space-between' }}>
              <Pill label={customerStageLabels[open.stage]} tone={STAGE_TONE[open.stage]} />
              <Text style={styles.meta}>{open.visitCount} زيارة</Text>
            </Row>
            <Body muted>
              {[open.governorate, open.district, open.village].filter(Boolean).join(' · ') || 'من غير عنوان'}
              {open.phone ? ` · ${open.phone}` : ''}
            </Body>
            {open.notes ? <Body>{open.notes}</Body> : null}
            <Body muted>{open.lastVisitAt ? `آخر زيارة ${dayText(open.lastVisitAt, field.summary?.timezone)} (${agoText(open.lastVisitAt)})` : 'لسه ما اتزارتش'}</Body>
            {open.stage === 'lost' && open.lostReason ? <Body muted>سبب الرفض: {open.lostReason}</Body> : null}
            <Button
              label="تسجيل زيارة دلوقتي" icon="◎"
              onPress={() => { setCheckingIn(open); setOpen(null); }}
              disabled={!field.summary?.shift || Boolean(field.summary?.openVisit && field.summary.openVisit.id)}
            />
            {!field.summary?.shift ? <Body muted>ابدأ الوردية الأول من الرئيسية عشان تسجّل الزيارة.</Body>
              : field.summary?.openVisit ? <Body muted>عندك زيارة مفتوحة — اقفلها الأول من تبويب الزيارات.</Body> : null}
            <SectionTitle title="المرحلة" />
            <View style={styles.chips}>
              {STAGES.filter(item => item !== open.stage).map(item => (
                <Pressable
                  key={item} accessibilityRole="button"
                  onPress={() => {
                    if (item === 'lost') { setFormError('اكتب سبب الرفض من اللوحة أو سيّج الزيارة بنتيجتها.'); return; }
                    void setStage(open.id, item);
                  }}
                  style={styles.chip}
                >
                  <Text style={styles.chipText}>{customerStageLabels[item]}</Text>
                </Pressable>
              ))}
            </View>
            {formError ? <Text style={styles.error}>{formError}</Text> : null}
          </>
        ) : null}
      </Sheet>

      <CheckInSheet visible={Boolean(checkingIn)} onClose={() => setCheckingIn(null)} field={field} user={user} preset={checkingIn ?? undefined} />
    </>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: space.lg, paddingBottom: 40, gap: space.md },
  header: { flexDirection: 'row-reverse', alignItems: 'center', gap: space.md },
  title: { fontFamily: fonts.bold, fontSize: 22, color: colors.green900, textAlign: 'right' },
  sub: { fontFamily: fonts.regular, fontSize: 12, color: colors.muted, textAlign: 'right' },
  add: { borderRadius: radius.pill, backgroundColor: colors.green700, paddingHorizontal: 12, paddingVertical: 8 },
  addText: { fontFamily: fonts.bold, fontSize: 12.5, color: '#fdf8ec' },
  chips: { flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 6 },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white },
  chipActive: { backgroundColor: colors.green700, borderColor: colors.green700 },
  chipText: { fontFamily: fonts.medium, fontSize: 11.5, color: colors.green900 },
  chipTextActive: { color: '#fdf8ec' },
  row: { flexDirection: 'row-reverse', alignItems: 'flex-start', gap: space.sm, paddingVertical: space.md },
  rowBorder: { borderTopWidth: 1, borderTopColor: colors.line },
  name: { fontFamily: fonts.bold, fontSize: 14.5, color: colors.ink, textAlign: 'right' },
  meta: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.muted, textAlign: 'right' },
  openTag: { fontFamily: fonts.medium, fontSize: 10.5, color: colors.amber },
  label: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.muted, textAlign: 'right' },
  ltr: { writingDirection: 'ltr', textAlign: 'left' },
  error: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.danger, textAlign: 'right' },
  errorText: { color: colors.danger },
  footnote: { fontFamily: fonts.regular, fontSize: 11, color: colors.muted, textAlign: 'center' },
});
