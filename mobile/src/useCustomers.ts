import { useCallback, useEffect, useRef, useState } from 'react';
import { createCustomer, myCustomers, updateCustomer } from './api';
import type { Customer, CustomerInput } from './types';

/**
 * The engineer's own customer list, read from the server and never kept on the phone.
 *
 * It is deliberately not queued or cached: the list is the one thing two devices disagree about
 * (the same farm added from the office and from the road), and a stale copy in storage would turn
 * that into a duplicate customer — which is exactly what this table exists to prevent. A phone with
 * no signal sees the last list it loaded, and adding a customer says plainly that nothing was saved.
 */
export interface CustomersBundle {
  customers: Customer[];
  loading: boolean;
  error: string;
  /** The server has no customer list at all (an app pointed at an older build): say so once, quietly. */
  unsupported: boolean;
  refresh: () => Promise<void>;
  /** Resolves false when the server refused, with the reason in `error`. */
  add: (data: CustomerInput) => Promise<Customer | null>;
  setStage: (id: string, stage: Customer['stage'], lostReason?: string) => Promise<boolean>;
}

export function useCustomers(enabled = true): CustomersBundle {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState('');
  const [unsupported, setUnsupported] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await myCustomers();
      if (!mounted.current) return;
      const list = Array.isArray(res?.customers) ? res.customers : [];
      // The phone filters as you type, so the whole list is fetched once and kept in memory.
      setCustomers([...list].sort((a, b) => (b.lastVisitAt ?? 0) - (a.lastVisitAt ?? 0) || a.name.localeCompare(b.name, 'ar')));
      setError(''); setUnsupported(false);
    } catch (e) {
      if (!mounted.current) return;
      if ((e as { status?: number }).status === 404) setUnsupported(true);
      else setError((e as Error).message);
    } finally { if (mounted.current) setLoading(false); }
  }, []);

  useEffect(() => { if (enabled) void refresh(); }, [enabled, refresh]);

  const add = useCallback(async (data: CustomerInput) => {
    setError('');
    try {
      const res = await createCustomer(data);
      const customer = res?.customer;
      if (customer && mounted.current) setCustomers(list => [customer, ...list.filter(row => row.id !== customer.id)]);
      return customer ?? null;
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
      return null;
    }
  }, []);

  const setStage = useCallback(async (id: string, stage: Customer['stage'], lostReason?: string) => {
    setError('');
    try {
      const res = await updateCustomer(id, { stage, ...(lostReason ? { lostReason } : {}) });
      const customer = res?.customer;
      if (customer && mounted.current) setCustomers(list => list.map(row => (row.id === id ? customer : row)));
      return true;
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
      return false;
    }
  }, []);

  return { customers, loading, error, unsupported, refresh, add, setStage };
}
