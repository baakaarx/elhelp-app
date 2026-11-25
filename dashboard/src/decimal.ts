/** Normalize Arabic numerals without converting a decimal comma into a different number. */
export function normalizeDecimal(text:string):string {
  return text.trim().replace(/[٠-٩]/g,c=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)))
    .replace(/[۰-۹]/g,c=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))).replace('٫','.');
}
/** Validate the actual input text, before Number() can discard extra significant digits. */
export function hasInputPrecision(text:string, places:number):boolean {
  const normalized=normalizeDecimal(text);
  if (!/^\d+(\.\d+)?$/.test(normalized)) return false;
  return (normalized.split('.')[1] ?? '').replace(/0+$/,'').length <= places;
}
/** Grouping commas are only accepted in complete groups of three, never guessed as decimals. */
export function ungroupPrice(text:string):string {
  const value=normalizeDecimal(text);
  if (!/[٬,]/.test(value)) return value;
  if (!/^\d{1,3}(?:[,٬]\d{3})+(?:\.\d+)?$/.test(value)) return '';
  return value.replace(/[٬,]/g,'');
}
