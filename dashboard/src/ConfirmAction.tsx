import { useEffect, useRef, useState } from 'react';

/**
 * A delete button that has to be pressed twice.
 *
 * Nothing else in this dashboard destroys a record: reports are reviewed, accounts are stopped,
 * devices are unbound. A manager cleaning a test row should not have to type anything (that is the
 * phone's rule for its own erasure), but he should not be one stray tap from removing a month of an
 * engineer's field data either. So the first press arms the button and shows what is about to be
 * lost; the second press does it.
 *
 * The arm expires. A red button left waiting at the side of the screen while the manager answers a
 * phone call is not a decision — and `onArm` is where a caller that needs a server-side count (how
 * many visits, how many fixes) fetches it, so the warning is a number and not a guess.
 */
export const ARM_WINDOW_MS = 10_000;

export default function ConfirmAction({ label, confirmLabel, detail, onArm, onConfirm, className = 'btn ghost sm', busyLabel = 'جارٍ الحذف…' }: {
  label: string;
  confirmLabel: string;
  /** What is about to be deleted, in words. Shown while the button is armed. */
  detail?: string | null;
  /** Called on the first press — fetch the impact, if there is one to fetch. */
  onArm?: () => void;
  onConfirm: () => Promise<void>;
  className?: string;
  busyLabel?: string;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const disarm = () => { clearTimeout(timer.current); setArmed(false); };
  // A card that unmounts mid-arm (the list refreshed, the tab changed) must not leave a timer that
  // calls setState on a dead component.
  useEffect(() => () => clearTimeout(timer.current), []);

  function arm() {
    setArmed(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setArmed(false), ARM_WINDOW_MS);
    onArm?.();
  }
  async function run() {
    disarm();
    setBusy(true);
    try { await onConfirm(); } finally { setBusy(false); }
  }

  return (
    <>
      {armed ? (
        <span className="confirm-pair">
          {detail ? <small className="muted" role="status">{detail}</small> : null}
          <button type="button" className="btn danger sm" disabled={busy} onClick={() => void run()}>
            {busy ? busyLabel : confirmLabel}
          </button>
          <button type="button" className="btn ghost sm" disabled={busy} onClick={disarm}>إلغاء</button>
        </span>
      ) : (
        <button type="button" className={className} onClick={arm}>{label}</button>
      )}
    </>
  );
}
