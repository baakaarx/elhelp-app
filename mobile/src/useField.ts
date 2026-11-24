import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { myCustomers, mySummary, myVisits, shiftState, startShift, stopShift, checkInVisit, checkOutVisit } from './api';
import { enqueueVisitCheckIn, enqueueVisitCheckOut, flushOutbox, outboxOwnerStatus } from './reports';
import { hasBackgroundPermission, hasForegroundPermission, isBackgroundTracking, requestPermissions, startTracking, stopTracking } from './tracking';
import { captureOnce, locationIssueMessage } from './location';
import { getDeviceId, getDeviceName } from './device';
import { getActiveShift, setActiveShift } from './storage';
import type { Customer, RepSummary, User, Visit, VisitInput } from './types';

export interface CheckOutInput {
  outcome: string;
  notes: string;
  amount: number | null;
  location: { lat: number; lng: number; accuracy: number | null } | null;
}

export interface FieldBundle {
  summary: RepSummary | null;
  visits: Visit[];
  pending: number;
  loading: boolean;
  busy: boolean;
  trackingActive: boolean;
  /** An actionable message from the sync loop (e.g. the phone clock is ahead of the server). */
  syncNotice: string;
  /**
   * A visit was kept on the phone because there was no signal. It is not an error — nothing was
   * lost — but the engineer must know the manager cannot see it yet.
   */
  offlineNotice: string;
  /**
   * Background tracking is not running while a shift is open, so locations stop the moment the
   * screen locks. Shown as a persistent warning — this used to fail silently and the manager
   * only found out from a stale signal.
   */
  backgroundNotice: string;
  /**
   * The engineer's own slice of the company's customer book, plus the note that explains when it is
   * not fresh.
   *
   * A visit is booked on one of these rows, so the sheet cannot simply refuse to open with no
   * network: an engineer who loaded his list at the office must still be able to record a visit in a
   * farm with two bars. The list is kept in memory from the last successful read for exactly that,
   * and `customersNotice` says it is a cached copy rather than pretending it is current. It is not
   * written to storage on purpose — a visit needs an open shift, and opening one needs the network,
   * so there is no offline session this cache would serve.
   */
  customers: Customer[];
  customersLoading: boolean;
  customersNotice: string;
  /** Called when the check-in sheet opens, and once when a shift starts (the moment we know there is signal). */
  loadCustomers: () => Promise<void>;
  error: string;
  clearError: () => void;
  refresh: () => Promise<void>;
  beginShift: (options: { background: boolean }) => Promise<void>;
  resumeTracking: (options: { background: boolean }) => Promise<void>;
  finishShift: () => Promise<void>;
  checkIn: (input: VisitInput) => Promise<void>;
  checkOut: (id: string, input: CheckOutInput) => Promise<void>;
}

/** Shown in the consent sheet when background tracking was asked for but cannot run. */
const BACKGROUND_PERMISSION_MESSAGE = 'لم يتم منح إذن الموقع في الخلفية. فعّل «السماح دائمًا» من إعدادات التطبيق عشان التتبع يشتغل والشاشة مقفولة — أو اقفل خيار «التسجيل في الخلفية» لو مش عايزه.';
const BACKGROUND_START_FAILED = 'تعذر تشغيل تتبع الخلفية. تأكد من إذن الموقع «السماح دائمًا» ومن إن البطارية «بدون قيود» ثم حاول مجددًا.';
/** Persistent warning while a shift is open without background tracking. */
const BACKGROUND_NOTICE = 'تتبع الخلفية مش شغال — الموقع هيقف لما الشاشة تتقفل. فعّل إذن الموقع «السماح دائمًا» من إعدادات التطبيق عشان التتبع يفضل شغال.';

export function useField(user: User | null, onSessionExpired: () => void): FieldBundle {
  const [summary, setSummary] = useState<RepSummary | null>(null);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [pending, setPending] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [trackingActive, setTrackingActive] = useState(false);
  const [error, setError] = useState('');
  const [syncNotice, setSyncNotice] = useState('');
  const [offlineNotice, setOfflineNotice] = useState('');
  const [backgroundNotice, setBackgroundNotice] = useState('');
  const trackingActiveRef = useRef(false);
  const mounted = useRef(true);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customersLoading, setCustomersLoading] = useState(false);
  const [customersNotice, setCustomersNotice] = useState('');
  /** Kept beside the state so a failed refresh can ask «is there anything to fall back to?» without re-creating the callback. */
  const customersRef = useRef<Customer[]>([]);
  /** Whose list is currently in memory: a second engineer on this phone must never see the first one's. */
  const listOwnerRef = useRef<string | null>(null);
  const writeCustomers = useCallback((next: Customer[]) => {
    customersRef.current = next;
    setCustomers(next);
  }, []);
  const pendingVisitNotice = (count: number) => count > 0
    ? `هناك ${count} زيارة محفوظة على الهاتف ولم تصل إلى السيرفر بعد.`
    : '';
  /**
   * True while one sync tick is still running.
   *
   * Four requests per refresh on a slow field connection can take longer than the 15-second
   * interval, so a second tick used to start on top of the first: two answers raced to set the
   * same state (an older summary could overwrite a newer one) and the phone kept twice the
   * requests going while the tower was weak. The timer now skips a tick instead of piling up.
   */
  const syncing = useRef(false);

  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => { trackingActiveRef.current = trackingActive; }, [trackingActive]);

  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      const [state, nextSummary, nextVisits] = await Promise.all([
        shiftState(),
        mySummary(),
        myVisits(),
      ]);
      // A single empty answer used to look like "the shift ended". If the phone believes a
      // shift is open, ask once more before dropping the engineer out mid-workday.
      let shift = state.shift;
      if (!shift && (await getActiveShift())) {
        await new Promise(resolve => setTimeout(resolve, 900));
        const retry = await shiftState().catch(() => null);
        if (retry?.shift) shift = retry.shift;
        else {
          await setActiveShift(null);
          await stopTracking().catch(() => undefined);
          setTrackingActive(false);
          setError('الوردية اتقفلت على الحساب من السيرفر. ابدأ وردية جديدة عشان تسجيل الموقع يرجع.');
        }
      }
      if (!mounted.current) return;
      setSummary({ ...(nextSummary ?? {}), shift } as RepSummary);
      setVisits(Array.isArray(nextVisits.visits) ? nextVisits.visits : []);
    } catch (e) {
      const status = (e as { status?: number }).status ?? 0;
      if (status === 401) { onSessionExpired(); return; }
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [user, onSessionExpired]);

  /**
   * The engineer's slice of the company's customer book — the list a visit is booked from.
   *
   * Asked for when the check-in sheet opens and when a shift starts, never on the 15-second tick: the
   * book changes when the office edits it, not while a man is driving, and a field connection should
   * not pay for it every quarter-minute.
   */
  const loadCustomers = useCallback(async () => {
    if (!user) { writeCustomers([]); setCustomersNotice(''); listOwnerRef.current = null; return; }
    if (listOwnerRef.current !== user.id) {
      listOwnerRef.current = user.id;
      writeCustomers([]);
      setCustomersNotice('');
    }
    setCustomersLoading(true);
    try {
      const res = await myCustomers();
      if (!mounted.current) return;
      writeCustomers(Array.isArray(res.customers) ? res.customers : []);
      setCustomersNotice('');
    } catch (e) {
      if (!mounted.current) return;
      const status = (e as { status?: number }).status ?? 0;
      if (status === 401) { onSessionExpired(); return; }
      // Answering an unreachable server with an empty list would tell the engineer he has no
      // customers, when the office gave him twenty. Keep the last good copy and say it is not fresh.
      setCustomersNotice(customersRef.current.length
        ? 'القايمة المعروضة من آخر اتصال — لو المكتب ضاف عميل أو نقل واحد، هتظهر أول ما الشبكة ترجع.'
        : `تعذر تحميل قايمعة العملاء. ${(e as Error).message || ''}`.trim());
    } finally {
      if (mounted.current) setCustomersLoading(false);
    }
  }, [onSessionExpired, user, writeCustomers]);

  useEffect(() => {
    if (!user) { setTrackingActive(false); setSummary(null); setVisits([]); setError(''); writeCustomers([]); listOwnerRef.current = null; return; }
    void refresh();
    const timer = setInterval(() => {
      if (syncing.current) return;
      syncing.current = true;
      void (async () => {
        const result = await flushOutbox(user.id).catch(() => null);
        if (result && mounted.current) {
          setPending(result.pending);
          // Cleared as soon as the server accepts the fixes again, so a fixed clock does not
          // leave a stale warning pinned to the screen all day.
          setSyncNotice(result.notice ?? '');
          setOfflineNotice(pendingVisitNotice(result.pendingVisits));
        }
        // If the OS killed the background service mid-shift, the engineer must know now —
        // not when the manager reports a stale signal.
        if (trackingActiveRef.current && Platform.OS !== 'web') {
          const running = await isBackgroundTracking();
          if (mounted.current) setBackgroundNotice(running ? '' : BACKGROUND_NOTICE);
        }
        await refresh();
      })().catch(() => undefined).finally(() => { syncing.current = false; });
    }, 15000);
    void flushOutbox(user.id).then(result => {
      if (mounted.current) {
        setPending(result.pending);
        setSyncNotice(result.notice ?? '');
        setOfflineNotice(pendingVisitNotice(result.pendingVisits));
      }
    }).catch(() => undefined);
    return () => clearInterval(timer);
  }, [user, refresh]);

  /**
   * Restart the position watcher for a shift that is already open.
   *
   * The old "resume" button went through the whole start-shift flow: it asked for consent
   * again, waited for a fresh GPS fix and could even open a second shift, so a phone indoors
   * simply could not resume. Now it only re-attaches to the existing shift.
   */
  const resumeTracking = useCallback(async ({ background }: { background: boolean }) => {
    setBusy(true); setError('');
    try {
      const outboxState = await outboxOwnerStatus(user?.id ?? null);
      if (outboxState.blockedByOwner) throw new Error(outboxState.notice || 'بيانات معلّقة لحساب آخر؛ لا يمكن بدء التتبع قبل حلها.');
      const permission = await requestPermissions(background);
      if (!permission.foreground) throw new Error('لم يتم منح صلاحية الموقع. لا يمكن تشغيل التتبع بدونها.');
      // Asked for background tracking but the phone said no: stop here with a clear reason
      // instead of running foreground-only and dying the moment the screen locks.
      if (background && !permission.background) throw new Error(BACKGROUND_PERMISSION_MESSAGE);
      const shift = summary?.shift ?? (await shiftState()).shift;
      const shiftId = shift?.id ?? await getActiveShift();
      if (!shiftId) throw new Error('لا توجد وردية مفتوحة على هذا الجهاز. ابدأ وردية جديدة.');
      const tracking = await startTracking(shiftId, { background: background && permission.background, startedAt: shift ? Number(shift.started_at) : undefined });
      if (background && !tracking.backgroundRunning) throw new Error(BACKGROUND_START_FAILED);
      setTrackingActive(true);
      setBackgroundNotice('');
      await refresh();
    } catch (e) { setError((e as Error).message); throw e; }
    finally { setBusy(false); }
  }, [refresh, summary, user?.id]);

  // A closed app or a killed foreground service leaves the shift open but the watcher off.
  // When the app comes back and permission is still granted, re-attach without asking anything.
  useEffect(() => {
    const shift = summary?.shift;
    if (!shift || trackingActive || busy) return;
    let cancelled = false;
    (async () => {
      const outboxState = await outboxOwnerStatus(user?.id ?? null);
      if (outboxState.blockedByOwner) {
        if (!cancelled) setError(outboxState.notice || 'بيانات معلّقة لحساب آخر؛ لا يمكن استئناف التتبع قبل حلها.');
        return;
      }
      if (!(await hasForegroundPermission())) return;
      const background = await hasBackgroundPermission();
      if (cancelled) return;
      const tracking = await startTracking(shift.id, { background, startedAt: Number(shift.started_at) });
      if (!cancelled) {
        setTrackingActive(true);
        // The shift is already open, so a missing background permission cannot block here —
        // warn persistently instead of going quiet until the screen locks.
        setBackgroundNotice(Platform.OS !== 'web' && !tracking.backgroundRunning ? BACKGROUND_NOTICE : '');
      }
    })().catch(() => undefined);
    return () => { cancelled = true; };
  }, [summary?.shift?.id, summary?.shift?.started_at, trackingActive, busy, user?.id]);

  const beginShift = useCallback(async ({ background }: { background: boolean }) => {
    setBusy(true); setError('');
    try {
      const outboxState = await outboxOwnerStatus(user?.id ?? null);
      if (outboxState.blockedByOwner) throw new Error(outboxState.notice || 'بيانات معلّقة لحساب آخر؛ لا يمكن بدء وردية جديدة قبل حلها.');
      const permission = await requestPermissions(background);
      if (!permission.foreground) throw new Error('لم يتم منح صلاحية الموقع. لا يمكن بدء التتبع بدونها.');
      // Asked for background tracking but the phone said no: stop here with a clear reason
      // instead of running foreground-only and dying the moment the screen locks.
      if (background && !permission.background) throw new Error(BACKGROUND_PERMISSION_MESSAGE);
      // Starting a shift is a claim about the phone's current location; do not reuse cached GPS.
      const fix = await captureOnce({ maxAgeMs: 0 });
      if (!fix) throw new Error(locationIssueMessage() || 'GPS مطلوب — فعّل الموقع وانتظر حتى تثبت الإشارة قبل بدء الوردية.');
      const deviceId = await getDeviceId();
      const deviceName = await getDeviceName();
      const res = await startShift('1.0', fix, deviceId, deviceName);
      try {
        const tracking = await startTracking(res.shift.id, { background: background && permission.background, startedAt: res.shift.started_at });
        if (background && !tracking.backgroundRunning) throw new Error(BACKGROUND_START_FAILED);
        setTrackingActive(true);
        setBackgroundNotice('');
      } catch (e) {
        await stopTracking().catch(() => undefined);
        setTrackingActive(false);
        // The server may already have opened the shift. Refresh its state rather than
        // pretending it didn't, and let the engineer retry from the consent sheet.
        await refresh();
        // Keep a specific background-tracking failure visible instead of replacing it with
        // the generic one.
        throw e instanceof Error && e.message === BACKGROUND_START_FAILED ? e : new Error('تم بدء الوردية، لكن تعذر تشغيل تتبع الموقع. تأكد من صلاحية الموقع ثم حاول مجددًا.');
      }
      await refresh();
      // The shift just proved this phone can reach the server, so this is the moment to take the
      // customer list with him into the field — the check-in sheet falls back to it when the bars die.
      void loadCustomers();
    } catch (e) { setError((e as Error).message); throw e; }
    finally { setBusy(false); }
  }, [loadCustomers, refresh, user?.id]);

  const finishShift = useCallback(async () => {
    // Ending the shift with a customer visit still open left the server to close it without a
    // result, and the visit's duration became "when the shift happened to stop". The engineer
    // records the result first — one button away in the visits tab.
    // The poll's copy is up to fifteen seconds old in both directions: it can show a visit that
    // is already closed (blocking the engineer for nothing) or miss one he has just opened, and
    // then the server closes it with no result. Ask the server every time, and refuse only on a
    // positive answer — a failed request must not trap him in the field.
    const fresh = await myVisits().catch(() => null);
    if (fresh?.visits.some(visit => visit.status === 'open')) {
      const message = 'فيه زيارة مفتوحة. سجّل نتيجتها من تبويب «الزيارات» الأول، وبعدها أنهِ الوردية.';
      setError(message);
      throw new Error(message);
    }
    setBusy(true); setError('');
    try {
      await stopShift();
      await stopTracking();
      setTrackingActive(false);
      setBackgroundNotice('');
      await flushOutbox(user?.id);
      await refresh();
    } catch (e) { setError((e as Error).message); throw e; }
    finally { setBusy(false); }
  }, [refresh, user?.id]);

  /**
   * The visit is the one record the whole product exists for, and a farm with no bars used to
   * make it impossible to record: the sheet answered "لا يوجد اتصال" and the visit was gone.
   * With no signal it is now kept on the phone, with the time it happened, and sent by the same
   * outbox that carries the positions.
   */
  const checkIn = useCallback(async (input: VisitInput) => {
    setBusy(true); setError('');
    try {
      try {
        await checkInVisit(input);
      } catch (e) {
        if ((e as { status?: number }).status !== 0) throw e;
        await enqueueVisitCheckIn({ ...input, recordedAt: Date.now() }, user?.id);
        setOfflineNotice('الزيارة اتحفظت على الموبايل — هتتبعت لوحدها أول ما الشبكة ترجع.');
        const result = await flushOutbox(user?.id).catch(() => null);
        if (result && mounted.current) {
          setPending(result.pending);
          setSyncNotice(result.notice ?? '');
          setOfflineNotice(pendingVisitNotice(result.pendingVisits));
        }
        return;
      }
      await refresh();
    } catch (e) { setError((e as Error).message); throw e; }
    finally { setBusy(false); }
  }, [refresh, user?.id]);

  const checkOut = useCallback(async (id: string, input: CheckOutInput) => {
    setBusy(true); setError('');
    try {
      try {
        await checkOutVisit(id, input);
      } catch (e) {
        if ((e as { status?: number }).status !== 0) throw e;
        await enqueueVisitCheckOut(id, { ...input, recordedAt: Date.now() }, user?.id);
        setOfflineNotice('نتيجة الزيارة اتحفظت على الموبايل — هتتبعت لوحدها أول ما الشبكة ترجع.');
        const result = await flushOutbox(user?.id).catch(() => null);
        if (result && mounted.current) {
          setPending(result.pending);
          setSyncNotice(result.notice ?? '');
          setOfflineNotice(pendingVisitNotice(result.pendingVisits));
        }
        return;
      }
      await refresh();
    } catch (e) { setError((e as Error).message); throw e; }
    finally { setBusy(false); }
  }, [refresh, user?.id]);

  return {
    summary, visits, pending, loading, busy, trackingActive, syncNotice, offlineNotice, backgroundNotice, error,
    customers, customersLoading, customersNotice, loadCustomers,
    clearError: () => setError(''),
    refresh, beginShift, resumeTracking, finishShift, checkIn, checkOut,
  };
}
