import { useCallback, useEffect, useState } from 'react';
import { ApiError, createMyInvoice, myCatalogue, myInvoices, myTargets, payMyInvoice, voidMyInvoice } from './api';
import { enqueueInvoice, flushOutbox } from './reports';
import type { CatalogueProduct, InvoiceInput, MyInvoice, MyTarget } from './types';

/**
 * The engineer's own sales and the catalogue, both read from the server on entry.
 *
 * Nothing here is queued or written back. The invoices are the office's record of what was billed in
 * this engineer's name — the phone is a window onto it, so a sale the office voided must disappear
 * from the phone rather than sit in storage as a number the engineer keeps quoting. The catalogue is
 * the same argument about stock: a quantity the shelf no longer holds is worse than no quantity,
 * because it turns into a promise the truck cannot deliver.
 *
 * A phone with no signal keeps the last list it loaded and is told so by the caller.
 */
export interface SalesBundle {
  invoices: MyInvoice[];
  products: CatalogueProduct[];
  /** Everything still unpaid across the window the server returned. */
  outstanding: number;
  loading: boolean;
  error: string;
  /** The server has no sales endpoints (an older build): hide the tab instead of showing an error. */
  unsupported: boolean;
  refresh: () => Promise<void>;
  /** Sales typed with no signal, waiting on the phone. */
  pendingInvoices: number;
  /** 'sent' landed on the server; 'queued' is on the phone and will go by itself. */
  submit: (invoice: InvoiceInput, ownerId?: string) => Promise<'sent' | 'queued'>;
  cancel: (id: string, reason: string) => Promise<boolean>;
  /** Cash taken at the door. Resolves with an error string when the server refuses, null when it took it. */
  pay: (id: string, amount: number, note: string) => Promise<string | null>;
  /** His month against the plan the manager set. Null when no target exists — that is not an error. */
  target: MyTarget | null;
}

/** `customerId` narrows the money pane to one farm — the question asked from the customer sheet. */
export function useSales(options: { enabled?: boolean; customerId?: string } = {}): SalesBundle {
  const enabled = options.enabled !== false;
  const customerId = options.customerId ?? '';
  const [invoices, setInvoices] = useState<MyInvoice[]>([]);
  const [products, setProducts] = useState<CatalogueProduct[]>([]);
  const [outstanding, setOutstanding] = useState(0);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState('');
  const [unsupported, setUnsupported] = useState(false);
  const [pendingInvoices, setPendingInvoices] = useState(0);
  const [target, setTarget] = useState<MyTarget | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // The catalogue is fetched with the invoices either way: the two panes are one screen and an
      // engineer switching to «الأصناف» should not wait for a second round trip.
      const [billed, catalogue] = await Promise.all([myInvoices(customerId), myCatalogue()]);
      setInvoices(Array.isArray(billed?.invoices) ? billed.invoices : []);
      setOutstanding(Number(billed?.outstanding || 0));
      setProducts(Array.isArray(catalogue?.products) ? catalogue.products : []);
      setError(''); setUnsupported(false);
      // Read on its own terms: a phone whose server has no target yet (404) or an engineer the
      // manager never planned for (null) is not a failed screen — the strip simply does not render.
      try { setTarget(await myTargets()); } catch { setTarget(null); }
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 404) setUnsupported(true);
      else if (status === 403) setUnsupported(true);
      else setError((e as Error).message);
    } finally { setLoading(false); }
  }, [customerId]);

  useEffect(() => { if (enabled) void refresh(); }, [enabled, refresh]);

  /**
   * A sale that cannot reach the server is kept on the phone, not thrown away — that is the whole
   * point of replacing the paper notebook. `outboxKey` treats a payload with no `id` as unique, so
   * two invoices typed minutes apart are never merged into one, and the recorded time rides along
   * unread: the office's books are dated by the server's clock, not by whichever phone was slow.
   */
  const submit = useCallback(async (invoice: InvoiceInput, ownerId?: string) => {
    try {
      await createMyInvoice(invoice);
      await refresh();
      return 'sent';
    } catch (e) {
      if ((e as ApiError).status !== 0) throw e;
      await enqueueInvoice({ ...invoice, recordedAt: Date.now() }, ownerId);
      const result = await flushOutbox(ownerId).catch(() => null);
      setPendingInvoices(result?.pendingInvoices ?? 1);
      if (result && result.sent > 0) await refresh();
      return 'queued';
    }
  }, [refresh]);

  const cancel = useCallback(async (id: string, reason: string) => {
    try { await voidMyInvoice(id, reason); await refresh(); return true; }
    catch { return false; }
  }, [refresh]);

  /**
   * Money is the one write on this screen that is never queued. A sale typed with no signal is a row
   * the office can still reconcile against; a payment replayed twice because the phone lost a bar is a
   * drawer that does not add up. So an offline attempt is refused here, out loud, and he tells the
   * office instead.
   */
  const pay = useCallback(async (id: string, amount: number, note: string) => {
    try { await payMyInvoice(id, amount, note.trim()); await refresh(); return null; }
    catch (e) {
      if ((e as ApiError).status === 0) return 'مافيش شبكة — التحصيل ما بيتسجلش من غير اتصال، عشان مايتسجلش مرتين. بلّغ المكتب يسجّله.';
      return (e as Error).message;
    }
  }, [refresh]);

  return { invoices, products, outstanding, loading, error, unsupported, refresh, pendingInvoices, submit, cancel, pay, target };
}
