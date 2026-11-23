import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, fonts, radius, space } from './theme';
import { Body, Card, Empty, Heading, Pill, Row, Stat } from './ui';
import { useSales } from './useSales';
import { myInvoices } from './api';
import { invoiceStatusLabels, type MyInvoice } from './types';

/**
 * What this engineer sold, and what the warehouse has — both read-only.
 *
 * Two separate needs meet on one screen. The first is money: a man standing in front of a customer
 * needs to know what that customer was billed and what he still owes, and until now the only answer
 * was a phone call to the office. The second is stock: a promise made in a farm about a product
 * nobody counted this week becomes a truck that comes back full.
 *
 * Nothing here writes. Invoices are typed at the office desk, where the price and the warehouse are
 * chosen; the phone sees the result. That is also why there is no offline copy of a balance — a
 * number read from storage would be quoted as if it were current, and a customer told «you owe 400»
 * when the office has since taken 300 is a fight, not a feature.
 */
type Pane = 'invoices' | 'catalogue';

const ARABIC = new Intl.NumberFormat('ar-EG', { maximumFractionDigits: 2 });
export const moneyText = (value: number) => `${ARABIC.format(Math.round(Number(value || 0) * 100) / 100)} ج.م`;
export const qtyText = (qty: number, unit: string) => `${ARABIC.format(qty)} ${unit}`;

export default function SalesScreen({ customerId }: { customerId?: string }) {
  const { invoices, products, outstanding, loading, error, unsupported, refresh } = useSales({ customerId });
  const [pane, setPane] = useState<Pane>('invoices');
  const [query, setQuery] = useState('');

  const total = useMemo(() => invoices.reduce((sum, invoice) => sum + invoice.total, 0), [invoices]);
  const paid = useMemo(() => invoices.reduce((sum, invoice) => sum + invoice.paidAmount, 0), [invoices]);

  const visibleProducts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return products;
    return products.filter(item => `${item.name} ${item.unit}`.toLowerCase().includes(needle));
  }, [products, query]);

  if (unsupported) {
    return (
      <View style={styles.wrap}>
        <Empty title="المبيعات مش متاحة على السيرفر" hint="السيرفر اللي التطبيق بيتوصل ليه لسه مفيهوش شاشة الفواتير — اطلب من الإدارة تحدّث السيرفر." />
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Heading>مبيعاتي</Heading>
        <Text style={styles.headHint}>الفواتير بيسجلها المكتب باسمك — هنا للقراءة بس، عشان تعرف وقفت عند قد إيه.</Text>
      </View>

      {/* A segmented switch, not two tabs: the two lists answer one question («can I close this
          sale?») and an engineer wants both in one gesture, not four more taps in the bar. */}
      <View style={styles.panes}>
        {(['invoices', 'catalogue'] as Pane[]).map(item => (
          <Pressable
            key={item}
            onPress={() => setPane(item)}
            style={[styles.pane, pane === item && styles.paneActive]}
            accessibilityRole="tab"
            accessibilityState={{ selected: pane === item }}
          >
            <Text style={[styles.paneText, pane === item && styles.paneTextActive]}>
              {item === 'invoices' ? `فواتيري (${ARABIC.format(invoices.length)})` : `الأصناف (${ARABIC.format(products.length)})`}
            </Text>
          </Pressable>
        ))}
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh()} tintColor={colors.green700} />}
      >
        {error ? <Body style={styles.error}>{error}</Body> : null}

        <View style={styles.stats}>
          <Stat label="إجمالي فواتيري" value={moneyText(total)} />
          <Stat label="المحصّل" value={moneyText(paid)} />
          <Stat label="لسه على العملاء" value={moneyText(outstanding)} tone="dark" />
        </View>

        {pane === 'invoices' ? (
          invoices.length === 0 ? (
            <Empty title="مافيش فواتير في الشهرين دول" hint="الفاتورة بتظهر هنا أول ما مكتب المبيعات يسجلها باسمك." />
          ) : invoices.map(invoice => {
            const due = Math.max(0, invoice.total - invoice.paidAmount);
            return (
              <Card key={invoice.id} tone={due > 0 ? 'mint' : 'plain'}>
                <Row style={styles.cardHead}>
                  <Text style={styles.customer}>{invoice.customerName}</Text>
                  <Pill label={invoiceStatusLabels[invoice.status] || invoice.status}
                    tone={invoice.status === 'paid' ? 'mint' : invoice.status === 'partial' ? 'warn' : 'danger'} />
                </Row>
                <Text style={styles.meta}>{invoice.number || 'من غير رقم'} · {invoice.date} · {invoice.warehouseName}</Text>
                {(invoice.lines || []).map((line, index) => (
                  <View key={`${line.productName}-${index}`} style={styles.line}>
                    <Text style={styles.lineName}>{line.productName}</Text>
                    <Text style={styles.lineQty}>{qtyText(line.qty, line.unit)}</Text>
                    <Text style={styles.lineTotal}>{moneyText(line.lineTotal)}</Text>
                  </View>
                ))}
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>الإجمالي</Text>
                  <Text style={styles.totalValue}>{moneyText(invoice.total)}</Text>
                </View>
                {due > 0 && <Text style={styles.due}>لسه عليه {moneyText(due)}</Text>}
                {invoice.stockShort && <Text style={styles.short}>المخزن كان عاجز وقت الفاتورة — الكمية اتسجلت فوق المتاح.</Text>}
                {invoice.note ? <Body muted>{invoice.note}</Body> : null}
              </Card>
            );
          })
        ) : (
          <>
            <TextInput
              style={styles.search}
              placeholder="دوّر على صنف"
              placeholderTextColor={colors.muted}
              value={query}
              onChangeText={setQuery}
              autoCorrect={false}
            />
            {visibleProducts.length === 0 ? (
              <Empty title="مافيش أصناف" hint="لما المكتب يضيف الأصناف هتظهر هنا بأسعارها وكمياتها." />
            ) : visibleProducts.map(product => (
              <Card key={product.id}>
                <Row style={styles.cardHead}>
                  <Text style={styles.customer}>{product.name}</Text>
                  <Text style={styles.price}>{moneyText(product.price)} / {product.unit}</Text>
                </Row>
                <Text style={product.onHand > 0 ? styles.meta : styles.outOfStock}>
                  {product.onHand > 0 ? `فاضل في المخزن ${qtyText(product.onHand, product.unit)}` : 'خلص من المخزن'}
                </Text>
                {product.warehouses.length > 1 && (
                  <Text style={styles.meta}>{product.warehouses.map(item => `${item.name}: ${qtyText(item.onHand, product.unit)}`).join(' · ')}</Text>
                )}
              </Card>
            ))}
          </>
        )}
        <Body muted style={styles.foot}>
          {pane === 'invoices'
            ? 'لو في غلط في فاتورة، كلّم المكتب — التعديل والتسعير من الداشبورد مقفول على الموبايل.'
            : 'الكميات دي آخر ما اتسجل في المخزن، مش ما هو على العربية النهاردة.'}
        </Body>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  head: { paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.sm, gap: 2 },
  headHint: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.muted, lineHeight: 18 },
  panes: { flexDirection: 'row', gap: space.sm, paddingHorizontal: space.lg, paddingBottom: space.md },
  pane: {
    flex: 1, alignItems: 'center', paddingVertical: space.sm, borderRadius: radius.md,
    backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line,
  },
  paneActive: { backgroundColor: colors.green900, borderColor: colors.green900 },
  paneText: { fontFamily: fonts.medium, fontSize: 13, color: colors.muted },
  paneTextActive: { fontFamily: fonts.bold, color: colors.white },
  content: { paddingHorizontal: space.lg, paddingBottom: space.xxl, gap: space.md },
  stats: { gap: space.sm },
  error: { color: colors.danger, fontFamily: fonts.medium },
  cardHead: { justifyContent: 'space-between', alignItems: 'center', marginBottom: space.xs },
  customer: { fontFamily: fonts.bold, fontSize: 15, color: colors.green900, flexShrink: 1 },
  meta: { fontFamily: fonts.regular, fontSize: 12, color: colors.muted, marginBottom: space.xs },
  price: { fontFamily: fonts.medium, fontSize: 13, color: colors.green700 },
  outOfStock: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.danger, marginBottom: space.xs },
  line: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.xs, borderTopWidth: 1, borderTopColor: colors.line },
  lineName: { flex: 1, fontFamily: fonts.regular, fontSize: 13, color: colors.ink },
  lineQty: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.muted },
  lineTotal: { fontFamily: fonts.medium, fontSize: 13, color: colors.green900, minWidth: 74, textAlign: 'right' },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: space.xs, paddingTop: space.xs, borderTopWidth: 1, borderTopColor: colors.line },
  totalLabel: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.muted },
  totalValue: { fontFamily: fonts.bold, fontSize: 15, color: colors.green900 },
  due: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.amber, marginTop: 2 },
  short: { fontFamily: fonts.regular, fontSize: 12, color: colors.danger, marginTop: 2 },
  search: {
    fontFamily: fonts.regular, fontSize: 14, color: colors.ink, backgroundColor: colors.white,
    borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  foot: { fontSize: 11.5, textAlign: 'center' },
});

/**
 * The balance line inside a customer's sheet — what the office billed this farm and what is still
 * unpaid, read on the spot so a number is never quoted from memory. It fetches its own narrow window
 * (`customerId`) instead of reusing the tab's list: the sheet is opened one customer at a time, and
 * pulling two months of invoices for every farm would cost the same on a rural connection and show
 * the engineer nothing he asked for.
 *
 * A server without the sales endpoints answers 404/403, and the honest response to that is silence:
 * the sheet about a customer still works, it just cannot say anything about money.
 */
export function CustomerBalance({ customerId }: { customerId: string }) {
  const [invoices, setInvoices] = useState<MyInvoice[] | null>(null);
  const load = useCallback(async () => {
    try { setInvoices((await myInvoices(customerId)).invoices); }
    catch { setInvoices(null); }
  }, [customerId]);
  useEffect(() => { void load(); }, [load]);
  if (!invoices) return <Body muted>مفيش بيانات تحصيل الوقت ده.</Body>;
  if (invoices.length === 0) return <Body muted>مافيش فواتير مسجلة لهذا العميل باسمك.</Body>;
  const total = invoices.reduce((sum, invoice) => sum + invoice.total, 0);
  const paid = invoices.reduce((sum, invoice) => sum + invoice.paidAmount, 0);
  const due = Math.max(0, total - paid);
  return (
    <Card tone={due > 0 ? 'mint' : 'plain'}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={styles.totalLabel}>إجمالي الفواتير ({ARABIC.format(invoices.length)})</Text>
        <Text style={styles.totalValue}>{moneyText(total)}</Text>
      </Row>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={styles.totalLabel}>المحصّل</Text>
        <Text style={styles.meta}>{moneyText(paid)}</Text>
      </Row>
      {due > 0 && (
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.totalLabel}>لسه عليه</Text>
          <Text style={styles.due}>{moneyText(due)}</Text>
        </Row>
      )}
      {invoices.slice(0, 3).map(invoice => (
        <Text key={invoice.id} style={styles.meta}>
          {invoice.number || invoice.date} · {invoice.date} · {moneyText(invoice.total)}
          {invoice.status === 'paid' ? ' · محصّل' : ''}
        </Text>
      ))}
      <Text style={styles.meta}>الفواتير بيسجلها المكتب؛ دي للقراءة بس.</Text>
    </Card>
  );
}
