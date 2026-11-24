import { useEffect, useMemo, useState } from 'react';
import * as Haptics from 'expo-haptics';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, fonts, radius, space } from './theme';
import { Body, Card, Empty, Field, Pill, Sheet } from './ui';
import { productCategoryLabels, type Product, type ProductCategory } from './types';
import type { FieldBundle } from './useField';

/**
 * قايمعة الأصناف — شاشة قراءة في التليفون، من غير أي سعر.
 *
 * The engineer standing in front of a farmer has two questions this screen answers: do we sell this at
 * all, and what do we sell it in. It has no business answering «بكام» — the server does not send prices on
 * a phone session, and the office is the one that names a number, because the number depends on a buyer
 * type the phone is not given. So there is no price row here to be screenshotted, remembered, or quoted
 * from, and the unit line is the loudest thing on every row: it is what a quantity counts in.
 *
 * The list is cached in memory by the same rule the customer book uses (last good copy plus a notice),
 * because the question gets asked in a field with two bars of signal, not in the car with four.
 */
const haptic = () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined); };

const CATEGORIES: Array<{ id: ProductCategory | 'all'; label: string }> = [
  { id: 'all', label: 'الكل' },
  { id: 'pesticide', label: productCategoryLabels.pesticide },
  { id: 'fertilizer', label: productCategoryLabels.fertilizer },
  { id: 'other', label: productCategoryLabels.other },
];

export default function CatalogueSheet({ visible, onClose, field }: { visible: boolean; onClose: () => void; field: FieldBundle }) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<ProductCategory | 'all'>('all');

  useEffect(() => {
    if (!visible) return;
    setSearch(''); setCategory('all');
    void field.loadProducts();
  }, [visible]);

  const products = field.products;
  const matches = useMemo(() => {
    const term = search.trim().toLowerCase();
    return products.filter(product => {
      if (category !== 'all' && product.category !== category) return false;
      if (!term) return true;
      return `${product.name} ${product.unit} ${product.unitSize}`.toLowerCase().includes(term);
    });
  }, [products, search, category]);

  return (
    <Sheet visible={visible} onClose={onClose} title="قايمعة الأصناف">
      <Field label="دوّر بالاسم أو العبوة" value={search} onChangeText={setSearch} placeholder="مثال: يوريا أو شيكارة" autoCapitalize="none" />
      <View style={styles.chips}>
        {CATEGORIES.map(item => (
          <Pressable
            key={item.id}
            onPress={() => { haptic(); setCategory(item.id); }}
            style={[styles.chip, category === item.id && styles.chipActive]}
            accessibilityRole="button"
            accessibilityState={{ selected: category === item.id }}
          >
            <Text style={[styles.chipText, category === item.id && styles.chipTextActive]}>{item.label}</Text>
          </Pressable>
        ))}
      </View>

      {field.productsNotice ? <Body muted style={{ fontSize: 12 }}>{field.productsNotice}</Body> : null}

      {products.length === 0 ? (
        <Empty
          title={field.productsLoading ? 'جارٍ تحميل القايمعة…' : 'مفيش أصناف في قايمعة الشركة لسه'}
          hint={field.productsLoading
            ? 'لو الشبكة ضعيفة، آخر قايمعة اتحمّلت هتفضل محفوظة.'
            : 'مدير المبيعات والتيم بيضيفوا الأصناف وأسعارها من الداشبورد. أول ما يضيفوها هتظهر هنا.'}
        />
      ) : matches.length === 0 ? (
        <Empty
          title="مفيش صنف بالاسم ده في القايمعة"
          hint="جرّب كلمة تانية، أو شيل الفلتار. لو الصنف فعلاً مش في القايمعة، ده معناه إن الشركة ما بتبيعهوش — مش إنه بسعر تاني."
        />
      ) : (
        <>
          <Body muted style={{ fontSize: 12 }}>{matches.length} صنف{category === 'all' ? '' : ` في ${CATEGORIES.find(item => item.id === category)?.label}`}</Body>
          <Card style={{ gap: 0 }}>
            {matches.map((product, index) => (
              <View key={product.id} style={[styles.row, index > 0 && styles.rowBorder]}>
                <View style={{ flex: 1, gap: 3 }}>
                  <Text style={styles.name}>{product.name}</Text>
                  <Text style={styles.pack}>{packText(product)}</Text>
                </View>
                <Pill label={productCategoryLabels[product.category] ?? 'أخرى'} tone="mint" />
              </View>
            ))}
          </Card>
        </>
      )}

      <Body muted style={{ fontSize: 11.5 }}>
        الأسعار عند المكتب وحده — لو العميل سأل عن السعر، اطلب من المكتب: السعر بيتحدّد حسب نوع العميل وبيتكتب في الداشبورد.
      </Body>
      <Body muted style={{ fontSize: 11.5 }}>
        أي كمية تتفق عليها بتُعدّ بالوحدة المكتوبة تحت اسم الصنف (شيكارة / عبوة / جركن) — مش بالكرتونة ولا بالطرد.
      </Body>
    </Sheet>
  );
}

/** The row's most important line: what one of these actually is. */
function packText(product: Product) {
  const size = product.unitSize.trim();
  return size ? `الوحدة: ${product.unit} · ${size}` : `الوحدة: ${product.unit}`;
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 6 },
  chip: {
    borderWidth: 1, borderColor: colors.line, borderRadius: radius.pill, paddingHorizontal: 12,
    paddingVertical: 7, backgroundColor: colors.white,
  },
  chipActive: { backgroundColor: colors.green700, borderColor: colors.green700 },
  chipText: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.green900 },
  chipTextActive: { color: '#fdf8ec' },
  row: { flexDirection: 'row-reverse', alignItems: 'center', gap: space.sm, paddingVertical: space.md },
  rowBorder: { borderTopWidth: 1, borderTopColor: colors.line },
  name: { fontFamily: fonts.bold, fontSize: 14.5, color: colors.ink, textAlign: 'right' },
  pack: { fontFamily: fonts.regular, fontSize: 12, color: colors.muted, textAlign: 'right' },
});
