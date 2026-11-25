import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ApiError, api, del, patch, post } from './api';
import { ago, formatNumber } from './session';
import ConfirmAction from './ConfirmAction';
import { customerStageLabels } from './types';
import type { AreaBook, Customer, CustomerStage, PriceTier } from './types';

const POOL = '';
const EMPTY_FORM = {
  name: '', phone: '', governorate: '', district: '', village: '', notes: '',
  stage: 'new' as CustomerStage, lostReason: '', repId: POOL, priceTierId: POOL,
};
const STAGES = Object.keys(customerStageLabels) as CustomerStage[];
const messageOf = (error: unknown, fallback: string) => (error instanceof ApiError && error.message ? error.message : fallback);

export default function Customers(_props: { timezone?: string }) {
  const [book, setBook] = useState<AreaBook | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  // The price list's headings: which column of it each customer buys at. Read here, edited in the
  // الأصناف screen — the book only records the choice.
  const [tiers, setTiers] = useState<PriceTier[]>([]);
  const [filters, setFilters] = useState({ q: '', includeInactive: false });
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const requestNumber = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Customer | 'new' | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  // The row whose engineer picker is open, and the id being written to (so one spinner per action).
  const [busyRow, setBusyRow] = useState('');
  const [assigning, setAssigning] = useState<string | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (filters.q.trim()) params.set('q', filters.q.trim());
    if (filters.includeInactive) params.set('includeInactive', '1');
    params.set('limit', '100');
    params.set('offset', String(page * 100));
    return params.toString();
  }, [filters, page]);

  const load = useCallback(async () => {
    const request = ++requestNumber.current;
    setLoading(true);
    try {
      const [list, areas, kinds] = await Promise.all([
        api<{ customers: Customer[]; hasMore: boolean }>(`/api/customers?${query}`),
        api<AreaBook>('/api/customers/areas'),
        api<{ tiers: PriceTier[] }>('/api/price-tiers'),
      ]);
      if (request !== requestNumber.current) return;
      setCustomers(list.customers);
      setHasMore(list.hasMore);
      setBook(areas);
      setTiers(kinds.tiers);
      setError('');
    } catch (e) {
      if (request === requestNumber.current) setError(messageOf(e, 'تعذر تحميل قائمة العملاء.'));
    } finally {
      if (request === requestNumber.current) setLoading(false);
    }
  }, [query]);

  useEffect(() => { const timer = setTimeout(() => void load(), 200); return () => { clearTimeout(timer); requestNumber.current++; }; }, [load]);

  const engineers = book?.engineers ?? [];
  const nameOf = (id: string | null) => (id ? engineers.find(rep => rep.id === id)?.name ?? 'مهندس محذوف' : 'من غير مهندس');
  function openCreate() {
    setForm({ ...EMPTY_FORM });
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
      setAssigning(null);
      await load();
    } catch (e) {
      await load();
      setError(messageOf(e, 'تعذر ربط العميل بالمهندس.'));
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
      await load();
      setError(messageOf(e, 'تعذر حذف العميل.'));
    } finally {
      setBusyRow('');
    }
  }

  const totals = book?.totals ?? { customers: 0, unassigned: 0, areas: 0 };
  const set = (patch_: Partial<typeof filters>) => { setPage(0); setFilters(value => ({ ...value, ...patch_ })); };

  return (
    <section className="page">
      <header className="page-head">
        <h2>قائمة العملاء</h2>
        <button className="btn primary" onClick={openCreate}>عميل جديد</button>
      </header>
      <div className="panel filters">
        <label className="field inline"><span>بحث</span>
          <input value={filters.q} onChange={event => set({ q: event.target.value })} placeholder="اسم أو تليفون أو قرية" />
        </label>
        <label className="field inline"><span>إظهار الموقوفين</span>
          <input type="checkbox" checked={filters.includeInactive} onChange={event => set({ includeInactive: event.target.checked })} />
        </label>
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
          قائمة الشركة · {formatNumber(customers.length)}
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
                    <td>
                      <span>{customer.repId ? customer.repName || nameOf(customer.repId) : 'من غير مهندس'}</span>
                      <div>
                        {assigning === customer.id ? <>
                          <select className="rowpick" value={customer.repId ?? POOL} disabled={busyRow === customer.id}
                            onChange={event => void assign(customer, event.target.value || null)} aria-label={`اختار مهندس ${customer.name}`}>
                            <option value={POOL}>من غير مهندس</option>
                            {engineers.map(rep => <option key={rep.id} value={rep.id} disabled={!rep.active}>{rep.name}{rep.region ? ` — ${rep.region}` : ''}{rep.active ? '' : ' (موقوف)'}</option>)}
                          </select>
                          <button className="btn ghost sm" onClick={() => setAssigning(null)}>إلغاء</button>
                        </> : <button className="btn ghost sm" disabled={busyRow === customer.id} onClick={() => setAssigning(customer.id)}>{customer.repId ? 'تغيير المهندس' : 'إضافة مهندس'}</button>}
                      </div>
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
        {(page > 0 || hasMore) && <div className="filters">
          <button className="btn ghost sm" disabled={loading || page === 0} onClick={() => setPage(p => p - 1)}>السابق</button>
          <span>صفحة {formatNumber(page + 1)}</span>
          <button className="btn ghost sm" disabled={loading || !hasMore} onClick={() => setPage(p => p + 1)}>التالي</button>
        </div>}
      </div>
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
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}
