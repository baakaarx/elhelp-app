import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import type { Rep, RouteResponse } from './types';

const TILE = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';
const MAX_DRAWN_POINTS = 900;

function sample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const step = items.length / max;
  return Array.from({ length: max }, (_, i) => items[Math.min(items.length - 1, Math.floor(i * step))]);
}

export default function MapView({ reps, selectedId, route }: { reps: Rep[]; selectedId: string | null; route: RouteResponse | null }) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(1);
  const [speed, setSpeed] = useState(120);

  const selected = useMemo(() => reps.find(r => r.id === selectedId) ?? null, [reps, selectedId]);
  const points = useMemo(() => (route?.points ?? []).map(p => ({ lat: p.lat, lng: p.lng, at: p.recordedAt })), [route]);
  const path = useMemo(() => sample(points, MAX_DRAWN_POINTS), [points]);

  useEffect(() => {
    if (!host.current || map.current) return;
    const instance = L.map(host.current, { zoomControl: true, attributionControl: true, preferCanvas: true }).setView([30.05, 31.25], 11);
    L.tileLayer(TILE, { attribution: ATTRIBUTION, maxZoom: 19, subdomains: 'abcd' }).addTo(instance);
    layer.current = L.layerGroup().addTo(instance);
    map.current = instance;
    const resize = () => instance.invalidateSize();
    window.addEventListener('resize', resize);
    setTimeout(resize, 250);
    return () => { window.removeEventListener('resize', resize); instance.remove(); map.current = null; };
  }, []);

  // Reset the replay whenever the selected route changes: a full trail is the useful default.
  useEffect(() => { setProgress(1); setPlaying(false); }, [route?.points.length, selectedId]);

  useEffect(() => {
    if (!playing) return;
    if (progress >= 1) { setPlaying(false); return; }
    const timer = window.setInterval(() => {
      setProgress(current => {
        const next = current + speed / Math.max(1, path.length);
        return next >= 1 ? 1 : next;
      });
    }, 100);
    return () => window.clearInterval(timer);
  }, [playing, progress, speed, path.length]);

  useEffect(() => {
    const instance = map.current, group = layer.current;
    if (!instance || !group) return;
    group.clearLayers();
    const bounds: L.LatLngExpression[] = [];
    if (path.length > 1) {
      const cutoff = Math.max(1, Math.round(path.length * progress));
      const traveled = path.slice(0, cutoff);
      const remaining = path.slice(cutoff - 1);
      const color = selected?.color || '#1f513f';
      if (remaining.length > 1) L.polyline(remaining.map(p => [p.lat, p.lng] as [number, number]), { color, weight: 3, opacity: 0.28, dashArray: '5 7' }).addTo(group);
      if (traveled.length > 1) L.polyline(traveled.map(p => [p.lat, p.lng] as [number, number]), { color, weight: 5, opacity: 0.85 }).addTo(group);
      const start = traveled[0], head = traveled[traveled.length - 1];
      L.circleMarker([start.lat, start.lng], { radius: 6, color: '#1f513f', fillColor: '#ffffff', fillOpacity: 1, weight: 2 }).addTo(group).bindTooltip('بداية اليوم');
      const headMarker = L.circleMarker([head.lat, head.lng], { radius: 9, color: '#ffffff', weight: 3, fillColor: color, fillOpacity: 1 }).addTo(group);
      headMarker.bindTooltip(`<b>${escapeHtml(selected?.name || 'المهندس')}</b><br/>${new Date(head.at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}`, { direction: 'top', offset: [0, -10] });
      if (progress >= 1) {
        L.circleMarker([head.lat, head.lng], { radius: 4, color: color, fillColor: color, fillOpacity: 1, weight: 0 }).addTo(group);
        headMarker.bindTooltip(`<b>${escapeHtml(selected?.name || 'المهندس')}</b><br/>آخر نقطة · ${new Date(head.at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}`, { direction: 'top', offset: [0, -10] });
      }
      bounds.push(...path.map(p => [p.lat, p.lng] as [number, number]));
    }
    for (const rep of reps.filter(r => r.location)) {
      const { lat, lng } = rep.location!;
      const isSelected = rep.id === selectedId;
      if (path.length > 1 && isSelected) continue;
      const marker = L.circleMarker([lat, lng], {
        radius: isSelected ? 12 : 9, color: '#ffffff', weight: 2.5, fillColor: rep.color, fillOpacity: 0.95,
      }).addTo(group);
      marker.bindTooltip(`<b>${escapeHtml(rep.name)}</b><br/>${rep.online ? 'متصل' : 'غير متصل'} · ${rep.tracking ? 'في وردية' : 'لا يتتبع'}${rep.openVisit ? `<br/>زيارة مفتوحة: ${escapeHtml(rep.openVisit.customerName)}` : ''}`, { direction: 'top', offset: [0, -8] });
      if (rep.online) L.circle([lat, lng], { radius: 140, color: rep.color, weight: 0, fillColor: rep.color, fillOpacity: 0.14 }).addTo(group);
      bounds.push([lat, lng]);
    }
    if (bounds.length === 1) instance.setView(bounds[0], 14, { animate: true });
    else if (bounds.length > 1) instance.fitBounds(L.latLngBounds(bounds).pad(0.15), { animate: true, maxZoom: 15 });
  }, [reps, selectedId, path, progress, selected]);

  const noFixYet = !reps.some(r => r.location);
  const headTime = path.length ? new Date(path[Math.min(path.length - 1, Math.max(0, Math.round(path.length * progress) - 1))].at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }) : null;
  return (
    <div className="map-shell">
      <div ref={host} className="map" role="application" aria-label="خريطة مواقع المهندسين" />
      {noFixYet && <div className="map-empty">لا توجد إحداثيات بعد. سيظهر المهندس على الخريطة فور استلام أول نقطة موقع من التطبيق.</div>}
      <div className="map-badge">التحديث كل ثانية · {route?.truncated ? 'المسار مقطوع عند ٢٠٠٠٠ نقطة' : 'المسار الكامل'}</div>
      {path.length > 1 && (
        <div className="replay" role="group" aria-label="إعادة تشغيل المسار">
          <button className="replay-play" onClick={() => { if (progress >= 1) setProgress(0); setPlaying(value => !value); }} aria-label={playing ? 'إيقاف مؤقت' : 'تشغيل المسار'}>
            {playing ? '❚❚' : '▶'}
          </button>
          <input
            type="range" min={0} max={1000} value={Math.round(progress * 1000)}
            aria-label="تقدم المسار"
            onChange={event => { setPlaying(false); setProgress(Number(event.target.value) / 1000); }}
          />
          <span className="replay-time">{headTime ?? '—'}</span>
          <select value={speed} aria-label="سرعة التشغيل" onChange={event => setSpeed(Number(event.target.value))}>
            <option value={40}>×١</option>
            <option value={120}>×٣</option>
            <option value={300}>×٨</option>
          </select>
          <button className="btn ghost sm" onClick={() => { setPlaying(false); setProgress(1); }}>الكل</button>
        </div>
      )}
    </div>
  );
}
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
