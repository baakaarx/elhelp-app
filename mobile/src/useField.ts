import { useCallback, useEffect, useRef, useState } from 'react';
import { myRoute, mySummary, myVisits, shiftState, startShift, stopShift, checkInVisit, checkOutVisit } from './api';
import { enqueueVisitCheckIn, enqueueVisitCheckOut, flushOutbox, outboxOwnerStatus } from './reports';
import { hasBackgroundPermission, hasForegroundPermission, requestPermissions, startTracking, stopTracking } from './tracking';
import { captureOnce, locationIssueMessage } from './location';
import { getDeviceId, getDeviceName } from './device';
import { getActiveShift, setActiveShift } from './storage';
import type { RepSummary, RouteResponse, User, Visit, VisitInput } from './types';

export interface CheckOutInput {
  outcome: string;
  notes: string;
  amount: number | null;
  location: { lat: number; lng: number; accuracy: number | null } | null;
}

export interface FieldBundle {
  summary: RepSummary | null;
  visits: Visit[];
  route: RouteResponse | null;
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
  error: string;
  clearError: () => void;
  refresh: () => Promise<void>;
  beginShift: (options: { background: boolean }) => Promise<void>;
  resumeTracking: (options: { background: boolean }) => Promise<void>;
  finishShift: () => Promise<void>;
  checkIn: (input: VisitInput) => Promise<void>;
  checkOut: (id: string, input: CheckOutInput) => Promise<void>;
}

export function useField(user: User | null, onSessionExpired: () => void): FieldBundle {
  const [summary, setSummary] = useState<RepSummary | null>(null);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [route, setRoute] = useState<RouteResponse | null>(null);
  const [pending, setPending] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [trackingActive, setTrackingActive] = useState(false);
  const [error, setError] = useState('');
  const [syncNotice, setSyncNotice] = useState('');
  const [offlineNotice, setOfflineNotice] = useState('');
  const mounted = useRef(true);
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

  // The day's trail is large, so it follows a slower clock than the counters and visits.
  const refreshCount = useRef(0);
  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      refreshCount.current += 1;
      const withRoute = refreshCount.current % 4 === 1;
      const [state, nextSummary, nextVisits, nextRoute] = await Promise.all([
        shiftState(),
        mySummary(),
        myVisits(),
        withRoute ? myRoute(user.id).catch(() => null) : Promise.resolve(undefined),
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
      setSummary({ ...nextSummary, shift } as RepSummary);
      setVisits(nextVisits.visits);
      if (nextRoute !== undefined) setRoute(nextRoute);
    } catch (e) {
      const status = (e as { status?: number }).status ?? 0;
      if (status === 401) { onSessionExpired(); return; }
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [user, onSessionExpired]);

  useEffect(() => {
    if (!user) { setTrackingActive(false); setSummary(null); setVisits([]); setRoute(null); setError(''); return; }
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
      const shift = summary?.shift ?? (await shiftState()).shift;
      const shiftId = shift?.id ?? await getActiveShift();
      if (!shiftId) throw new Error('لا توجد وردية مفتوحة على هذا الجهاز. ابدأ وردية جديدة.');
      await startTracking(shiftId, { background: background && permission.background, startedAt: shift ? Number(shift.started_at) : undefined });
      setTrackingActive(true);
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
      await startTracking(shift.id, { background, startedAt: Number(shift.started_at) });
      if (!cancelled) setTrackingActive(true);
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
      // Starting a shift is a claim about the phone's current location; do not reuse cached GPS.
      const fix = await captureOnce({ maxAgeMs: 0 });
      if (!fix) throw new Error(locationIssueMessage() || 'GPS مطلوب — فعّل الموقع وانتظر حتى تثبت الإشارة قبل بدء الوردية.');
      const deviceId = await getDeviceId();
      const deviceName = await getDeviceName();
      const res = await startShift('1.0', fix, deviceId, deviceName);
      try {
        await startTracking(res.shift.id, { background: background && permission.background, startedAt: res.shift.started_at });
        setTrackingActive(true);
      } catch {
        await stopTracking().catch(() => undefined);
        setTrackingActive(false);
        // The server may already have opened the shift. Refresh its state rather than
        // pretending it didn't, and let the engineer retry from the consent sheet.
        await refresh();
        throw new Error('تم بدء الوردية، لكن تعذر تشغيل تتبع الموقع. تأكد من صلاحية الموقع ثم حاول مجددًا.');
      }
      await refresh();
    } catch (e) { setError((e as Error).message); throw e; }
    finally { setBusy(false); }
  }, [refresh, user?.id]);

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
    summary, visits, route, pending, loading, busy, trackingActive, syncNotice, offlineNotice, error,
    clearError: () => setError(''),
    refresh, beginShift, resumeTracking, finishShift, checkIn, checkOut,
  };
}
