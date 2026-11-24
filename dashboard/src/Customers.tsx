import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { api, del, patch, post } from './api';
import { ago, formatNumber } from './session';
import ConfirmAction from './ConfirmAction';
import type { AreaEngineer, AreaMove, Customer, CustomerArea, Rep } from './types';

/**
 * The customers screen — the company's customer book, and who is being given which part of it.
 *
 * The list is entered here, in the office, with the place each customer lives; the engineer is
 * attached afterwards, area by area («كل عملاء طنطا لمهندس طنطا»). That order is the whole design: a
 * name typed in the office before anybody decided who drives that district is a real customer, not a
 * half-row waiting for an owner. So this page is a review screen, not a form fighting the field —
 * and the one write it makes in bulk (handing a whole area over) has to be previewed first, because a
 * press that moves 40 customers has to be a decision and not a reflex.
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
 * The sentence under a customer's name, and the only judgement this page makes about a person.
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

/**
 * Whether one area still needs handing out.
 *
 * «Settled» is not a compliment about the manager's work: it is the switch that hides a row from a
 * list that would otherwise be 20 districts of nothing to do. An area with customers nobody owns, or
 * split between two engineers, is always shown.
 */
export function areaNeedsWork(area: CustomerArea): boolean {
  return area.unassigned > 0 || !area.settled;
}

/** The two halves of an area, as the server groups them. */
export const areaKey = (area: { bareGovernorate: string; bareDistrict: string }) => `${area.bareGovernorate}\u0000${area.bareDistrict}`;

const emptyForm = { name: '', phone: '', governorate: '', district: '', village: '', notes: '', lat: '', lng: '', stage: 'new' as Customer['stage'], lostReason: '' };
type Form = typeof emptyForm;

const toForm = (customer: Customer): Form => ({
  name: customer.name, phone: customer.phone || '', governorate: customer.governorate || '', district: customer.district || '',
  village: customer.village || '', notes: customer.notes || '', lat: customer.lat == null ? '' : String(customer.lat),
  lng: customer.lng == null ? '' : String(customer.lng), stage: customer.stage, lostReason: customer.lostReason || '',
});

/** The draft of one area move: which engineer, how far, and what the server said it would do. */
interface AreaPanel {
  area: CustomerArea;
  /** '' is the company list itself — taking an area back is a move like any other. */
  repId: string;
  onlyUnassigned: boolean;
  preview: AreaMove | null;
}

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
  const [areas, setAreas] = useState<CustomerArea[]>([]);
  const [areaEngineers, setAreaEngineers] = useState<AreaEngineer[]>([]);
  const [areaTotals, setAreaTotals] = useState<{ customers: number; unassigned: number; areas: number } | null>(null);
  const [panel, setPanel] = useState<AreaPanel | null>(null);
  const [areaBusy, setAreaBusy] = useState(false);
  const [areaError, setAreaError] = useState('');
  const [areaDone, setAreaDone] = useState('');
  const [hideSettled, setHideSettled] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [list, team, areaData] = await Promise.all([
        api<{ customers: Customer[] }>('/api/customers?includeInactive=1&limit=500'),
        api<{ reps: Rep[] }>('/api/reps'),
        api<{ areas: CustomerArea[]; engineers: AreaEngineer[]; totals: { customers: number; unassigned: number; areas: number } }>('/api/customers/areas'),
      ]);
      setCustomers(list.customers);
      setReps(team.reps);
      setAreas(areaData.areas);
      setAreaEngineers(areaData.engineers);
      setAreaTotals(areaData.totals);
      setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر تحميل قايمع العملاء.'); }
    finally { setLoaded(true); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const visible = useMemo(() => customers.filter(customer => (repFilter === 'all' || (repFilter === 'pool' ? customer.repId === null : customer.repId === repFilter))
    && (stageFilter === 'all' || customer.stage === stageFilter)
    && (!query.trim() || `${customer.name} ${customer.phone} ${customer.village} ${customer.district}`.toLowerCase().includes(query.trim().toLowerCase()))),
  [customers, repFilter, stageFilter, query]);
  const counts = useMemo(() => {
    const byStage: Record<string, number> = {};
    let cooling = 0;
    let unassigned = 0;
    for (const customer of customers) {
      if (!customer.active) continue;
      byStage[customer.stage] = (byStage[customer.stage] || 0) + 1;
      if (customer.repId === null) unassigned += 1;
      if (customerWatch(customer).level === 'warn') cooling += 1;
    }
    return { byStage, cooling, unassigned, total: customers.filter(c => c.active).length };
  }, [customers]);
  const shownAreas = useMemo(() => areas.filter(area => !hideSettled || areaNeedsWork(area)), [areas, hideSettled]);
  const engineerName = (repId: string) => areaEngineers.find(item => item.id === repId)?.name
    || reps.find(item => item.id === repId)?.name || 'قايمعة الشركة';

  function openCreate() { setEditing(null); setCreating(true); setForm(emptyForm); setOwner(repFilter === 'all' || repFilter === 'pool' ? '' : repFilter); setError(''); }
  function openEdit(customer: Customer) { setCreating(false); setEditing(customer.id); setForm(toForm(customer)); setOwner(customer.repId ?? ''); setError(''); }
  function closeForm() { setCreating(false); setEditing(null); setForm(emptyForm); setOwner(''); }

  async function save() {
    setSaving(true); setError('');
    const body = {
      name: form.name.trim(), phone: form.phone.trim(), governorate: form.governorate.trim(), district: form.district.trim(),
      village: form.village.trim(), notes: form.notes.trim(), stage: form.stage, lostReason: form.lostReason.trim(),
      ...(form.lat.trim() && form.lng.trim() ? { lat: Number(form.lat), lng: Number(form.lng) } : {}),
    };
    try {
      // null is a real answer here and not a missing one: it means «the company's customer, not handed
      // to anybody yet», which is what the area workbench below works through.
      if (editing) { const res = await patch<{ customer: Customer }>(`/api/customers/${editing}`, body); setCustomers(list => list.map(row => (row.id === editing ? res.customer : row))); }
      else { const res = await post<{ customer: Customer }>('/api/customers', { ...body, repId: owner || null }); setCustomers(list => [res.customer, ...list]); }
      closeForm();
      void refresh();
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

  async function assign(customer: Customer, repId: string | null) {
    try {
      const res = await post<{ customer: Customer }>(`/api/customers/${customer.id}/assign`, { repId });
      setCustomers(list => list.map(row => (row.id === customer.id ? res.customer : row)));
      setMoving(null); setMoveTarget(''); setError('');
      void refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر نقل العميل.'); }
  }

  async function remove(customer: Customer) {
    try { await del(`/api/customers/${customer.id}`); setCustomers(list => list.filter(row => row.id !== customer.id)); setError(''); void refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر حذف العميل.'); }
  }

  function openArea(area: CustomerArea) {
    setAreaError(''); setAreaDone('');
    setPanel(current => (current && areaKey(current.area) === areaKey(area) ? null : { area, repId: area.suggestedRepId || '', onlyUnassigned: true, preview: null }));
  }

  /**
   * Ask the server what the press would do, then — if the manager says so — do it.
   *
   * The preview is not decoration: `dryRun` is where a name the engineer already has shows up, and
   * the rows it blocks are named in the answer instead of being silently skipped after the write.
   */
  async function runAreaMove(dryRun: boolean) {
    if (!panel) return;
    setAreaBusy(true); setAreaError('');
    try {
      const res = await post<AreaMove>('/api/customers/assign-area', {
        governorate: panel.area.bareGovernorate, district: panel.area.bareDistrict,
        repId: panel.repId || null, onlyUnassigned: panel.onlyUnassigned, dryRun,
      });
      if (dryRun) { setPanel(current => (current ? { ...current, preview: res } : current)); }
      else {
        setPanel(null);
        setAreaDone(res.moved
          ? `اتنقل ${formatNumber(res.moved)} عميل لـ«${engineerName(panel.repId)}»${res.skipped ? `، و${formatNumber(res.skipped)} وقفوا بسبب تعارض الاسم` : ''}.`
          : 'مفيش حاجة اتغيرت.');
        await refresh();
      }
    } catch (e) { setAreaError(e instanceof Error ? e.message : 'تعذر تنفيذ النقل.'); }
    finally { setAreaBusy(false); }
  }

  const ownerName = (customer: Customer) => customer.repName || 'من غير مهندس';

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h2>العملاء</h2>
          <p className="muted">قايمعة الشركة كلها: اللي يتسجّل من التطبيق، واللي يتدخل من هنا. كل عميل بمكانه، والمهندس يتربط بيه من المنطقة.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {counts.unassigned > 0 && <span className="pill warn">{formatNumber(counts.unassigned)} من غير مهندس</span>}
          {counts.cooling > 0 && <span className="pill warn">{formatNumber(counts.cooling)} عميل برّد</span>}
          <button className="btn primary" onClick={openCreate}>عميل جديد</button>
        </div>
      </header>

      {areas.length > 0 && (
        <div className="panel">
          <h3 className="panel-title">توزيع العملاء على المناطق</h3>
          <p className="muted small">
            {areaTotals && areaTotals.unassigned
              ? <>في {formatNumber(areaTotals.unassigned)} عميل من {formatNumber(areaTotals.customers)} لسه مربوطش بمهندس. اختار المنطقة، شوف هينقل مين، وبعدين أكّد — مفيش عميل بيتنقل لوحده.</>
              : <>كل العملاء مربوطة بمهندسين. من هنا كمان تنقل منطقة لمهندس تاني، أو ترجّعها قايمعة الشركة لو حد سافر أو اتوقف.</>}
          </p>
          <div className="kpi-table-wrap">
            <table className="area-table">
              <thead>
                <tr>
                  <th>المنطقة</th><th>العملاء</th><th>من غير مهندس</th><th>عليه زيارة</th>
                  <th>المهندس اللي شايلها</th><th>مقترح من المنطقة</th><th></th>
                </tr>
              </thead>
              <tbody>
                {shownAreas.map(area => {
                  const key = areaKey(area);
                  const open = panel && areaKey(panel.area) === key;
                  const holders = area.owners.map(owner => `${owner.repName}${owner.repActive ? '' : ' (متوقف)'} · ${formatNumber(owner.customers)}`).join('، ');
                  return (
                    <Fragment key={key}>
                      <tr>
                        <td>
                          <strong>{area.district}</strong>
                          {area.governorate && area.governorate !== 'من غير محافظة' ? <span className="muted small"> · {area.governorate}</span> : null}
                        </td>
                        <td>{formatNumber(area.total)}</td>
                        <td>{area.unassigned ? <span className="pill warn">{formatNumber(area.unassigned)}</span> : <span className="muted">—</span>}</td>
                        <td>{formatNumber(area.visited)}</td>
                        <td>{holders || <span className="muted">لسه محدش شايلها</span>}</td>
                        <td>
                          {area.suggestedRepName
                            ? <span title="مطابقة نصّية بين منطقة المهندس والمحافظة/المركز — مش قرار آلي">{area.suggestedRepName}</span>
                            : <span className="muted">مفيش مهندس مسجّل عنده المنطقة دي</span>}
                        </td>
                        <td>
                          <button className="btn ghost sm" onClick={() => openArea(area)}>{open ? 'إلغاء' : 'اربط المنطقة'}</button>
                        </td>
                      </tr>
                      {open && panel && (
                        <tr>
                          <td colSpan={7}>
                            <div className="area-move">
                              <label className="field inline">
                                <span>يتم ربطهم بـ</span>
                                <select value={panel.repId} onChange={event => setPanel({ ...panel, repId: event.target.value, preview: null })}>
                                  <option value="">قايمعة الشركة (من غير مهندس)</option>
                                  {areaEngineers.map(engineer => (
                                    <option key={engineer.id} value={engineer.id}>
                                      {engineer.name}{engineer.region ? ` — ${engineer.region}` : ''}{engineer.active ? '' : ' (متوقف)'}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label className="field inline checkbox">
                                <span>
                                  <input type="checkbox" checked={panel.onlyUnassigned}
                                    onChange={event => setPanel({ ...panel, onlyUnassigned: event.target.checked, preview: null })} />
                                  {' '}اللي من غير مهندس بس
                                </span>
                                <small className="muted">لو قفلته، عملاء المهندسين التانيين في المنطقة دي هينتقلوا هم كمان.</small>
                              </label>
                              <div className="filters">
                                <button className="btn ghost sm" disabled={areaBusy} onClick={() => void runAreaMove(true)}>معاينة الأول</button>
                                <button className="btn primary sm" disabled={areaBusy || !panel.preview || !panel.preview.wouldMove}
                                  onClick={() => void runAreaMove(false)}>
                                  {areaBusy ? 'جارٍ التنفيذ…' : 'تأكيد النقل'}
                                </button>
                              </div>
                              {panel.preview && (
                                <p className="muted small">
                                  {panel.repId
                                    ? `هينقل ${formatNumber(panel.preview.wouldMove || 0)} عميل لـ«${engineerName(panel.repId)}»`
                                    : `هيرجع ${formatNumber(panel.preview.wouldMove || 0)} عميل قايمعة الشركة`}
                                  {panel.preview.conflicts.length ? ` · ${formatNumber(panel.preview.conflicts.length)} متخطّي بسبب تعارض اسم: ${panel.preview.conflicts.map(row => `«${row.name}»`).join('، ')}` : ''}
                                  {panel.preview.capped ? ' · القايمعة هنا أطول من ١٠٠٠ عميل — اللي ظهر في المعاينة بس هو اللي بيتنقل.' : ''}
                                </p>
                              )}
                              {!panel.preview && <p className="muted small">مفيش معاينة بعد — دوس «معاينة الأول» عشان تشوف الأسماء اللي هينتقل قبل ما يتنفّذ.</p>}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="filters">
            <label className="field inline checkbox">
              <span>
                <input type="checkbox" checked={hideSettled} onChange={event => setHideSettled(event.target.checked)} />
                {' '}إخفاء المناطق اللي خلاصت
              </span>
              <small className="muted">{formatNumber(areas.length - shownAreas.length)} منطقة مخفية من {formatNumber(areas.length)}.</small>
            </label>
          </div>
          {areaError && <p className="error" role="alert">{areaError}</p>}
          {areaDone && <p className="muted small">{areaDone}</p>}
        </div>
      )}

      <div className="filters">
        <label className="field inline">
          <span>المهندس</span>
          <select value={repFilter} onChange={event => setRepFilter(event.target.value)}>
            <option value="all">كل الفريق ({formatNumber(counts.total)})</option>
            <option value="pool">من غير مهندس ({formatNumber(counts.unassigned)})</option>
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
          <input value={query} placeholder="اسم، تليفون، قرية أو مركز" onChange={event => setQuery(event.target.value)} />
        </label>
        <button className="btn ghost sm" onClick={() => void refresh()}>تحديث</button>
        {error && <p className="error" role="alert">{error}</p>}
      </div>

      {(creating || editing) && (
        <div className="panel">
          <h3 className="panel-title">{editing ? 'تعديل عميل' : 'عميل جديد'}</h3>
          <p className="muted small">
            {editing ? 'التغيير هنا على الاسم والعنوان بيسري على اللي يتسجل من هنا؛ الزيارات اللي فاتت بتفضل زي ما المهندس كتبها.'
              : 'اكتب العميل بمكانه (المحافظة والمركز) — دول اللي بيحددوا مين مهندس يربط بيه. تقدر تسيب «المهندس» من غير اختيار، فيفضل في قايمعة الشركة لحد ما تتوزع المنطقة.'}
          </p>
          <div className="two-col">
            <label className="field">
              <span>اسم العميل / المزرعة</span>
              <input required value={form.name} onChange={event => setForm(f => ({ ...f, name: event.target.value }))} />
            </label>
            <label className="field">
              <span>المهندس</span>
              <select value={owner} disabled={!!editing} onChange={event => setOwner(event.target.value)}>
                <option value="">من غير مهندس — يفضل في قايمعة الشركة</option>
                {reps.map(rep => <option key={rep.id} value={rep.id}>{rep.name}{rep.region ? ` — ${rep.region}` : ''}</option>)}
              </select>
              {editing ? <small className="muted">للنقل لحد تاني استخدم زر «نقل»</small> : <small className="muted">الاختيار من هنا اختياري: التوزيع بالمناطق يتعمل من فوق.</small>}
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
            <button className="btn primary" disabled={saving || !form.name.trim()} onClick={() => void save()}>{saving ? 'جارٍ الحفظ…' : 'حفظ'}</button>
            <button className="btn ghost sm" disabled={saving} onClick={closeForm}>إلغاء</button>
          </div>
        </div>
      )}

      {!loaded ? <p className="muted">جارٍ التحميل…</p> : visible.length === 0 ? (
        <p className="empty">{customers.length ? 'مفيش عملاء بالفلاتر دي.' : 'لسه مافيش عملاء — ضيف أول عميل من هنا، أو أول ما مهندس يسجّله من التطبيق هيظهر هنا.'}</p>
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
                  <button className="btn ghost sm" onClick={() => { setMoving(moving === customer.id ? null : customer.id); setMoveTarget(''); setError(''); }}>
                    {moving === customer.id ? 'إلغاء النقل' : customer.repId === null ? 'اربطه بمهندس' : 'نقل لمهندس تاني'}
                  </button>
                  {moving === customer.id && (
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      <select value={moveTarget} onChange={event => setMoveTarget(event.target.value)}>
                        <option value="">{customer.repId === null ? 'من غير مهندس…' : 'من غير مهندس — يرجع قايمعة الشركة'}</option>
                        {reps.filter(rep => rep.id !== customer.repId).map(rep => <option key={rep.id} value={rep.id}>{rep.name}{rep.region ? ` — ${rep.region}` : ''}</option>)}
                      </select>
                      <button className="btn primary sm" disabled={customer.repId !== null && !moveTarget} onClick={() => void assign(customer, moveTarget || null)}>
                        انقل
                      </button>
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
