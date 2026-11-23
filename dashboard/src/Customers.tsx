import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, del, patch, post } from './api';
import { ago, formatNumber } from './session';
import ConfirmAction from './ConfirmAction';
import type { Customer, Rep } from './types';

/**
 * The customers screen — the manager's view of what each engineer is selling to.
 *
 * The engineer fills his own list from the phone; this page is where it is checked: who owns which
 * customer, how long it is since anyone stood in front of him, and what happens to the list when a
 * man leaves. It is deliberately read-mostly: a name typed here would fight the one typed in the
 * field, and the field always knows better.
 */
export const STAGE_LABELS: Record<Customer['stage'], string> = {
  new: 'عميل جديد',
  following: 'قيد المتابعة',
  active: 'عميل دائم',
  dormant: 'برّد — محتاج متابعة',
  lost: 'مرفوض',
};
const STAGES = Object.keys(STAGE_LABELS) as Customer['stage'][];

/** Days after which an unvisited customer is a cooling relationship, not a busy week. */
export const CUSTOMER_OVERDUE_DAYS = 45;
/** A brand-new customer nobody has visited yet gets the same clock, from the day he was added. */
export const CUSTOMER_NEW_OVERDUE_DAYS = 14;

export function daysSince(at: number | null, now = Date.now()): number | null {
  if (!at) return null;
  return Math.max(0, Math.floor((now - at) / 86400000));
}

/**
 * The sentence under a customer's name, and the only judgement this page makes.
 *
 * It never says «مهمَل»: the manager is not watching the engineer's minutes here, he is watching a
 * relationship going cold. A customer with no visit at all is called out from the day he was added,
 * because that is the case people forget about.
 */
export function customerWatch(customer: Customer, now = Date.now()): { level: 'ok' | 'warn'; text: string } {
  const sinceVisit = daysSince(customer.lastVisitAt, now);
  if (customer.stage === 'lost') return { level: 'ok', text: `مرفوض${customer.lostReason ? `: ${customer.lostReason}` : ''}` };
  if (sinceVisit === null) {
    const sinceAdded = daysSince(customer.createdAt, now) ?? 0;
    return sinceAdded > CUSTOMER_NEW_OVERDUE_DAYS
      ? { level: 'warn', text: `متسجّل من ${formatNumber(sinceAdded)} يوم ومفيش زيارة` }
      : { level: 'ok', text: 'لسه من غير زيارة' };
  }
  if (sinceVisit > CUSTOMER_OVERDUE_DAYS) {
    return { level: 'warn', text: `آخر زيارة من ${formatNumber(sinceVisit)} يوم — برّد` };
  }
  return { level: 'ok', text: `آخر زيارة ${ago(customer.lastVisitAt, now)}` };
}

const emptyForm = { name: '', phone: '', governorate: '', district: '', village: '', notes: '', lat: '', lng: '', stage: 'new' as Customer['stage'], lostReason: '' };
type Form = typeof emptyForm;

const toForm = (customer: Customer): Form => ({
  name: customer.name, phone: customer.phone || '', governorate: customer.governorate || '', district: customer.district || '',
  village: customer.village || '', notes: customer.notes || '', lat: customer.lat == null ? '' : String(customer.lat),
  lng: customer.lng == null ? '' : String(customer.lng), stage: customer.stage, lostReason: customer.lostReason || '',
});

export default function Customers() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [reps, setReps] = useState<Rep[]>([]);
  const [repFilter, setRepFilter] = useState('all');
  const [stageFilter, setStageFilter] = useState<'all' | Customer['stage']>('all');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<Form>(emptyForm);
  const [owner, setOwner] = useState('');
  const [saving, setSaving] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState('');
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [list, team] = await Promise.all([
        api<{ customers: Customer[] }>('/api/customers?includeInactive=1&limit=500'),
        api<{ reps: Rep[] }>('/api/reps'),
      ]);
      setCustomers(list.customers);
      setReps(team.reps);
      setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر تحميل قايمع العملاء.'); }
    finally { setLoaded(true); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const visible = useMemo(() => customers.filter(customer => (repFilter === 'all' || customer.repId === repFilter)
    && (stageFilter === 'all' || customer.stage === stageFilter)
    && (!query.trim() || `${customer.name} ${customer.phone} ${customer.village}`.toLowerCase().includes(query.trim().toLowerCase()))),
  [customers, repFilter, stageFilter, query]);
  const counts = useMemo(() => {
    const byStage: Record<string, number> = {};
    let cooling = 0;
    for (const customer of customers) {
      if (!customer.active) continue;
      byStage[customer.stage] = (byStage[customer.stage] || 0) + 1;
      if (customerWatch(customer).level === 'warn') cooling += 1;
    }
    return { byStage, cooling, total: customers.filter(c => c.active).length };
  }, [customers]);

  function openCreate() { setEditing(null); setCreating(true); setForm(emptyForm); setOwner(repFilter === 'all' ? '' : repFilter); setError(''); }
  function openEdit(customer: Customer) { setCreating(false); setEditing(customer.id); setForm(toForm(customer)); setOwner(customer.repId); setError(''); }
  function closeForm() { setCreating(false); setEditing(null); setForm(emptyForm); setOwner(''); }

  async function save() {
    setSaving(true); setError('');
    const body = {
      name: form.name.trim(), phone: form.phone.trim(), governorate: form.governorate.trim(), district: form.district.trim(),
      village: form.village.trim(), notes: form.notes.trim(), stage: form.stage, lostReason: form.lostReason.trim(),
      ...(form.lat.trim() && form.lng.trim() ? { lat: Number(form.lat), lng: Number(form.lng) } : {}),
    };
    try {
      if (editing) { const res = await patch<{ customer: Customer }>(`/api/customers/${editing}`, body); setCustomers(list => list.map(row => (row.id === editing ? res.customer : row))); }
      else { const res = await post<{ customer: Customer }>('/api/customers', { ...body, repId: owner }); setCustomers(list => [res.customer, ...list]); }
      closeForm();
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر الحفظ.'); }
    finally { setSaving(false); }
  }

  async function setActive(customer: Customer, active: boolean) {
    try {
      const res = await patch<{ customer: Customer }>(`/api/customers/${customer.id}`, { active });
      setCustomers(list => list.map(row => (row.id === customer.id ? res.customer : row)));
      setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر تحديث حالة العميل.'); }
  }

  async function assign(customer: Customer, repId: string) {
    try {
      const res = await post<{ customer: Customer }>(`/api/customers/${customer.id}/assign`, { repId });
      setCustomers(list => list.map(row => (row.id === customer.id ? res.customer : row)));
      setMoving(null); setMoveTarget(''); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر نقل العميل.'); }
  }

  async function remove(customer: Customer) {
    try { await del(`/api/customers/${customer.id}`); setCustomers(list => list.filter(row => row.id !== customer.id)); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر حذف العميل.'); }
  }

  const ownerName = (customer: Customer) => customer.repName || 'بدون مهندس';

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h2>العملاء</h2>
          <p className="muted">قايمع كل مهندس — اللي بيتسجّل من التطبيق، واللي يتنقل بين المهندسين لماحد يسافر أو يتوقف.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {counts.cooling > 0 && <span className="pill warn">{formatNumber(counts.cooling)} عميل برّد</span>}
          <button className="btn primary" onClick={openCreate}>عميل جديد</button>
        </div>
      </header>

      <div className="filters">
        <label className="field inline">
          <span>المهندس</span>
          <select value={repFilter} onChange={event => setRepFilter(event.target.value)}>
            <option value="all">كل الفريق ({formatNumber(counts.total)})</option>
            {reps.map(rep => <option key={rep.id} value={rep.id}>{rep.name}</option>)}
          </select>
        </label>
        <label className="field inline">
          <span>المرحلة</span>
          <select value={stageFilter} onChange={event => setStageFilter(event.target.value as typeof stageFilter)}>
            <option value="all">الكل</option>
            {STAGES.map(stage => <option key={stage} value={stage}>{STAGE_LABELS[stage]} ({formatNumber(counts.byStage[stage] || 0)})</option>)}
          </select>
        </label>
        <label className="field inline">
          <span>دوّر</span>
          <input value={query} placeholder="اسم، تليفون، أو قرية" onChange={event => setQuery(event.target.value)} />
        </label>
        <button className="btn ghost sm" onClick={() => void refresh()}>تحديث</button>
        {error && <p className="error" role="alert">{error}</p>}
      </div>

      {(creating || editing) && (
        <div className="panel">
          <h3 className="panel-title">{editing ? 'تعديل عميل' : 'عميل جديد'}</h3>
          <p className="muted small">
            {editing ? 'التغيير هنا على الاسم والعنوان بيسري على اللي يتسجل من هنا؛ الزيارات اللي فاتت بتفضل زي ما المهندس كتبها.'
              : 'الأفضل إن المهندس يضيف عميله من التليفون وهو في المكان — الإضافة من هنا للحالات اللي مفيهاش مهندس متخصّص.'}
          </p>
          <div className="two-col">
            <label className="field">
              <span>اسم العميل / المزرعة</span>
              <input required value={form.name} onChange={event => setForm(f => ({ ...f, name: event.target.value }))} />
            </label>
            <label className="field">
              <span>المهندس</span>
              <select value={owner} disabled={!!editing} onChange={event => setOwner(event.target.value)}>
                <option value="">اختار المهندس…</option>
                {reps.map(rep => <option key={rep.id} value={rep.id}>{rep.name}</option>)}
              </select>
              {editing ? <small className="muted">للنقل لحد تاني استخدم زر «نقل»</small> : null}
            </label>
            <label className="field"><span>التليفون</span><input dir="ltr" value={form.phone} onChange={event => setForm(f => ({ ...f, phone: event.target.value }))} /></label>
            <label className="field"><span>المحافظة</span><input value={form.governorate} onChange={event => setForm(f => ({ ...f, governorate: event.target.value }))} /></label>
            <label className="field"><span>المركز</span><input value={form.district} onChange={event => setForm(f => ({ ...f, district: event.target.value }))} /></label>
            <label className="field"><span>القرية</span><input value={form.village} onChange={event => setForm(f => ({ ...f, village: event.target.value }))} /></label>
            <label className="field"><span>خط العرض <small className="muted">(اختياري)</small></span><input dir="ltr" value={form.lat} onChange={event => setForm(f => ({ ...f, lat: event.target.value }))} /></label>
            <label className="field"><span>خط الطول <small className="muted">(اختياري)</small></span><input dir="ltr" value={form.lng} onChange={event => setForm(f => ({ ...f, lng: event.target.value }))} /></label>
            <label className="field">
              <span>المرحلة</span>
              <select value={form.stage} onChange={event => setForm(f => ({ ...f, stage: event.target.value as Customer['stage'] }))}>
                {STAGES.map(stage => <option key={stage} value={stage}>{STAGE_LABELS[stage]}</option>)}
              </select>
            </label>
            {form.stage === 'lost' && (
              <label className="field"><span>سبب الرفض</span><input required value={form.lostReason} onChange={event => setForm(f => ({ ...f, lostReason: event.target.value }))} /></label>
            )}
            <label className="field"><span>ملاحظات</span><input value={form.notes} onChange={event => setForm(f => ({ ...f, notes: event.target.value }))} /></label>
          </div>
          <div className="filters">
            <button className="btn primary" disabled={saving || !form.name.trim() || (!editing && !owner)} onClick={() => void save()}>{saving ? 'جارٍ الحفظ…' : 'حفظ'}</button>
            <button className="btn ghost sm" disabled={saving} onClick={closeForm}>إلغاء</button>
          </div>
        </div>
      )}

      {!loaded ? <p className="muted">جارٍ التحميل…</p> : visible.length === 0 ? (
        <p className="empty">{customers.length ? 'مفيش عملاء بالفلاتر دي.' : 'لسه مافيش عملاء مسجلين — أول ما مهندس يضيف عميل من التطبيق هيظهر هنا.'}</p>
      ) : (
        <ul className="stack-list">
          {visible.map(customer => {
            const watch = customerWatch(customer);
            return (
              <li key={customer.id} className="card report" style={customer.active ? undefined : { opacity: 0.6 }}>
                <div className="report-head">
                  <span className="dot" style={{ background: customer.repColor || '#94a3b8' }} aria-hidden="true" />
                  <div className="grow">
                    <h3>{customer.name} {!customer.active && <span className="muted small">· متوقف</span>}</h3>
                    <p className="muted small">
                      {ownerName(customer)}
                      {[customer.governorate, customer.district, customer.village].filter(Boolean).join(' · ') ? ` · ${[customer.governorate, customer.district, customer.village].filter(Boolean).join(' · ')}` : ''}
                      {customer.phone ? ` · ${customer.phone}` : ''} · {STAGE_LABELS[customer.stage]}
                      {' · '}{formatNumber(customer.visitCount)} زيارة
                    </p>
                    <p className={watch.level === 'warn' ? 'visit-marks' : 'muted small'}>{watch.text}</p>
                    {customer.notes ? <p className="muted small">ملاحظة: {customer.notes}</p> : null}
                  </div>
                  <span className={customer.openVisits ? 'pill warn' : 'pill ok'}>
                    {customer.openVisits ? `${formatNumber(customer.openVisits)} زيارة مفتوحة` : 'مفيش زيارة مفتوحة'}
                  </span>
                </div>
                <div className="report-actions">
                  <button className="btn ghost sm" onClick={() => openEdit(customer)}>تعديل</button>
                  <button className="btn ghost sm" onClick={() => { setMoving(moving === customer.id ? null : customer.id); setMoveTarget(''); }}>
                    {moving === customer.id ? 'إلغاء النقل' : 'نقل لمهندس تاني'}
                  </button>
                  {moving === customer.id && (
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      <select value={moveTarget} onChange={event => setMoveTarget(event.target.value)}>
                        <option value="">اختار المهندس…</option>
                        {reps.filter(rep => rep.id !== customer.repId).map(rep => <option key={rep.id} value={rep.id}>{rep.name}</option>)}
                      </select>
                      <button className="btn primary sm" disabled={!moveTarget} onClick={() => void assign(customer, moveTarget)}>انقل</button>
                    </span>
                  )}
                  <button className="btn ghost sm" onClick={() => void setActive(customer, !customer.active)}>{customer.active ? 'إيقاف' : 'تفعيل'}</button>
                  <ConfirmAction label="حذف" confirmLabel="تأكيد الحذف" busyLabel="جارٍ الحذف…"
                    detail={customer.visitCount ? `عندك ${formatNumber(customer.visitCount)} زيارة مسجلة عليه — الحذف مرفوض، وقّفه أحسن.` : 'هيُحذف العميل من غير ما يكون عليه أي زيارة.'}
                    onConfirm={() => remove(customer)} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
