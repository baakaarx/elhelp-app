/** Test decimal precision using the number's shortest decimal representation, rather than an
 * absolute floating-point tolerance that could silently turn a tiny nonzero amount into zero. */
export function hasDecimalPrecision(value:number, places:number):boolean {
  if (!Number.isFinite(value)) return false;
  const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
  const fractional = mantissa.split('.')[1]?.length ?? 0;
  return fractional - Number(exponent) <= places;
}
