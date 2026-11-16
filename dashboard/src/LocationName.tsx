import { useEffect, useState } from 'react';
import type { LocationPoint } from './types';

type Lookup = { label: string; at: number };
/** Reverse lookup is opt-in: do not send anyone's GPS to a third party on page load. */
export default function LocationName({ location }: { location: LocationPoint | null }) {
  const [result, setResult] = useState<Lookup | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // The parent refreshes positions every few seconds; without this the label of the previous
  // fix stayed on screen next to a newer timestamp — a place name that is simply wrong.
  const fixKey = location ? `${location.lat},${location.lng},${location.recordedAt}` : '';
  useEffect(() => { setResult(null); setError(''); }, [fixKey]);
  async function lookup() {
    if (!location || loading) return;
    const fix = location;
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ f: 'json', location: `${fix.lng},${fix.lat}`, langCode: 'AR', outFields: 'LongLabel,ShortLabel,Neighborhood,City,Region' });
      const response = await fetch(`https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode?${params}`);
      if (!response.ok) throw new Error();
      const data = await response.json() as { address?: Record<string, string>; error?: unknown };
      if (data.error || !data.address) throw new Error();
      const address = data.address;
      const label = address.LongLabel || address.Match_addr || [address.Neighborhood, address.City, address.Region].filter(Boolean).join('، ') || address.ShortLabel;
      if (!label) throw new Error();
      setResult({ label, at: fix.recordedAt });
    } catch { setError('تعذر تحديد اسم المنطقة الآن؛ الإحداثيات متاحة على الخريطة.'); }
    finally { setLoading(false); }
  }
  if (!location) return <span className="muted small">لا توجد إشارة موقع</span>;
  return <div className="small">
    {result && <span>{result.label} <span className="muted">(تقريبي · إشارة {new Date(result.at).toLocaleTimeString('ar-EG')})</span><br /></span>}
    {error && <span className="error" role="alert">{error}<br /></span>}
    <button type="button" className="btn ghost sm" onClick={lookup} disabled={loading}>{loading ? 'جارٍ تحديد المنطقة…' : result ? 'تحديث اسم المنطقة' : 'عرض اسم المنطقة التقريبي'}</button>
    <small className="muted" style={{ display: 'block' }}>بالضغط تُرسل إحداثيات هذه الإشارة لخدمة Esri لتحديد الاسم.</small>
  </div>;
}
