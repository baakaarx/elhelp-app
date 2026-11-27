import { useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, fonts, radius, space } from './theme';
import { Body, Button, Card, Empty, Field } from './ui';
import type { FieldBundle } from './useField';

const normalize = (value: string) => value.toLocaleLowerCase().replace(/[٠-٩]/g, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/[۰-۹]/g, c => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c)));

/** The company book assigned to this engineer, not the device's private contacts. */
export default function CustomersScreen({ field }: { field: FieldBundle }) {
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { void field.loadCustomers(); }, [field.loadCustomers]);
  const customers = useMemo(() => {
    const q = normalize(search.trim());
    return [...field.customers].filter(c => !q || normalize(`${c.name} ${c.phone} ${c.governorate} ${c.district} ${c.village}`).includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, 'ar') || a.id.localeCompare(b.id));
  }, [field.customers, search]);
  const call = async (phone: string) => {
    const digits = normalize(phone);
    if (!/^\+?[\d\s()-]+$/.test(digits) || !/\d/.test(digits)) { setError('رقم العميل غير واضح. راجع المكتب قبل الاتصال.'); return; }
    try { setError(''); await Linking.openURL(`tel:${digits.replace(/[\s()-]/g, '')}`); }
    catch { setError('تعذر فتح تطبيق الاتصال على الجهاز.'); }
  };
  return <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
    <Text style={styles.title}>عملائي</Text>
    <Body muted>عملاء الشركة المسندين إليك فقط · {field.customers.length} عميل</Body>
    <Field label="ابحث بالاسم أو الرقم أو المنطقة" value={search} onChangeText={setSearch} placeholder="ابحث عن عميل" autoCapitalize="none" />
    <Button variant="soft" size="sm" label={field.customersLoading ? 'جارٍ تحديث العملاء…' : 'تحديث العملاء'} onPress={() => { void field.loadCustomers(); }} disabled={field.customersLoading} />
    {field.customersNotice ? <Body muted>{field.customersNotice}</Body> : null}
    {error ? <Text style={styles.error}>{error}</Text> : null}
    {customers.length === 0 ? <Empty title={field.customersLoading ? 'جارٍ تحميل العملاء…' : search ? 'مفيش عميل مطابق للبحث' : 'مفيش عملاء في قائمتك'} hint={search ? 'جرّب اسمًا أو رقمًا آخر.' : 'المكتب يضيف العملاء ويحدد المهندس المسؤول عنهم.'} /> : customers.map(customer => <Card key={customer.id} style={styles.card}>
      <View style={styles.details}>
        <Text style={styles.name}>{customer.name}</Text>
        {customer.phone ? <Text style={styles.phone}>{customer.phone}</Text> : <Text style={styles.detail}>رقم الهاتف غير مسجل</Text>}
        <Text style={styles.detail}>{[customer.governorate, customer.district, customer.village].filter(Boolean).join(' · ') || 'العنوان غير مسجل'}</Text>
        {customer.notes ? <Text style={styles.detail}>ملاحظة المكتب: {customer.notes}</Text> : null}
      </View>
      {customer.phone ? <Pressable accessibilityRole="button" accessibilityLabel={`اتصل بـ ${customer.name}`} onPress={() => { void call(customer.phone); }} style={styles.call}><Text style={styles.callText}>اتصال</Text></Pressable> : null}
    </Card>)}
  </ScrollView>;
}
const styles = StyleSheet.create({
  scroll: { padding: space.lg, gap: space.md, paddingBottom: 36 },
  title: { fontFamily: fonts.bold, fontSize: 25, color: colors.green900, textAlign: 'right' },
  card: { flexDirection: 'row-reverse', alignItems: 'center', gap: space.md },
  details: { flex: 1, minWidth: 0, gap: 3 },
  name: { fontFamily: fonts.bold, fontSize: 16, color: colors.ink, textAlign: 'right' },
  phone: { fontFamily: fonts.medium, fontSize: 14, color: colors.green900, textAlign: 'right' },
  detail: { fontFamily: fonts.regular, fontSize: 12, color: colors.muted, textAlign: 'right' },
  error: { fontFamily: fonts.medium, color: colors.danger, textAlign: 'right' },
  call: { paddingHorizontal: 14, paddingVertical: 10, backgroundColor: colors.mint, borderRadius: radius.md },
  callText: { fontFamily: fonts.bold, color: colors.green700 },
});
