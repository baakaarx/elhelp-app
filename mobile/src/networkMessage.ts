/** Losing the response does not prove whether a write reached the server. */
export function networkMessage(path: string, method = 'GET'): string {
  const changesData = !['GET', 'HEAD'].includes(method.toUpperCase())
    && !path.startsWith('/api/auth/login') && !path.startsWith('/api/auth/oauth');
  return changesData
    ? 'تعذر الاتصال بالسيرفر أو تأكيد الرد. قد تكون العملية وصلت؛ راجع حالتها قبل تكرارها.'
    : 'تعذر الاتصال بالسيرفر. تأكد من الشبكة وتشغيل السيرفر، ثم حاول تاني.';
}
