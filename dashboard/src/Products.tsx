import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ApiError, api, del, patch, post } from './api';
import { formatNumber } from './session';
import ConfirmAction from './ConfirmAction';
import { productCategoryLabels } from './types';
import type { PriceTier, Product, ProductCategory } from './types';

/**
 * قايمعة الأصناف والأسعار — المكتب بيكتبها من هنا، والمهندس بيقرأها من تليفونه.
 *
 * The rule the whole screen is built around is what a price is attached to: a price belongs to a pack,
 * not to a product. That is why every price header says «سعر الوحدة», why each cell carries a title
 * naming the row's own pack, and why a line under the table says it again in words. The office was burned
 * by a «كرتونة» that got assumed for a bottle: the number read as twelve times its value and the invoice
 * still looked finished.
 *
 * So `unit` is required with no suggestion to lean on, prices are written one cell at a time against the
 * real list of buyer types, «امسح» really removes a price instead of turning it into zero, and deleting
 * is offered while the server stays the one that says whether an item is still referenced — its refusal
 * names the table and the row count, and is shown as written.
 */
const messageOf = (error: unknown, fallback: string) => (error instanceof ApiError && error.message ? error.message : fallback);
/** Arabic digits like the rest of the dashboard, but a price keeps its piastres: 12.5 must not round to 13. */
const money = (value: number) => new Intl.NumberFormat('ar-EG', { maximumFractionDigits: 2 }).format(value);
const CATEGORIES = Object.keys(productCategoryLabels) as ProductCategory[];
const EMPTY_FORM = { name: '', category: 'other' as ProductCategory, unit: '', unitSize: '', notes: '' };
const NONE = '';

export default function Products({ timezone }: { timezone?: string }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [tiers, setTiers] = useState<PriceTier[]>([]);
  const [filters, setFilters] = useState({ q: '', category: '', tierId: NONE, unpricedOnly: false, includeInactive: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyRow, setBusyRow] = useState('');
  // One price cell open at a time: the product row picks the line, the column picks the buyer type.
  const [draft, setDraft] = useState<{ productId: string; tierId: string; value: string } | null>(null);
  const [priceError, setPriceError] = useState('');

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (filters.q.trim()) params.set('q', filters.q.trim());
    if (filters.category) params.set('category', filters.category);
    if (filters.includeInactive) params.set('includeInactive', '1');
    // «بلا سعر» is only ever asked about one type at a time: every type is unfinished for some item.
    if (filters.unpricedOnly && filters.tierId) params.set('unpricedFor', filters.tierId);
    return params.toString();
  }, [filters]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, kinds] = await Promise.all([
        api<{ products: Product[] }>(`/api/products?${query}`),
        api<{ tiers: PriceTier[] }>('/api/price-tiers'),
      ]);
      setProducts(list.products);
      setTiers(kinds.tiers);
      setError('');
    } catch (e) {
      setError(messageOf(e, 'تعذر تحميل قايمعة الأصناف.'));
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => { void load(); }, [load]);

  /**
   * Every heading is a column, stopped ones included.
   *
   * Showing only the working types looked right until it met the server's own refusal: a type cannot be
   * deleted while items still hold prices under it («عليه ٣ أصناف مسعّرة — وقّفه بدل الحذف»). If the
   * stopped heading's prices were hidden, the office would be told to clear numbers it cannot see, and the
   * screen would have no move left in it. So the column stays, marked, and its cells stay editable.
   */
  const columns = tiers;
  const liveColumns = useMemo(() => tiers.filter(tier => tier.active), [tiers]);
  const priceOf = (product: Product, tierId: string) => product.prices?.find(entry => entry.tierId === tierId)?.price;
  const priceCount = products.reduce((total, product) => total + (product.prices?.length ?? 0), 0);
  const set = (next: Partial<typeof filters>) => setFilters(value => ({ ...value, ...next }));

  function openCreate() {
    setForm({ ...EMPTY_FORM });
    setFormError('');
    setEditing('new');
  }
  function openEdit(product: Product) {
    setForm({ name: product.name, category: product.category, unit: product.unit, unitSize: product.unitSize, notes: product.notes });
    setFormError('');
    setEditing(product);
  }
  const closeForm = () => { setEditing(null); setFormError(''); };

  async function save(event: FormEvent) {
    event.preventDefault();
    const current = editing;
    const name = form.name.trim();
    const unit = form.unit.trim();
    if (name.length < 2) { setFormError('اكتب اسم الصنف — حرفين على الأقل.'); return; }
    // Checked here as well as on the server so the office is told before the round trip. This is the field
    // that used to be guessed, so «required» is not the message — what the field means is.
    if (!unit) { setFormError('قولي الصنف ده بيتبيع إيه: عبوة / شيكارة / جركن — السعر ده للوحدة دي.'); return; }
    setSaving(true);
    setFormError('');
    const fields = { name, category: form.category, unit, unitSize: form.unitSize.trim(), notes: form.notes.trim() };
    try {
      if (current === 'new') await post('/api/products', fields);
      else if (current) await patch(`/api/products/${current.id}`, fields);
      closeForm();
      await load();
    } catch (e) {
      setFormError(messageOf(e, 'تعذر حفظ الصنف.'));
      // The list is re-read whatever happened: a 409 means somebody else already typed this item, and the
      // row they typed is the thing to look at next to this message.
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function setActive(product: Product, active: boolean) {
    setBusyRow(product.id);
    try {
      await patch(`/api/products/${product.id}`, { active });
      await load();
    } catch (e) {
      setError(messageOf(e, 'تعذر تغيير حالة الصنف.'));
    } finally {
      setBusyRow('');
    }
  }

  async function remove(product: Product) {
    setBusyRow(product.id);
    try {
      await del(`/api/products/${product.id}`);
      await load();
    } catch (e) {
      // «الصنف ده مستخدم: ٣ سطور في order_items» is an answer, not a crash to hide.
      setError(messageOf(e, 'تعذر حذف الصنف.'));
      await load();
    } finally {
      setBusyRow('');
    }
  }

  function openCell(product: Product, tierId: string) {
    const existing = priceOf(product, tierId);
    setPriceError('');
    setDraft({ productId: product.id, tierId, value: existing === undefined ? '' : String(existing) });
  }

  /**
   * One cell, one type, one call. `null` is the delete and a number is the write; the other columns are
   * not mentioned at all, which is how the server knows to leave them alone.
   */
  async function writePrice(product: Product, tier: PriceTier, price: number | null) {
    setBusyRow(product.id);
    setPriceError('');
    try {
      await api(`/api/products/${product.id}/prices`, { method: 'PUT', body: JSON.stringify({ prices: [{ tierId: tier.id, price }] }) });
      setDraft(null);
      await load();
    } catch (e) {
      setPriceError(messageOf(e, 'تعذر حفظ السعر.'));
      await load();
    } finally {
      setBusyRow('');
    }
  }

  function saveCell(product: Product, tier: PriceTier) {
    const raw = (draft?.value ?? '').trim();
    if (raw === '') {
      // Empty and pressed «حفظ» is not «امسح»: wiping a price by leaving a box empty is how a price list
      // loses numbers silently. The office has to press the word.
      setPriceError('سيبت السعر فاضي. لو عايز تمسحه اضغط «امسح»، ولو عايز تكتبه اكتب رقم.');
      return;
    }
    const parsed = Number(raw.replace(/[٬,]/g, ''));
    if (!Number.isFinite(parsed) || parsed < 0) {
      setPriceError(`«${raw}» مش رقم. اكتب سعر موجب لـ«${product.name}» تحت «${tier.name}»، أو اضغط «امسح».`);
      return;
    }
    void writePrice(product, tier, parsed);
  }

  const shownUnit = (product: Product) => [product.unit, product.unitSize].filter(Boolean).join(' · ');

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h2>قايمعة الأصناف والأسعار</h2>
          <p className="muted">
            المكتب بيكتب الأصناف وأنواع المشترين وسعر كل عبوة. تليفون المهندس بيشوف الاسم والعبوة وبس — التسعير بيتقرّر هنا.
          </p>
        </div>
        <button className="btn primary" onClick={openCreate}>صنف جديد</button>
      </header>

      <div className="stats">
        <div className="card stat"><span className="muted small">أصناف ظاهرة</span><strong>{formatNumber(products.length)}</strong><small className="muted">بعد الفلاتر{filters.includeInactive ? ' (الموقوفين داخلين)' : ''}</small></div>
        <div className="card stat"><span className="muted small">أنواع شغالة</span><strong>{formatNumber(liveColumns.length)}</strong><small className="muted">الموقوف باين كعمود كمان عشان يتنضّف</small></div>
        <div className="card stat"><span className="muted small">أسعار مكتوبة</span><strong>{formatNumber(priceCount)}</strong><small className="muted">في الأصناف الظاهرة</small></div>
        <div className="card stat">
          <span className="muted small">بلا سعر في «{columns.find(tier => tier.id === filters.tierId)?.name ?? 'النوع المختار'}»</span>
          <strong>{filters.unpricedOnly && filters.tierId ? formatNumber(products.length) : '—'}</strong>
          <small className="muted">شغّل «اللي بلا سعر بس» بعد ما تختار نوع</small>
        </div>
      </div>

      <div className="panel filters">
        <label className="field inline">
          <span>بحث</span>
          <input value={filters.q} onChange={event => set({ q: event.target.value })} placeholder="اسم الصنف أو العبوة أو ملاحظة" />
        </label>
        <label className="field inline">
          <span>التصنيف</span>
          <select value={filters.category} onChange={event => set({ category: event.target.value })}>
            <option value="">الكل</option>
            {CATEGORIES.map(category => <option key={category} value={category}>{productCategoryLabels[category]}</option>)}
          </select>
        </label>
        <label className="field inline">
          <span>نوع السعر</span>
          <select value={filters.tierId} onChange={event => set({ tierId: event.target.value, unpricedOnly: event.target.value ? filters.unpricedOnly : false })}>
            <option value="">كل الأنواع</option>
            {tiers.map(tier => <option key={tier.id} value={tier.id}>{tier.name}{tier.active ? '' : ' (موقوف)'}</option>)}
          </select>
        </label>
        <label className="field inline">
          <span>اللي بلا سعر بس</span>
          <input type="checkbox" disabled={!filters.tierId} checked={filters.unpricedOnly && !!filters.tierId} onChange={event => set({ unpricedOnly: event.target.checked })} />
        </label>
        <label className="field inline">
          <span>الموقوفين</span>
          <input type="checkbox" checked={filters.includeInactive} onChange={event => set({ includeInactive: event.target.checked })} />
        </label>
        <button className="btn ghost sm" onClick={() => void load()} disabled={loading}>{loading ? 'جارٍ التحميل…' : 'تحديث'}</button>
        {(filters.q || filters.category || filters.tierId || filters.unpricedOnly || filters.includeInactive) && (
          <button className="btn ghost sm" onClick={() => setFilters({ q: '', category: '', tierId: NONE, unpricedOnly: false, includeInactive: false })}>مسح الفلاتر</button>
        )}
      </div>

      {error && <p className="error banner" role="alert">{error}</p>}

      {editing && (
        <form className="panel" onSubmit={save}>
          <h3 className="panel-title">{editing === 'new' ? 'صنف جديد في قايمعة الأصناف' : `تعديل: ${editing.name}`}</h3>
          <div className="filters">
            <label className="field inline">
              <span>اسم الصنف</span>
              <input required minLength={2} maxLength={120} autoFocus value={form.name} placeholder="يوريا ٤٦٪ — زي ما مكتوب على الشيكارة"
                onChange={event => setForm({ ...form, name: event.target.value })} />
            </label>
            <label className="field inline">
              <span>التصنيف</span>
              <select value={form.category} onChange={event => setForm({ ...form, category: event.target.value as ProductCategory })}>
                {CATEGORIES.map(category => <option key={category} value={category}>{productCategoryLabels[category]}</option>)}
              </select>
            </label>
            <label className="field inline">
              <span>العبوة اللي بيتبيعها</span>
              <input required maxLength={40} value={form.unit} placeholder="عبوة / شيكارة / جركن"
                onChange={event => setForm({ ...form, unit: event.target.value })} />
            </label>
            <label className="field inline">
              <span>جوّا العبوة إيه</span>
              <input maxLength={60} value={form.unitSize} placeholder="٥٠٠ مل أو ٥٠ كجم"
                onChange={event => setForm({ ...form, unitSize: event.target.value })} />
            </label>
          </div>
          <div className="filters">
            <label className="field inline" style={{ flex: '1 1 320px' }}>
              <span>ملاحظات</span>
              <input maxLength={500} value={form.notes} placeholder="تخزينه، صلاحيته، أي حاجة لازم المكتب يعرفها"
                onChange={event => setForm({ ...form, notes: event.target.value })} />
            </label>
            <button className="btn primary sm" type="submit" disabled={saving}>{saving ? 'جارٍ الحفظ…' : 'حفظ'}</button>
            <button className="btn ghost sm" type="button" onClick={closeForm}>إلغاء</button>
          </div>
          <p className="muted small">
            «العبوة اللي بيتبيعها» مش اختيارية: السعر اللي هيتكتب بعدها سعر الوحدة دي بالذات. الاسم + العبوة مع بعض = سطر واحد؛ نفس الاسم في عبوة تانية صنف تاني برقم تاني. الأسعار ما تتكتبش هنا — الأعمدة هي مكانها.
          </p>
          {formError && <p className="error" role="alert">{formError}</p>}
        </form>
      )}

      <div className="panel">
        <h3 className="panel-title">الأصناف · {formatNumber(products.length)}</h3>
        {tiers.length === 0 && (
          <p className="error banner" role="alert">
            مفيش نوع مشترٍ أصلًا، فقايمعة الأسعار ملهاش عمود. الأصناف تقدر تضيفها دلوقتي، والسعر يتكتب أول ما تضيف نوع تحت («جملة» مثلًا).
          </p>
        )}
        {products.length === 0 && !loading ? (
          <p className="empty">
            {filters.q || filters.category || filters.unpricedOnly
              ? 'مفيش أصناف بالفلاتر دي — امسح الفلاتر أو ضيف صنف جديد.'
              : 'قايمعة الأصناف فاضية. أول صنف يتضاف من زرار «صنف جديد» فوق، وبعدين يتسعّر في الأعمدة.'}
          </p>
        ) : (
          <>
            <div className="kpi-table-wrap products-table">
              <table className="kpi-table">
                <thead>
                  <tr>
                    <th>الصنف</th><th>العبوة</th><th>التصنيف</th>
                    {columns.map(tier => (
                      <th key={tier.id} style={tier.active ? undefined : { opacity: 0.7 }}>
                        {tier.name}
                        {tier.active ? null : <em className="muted small"> (موقوف)</em>}
                        <small className="muted"> سعر الوحدة</small>
                      </th>
                    ))}
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {products.map(product => (
                    <tr key={product.id} style={product.active ? undefined : { opacity: 0.6 }}>
                      <td>
                        <strong>{product.name}</strong>
                        {product.active ? null : <em className="muted small"> · موقوف</em>}
                        {product.notes ? <small className="muted">{product.notes}</small> : null}
                      </td>
                      <td>{shownUnit(product)}</td>
                      <td><span className="pill">{productCategoryLabels[product.category]}</span></td>
                      {columns.map(tier => {
                        const price = priceOf(product, tier.id);
                        const open = draft && draft.productId === product.id && draft.tierId === tier.id;
                        return (
                          <td key={tier.id} className="mono">
                            {open ? (
                              <span className="confirm-pair">
                                <input dir="ltr" autoFocus style={{ width: 90 }} value={draft.value} aria-label={`سعر ${product.name} — ${tier.name}`}
                                  onChange={event => setDraft({ ...draft, value: event.target.value })} />
                                <button className="btn primary sm" disabled={busyRow !== ''} onClick={() => saveCell(product, tier)}>حفظ</button>
                                {price !== undefined && (
                                  <button className="btn ghost sm" disabled={busyRow !== ''} onClick={() => void writePrice(product, tier, null)}>امسح</button>
                                )}
                                <button className="btn ghost sm" onClick={() => { setDraft(null); setPriceError(''); }}>إلغاء</button>
                              </span>
                            ) : busyRow === product.id ? (
                              <span className="muted small">جارٍ الحفظ…</span>
                            ) : (
                              <button className="btn ghost sm" onClick={() => openCell(product, tier.id)} title={`سعر ${product.unit} الواحدة لـ«${tier.name}»`}>
                                {price === undefined ? <span className="pill warn">بلا سعر</span> : money(price)}
                              </button>
                            )}
                          </td>
                        );
                      })}
                      <td>
                        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <button className="btn ghost sm" onClick={() => openEdit(product)}>تعديل</button>
                          <button className="btn ghost sm" onClick={() => void setActive(product, !product.active)}>{product.active ? 'وقف' : 'رجّع للشغل'}</button>
                          <ConfirmAction
                            label="حذف"
                            confirmLabel="امسحه نهائيًا"
                            detail={product.active
                              ? 'اللي عليه طلبيات أو فواتير ما يتحذفش — هيخلي السجلات دي تشير لفراغ. الوقف أحسن.'
                              : 'موقوف بالفعل، بس لسه ممكن يكون عليه سطور في سجلات قديمة — لو كده الحذف هيترفض ويقولك فين.'}
                            onConfirm={() => remove(product)}
                          />
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small" style={{ marginTop: 10 }}>
              كل خانة سعر = ثمن <strong>الوحدة المكتوبة في عمود «العبوة»</strong> لصنف واحد — مش الكرتونة ولا الطرد · «امسح» = الصنف يفضل من غير سعر تحت النوع ده، وده مش صفر · الأعمدة الموقوفة باينة عشان تقدر تنضّف اللي تحتها (بدون كده «نوع عليه أسعار ما يتحذفش» يبقى كلام ملوش مخرج) · التوقيت {timezone ?? 'Africa/Cairo'}.
            </p>
            {priceError && <p className="error" role="alert">{priceError}</p>}
          </>
        )}
      </div>

      <TiersPanel tiers={tiers} onDone={() => void load()} />
    </section>
  );
}

/**
 * أنواع المشترين: راس قايمعة الأسعار.
 *
 * The office names these and orders them. Nothing here is derived from a region or from what a customer
 * bought last, because «جملة» is a commercial decision and not an inference. Two refusals are the point of
 * this panel rather than edge cases: the last working type cannot be stopped (that leaves the price list
 * with no column), and a type still holding prices cannot be deleted — stopping it keeps every number for
 * the day the type comes back.
 */
function TiersPanel({ tiers, onDone }: { tiers: PriceTier[]; onDone: () => void }) {
  const [name, setName] = useState('');
  const [position, setPosition] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string; position: string } | null>(null);
  const [busy, setBusy] = useState('');

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length < 2) { setError('اكتب اسم نوع السعر — «جملة»، «نصف جملة»، «تجزئة»…'); return; }
    if (position.trim() && !Number.isFinite(Number(position))) { setError('الترتيب رقم، أو سيبه فاضي يتحط في آخر القايمعة.'); return; }
    setSaving(true);
    setError('');
    setNote('');
    try {
      await post('/api/price-tiers', { name: trimmed, ...(position.trim() ? { position: Number(position) } : {}) });
      setName('');
      setPosition('');
      onDone();
    } catch (e) {
      setError(messageOf(e, 'تعذر إضافة النوع.'));
    } finally {
      setSaving(false);
    }
  };

  const update = async (tier: PriceTier, body: { name?: string; position?: number; active?: boolean }) => {
    setBusy(tier.id);
    setError('');
    setNote('');
    try {
      await patch(`/api/price-tiers/${tier.id}`, body);
      setRenaming(null);
      onDone();
    } catch (e) {
      setError(messageOf(e, 'تعذر تعديل النوع.'));
      onDone();
    } finally {
      setBusy('');
    }
  };

  const remove = async (tier: PriceTier) => {
    setBusy(tier.id);
    setError('');
    try {
      const result = await del<{ unquoted: number }>(`/api/price-tiers/${tier.id}`);
      // The number is the part the office has to act on: those customers now get priced by hand.
      setNote(result.unquoted
        ? `«${tier.name}» اتشال. ${formatNumber(result.unquoted)} عميل بقوا من غير نوع سعر — حدّد لهم نوع أو سعّرهم باليد.`
        : `«${tier.name}» اتشال، ومفيش عميل كان بيتسعّر بيه.`);
      onDone();
    } catch (e) {
      setError(messageOf(e, 'تعذر حذف النوع.'));
      onDone();
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="panel">
      <h3 className="panel-title">أنواع المشترين · {formatNumber(tiers.filter(tier => tier.active).length)} شغال</h3>
      <p className="muted small">
        دول راس قايمعة الأسعار: كل نوع عمود في الجدول فوق. الترتيب = إزاي تتقرأ القايمعة (الأكثر شراءً على الشمال)، مش ترتيب ألفبائي.
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      {note && <p className="small ok-text">{note}</p>}
      {tiers.length === 0 ? (
        <p className="empty">مفيش أنواع — ضيف «جملة» تحت عشان قايمعة الأسعار يبقى لها عمود.</p>
      ) : (
        <div className="kpi-table-wrap tiers-table">
          <table className="kpi-table">
            <thead>
              <tr><th>النوع</th><th>الترتيب</th><th>أصناف مسعّرة</th><th>عملاء عليه</th><th>الحالة</th><th></th></tr>
            </thead>
            <tbody>
              {tiers.map(tier => (
                <tr key={tier.id} style={tier.active ? undefined : { opacity: 0.6 }}>
                  <td>
                    {renaming?.id === tier.id ? (
                      <span className="confirm-pair">
                        <input autoFocus value={renaming.name} maxLength={60} aria-label="اسم النوع"
                          onChange={event => setRenaming({ ...renaming, name: event.target.value })} />
                        <input dir="ltr" style={{ width: 64 }} value={renaming.position} aria-label="ترتيب النوع"
                          onChange={event => setRenaming({ ...renaming, position: event.target.value })} />
                        <button className="btn primary sm" disabled={busy !== ''} onClick={() => void update(tier, {
                          name: renaming.name.trim(),
                          // Left as it was when the box is not a number: a blank position is not «first».
                          position: Number.isFinite(Number(renaming.position)) ? Math.max(0, Math.trunc(Number(renaming.position))) : tier.position,
                        })}>احفظ</button>
                        <button className="btn ghost sm" onClick={() => setRenaming(null)}>إلغاء</button>
                      </span>
                    ) : (
                      <>
                        <strong>{tier.name}</strong>
                        {tier.active ? null : <em className="muted small"> · موقوف</em>}
                      </>
                    )}
                  </td>
                  <td className="mono">{formatNumber(tier.position)}</td>
                  <td className="mono">{formatNumber(tier.priced)}</td>
                  <td className="mono">{tier.customers ? formatNumber(tier.customers) : '—'}</td>
                  <td>{tier.active ? <span className="pill ok">شغال</span> : <span className="pill warn">موقوف</span>}</td>
                  <td>
                    <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button className="btn ghost sm" onClick={() => setRenaming({ id: tier.id, name: tier.name, position: String(tier.position) })}>تعديل</button>
                      <button className="btn ghost sm" disabled={busy !== ''} onClick={() => void update(tier, { active: !tier.active })}>
                        {tier.active ? 'وقف' : 'رجّع للشغل'}
                      </button>
                      <ConfirmAction
                        label="حذف"
                        confirmLabel="امسحه نهائيًا"
                        detail={tier.priced
                          ? `عليه ${formatNumber(tier.priced)} صنف مسعّر — الحذف يمسح الأرقام دي. الأحسن توقّفه.`
                          : `مفيش أصناف مسعّرة تحته${tier.customers ? `، و${formatNumber(tier.customers)} عميل هيبقوا من غير نوع سعر` : ''}.`}
                        onConfirm={() => remove(tier)}
                      />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form className="filters" onSubmit={event => void add(event)} style={{ marginTop: 12 }}>
        <label className="field inline">
          <span>نوع جديد</span>
          <input value={name} onChange={event => setName(event.target.value)} maxLength={60} placeholder="موزع" />
        </label>
        <label className="field inline">
          <span>ترتيبه (اختياري)</span>
          <input dir="ltr" value={position} onChange={event => setPosition(event.target.value)} style={{ width: 70 }} placeholder="٣" />
        </label>
        <button className="btn primary sm" type="submit" disabled={saving}>{saving ? 'جارٍ الحفظ…' : 'ضيف'}</button>
      </form>
      <p className="muted small">
        نوع موقوف = لسه عمود في القايمعة (عشان تعرف تمسح اللي تحته) بس ما بيتختارشش لعميل جديد، وسعره محفوظ ليرجع · نوع عليه أسعار ما يتحذفش (الحذف يمسح الأسعار) · آخر نوع شغال ما يتقفلش.
      </p>
    </div>
  );
}
