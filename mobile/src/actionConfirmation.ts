import type { DailyReportInput, ReportInput, VisitInput } from './types';

type Value = Record<string, any>;
function entity(response: unknown, key: string): Value | null {
  if (!response || typeof response !== 'object') return null;
  const r = response as Value;
  return typeof r.duplicate === 'boolean' && r[key] && typeof r[key] === 'object' ? r[key] : null;
}
function locationMatches(row: Value, location: { lat: number; lng: number; accuracy: number | null } | null): boolean {
  return row.lat === (location?.lat ?? null) && row.lng === (location?.lng ?? null) && row.accuracy === (location?.accuracy ?? null);
}
export function confirmedReport(input: ReportInput, response: unknown): boolean {
  const r = entity(response, 'report');
  return !!r && r.id === input.id && r.type === input.type && r.title === input.title.trim() && r.body === input.body.trim()
    && r.customer === input.customer.trim() && r.amount === input.amount && locationMatches(r, input.location);
}
export function confirmedDailyReport(input: DailyReportInput, response: unknown): boolean {
  const r = entity(response, 'report');
  if (!r || r.id !== input.id || r.version !== input.version || r.engineerName !== input.engineerName.trim()
      || r.reportDate !== input.reportDate || r.leftAt !== input.leftAt.trim() || r.returnedAt !== input.returnedAt.trim()
      || r.circumstances !== input.circumstances.trim() || r.signedName !== input.signedName.trim() || !locationMatches(r, input.location)
      || !Array.isArray(r.visits) || r.visits.length !== input.visits.length) return false;
  return input.visits.every((v, i) => {
    const saved = r.visits[i];
    return saved && saved.customerName === v.customerName.trim() && saved.governorate === v.governorate.trim()
      && saved.district === v.district.trim() && saved.village === v.village.trim() && saved.phone === v.phone.trim()
      && saved.areaFeddan === v.areaFeddan && saved.crops === v.crops.trim()
      && saved.recommendations === v.recommendations.trim() && saved.outcome === v.outcome.trim();
  });
}
export function confirmedCheckIn(input: VisitInput, response: unknown): boolean {
  const r = entity(response, 'visit');
  return !!r && r.id === input.id && r.customerId === input.customerId && r.purpose === input.purpose
    && r.inLat === input.location.lat && r.inLng === input.location.lng && r.inAccuracy === input.location.accuracy;
}
export function confirmedCheckOut(id: string, input: { outcome: string; notes: string; location: {lat: number; lng: number} | null }, response: unknown): boolean {
  const r = entity(response, 'visit');
  return !!r && r.id === id && r.status === 'closed' && r.outcome === input.outcome.trim()
    && (!input.notes.trim() || r.notes === input.notes.trim())
    && r.outLat === (input.location?.lat ?? null) && r.outLng === (input.location?.lng ?? null);
}
