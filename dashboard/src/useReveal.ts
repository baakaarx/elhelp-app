import { useLayoutEffect, useRef, useState } from 'react';

/** Bring a newly opened form/panel into view even when the same action is pressed again. */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [revision, setRevision] = useState(0);
  const reveal = () => setRevision(value => value + 1);
  useLayoutEffect(() => {
    if (!revision || !ref.current) return;
    ref.current.focus({ preventScroll: true });
    ref.current.scrollIntoView({ block: 'start', behavior: 'auto' });
  }, [revision]);
  return { ref, reveal };
}
