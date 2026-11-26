import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { colors, fonts, radius, space } from './theme';
import { Body, Button, Card, Empty, Field, Sheet } from './ui';
import { CustomerPicker } from './VisitSheets';
import { randomUUID } from './tracking';
import type { FieldBundle } from './useField';
import type { OrderView, Product, Visit } from './types';
import { myOrders } from './api';

/**
 * تسجيل طلبية — the one screen where the field writes numbers, and only quantities.
 *
 * The workflow this sheet exists for: the engineer agrees what the farm takes, presses send, and the
 * office dashboard lights up. Prices never appear here — not because the screen hides them, but
 * because the phone session is never sent a price to hide. The same rule is why no text box on this
 * sheet accepts a customer's name: the customer is picked from his list, one tap, same as a visit.
 *
 * Everything is sized for gloves in a yard: the item list adds with a press (each press is one more
 * of the unit the office wrote under the name), the quantities fix themselves with − and +, and
 * nothing needs a keyboard unless the man wants to add a delivery note. No shift, no GPS, no open
 * visit to close first — an order agreed by phone from the road is still the order the office has
 * to price, and the flow must not ask for a visit it does not need. (The server still links one in
 * when it is sent from inside a visit.)
 */
const haptic = () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined); };
const SCROLL_LIMIT = 12;

type Line = { productId: string; product: Product; qty: number };

export default function OrderSheet({ visible, onClose, field, visit, onSubmitted }: { visible: boolean; onClose: () => void; field: FieldBundle; visit?: Visit | null; onSubmitted: (result: 'sent' | 'queued') => void }) {
  const [customerId, setCustomerId] = useState('');
  const [search, setSearch] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<OrderView[]>([]);
  const [historyError, setHistoryError] = useState('');

  const customers = field.customers;
  const selected = useMemo(() => customers.find(row => row.id === customerId) ?? null, [customers, customerId]);
  const products = field.products;
  const byProduct = useMemo(() => new Map(products.map(product => [product.id, product])), [products]);
  const matches = useMemo(() => {
    const term = productSearch.trim().toLowerCase();
    if (!term) return products;
    return products.filter(product => `${product.name} ${product.unit} ${product.unitSize}`.toLowerCase().includes(term));
  }, [products, productSearch]);
  const shown = matches.slice(0, SCROLL_LIMIT);

  useEffect(() => {
    if (!visible) return;
    setCustomerId(visit?.customerId ?? ''); setSearch(''); setProductSearch(''); setLines([]); setNotes(''); setError('');
    // Same rule as the visit sheet: the office may have added the item or handed over the customer
    // this morning, and both lists refresh on open when there is signal, keep the last good copy
    // when there is not.
    void field.loadCustomers();
    void field.loadProducts();
    let active = true;
    setHistory([]); setHistoryError('');
    void myOrders().then(result => { if (active) setHistory(result.orders); })
      .catch(() => { if (active) setHistoryError('تعذر تحميل الطلبيات السابقة — حاول لما الشبكة ترجع.'); });
    return () => { active = false; };
  }, [visible]);

  const addProduct = (product: Product) => {
    haptic();
    setLines(prev => {
      const at = prev.findIndex(line => line.productId === product.id);
      if (at === -1) return [...prev, { productId: product.id, product, qty: 1 }];
      return prev.map((line, index) => (index === at ? { ...line, qty: Math.min(100000, line.qty + 1) } : line));
    });
  };
  const bump = (productId: string, delta: number) => {
    haptic();
    setLines(prev => prev
      .map(line => (line.productId === productId ? { ...line, qty: Math.min(100000, line.qty + delta) } : line))
      .filter(line => line.qty > 0));
  };

  async function submit() {
    if (!selected) { setError('اختار العميل من قائمتك الأول — الطلبية بتتسجل على عميل من قائمة الشركة.'); return; }
    if (lines.length === 0) { setError('ضيف صنف واحد على الأقل — دوس + جنب اسمه.'); return; }
    if (lines.some(line => line.qty <= 0)) { setError('اكتب كمية أكبر من صفر لكل صنف.'); return; }
    if (lines.some(line => !byProduct.has(line.productId))) { setError('في صنف مش موجود دلوقتي في القائمة — احذفه من الطلبية أو كلّم المكتب.'); return; }
    setSaving(true); setError('');
    try {
      const result = await field.submitOrder({
        id: randomUUID(), customerId: selected.id, notes: notes.trim(),
        ...(visit?.customerId === selected.id ? { visitId: visit.id } : {}),
        lines: lines.map(line => ({ productId: line.productId, qty: line.qty })),
        send: true,
      });
      haptic();
      onSubmitted(result);
      onClose();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }

  return (
    <Sheet visible={visible} onClose={() => { if (!saving) onClose(); }} title="تسجيل طلبية">
      <View style={{ gap: 6 }}>
        <Text style={styles.label}>العميل من قائمتك *</Text>
        <CustomerPicker
          field={field}
          selected={selected}
          search={search}
          onSearch={setSearch}
          onSelect={row => { if (!row) { setCustomerId(''); setSearch(''); return; } haptic(); setCustomerId(row.id); }}
        />
      </View>

      <View style={{ gap: 6 }}>
        <Text style={styles.label}>الأصناف — دوس + على كل صنف طلبه العميل</Text>
        {products.length === 0 && lines.length === 0 ? (
          <Empty
            title={field.productsLoading ? 'جارٍ تحميل الأصناف…' : 'مفيش أصناف في قائمة الشركة لسه'}
            hint={field.productsLoading
              ? 'لو الشبكة ضعيفة، آخر قائمة اتحمّلت هتفضل محفوظة.'
              : field.productsNotice || 'التيم بيضيف الأصناف من الداشبورد — أول ما يضيفوها هتظهر هنا.'}
          />
        ) : (
          <>
            {field.productsNotice ? <Text style={styles.notice}>{field.productsNotice}</Text> : null}
            {lines.length > 0 && (
              <Card tone="mint" style={{ gap: 0 }}>
                {lines.map((line, index) => {
                  const product = byProduct.get(line.productId) ?? line.product;
                  const unavailable = !byProduct.has(line.productId);
                  const labelName = products.filter(p => p.name === product.name).length > 1 ? `${product.name} · ${packText(product)}` : product.name;
                  return (
                    <View key={line.productId} style={[styles.lineRow, index > 0 && styles.lineBorder]}>
                      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                        <Text style={styles.lineName}>{product.name}</Text>
                        <Text style={styles.linePack}>{packText(product)}</Text>
                        {unavailable && <Text style={styles.error}>الصنف مش موجود دلوقتي — احذفه أو كلّم المكتب.</Text>}
                        <Pressable onPress={() => setLines(prev => prev.filter(item => item.productId !== line.productId))} accessibilityRole="button" accessibilityLabel={`احذف ${labelName}`}><Text style={styles.notice}>حذف الصنف</Text></Pressable>
                      </View>
                      <View style={styles.stepper}>
                        <Pressable onPress={() => bump(line.productId, -1)} accessibilityRole="button" accessibilityLabel={`ناقص ${labelName}`} style={styles.stepBtn}>
                          <Text style={styles.stepText}>−</Text>
                        </Pressable>
                        <TextInput
                          style={styles.stepQty} keyboardType="number-pad" accessibilityLabel={`كمية ${labelName}`}
                          value={line.qty ? String(line.qty) : ''}
                          onChangeText={value => {
                            const normalized = value.replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
                              .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));
                            if (!/^\d*$/.test(normalized) || Number(normalized) > 100000) return;
                            setLines(prev => prev.map(item => item.productId === line.productId ? { ...item, qty: Number(normalized) } : item));
                          }}
                        />
                        <Pressable onPress={() => bump(line.productId, 1)} accessibilityRole="button" accessibilityLabel={`زود ${labelName}`} style={styles.stepBtn}>
                          <Text style={styles.stepText}>+</Text>
                        </Pressable>
                      </View>
                    </View>
                  );
                })}
                <View style={[styles.lineRow, styles.lineBorder]}>
                  <Text style={styles.linePack}>عدد الأصناف: {lines.length}</Text>
                </View>
              </Card>
            )}
            <Field label="دوّر بالاسم أو العبوة" value={productSearch} onChangeText={setProductSearch} placeholder="مثال: يوريا أو شيكارة" autoCapitalize="none" />
            {matches.length === 0 ? (
              <Text style={styles.error}>مفيش صنف بالاسم ده في القائمة. كلّم المكتب يضيفه — الطلبية ما تتسجلش على صنف مش في القائمة.</Text>
            ) : (
              <>
                {shown.map(product => {
                  const inOrder = lines.find(line => line.productId === product.id);
                  const labelName = products.filter(p => p.name === product.name).length > 1 ? `${product.name} · ${packText(product)}` : product.name;
                  return (
                    <Pressable key={product.id} onPress={() => addProduct(product)} accessibilityRole="button" accessibilityLabel={`ضيف ${labelName}`} style={({ pressed }) => [styles.pickRow, pressed && styles.pickRowPressed]}>
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text style={styles.lineName}>{product.name}</Text>
                        <Text style={styles.linePack}>{packText(product)}</Text>
                      </View>
                      <View style={styles.addBox}>
                        <Text style={styles.addText}>{inOrder ? `+ · ${inOrder.qty}` : '+'}</Text>
                      </View>
                    </Pressable>
                  );
                })}
                {matches.length > shown.length ? <Text style={styles.notice}>في {matches.length - shown.length} صنف تاني — كمّل كتابة في البحث.</Text> : null}
              </>
            )}
          </>
        )}
      </View>

      <Field label="ملاحظة على التسليم (اختياري)" value={notes} onChangeText={setNotes} multiline placeholder="مثال: التسليم السبت الصبح، يترش على طول" style={{ minHeight: 60 }} />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button
        label={saving ? 'جارٍ الإرسال…' : lines.length > 0 ? `ابعت الطلبية للمكتب · ${lines.length} صنف` : 'ابعت الطلبية للمكتب'}
        onPress={submit}
        loading={saving}
        icon="➤"
      />
      <View style={{ gap: 6 }}>
        <Text style={styles.label}>طلبياتك السابقة</Text>
        {historyError ? <Text style={styles.notice}>{historyError}</Text> : null}
        {history.slice(0, 10).map(order => <Card key={order.id} tone="plain">
          <Text style={styles.lineName}>{order.customerName} · {order.sold ? 'اتسجلت لها فاتورة' : order.status === 'draft' ? 'مسودة' : 'اتبعتت للمكتب'}</Text>
          <Text style={styles.linePack}>{order.lines.map(line => `${line.productName}: ${line.qty} ${line.unit} ${line.unitSize}`).join(' · ')}</Text>
        </Card>)}
      </View>
      <Body muted style={{ fontSize: 11.5 }}>
        دورك ترشيح الأصناف والكميات فقط؛ فريق المبيعات يحدد الأسعار في الفاتورة. الكمية بتُعدّ بالوحدة المكتوبة تحت اسم الصنف (شيكارة / عبوة / جركن).
      </Body>
      <Body muted style={{ fontSize: 11.5 }}>
        لو الشبكة قطعت، الطلبية بتتحفظ على الموبايل وإرسالها بيتحاول تلقائيًا لما ترجع. لو السيرفر رفضها هتظهر رسالة بالمشكلة — ما تكررش الطلبية من شاشة تانية.
      </Body>
    </Sheet>
  );
}

/** The line's loudest fact is what a quantity counts in — same rule as the catalogue screen. */
function packText(product: Product) {
  const size = product.unitSize.trim();
  return size ? `${product.unit} · ${size}` : product.unit;
}

const styles = StyleSheet.create({
  label: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.green900, writingDirection: 'rtl' },
  notice: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.muted },
  error: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.danger, textAlign: 'right' },
  pickRow: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: space.sm,
    backgroundColor: colors.white, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line,
    paddingHorizontal: space.md, paddingVertical: 11,
  },
  pickRowPressed: { borderColor: colors.green500, backgroundColor: '#f4f9f1' },
  lineRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: space.sm, paddingVertical: 10 },
  lineBorder: { borderTopWidth: 1, borderTopColor: '#e2eede' },
  lineName: { fontFamily: fonts.bold, fontSize: 14, color: colors.ink, textAlign: 'right' },
  linePack: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.muted, textAlign: 'right' },
  stepper: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8 },
  stepBtn: {
    width: 34, height: 34, borderRadius: 11, borderWidth: 1, borderColor: colors.green500,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.white,
  },
  stepText: { fontFamily: fonts.bold, fontSize: 17, color: colors.green700, lineHeight: 19 },
  stepQty: { width: 64, textAlign: 'center', fontFamily: fonts.bold, fontSize: 15.5, color: colors.ink },
  addBox: {
    minWidth: 46, alignItems: 'center', borderRadius: 11, backgroundColor: colors.green700,
    paddingHorizontal: 10, paddingVertical: 6,
  },
  addText: { fontFamily: fonts.bold, fontSize: 13, color: '#fdf8ec' },
});
