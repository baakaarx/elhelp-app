/** Recommendations are legacy floating-point values; do not display a tiny nonzero value as zero. */
export function recommendationQty(value:number):string {
  if (value !== 0 && Math.abs(value) < 1e-20) return `${String(value)} (صيغة علمية)`;
  return value.toLocaleString('ar-EG',{maximumFractionDigits:20});
}
