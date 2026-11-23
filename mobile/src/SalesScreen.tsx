import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, fonts, radius, space } from './theme';
import { Body, Button, Card, Empty, Field, Heading, Pill, Row, Sheet, Stat } from './ui';
import { dayText, parseNumberText } from './format';
import { myInvoices, myStockReport, myWarehouses } from './api';
import { useCustomers } from './useCustomers';
import { useSales } from './useSales';
import { invoiceStatusLabels, type CatalogueProduct, type MyInvoice, type StockReport } from './types';

/**
 * The engineer's sales — what he billed, what the shelf holds, and the invoice he writes himself.
 *
 * This screen replaced the paper notebook. He types the sale here, standing at the farm, and the
 * office's dashboard shows the same row on the customer's name a moment later: same invoice number
 * series, same warehouse deduction, same totals — computed by the server from the catalogue, not from
 * anything this phone sent. What he still cannot do is price a product, discount a line, credit the
 * sale to a colleague, or cancel a bill the office has already collected on.
 *
 * The balance at the top is read live and never cached: a number kept on the phone would be quoted as
 * if it were current, and a customer told «you owe 400» when the office has since taken 300 is a
 * fight, not a feature.
 */
type Pane = 'invoices' | 'catalogue' | 'stock';

const ARABIC = new Intl.NumberFormat('ar-EG', { maximumFractionDigits: 2 });
export const moneyText = (value: number) => `${ARABIC.format(Math.round(Number(value || 0) * 100) / 100)} ج.م`;
export const qtyText = (qty: number, unit: string) => `${ARABIC.format(qty)} ${unit}`;

export default function SalesScreen({ customerId, ownerId }: { customerId?: string; ownerId?: string }) {
  const { invoices, products, outstanding, loading, error, unsupported, refresh, pendingInvoices, submit, cancel, pay, target } = useSales({ customerId });
  const [pane, setPane] = useState<Pane>('invoices');
  const [query, setQuery] = useState('');
  const [writing, setWriting] = useState(false);
  const [canceling, setCanceling] = useState<MyInvoice | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [paying, setPaying] = useState<MyInvoice | null>(null);
  const [sheetMessage, setSheetMessage] = useState('');
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    myWarehouses().then(res => setWarehouses(Array.isArray(res?.warehouses) ? res.warehouses : [])).catch(() => setWarehouses([]));
  }, []);

  const total = useMemo(() => invoices.reduce((sum, invoice) => sum + invoice.total, 0), [invoices]);
  const paid = useMemo(() => invoices.reduce((sum, invoice) => sum + invoice.paidAmount, 0), [invoices]);

  const visibleProducts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return products;
    return products.filter(item => `${item.name} ${item.unit}`.toLowerCase().includes(needle));
  }, [products, query]);

  const head = (
    <View style={styles.head}>
      <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <Heading>مبيعاتي</Heading>
        {!customerId && <Button label="فاتورة جديدة" icon="＋" size="sm" onPress={() => { setSheetMessage(''); setWriting(true); }} />}
      </Row>
      <Text style={styles.headHint}>
        {customerId ? 'الفواتير دي بتاعت العميل ده.' : 'إنت اللي بتكتب الفاتورة هنا، وهي بتظهر في الداشبورد على اسم العميل فورًا.'}
      </Text>
      {pendingInvoices ? (
        <Text style={styles.pendingNotice}>
          {ARABIC.format(pendingInvoices)} فاتورة مستنية الشبكة — هتتبعت لوحدها، وما تظهرش للمكتب قبل كده.
        </Text>
      ) : null}
    </View>
  );

  if (unsupported) {
    return (
      <View style={styles.wrap}>
        {head}
        <Empty title="المبيعات مش متاحة على السيرفر" hint="السيرفر اللي التطبيق بيتوصل ليه لسه مفيهوش شاشة الفواتير — اطلب من الإدارة تحدّث السيرفر." />
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      {head}

      {/* A segmented switch, not four tabs: these three lists answer one question («can I close this
          sale, and what did I already close it for?»). */}
      <View style={styles.panes}>
        {(['invoices', 'catalogue', 'stock'] as Pane[]).map(item => (
          <Pressable
            key={item}
            onPress={() => setPane(item)}
            style={[styles.pane, pane === item && styles.paneActive]}
            accessibilityRole="tab"
            accessibilityState={{ selected: pane === item }}
          >
            <Text style={[styles.paneText, pane === item && styles.paneTextActive]}>
              {item === 'invoices' ? `فواتيري (${ARABIC.format(invoices.length)})` : item === 'catalogue' ? `الأصناف (${ARABIC.format(products.length)})` : 'المخزون'}
            </Text>
          </Pressable>
        ))}
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh()} tintColor={colors.green700} />}
      >
        {error ? <Body style={styles.error}>{error}</Body> : null}
        {sheetMessage ? <Body style={styles.warn}>{sheetMessage}</Body> : null}

        <View style={styles.stats}>
          <Stat label="إجمالي فواتيري" value={moneyText(total)} />
          <Stat label="المحصّل" value={moneyText(paid)} />
          <Stat label="لسه على العملاء" value={moneyText(outstanding)} tone="dark" />
        </View>

        {/* الهدف بيقرا من السيرفر كل مرة، مش من رقم اتخزن على الهاتف: رقم ميت على شاشة الموبايل
            بيفتح مشاكرة مع المكتب. */}
        {!customerId && target?.target ? (
          <TargetStrip sold={target.sold} target={target.target} daysLeft={target.daysLeft} month={target.month} />
        ) : null}

        {pane === 'invoices' ? (
          invoices.length === 0 ? (
            <Empty title="مافيش فواتير في الشهرين دول" hint="اكتب فاتورة جديدة من الزر فوق — أو استنى المكتب يسجّلها باسمك." />
          ) : invoices.map(invoice => {
            const due = Math.max(0, invoice.total - invoice.paidAmount);
            // The server already limits this list to his own sales; `source` says who typed the row,
            // and only a row he typed himself can be taken back from the phone.
            const isMine = invoice.source === 'field' || (Boolean(ownerId) && invoice.createdBy === ownerId);
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
                {due > 0 ? (
                  <Button label="سجّل تحصيل" variant="ghost" size="sm" onPress={() => setPaying(invoice)} />
                ) : null}
                {invoice.stockShort && <Text style={styles.short}>المخزن كان عاجز وقت الفاتورة — الكمية اتسجلت فوق المتاح.</Text>}
                {invoice.note ? <Body muted>{invoice.note}</Body> : null}
                {/* Only a sale with nothing collected on it, typed by him, can be taken back here. */}
                {isMine && invoice.status === 'unpaid' ? (
                  <Button label="شيل الفاتورة" variant="ghost" size="sm" onPress={() => { setCanceling(invoice); setCancelReason(''); }} />
                ) : null}
              </Card>
            );
          })
        ) : pane === 'stock' ? (
          <StockPane />
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
            ? 'السعر من أصناف المكتب، والخصم والتعديل بعد التسجيل يبقوا للمكتب.'
            : pane === 'stock'
              ? 'ده اللي إنت طلعته من المخزن في الشهر، والفاضل فيه. كشف العمليات سطر لكل فاتورة.'
              : 'الكميات دي آخر ما اتسجل في المخزن، مش ما هو على العربية النهاردة.'}
        </Body>
      </ScrollView>

      <PaySheet
        invoice={paying}
        onClose={() => setPaying(null)}
        onPay={async (amount, note) => {
          if (!paying) return null;
          const message = await pay(paying.id, amount, note);
          if (!message) setPaying(null);
          return message;
        }}
      />
      <InvoiceSheet
        visible={writing}
        products={products}
        warehouses={warehouses}
        onClose={() => setWriting(false)}
        onSubmit={async payload => {
          const result = await submit(payload, ownerId);
          setWriting(false);
          setSheetMessage(result === 'queued'
            ? 'الفاتورة اتحفظت على الموبايل وهتتبعت أول ما الشبكة ترجع.'
            : 'الفاتورة وصلت المكتب باسم العميل.');
          return result;
        }}
      />

      <Sheet visible={Boolean(canceling)} onClose={() => setCanceling(null)} title={canceling ? `إلغاء ${canceling.number ?? 'الفاتورة'}` : ''}>
        <Body muted>الكميات هترجع للمخزن، والفاتورة هتفضل مسجلة ملغاة بالسبب — مش محذوفة.</Body>
        <Field label="السبب *" value={cancelReason} onChangeText={setCancelReason} placeholder="كتبنا الكمية غلط" multiline style={{ minHeight: 64 }} />
        <Button
          label="تأكيد الإلغاء" variant="danger" icon="✕"
          disabled={cancelReason.trim().length < 2}
          onPress={async () => {
            if (!canceling) return;
            const ok = await cancel(canceling.id, cancelReason.trim());
            setCanceling(null);
            setSheetMessage(ok ? 'الفاتورة اتلغت والكمية رجعت للمخزن.' : 'السيرفر ما قبلش الإلغاء — غالبًا فيه تحصيل مسجل، كلّم المكتب.');
          }}
        />
      </Sheet>
    </View>
  );
}

/** The month against the plan the manager set — progress is computed on the server, never here. */
function TargetStrip({ sold, target, daysLeft, month }: {
  sold: { invoices: number; revenue: number };
  target: { revenue: number; invoices: number; revenueProgress: number | null; invoicesProgress: number | null; note: string };
  daysLeft: number;
  month: string;
}) {
  const percent = Math.max(0, Math.min(100, target.revenueProgress ?? 0));
  return (
    <View style={styles.target}>
      <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={styles.targetTitle}>هدف {month}</Text>
        <Text style={styles.targetPct}>{ARABIC.format(target.revenueProgress ?? 0)}٪</Text>
      </Row>
      <View style={styles.bar}>
        <View style={[styles.barFill, { width: `${percent}%` }]} />
      </View>
      <Text style={styles.meta}>
        بعت {moneyText(sold.revenue)} من {moneyText(target.revenue)} · {ARABIC.format(sold.invoices)} فاتورة
        {target.invoices ? ` من ${ARABIC.format(target.invoices)}` : ''}
      </Text>
      <Text style={styles.targetFoot}>
        {target.revenue > sold.revenue
          ? `فاضل ${moneyText(target.revenue - sold.revenue)} · ${ARABIC.format(daysLeft)} يوم في الشهر`
          : `خلصت الهدف — زيادة ${moneyText(sold.revenue - target.revenue)}`}
        {target.note ? ` · ${target.note}` : ''}
      </Text>
    </View>
  );
}

/**
 * Cash he took at the door. The amount defaults to what the invoice still owes, and the field says so,
 * because «the cash he took» and «what the invoice still owes» are two different numbers, and the
 * register stores the first while the invoice carries the second.
 */
function PaySheet({ invoice, onClose, onPay }: {
  invoice: MyInvoice | null;
  onClose: () => void;
  onPay: (amount: number, note: string) => Promise<string | null>;
}) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const due = invoice ? Math.max(0, invoice.total - invoice.paidAmount) : 0;
  useEffect(() => { setAmount(invoice ? String(due) : ''); setNote(''); setMessage(''); }, [invoice, due]);
  const parsed = parseNumberText(amount) ?? 0;
  return (
    <Sheet visible={Boolean(invoice)} onClose={onClose} title="تسجيل تحصيل">
      {invoice ? (
        <>
          <Text style={styles.meta}>
            {invoice.customerName} · {invoice.number || 'من غير رقم'} — عليه {moneyText(due)} من {moneyText(invoice.total)}
          </Text>
          <Field label="المبلغ المستلم (ج.م)" hint={`لو كتبته كامل، الفاتورة تتقفل. التحصيل بيظهر فورًا في تقرير المكتب.`}
            keyboardType="numeric" value={amount} onChangeText={setAmount} />
          <Field label="ملاحظة (اختياري)" placeholder="شيك رقمه، أو إن الباقي هيتسلّم بكرة" value={note} onChangeText={setNote} multiline />
          {parsed > due + 0.005 ? <Text style={styles.warn}>المبلغ أكبر من اللي على الفاتورة — زوّداه على فاتورة تانية.</Text> : null}
          {message ? <Text style={styles.error}>{message}</Text> : null}
          <Button label={busy ? 'جارٍ التسجيل…' : 'سجّل التحصيل'} disabled={busy || !(parsed > 0) || parsed > due + 0.005}
            onPress={() => {
              setBusy(true);
              void onPay(parsed, note).then(result => {
                setBusy(false);
                if (result) setMessage(result);
              });
            }} />
          <Text style={styles.sheetHint}>التحصيل من الموبايل ما بيرجعش لورا: لو الرقم غلط، المكتب يلغي الفاتورة ويسجّلها صح — والإلغاء بيرجّع الفلوس في سجل التحصيل.</Text>
        </>
      ) : null}
    </Sheet>
  );
}

/**
 * His own monthly stock sheet: what the shelf held when the period opened, what his invoices drew, and
 * what is left. Same arithmetic as the office's statement, cut to the movements his own sales caused —
 * so a dispute about «we never took thirty» has a row per invoice to read, not a argument.
 */
function StockPane() {
  const [report, setReport] = useState<StockReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await myStockReport({ from: Date.now() - 30 * 86400000 }));
      setMessage('');
    } catch (e) { setMessage((e as Error).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (loading && !report) return <Body muted>جارٍ التحميل…</Body>;
  if (!report) return <Empty title="مافيش بيانات مخزون" hint={message || 'اسحب فوق عشان تعيد المحاولة.'} />;
  if (report.rows.length === 0) return <Empty title="مافيش حركة في الشهر ده" hint="أول فاتورة تسجلها هتظهر هنا بكميتها." />;
  return (
    <View style={{ gap: space.sm }}>
      {report.rows.map((row, index) => (
        <Card key={`${row.warehouseName}-${row.productName}-${index}`}>
          <Row style={styles.cardHead}>
            <Text style={styles.customer}>{row.productName}</Text>
            <Text style={styles.price}>{row.warehouseName}</Text>
          </Row>
          <Text style={styles.meta}>
            إنت طلعت {ARABIC.format(row.outQty)}{row.inQty ? ` · رجع ليك ${ARABIC.format(row.inQty)}` : ''} · {ARABIC.format(row.movements)} حركة
          </Text>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>فاضل في {row.warehouseName}</Text>
            <Text style={row.closing < 0 ? styles.short : styles.totalValue}>{ARABIC.format(row.closing)} {row.unit}</Text>
          </View>
        </Card>
      ))}
      {report.ledger.length > 0 && (
        <Card tone="plain">
          <Text style={styles.label}>كشف العمليات ({ARABIC.format(report.ledger.length)})</Text>
          {report.ledger.slice(0, 30).map(item => (
            <Text key={`${item.createdAt}-${item.productName}-${item.qty}`} style={styles.meta}>
              {dayText(item.createdAt)} · {item.productName} · {item.qty > 0 ? '+' : ''}{ARABIC.format(item.qty)} {item.unit}
              {item.invoiceNumber ? ` · ${item.invoiceNumber}` : ''}
            </Text>
          ))}
          {report.truncated ? <Text style={styles.warn}>آخر ٢٠٠ حركة بس — الباقي في الداشبورد.</Text> : null}
        </Card>
      )}
    </View>
  );
}

interface LineRow { productId: string; qty: string }

/**
 * The invoice sheet. Deliberately narrower than the office's form: no price (the catalogue owns it),
 * no discount, no crediting another engineer, and no warehouse the customer's area cannot reach. The
 * total shown while typing is a preview of what the server will compute — and if the two ever
 * disagree, the server's number is the one in the books.
 */
function InvoiceSheet({ visible, products, warehouses, onClose, onSubmit }: {
  visible: boolean;
  products: CatalogueProduct[];
  warehouses: { id: string; name: string }[];
  onClose: () => void;
  onSubmit: (payload: { customerId: string; warehouseId?: string; lines: { productId: string; qty: number }[]; note?: string }) => Promise<'sent' | 'queued'>;
}) {
  const { customers } = useCustomers(visible);
  const [customerId, setCustomerId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [rows, setRows] = useState<LineRow[]>([{ productId: '', qty: '' }]);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  // A half-typed invoice must not survive a close: the next one is a different truck.
  useEffect(() => {
    if (!visible) { setCustomerId(''); setWarehouseId(''); setRows([{ productId: '', qty: '' }]); setNote(''); setMessage(''); }
  }, [visible]);

  const priced = rows
    .map(row => {
      const product = products.find(item => item.id === row.productId);
      // parseNumberText, not Number(): an Arabic keyboard types ١٠ and `Number('١٠')` is NaN.
      const qty = parseNumberText(row.qty);
      return product && qty && qty > 0 ? { product, qty, total: Math.round(qty * product.price * 100) / 100 } : null;
    })
    .filter(Boolean) as { product: CatalogueProduct; qty: number; total: number }[];
  const total = Math.round(priced.reduce((sum, line) => sum + line.total, 0) * 100) / 100;
  const short = priced.filter(line => line.product.onHand > 0 && line.qty > line.product.onHand);

  async function submitNow() {
    if (!customerId) { setMessage('اختار العميل الأول.'); return; }
    if (priced.length === 0) { setMessage('اكتب صنف وكمية صح.'); return; }
    setSaving(true); setMessage('');
    try {
      await onSubmit({
        customerId, warehouseId: warehouseId || undefined,
        lines: priced.map(line => ({ productId: line.product.id, qty: line.qty })),
        note: note.trim() || undefined,
      });
      onClose();
    } catch (e) {
      setMessage((e as Error).message);
    } finally { setSaving(false); }
  }

  return (
    <Sheet visible={visible} onClose={onClose} title="فاتورة جديدة">
      <Text style={styles.sheetHint}>الفاتورة بتتنسب لعميلك إنت، والسعر بيتاخد من أصناف المكتب.</Text>
      <View style={{ gap: space.sm }}>
        <Text style={styles.label}>العميل *</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
          {customers.length === 0 ? <Text style={styles.meta}>قايمتك فاضية — ضيف العميل من تبويب «عملائي».</Text> : null}
          {customers.map(item => (
            <Pressable key={item.id} onPress={() => setCustomerId(item.id)} style={[styles.chip, customerId === item.id && styles.chipActive]}>
              <Text style={[styles.chipText, customerId === item.id && styles.chipTextActive]}>{item.name}</Text>
            </Pressable>
          ))}
        </ScrollView>
        {warehouses.length > 1 && (
          <>
            <Text style={styles.label}>المخزن اللي البضاعة خرجت منه</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
              {warehouses.map(item => (
                <Pressable key={item.id} onPress={() => setWarehouseId(item.id)} style={[styles.chip, warehouseId === item.id && styles.chipActive]}>
                  <Text style={[styles.chipText, warehouseId === item.id && styles.chipTextActive]}>{item.name}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Text style={styles.sheetHint}>لو مخزن واحد لمنطقة العميل، السيرفر بيحدده لوحدك.</Text>
          </>
        )}
        <Text style={styles.label}>الأصناف *</Text>
        {rows.map((row, index) => (
          <View key={index} style={{ gap: space.xs }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
              {products.map(item => (
                <Pressable key={item.id}
                  onPress={() => setRows(list => list.map((entry, at) => (at === index ? { ...entry, productId: item.id } : entry)))}
                  style={[styles.chip, row.productId === item.id && styles.chipActive]}>
                  <Text style={[styles.chipText, row.productId === item.id && styles.chipTextActive]}>
                    {item.name} · {ARABIC.format(item.price)}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <Row style={{ gap: space.sm }}>
              <View style={{ flex: 1 }}>
                <Field label={`الكمية (${products.find(item => item.id === row.productId)?.unit ?? 'وحدة'})`} value={row.qty} keyboardType="numeric"
                  onChangeText={value => setRows(list => list.map((entry, at) => (at === index ? { ...entry, qty: value } : entry)))} />
              </View>
              <Pressable
                onPress={() => setRows(list => (list.length > 1 ? list.filter((_, at) => at !== index) : [...list, { productId: '', qty: '' }]))}
                style={styles.addLine}
                accessibilityRole="button"
                accessibilityLabel={index === 0 ? 'إضافة صنف' : 'شيل الصنف'}
              >
                <Text style={styles.addText}>{index === 0 ? '＋' : '−'}</Text>
              </Pressable>
            </Row>
          </View>
        ))}
        <Field label="ملاحظة" value={note} onChangeText={setNote} placeholder="سلّم سواق الشركة" />
        {short.length > 0 && (
          <Text style={styles.warn}>
            {short.map(line => line.product.name).join(' · ')} — الكمية أكتر من المتاح ({ARABIC.format(short[0].product.onHand)}). الفاتورة هتتسجل والمخزن هيفضل بالسالب لحد الجرد.
          </Text>
        )}
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>الإجمالي المتوقع</Text>
          <Text style={styles.totalValue}>{moneyText(total)}</Text>
        </View>
        <Text style={styles.sheetHint}>الخصم والتعديل بعد التسجيل للمكتب. المسدد يتسجل من زيارة «تحصيل».</Text>
        {message ? <Text style={styles.warn}>{message}</Text> : null}
        <Button label={saving ? 'جارٍ الإرسال…' : 'إرسال الفاتورة'} onPress={submitNow} loading={saving} disabled={!customerId || priced.length === 0} icon="✓" />
      </View>
    </Sheet>
  );
}

/**
 * The balance line inside a customer's sheet — what the office billed this farm and what is still
 * unpaid, read on the spot so a number is never quoted from memory. It fetches its own narrow window
 * (`customerId`) instead of reusing the tab's list: the sheet is opened one customer at a time, and
 * pulling two months of invoices for every farm would cost the same on a rural connection and show the
 * engineer nothing he asked for.
 *
 * A server without the sales endpoints answers 404/403, and the honest response to that is silence:
 * the sheet about a customer still works, it just cannot say anything about money.
 */
export function CustomerBalance({ customerId }: { customerId: string }) {
  const [rows, setRows] = useState<MyInvoice[] | null>(null);
  const load = useCallback(async () => {
    try { setRows((await myInvoices(customerId)).invoices); }
    catch { setRows(null); }
  }, [customerId]);
  useEffect(() => { void load(); }, [load]);
  if (!rows) return <Body muted>مفيش بيانات تحصيل الوقت ده.</Body>;
  if (rows.length === 0) return <Body muted>مافيش فواتير مسجلة لهذا العميل باسمك.</Body>;
  const billed = rows.reduce((sum, invoice) => sum + invoice.total, 0);
  const paid = rows.reduce((sum, invoice) => sum + invoice.paidAmount, 0);
  const due = Math.max(0, billed - paid);
  return (
    <Card tone={due > 0 ? 'mint' : 'plain'}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={styles.totalLabel}>إجمالي الفواتير ({ARABIC.format(rows.length)})</Text>
        <Text style={styles.totalValue}>{moneyText(billed)}</Text>
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
      {rows.slice(0, 3).map(invoice => (
        <Text key={invoice.id} style={styles.meta}>
          {invoice.number || invoice.date} · {invoice.date} · {moneyText(invoice.total)}
          {invoice.status === 'paid' ? ' · محصّل' : ''}
        </Text>
      ))}
      <Text style={styles.meta}>الفواتير بيسجلها المكتب وإنت؛ دي للقراءة بس.</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  head: { paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.sm, gap: 2 },
  headHint: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.muted, lineHeight: 18 },
  pendingNotice: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.amber, marginTop: 2 },
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
  label: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.muted },
  sheetHint: { fontFamily: fonts.regular, fontSize: 12, color: colors.muted, lineHeight: 18 },
  chipRow: { flexDirection: 'row', gap: space.sm },
  chip: { paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, backgroundColor: colors.cream, borderWidth: 1, borderColor: colors.line },
  chipActive: { backgroundColor: colors.green900, borderColor: colors.green900 },
  chipText: { fontFamily: fonts.regular, fontSize: 13, color: colors.ink },
  chipTextActive: { fontFamily: fonts.bold, color: colors.white },
  addLine: { width: 42, height: 42, borderRadius: radius.md, backgroundColor: colors.cream, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  addText: { fontFamily: fonts.bold, fontSize: 18, color: colors.green700 },
  warn: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.danger, lineHeight: 18 },
  target: {
    gap: 4, padding: space.md, borderRadius: radius.md,
    backgroundColor: colors.mint, borderWidth: 1, borderColor: colors.line,
  },
  targetTitle: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.green900 },
  targetPct: { fontFamily: fonts.bold, fontSize: 15, color: colors.green700 },
  bar: { height: 7, borderRadius: radius.pill, backgroundColor: colors.white, overflow: 'hidden', marginBottom: 2 },
  barFill: { height: '100%', borderRadius: radius.pill, backgroundColor: colors.green700 },
  targetFoot: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.green700, lineHeight: 17 },
});
