import { useCallback, useEffect, useRef, useState } from 'react';
import { myRoute, mySummary, myVisits, shiftState, startShift, stopShift, checkInVisit, checkOutVisit } from './api';
import { flushOutbox } from './reports';
import { hasBackgroundPermission, hasForegroundPermission, requestPermissions, startTracking, stopTracking } from './tracking';
import { captureOnce } from './location';
import { getDeviceId, getDeviceName } from './device';
import { getActiveShift, getShiftToken, setShiftToken } from './storage';
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
  const mounted = useRef(true);

  useEffect(() => () => { mounted.current = false; }, []);

  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      const [state, nextSummary, nextVisits, nextRoute] = await Promise.all([
        shiftState(),
        mySummary(),
        myVisits(),
        myRoute(user.id).catch(() => null),
      ]);
      // A single empty answer used to look like "the shift ended": on the hosted demo each
      // request can reach a different instance. Confirm before dropping the engineer out.
      let shift = state.shift;
      if (!shift && (await getShiftToken())) {
        await new Promise(resolve => setTimeout(resolve, 900));
        const retry = await shiftState().catch(() => null);
        if (retry?.shift) shift = retry.shift;
        else {
          await setShiftToken(null);
          await stopTracking().catch(() => undefined);
          setTrackingActive(false);
          setError('الوردية اتقفلت على الحساب من السيرفر. ابدأ وردية جديدة عشان تسجيل الموقع يرجع.');
        }
      }
      if (!mounted.current) return;
      setSummary({ ...nextSummary, shift } as RepSummary);
      setVisits(nextVisits.visits);
      setRoute(nextRoute);
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
    const timer = setInterval(async () => {
      const result = await flushOutbox().catch(() => null);
      if (result && mounted.current) setPending(result.pending);
      void refresh();
    }, 15000);
    void flushOutbox().then(result => { if (mounted.current) setPending(result.pending); }).catch(() => undefined);
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
  }, [refresh, summary]);

  // A closed app or a killed foreground service leaves the shift open but the watcher off.
  // When the app comes back and permission is still granted, re-attach without asking anything.
  useEffect(() => {
    const shift = summary?.shift;
    if (!shift || trackingActive || busy) return;
    let cancelled = false;
    (async () => {
      if (!(await hasForegroundPermission())) return;
      const background = await hasBackgroundPermission();
      if (cancelled) return;
      await startTracking(shift.id, { background, startedAt: Number(shift.started_at) });
      if (!cancelled) setTrackingActive(true);
    })().catch(() => undefined);
    return () => { cancelled = true; };
  }, [summary?.shift?.id, summary?.shift?.started_at, trackingActive, busy]);

  const beginShift = useCallback(async ({ background }: { background: boolean }) => {
    setBusy(true); setError('');
    try {
      const permission = await requestPermissions(background);
      if (!permission.foreground) throw new Error('لم يتم منح صلاحية الموقع. لا يمكن بدء التتبع بدونها.');
      const fix = await captureOnce({ maxAgeMs: 15000 });
      if (!fix) throw new Error('GPS مطلوب — فعّل الموقع وانتظر حتى تثبت الإشارة قبل بدء الوردية.');
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
  }, [refresh]);

  const finishShift = useCallback(async () => {
    setBusy(true); setError('');
    try {
      await stopShift();
      await stopTracking();
      setTrackingActive(false);
      await flushOutbox();
      await refresh();
    } catch (e) { setError((e as Error).message); throw e; }
    finally { setBusy(false); }
  }, [refresh]);

  const checkIn = useCallback(async (input: VisitInput) => {
    setBusy(true); setError('');
    try {
      await checkInVisit(input);
      await refresh();
    } catch (e) { setError((e as Error).message); throw e; }
    finally { setBusy(false); }
  }, [refresh]);

  const checkOut = useCallback(async (id: string, input: CheckOutInput) => {
    setBusy(true); setError('');
    try {
      await checkOutVisit(id, input);
      await refresh();
    } catch (e) { setError((e as Error).message); throw e; }
    finally { setBusy(false); }
  }, [refresh]);

  return {
    summary, visits, route, pending, loading, busy, trackingActive, error,
    clearError: () => setError(''),
    refresh, beginShift, resumeTracking, finishShift, checkIn, checkOut,
  };
}
