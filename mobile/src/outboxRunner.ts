/**
 * طابور المزامنة مشترك على الجهاز. نشغّل محاولة واحدة في المرة، ونضمن إن
 * المحاولة اليدوية ما تختفيش لو المزامنة التلقائية شغالة بالفعل.
 */
export function createOutboxRunner<T>() {
  let tail: Promise<void> = Promise.resolve();
  const pending = new Map<string, Promise<T>>();
  return (key: string, task: () => Promise<T>): Promise<T> => {
    const existing = pending.get(key);
    if (existing) return existing;
    const result = tail.then(task);
    tail = result.then(() => undefined, () => undefined);
    pending.set(key, result);
    void result.then(() => pending.delete(key), () => pending.delete(key));
    return result;
  };
}
