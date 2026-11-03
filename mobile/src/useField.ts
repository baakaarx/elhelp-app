import { useCallback, useEffect, useRef, useState } from 'react';
import { myRoute, mySummary, myVisits, shiftState, startShift, stopShift, checkInVisit, checkOutVisit } from './api';
import { flushOutbox } from './reports';
import { requestPermissions, startTracking, stopTracking } from './tracking';
import { captureOnce } from './location';
import { getDeviceId, getDeviceName } from './device';
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
      if (!mounted.current) return;
      setSummary({ ...nextSummary, shift: state.shift });
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
        await startTracking(res.shift.id, { background: background && permission.background });
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
    refresh, beginShift, finishShift, checkIn, checkOut,
  };
}
