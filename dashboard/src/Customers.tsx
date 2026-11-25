import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ApiError, api, del, patch, post } from './api';
import { ago, formatNumber } from './session';
import ConfirmAction from './ConfirmAction';
import { customerStageLabels } from './types';
import type { AreaBook, AreaPreview, AreaRow, Customer, CustomerStage, MoveResult, PriceTier } from './types';

/**
 * The company's customer book: entered here, divided here, and read by the engineers' phones.
 *
 * The rule the whole screen is built around is that this list is not a by-product of field work. The
 * office types it, and the office decides who serves whom. That is why the add/edit form lives on this
 * screen rather than on the phone, and why the area workbench below never moves a customer on its own:
 * `users.region` matching an area is a text comparison, so it produces a proposal next to a button.
 */

/** Choosing «nobody» is an answer, so it needs its own value rather than an empty selection. */
const POOL = '';
const EMPTY_FORM = {
  name: '', phone: '', governorate: '', district: '', village: '', notes: '',
  stage: 'new' as CustomerStage, lostReason: '', repId: POOL, priceTierId: POOL,
};
const STAGES = Object.keys(customerStageLabels) as CustomerStage[];
/** An area is the pair as stored, not as printed: «من غير مركز» is not a value the server can filter on. */
const areaKey = (row: Pick<AreaRow, 'bareGovernorate' | 'bareDistrict'>) => `${row.bareGovernorate}|${row.bareDistrict}`;
const messageOf = (error: unknown, fallback: string) => (error instanceof ApiError && error.message ? error.message : fallback);

export default function Customers({ timezone }: { timezone?: string }) {
  const [book, setBook] = useState<AreaBook | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  // The price list's headings: which column of it each customer buys at. Read here, edited in the
  // الأصناف screen — the book only records the choice.
  const [tiers, setTiers] = useState<PriceTier[]>([]);
  const [filters, setFilters] = useState({ q: '', governorate: '', district: '', repId: POOL, unassigned: false, stage: '', includeInactive: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Customer | 'new' | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  // The row whose engineer picker is open, and the id being written to (so one spinner per action).
  const [busyRow, setBusyRow] = useState('');

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (filters.q.trim()) params.set('q', filters.q.trim());
    if (filters.governorate) params.set('governorate', filters.governorate);
    if (filters.district) params.set('district', filters.district);
    if (filters.unassigned) params.set('unassigned', '1');
    else if (filters.repId) params.set('repId', filters.repId);
    if (filters.stage) params.set('stage', filters.stage);
    if (filters.includeInactive) params.set('includeInactive', '1');
    return params.toString();
  }, [filters]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, areas, kinds] = await Promise.all([
        api<{ customers: Customer[] }>(`/api/customers?${query}`),
        api<AreaBook>('/api/customers/areas'),
        api<{ tiers: PriceTier[] }>('/api/price-tiers'),
      ]);
      setCustomers(list.customers);
      setBook(areas);
      setTiers(kinds.tiers);
      setError('');
    } catch (e) {
      setError(messageOf(e, 'تعذر تحميل قائمة العملاء.'));
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => { void load(); }, [load]);

  const engineers = book?.engineers ?? [];
  const nameOf = (id: string | null) => (id ? engineers.find(rep => rep.id === id)?.name ?? 'مهندس محذوف' : 'من غير مهندس');
  // District options follow the chosen governorate, because «طنطا» is a مركز in الغربية and a حى in
  // المنوفية — one list of both would be a lottery.
  const districts = useMemo(() => {
    const seen = new Set<string>();
    for (const row of book?.areas ?? []) {
      if (filters.governorate && row.bareGovernorate !== filters.governorate) continue;
      if (row.bareDistrict) seen.add(row.bareDistrict);
    }
    return [...seen].sort((a, b) => a.localeCompare(b, 'ar'));
  }, [book, filters.governorate]);

  function openCreate() {
    setForm({ ...EMPTY_FORM, governorate: filters.governorate, district: filters.district, repId: filters.repId || POOL });
    setFormError('');
    setEditing('new');
  }
  function openEdit(customer: Customer) {
    setForm({
      name: customer.name, phone: customer.phone, governorate: customer.governorate, district: customer.district,
      village: customer.village, notes: customer.notes, stage: customer.stage, lostReason: customer.lostReason,
      repId: customer.repId ?? POOL, priceTierId: customer.priceTierId ?? POOL,
    });
    setFormError('');
    setEditing(customer);
  }
  const closeForm = () => { setEditing(null); setFormError(''); };

  async function save(event: FormEvent) {
    event.preventDefault();
    // Narrowed once, here: `editing` is state, so nothing inside this function can prove to the
    // compiler that the form is open on an existing row rather than on `null`.
    const current = editing;
    const name = form.name.trim();
    if (name.length < 2) { setFormError('اكتب اسم العميل أو المزرعة — حرفين على الأقل.'); return; }
    if (form.stage === 'lost' && !form.lostReason.trim()) { setFormError('اكتب سبب رفض العميل قبل ما تقفله.'); return; }
    setSaving(true);
    setFormError('');
    const fields = {
      name, phone: form.phone.trim(), governorate: form.governorate.trim(), district: form.district.trim(),
      village: form.village.trim(), notes: form.notes.trim(), stage: form.stage, lostReason: form.lostReason.trim(),
    };
    // Which column of the price list he buys at. Sent only when it moved: a customer already quoted at a
    // type the office has since stopped must survive an edit of his phone number, and the server refuses a
    // stopped type as a new choice.
    const priceTier = { priceTierId: form.priceTierId || null };
    const tierChanged = form.priceTierId !== (current && current !== 'new' ? current.priceTierId ?? POOL : POOL);
    let fieldsSaved = false;
    try {
      if (current === 'new') {
        await post('/api/customers', { ...fields, repId: form.repId || null, ...priceTier });
      } else if (current) {
        // One PATCH for the row, and the type is only in it when it actually moved.
        await patch(`/api/customers/${current.id}`, tierChanged ? { ...fields, ...priceTier } : fields);
        fieldsSaved = true;
        // The link is its own call, with its own refusal («ادمج العميلين الأول») — so it is asked after
        // the fields are saved, and the message below says which half happened.
        const target = form.repId || null;
        if (target !== (current.repId ?? null)) await post(`/api/customers/${current.id}/assign`, { repId: target });
      }
      closeForm();
      await load();
    } catch (e) {
      // «اتحفظت لكن النقل اترفض» is only true once the row itself went in; saying it after a refused
      // first call would send the office to look for a half-saved record that was never written.
      setFormError(fieldsSaved
        ? `البيانات اتحفظت، لكن النقل اترفض: ${messageOf(e, 'تعذر ربط العميل.')}`
        : messageOf(e, 'تعذر حفظ العميل.'));
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function assign(customer: Customer, repId: string | null) {
    setBusyRow(customer.id);
    try {
      await post(`/api/customers/${customer.id}/assign`, { repId });
      await load();
    } catch (e) {
      setError(messageOf(e, 'تعذر نقل العميل.'));
      await load();
    } finally {
      setBusyRow('');
    }
  }

  async function setActive(customer: Customer, active: boolean) {
    setBusyRow(customer.id);
    try {
      await patch(`/api/customers/${customer.id}`, { active });
      await load();
    } catch (e) {
      setError(messageOf(e, 'تعذر تغيير حالة العميل.'));
    } finally {
      setBusyRow('');
    }
  }

  /**
   * Deleting is the one action here that cannot be undone, so the button asks twice and the failure is
   * reported instead of thrown: a server that refuses («عليه زيارات») is a normal answer, and
   * ConfirmAction has no catch of its own — an escaping rejection would sit in the console.
   */
  async function remove(customer: Customer) {
    setBusyRow(customer.id);
    try {
      await del(`/api/customers/${customer.id}`);
      await load();
    } catch (e) {
      setError(messageOf(e, 'تعذر حذف العميل.'));
      await load();
    } finally {
      setBusyRow('');
    }
  }

  const totals = book?.totals ?? { customers: 0, unassigned: 0, areas: 0 };
  const set = (patch_: Partial<typeof filters>) => setFilters(value => ({ ...value, ...patch_ }));

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h2>قائمة العملاء</h2>
          <p className="muted">
            عملاء الشركة كلهم هنا — المكتب بيضيفهم وبيحدد مين يخدم كل عميل. التليفون بيشوف قائمته هو وبس.
          </p>
        </div>
        <button className="btn primary" onClick={openCreate}>عميل جديد</button>
      </header>

      <div className="stats">
        <div className="card stat"><span className="muted small">عملاء الشركة</span><strong>{formatNumber(totals.customers)}</strong><small className="muted">القائمة كلها، الموقوف عليها</small></div>
        <div className="card stat"><span className="muted small">لسه ما اتوزّعوش</span><strong>{formatNumber(totals.unassigned)}</strong><small className="muted">من غير مهندس — حالة عادية</small></div>
        <div className="card stat"><span className="muted small">مناطق فيها عملاء</span><strong>{formatNumber(totals.areas)}</strong><small className="muted">محافظة / مركز</small></div>
        <div className="card stat"><span className="muted small">الظاهر دلوقتي</span><strong>{formatNumber(customers.length)}</strong><small className="muted">بعد الفلاتر</small></div>
      </div>

      <div className="panel filters">
        <label className="field inline">
          <span>بحث</span>
          <input value={filters.q} onChange={event => set({ q: event.target.value })} placeholder="اسم أو تليفون أو قرية" />
        </label>
        <label className="field inline">
          <span>المحافظة</span>
          <select value={filters.governorate} onChange={event => set({ governorate: event.target.value, district: '' })}>
            <option value="">الكل</option>
            {[...new Set((book?.areas ?? []).map(row => row.bareGovernorate).filter(Boolean))].map(gov => <option key={gov} value={gov}>{gov}</option>)}
          </select>
        </label>
        <label className="field inline">
          <span>المركز</span>
          <select value={filters.district} onChange={event => set({ district: event.target.value })}>
            <option value="">الكل</option>
            {districts.map(district => <option key={district} value={district}>{district}</option>)}
          </select>
        </label>
        <label className="field inline">
          <span>المهندس</span>
          <select value={filters.unassigned ? 'unassigned' : filters.repId} onChange={event => {
            const value = event.target.value;
            set({ unassigned: value === 'unassigned', repId: value === 'unassigned' ? POOL : value });
          }}>
            <option value="">الكل</option>
            <option value="unassigned">من غير مهندس</option>
            {engineers.map(rep => <option key={rep.id} value={rep.id}>{rep.name}{rep.active ? '' : ' (موقوف)'}{rep.region ? ` — ${rep.region}` : ''}</option>)}
          </select>
        </label>
        <label className="field inline">
          <span>المرحلة</span>
          <select value={filters.stage} onChange={event => set({ stage: event.target.value })}>
            <option value="">الكل</option>
            {STAGES.map(stage => <option key={stage} value={stage}>{customerStageLabels[stage]}</option>)}
          </select>
        </label>
        <label className="field inline">
          <span>الموقوفين</span>
          <input type="checkbox" checked={filters.includeInactive} onChange={event => set({ includeInactive: event.target.checked })} />
        </label>
        <button className="btn ghost sm" onClick={() => void load()} disabled={loading}>{loading ? 'جارٍ التحميل…' : 'تحديث'}</button>
        {(filters.q || filters.governorate || filters.district || filters.repId || filters.unassigned || filters.stage || filters.includeInactive) && (
          <button className="btn ghost sm" onClick={() => setFilters({ q: '', governorate: '', district: '', repId: POOL, unassigned: false, stage: '', includeInactive: false })}>مسح الفلاتر</button>
        )}
      </div>

      {error && <p className="error banner" role="alert">{error}</p>}

      {editing && (
        <CustomerForm
          editing={editing}
          form={form}
          setForm={setForm}
          error={formError}
          saving={saving}
          tiers={tiers}
          engineers={engineers}
          onCancel={closeForm}
          onSave={save}
        />
      )}

      <div className="panel">
        <h3 className="panel-title">
          {filters.unassigned ? 'من غير مهندس' : filters.repId ? `قائمة ${nameOf(filters.repId)}` : 'قائمة الشركة'}
          {' '}· {formatNumber(customers.length)}
        </h3>
        {customers.length === 0 && !loading ? (
          <p className="empty">
            {totals.customers
              ? 'مفيش عملاء بالفلاتر دي — امسح الفلاتر أو ضيف عميل جديد.'
              : 'قائمة العملاء فاضية. أول عميل يتضاف من زرار «عميل جديد» فوق، وبعدين يتربط بالمهندس.'}
          </p>
        ) : (
          <div className="kpi-table-wrap customers-table">
            <table className="kpi-table">
              <thead>
                <tr>
                  <th>العميل</th><th>المهندس</th><th>المرحلة</th><th>نوع السعر</th><th>الزيارات</th><th></th>
                </tr>
              </thead>
              <tbody>
                {customers.map(customer => (
                  <tr key={customer.id} style={customer.active ? undefined : { opacity: 0.6 }}>
                    <td>
                      <strong>{customer.name}</strong>
                      {customer.active ? null : <em className="muted small"> · موقوف</em>}
                      {/* Everything that only explains the name lives under it now. Nine columns of
                          read-only text plus four buttons was a table that scrolled sideways and wrapped. */}
                      {customer.phone ? <small className="mono">{customer.phone}</small> : null}
                      <small>{[customer.governorate, customer.district, customer.village].filter(Boolean).join(' / ') || 'من غير منطقة'}</small>
                      {customer.notes ? <small>{customer.notes}</small> : null}
                      {customer.stage === 'lost' && customer.lostReason ? <small>سبب الرفض: {customer.lostReason}</small> : null}
                    </td>
                    {/* The cell is the control: a name you click, and the change saves on its own. This is the
                        one move the office came here for, so it no longer costs a button, a modal, a picker
                        and a save. */}
                    <td>
                      <span className="dot" style={{ background: customer.repColor }} aria-hidden="true" />
                      <select
                        className="rowpick"
                        value={customer.repId ?? POOL}
                        disabled={busyRow === customer.id}
                        onChange={event => void assign(customer, event.target.value || null)}
                        aria-label={`مهندس ${customer.name}`}
                        title={busyRow === customer.id ? 'جارٍ الحفظ…' : 'اختار المهندس — بيتسجّل على طول'}
                      >
                        <option value={POOL}>من غير مهندس (قائمة الشركة)</option>
                        {engineers.map(rep => <option key={rep.id} value={rep.id} disabled={!rep.active}>{rep.name}{rep.active ? '' : ' (موقوف)'}</option>)}
                      </select>
                      {busyRow === customer.id ? <small>جارٍ الحفظ…</small> : null}
                    </td>
                    <td><span className={customer.stage === 'lost' ? 'pill warn' : 'pill'}>{customerStageLabels[customer.stage]}</span></td>
                    <td>
                      {customer.priceTierName || <span className="pill warn" title="نوع السعر مش محدد له — أي طلبية عليه تتسعّر باليد">باليد</span>}
                    </td>
                    <td>
                      <span className="mono">{formatNumber(customer.visitCount)}</span>
                      {customer.openVisits ? <em className="pill ok"> جارية</em> : null}
                      <small>{customer.lastVisitAt ? ago(customer.lastVisitAt) : 'ما اتزارش'}</small>
                    </td>
                    <td>
                      <span className="row-actions">
                        <button className="btn ghost sm" onClick={() => openEdit(customer)}>تعديل</button>
                        <button className="btn ghost sm" disabled={busyRow === customer.id} onClick={() => void setActive(customer, !customer.active)}>{customer.active ? 'وقف' : 'رجّع للشغل'}</button>
                        <ConfirmAction
                          label="حذف"
                          confirmLabel="امسحه نهائيًا"
                          detail={customer.visitCount
                            ? `عليه ${formatNumber(customer.visitCount)} زيارة — الحذف مش مسموح للحفاظ على تاريخه. الأحسن توقّفه.`
                            : 'مفيش عليه زيارات. لو عليه طلبيات، الحذف هيترفض للحفاظ على تاريخه.'}
                          onConfirm={() => remove(customer)}
                        />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small" style={{ marginTop: 10 }}>
          الاسم في عمود «المهندس» هو الأداة نفسها: اضغطه واختار، بيتسجّل على طول ومفيش نافذة · عميل من غير مهندس = لسه ما اتوزّعش، مش عميل منسيّ · التوقيت {timezone ?? 'Africa/Cairo'}.
        </p>
      </div>

      <AreaWorkbench book={book} onDone={() => void load()} />
    </section>
  );
}

/** One form for adding and editing. The engineer select is the assignment, and it travels alone. */
function CustomerForm({ editing, form, setForm, error, saving, tiers, engineers, onCancel, onSave }: {
  editing: Customer | 'new';
  form: typeof EMPTY_FORM;
  setForm: (value: typeof EMPTY_FORM) => void;
  error: string;
  saving: boolean;
  tiers: PriceTier[];
  engineers: AreaBook['engineers'];
  onCancel: () => void;
  onSave: (event: FormEvent) => void;
}) {
  const field = (key: keyof typeof EMPTY_FORM) => ({
    value: String(form[key] ?? ''),
    onChange: (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value }),
  });
  const isNew = editing === 'new';
  return (
    <form className="panel" onSubmit={onSave}>
      <h3 className="panel-title">{isNew ? 'عميل جديد في قائمة الشركة' : `تعديل: ${editing.name}`}</h3>
      <div className="filters">
        <label className="field inline">
          <span>اسم العميل / المزرعة</span>
          <input required minLength={2} maxLength={120} autoFocus {...field('name')} placeholder="زي ما العميل بيقول على نفسه" />
        </label>
        <label className="field inline">
          <span>التليفون</span>
          <input dir="ltr" maxLength={30} {...field('phone')} placeholder="01xxxxxxxxx" />
        </label>
        <label className="field inline">
          <span>المحافظة</span>
          <input maxLength={80} {...field('governorate')} placeholder="الغربية" />
        </label>
        <label className="field inline">
          <span>المركز</span>
          <input maxLength={80} {...field('district')} placeholder="طنطا" />
        </label>
        <label className="field inline">
          <span>القرية</span>
          <input maxLength={120} {...field('village')} />
        </label>
        <label className="field inline">
          <span>المرحلة</span>
          <select {...field('stage')} onChange={event => setForm({ ...form, stage: event.target.value as CustomerStage })}>
            {STAGES.map(stage => <option key={stage} value={stage}>{customerStageLabels[stage]}</option>)}
          </select>
        </label>
        <label className="field inline">
          <span>نوع السعر</span>
          <select value={form.priceTierId} onChange={event => setForm({ ...form, priceTierId: event.target.value })}>
            <option value={POOL}>من غير تحديد — يتسعّر باليد</option>
            {tiers.map(tier => <option key={tier.id} value={tier.id}>{tier.name}{tier.active ? '' : ' (موقوف)'}</option>)}
          </select>
        </label>
        <label className="field inline">
          <span>{isNew ? 'المهندس' : 'نقل إلى مهندس'}</span>
          <select value={form.repId} onChange={event => setForm({ ...form, repId: event.target.value })}>
            <option value={POOL}>من غير مهندس — يفضل في قائمة الشركة</option>
            {engineers.map(rep => <option key={rep.id} value={rep.id} disabled={!rep.active && rep.id !== form.repId}>{rep.name}{rep.active ? '' : ' (موقوف)'}</option>)}
          </select>
        </label>
      </div>
      {form.stage === 'lost' && (
        <div className="filters">
          <label className="field inline">
            <span>سبب الرفض</span>
            <input required maxLength={300} {...field('lostReason')} placeholder="السعر أعلى من السوق / بيشتري من تاني" />
          </label>
        </div>
      )}
      <div className="filters">
        <label className="field inline" style={{ flex: '1 1 320px' }}>
          <span>ملاحظات</span>
          <input maxLength={1000} {...field('notes')} placeholder="محصوله، مساحته، أي حاجة لازم المهندس يعرفها" />
        </label>
        <button className="btn primary sm" type="submit" disabled={saving}>{saving ? 'جارٍ الحفظ…' : 'حفظ'}</button>
        <button className="btn ghost sm" type="button" onClick={onCancel}>إلغاء</button>
      </div>
      <p className="muted small">
        «نوع السعر» قرار المكتب: المنطقة ما بتقترحش حاجة — المنطقة تقول مين بيخدم العميل، مش بيدفع إيه.
        الاسم بيتسجّل زي ما هو (بيتم تشذيب المسافات بس) ومفيش تكرار لنفس المهندس — لو الاسم موجود، النظام هيقولك تعدّل السطر الموجود بدل ما تضيف نسخة.
      </p>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}

/**
 * التوزيع بالمناطق: the workbench that hands a whole area to one engineer.
 *
 * The area row is its own control, the same rule the customer list learned: the list carries the
 * engineer and the button next to it says who and how many before anything is pressed. Handing an
 * area to a person moves only the customers nobody owns yet — stealing a colleague's rows by a stray
 * press is the one thing this screen must not do — and the sweep that does touch assigned names,
 * sending the whole area back to the company's list, arms itself like a delete does. Names the
 * receiver already carries are skipped by the server and counted in the answer («اتخطّوا»), so the
 * office learns about a collision the moment it happens instead of one round-trip earlier.
 */
function AreaTransfer({ row, engineers, onDone }: { row: AreaRow; engineers: AreaBook['engineers']; onDone: () => void }) {
  const [choice, setChoice] = useState<string | null>(null);
  const [onlyUnassigned, setOnlyUnassigned] = useState(true);
  const [preview, setPreview] = useState<AreaPreview | null>(null);
  const [result, setResult] = useState<MoveResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const repId = choice ?? row.suggestedRepId ?? POOL;
  const name = engineers.find(rep => rep.id === repId)?.name ?? 'قائمة الشركة';
  const unassigned = repId !== POOL && onlyUnassigned;

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setError('');
    // Never broaden an unnamed area into the whole customer book.
    if (!row.bareGovernorate && !row.bareDistrict) return () => { cancelled = true; };
    void post<AreaPreview>('/api/customers/assign-area', {
      governorate: row.bareGovernorate, district: row.bareDistrict,
      repId: repId || null, onlyUnassigned: unassigned, exactArea: true, dryRun: true,
    }).then(value => { if (!cancelled) setPreview(value); })
      .catch(e => { if (!cancelled) setError(messageOf(e, 'تعذر حساب النقل.')); });
    return () => { cancelled = true; };
  }, [row, repId, unassigned]);

  async function move() {
    if (!preview || !preview.wouldMove || busy) return;
    setBusy(true); setError('');
    try {
      const done = await post<MoveResult>('/api/customers/assign-area', {
        governorate: row.bareGovernorate, district: row.bareDistrict,
        repId: repId || null, onlyUnassigned: unassigned, exactArea: true,
      });
      setResult(done);
      onDone();
    } catch (e) { setError(messageOf(e, 'تعذر تنفيذ النقل.')); }
    finally { setBusy(false); }
  }

  return <div className="stack">
    <select className="rowpick" value={repId} aria-label="المهندس" onChange={event => { setPreview(null); setChoice(event.target.value); setResult(null); }}>
      <option value={POOL}>قائمة الشركة (من غير مهندس)</option>
      {engineers.map(rep => <option key={rep.id} value={rep.id} disabled={!rep.active}>{rep.name}{rep.active ? '' : ' (موقوف)'}</option>)}
    </select>
    {repId !== POOL && <label className="field inline"><span>اللي من غير مهندس بس</span>
      <input type="checkbox" checked={onlyUnassigned} onChange={event => { setPreview(null); setOnlyUnassigned(event.target.checked); setResult(null); }} />
    </label>}
    {preview && <p className="small">هينقل {formatNumber(preview.wouldMove)} من {formatNumber(preview.matched)}
      {preview.conflicts.length > 0 ? `، وهيتخطّى ${formatNumber(preview.conflicts.length)}: ${preview.conflicts.map(item => item.name).join('، ')}` : ''}
      {preview.capped ? ' · أول ١٠٠٠ عميل بس' : ''}.</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <button className="btn primary sm" disabled={busy || !preview?.wouldMove} onClick={() => void move()}>
      {busy ? 'جارٍ النقل…' : `تأكيد النقل لـ ${name}`}
    </button>
    {result && <p className="small ok-text">{formatNumber(result.moved)} اتنقلوا{result.skipped ? `، و${formatNumber(result.skipped)} اتخطّوا` : ''}.
      {result.capped ? ' النقل وقف عند أول ١٠٠٠ عميل.' : ''}</p>}
  </div>;
}

function AreaWorkbench({ book, onDone }: { book: AreaBook | null; onDone: () => void }) {
  const [error, setError] = useState('');
  const [regionFor, setRegionFor] = useState('');
  const [regionValue, setRegionValue] = useState('');
  const [savingRegion, setSavingRegion] = useState(false);

  const areas = book?.areas ?? [];
  const engineers = book?.engineers ?? [];
  async function saveRegion(repId: string) {
    setSavingRegion(true);
    setError('');
    try {
      await patch(`/api/reps/${repId}`, { region: regionValue.trim() });
      setRegionFor('');
      onDone();
    } catch (e) {
      setError(messageOf(e, 'تعذر حفظ المنطقة.'));
    } finally {
      setSavingRegion(false);
    }
  }

  return (
    <div className="panel">
      <h3 className="panel-title">توزيع العملاء على المناطق</h3>
      <p className="muted small">
        اختار المهندس لكل منطقة؛ العدد والأسماء المتعارضة بيتحسبوا تلقائيًا قبل النقل. تقدر تنقل اللي من غير مهندس بس أو كل العملاء.
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      {areas.length === 0 ? (
        <p className="empty">مفيش مناطق مسجلة لحد دلوقتي — ضيف محافظة ومركز لأي عميل وهيظهروا هنا.</p>
      ) : (
        <div className="kpi-table-wrap area-table">
          <table className="kpi-table">
            <thead>
              <tr><th>المنطقة</th><th>عملاء</th><th>من غير مهندس</th><th>عليه زيارات</th><th>مين شايلها</th><th>النقل</th></tr>
            </thead>
            <tbody>
              {areas.map(row => {
                const key = areaKey(row);
                return (
                  <tr key={key}>
                    <td>
                      <strong>{row.district}</strong>
                      <small className="muted">{row.governorate}</small>
                      {row.inactive ? <small className="muted">{formatNumber(row.inactive)} موقوف</small> : null}
                    </td>
                    <td className="mono">{formatNumber(row.total)}</td>
                    <td className="mono">{row.unassigned ? <span className="pill warn">{formatNumber(row.unassigned)}</span> : '—'}</td>
                    <td className="mono">{formatNumber(row.visited)}</td>
                    <td>
                      {row.owners.length === 0
                        ? <span className="muted">حد لسه</span>
                        : row.owners.map(owner => (
                          <span key={owner.repId} className="pill" style={{ opacity: owner.repActive ? 1 : 0.6 }}>
                            {owner.repName} · {formatNumber(owner.customers)}
                          </span>
                        ))}
                      {row.settled ? <em className="ok-text small"> · خلاص</em> : null}
                    </td>
                    <td><AreaTransfer row={row} engineers={engineers} onDone={onDone} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h4 className="panel-title" style={{ marginTop: 14 }}>مناطق المهندسين</h4>
      <p className="muted small">
        «منطقته» هي اللي بتحدد الاقتراح في الجدول فوق — اكتبها زي ما العميل بيكتبها (طنطا، المحلة…).
      </p>
      <ul className="rep-list">
        {engineers.length === 0 && <li className="empty">مفيش مهندسين لحد دلوقتي.</li>}
        {engineers.map(rep => (
          <li key={rep.id} className="team-row" style={{ opacity: rep.active ? 1 : 0.7 }}>
            <span className="dot" style={{ background: rep.color }} aria-hidden="true" />
            <span className="grow">
              <strong>{rep.name}</strong>
              <small>{rep.region ? `منطقته: ${rep.region}` : 'من غير منطقة — مفيش اقتراح هيتعمل له'}{rep.active ? '' : ' · الحساب متوقف'}</small>
            </span>
            {regionFor === rep.id ? (
              <span className="confirm-pair">
                <input value={regionValue} autoFocus maxLength={80} placeholder="طنطا" onChange={event => setRegionValue(event.target.value)} />
                <button className="btn primary sm" disabled={savingRegion} onClick={() => void saveRegion(rep.id)}>{savingRegion ? 'جارٍ الحفظ…' : 'احفظ'}</button>
                <button className="btn ghost sm" onClick={() => setRegionFor('')}>إلغاء</button>
              </span>
            ) : (
              <button className="btn ghost sm" onClick={() => { setRegionFor(rep.id); setRegionValue(rep.region || ''); }}>اربط المنطقة</button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
