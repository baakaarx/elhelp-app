import { useCallback, useEffect, useState } from 'react';
import { myCatalogue, myInvoices } from './api';
import type { CatalogueProduct, MyInvoice } from './types';

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
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 404) setUnsupported(true);
      else if (status === 403) setUnsupported(true);
      else setError((e as Error).message);
    } finally { setLoading(false); }
  }, [customerId]);

  useEffect(() => { if (enabled) void refresh(); }, [enabled, refresh]);

  return { invoices, products, outstanding, loading, error, unsupported, refresh };
}
