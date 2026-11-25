/** مدة واضحة بدل عرض عدد كبير من الدقايق، من غير تقريب الساعات أو الأيام لفوق. */
export function elapsedMinutesText(value: number): string {
  const total = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} يوم`);
  if (hours) parts.push(`${hours} ساعة`);
  if (minutes || parts.length === 0) parts.push(`${minutes} دقيقة`);
  return parts.join(' و');
}
