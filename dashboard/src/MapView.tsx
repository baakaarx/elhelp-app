import { useEffect, useRef } from 'react';
import L from 'leaflet';
import type { Rep, RouteResponse } from './types';

const TILE = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

export default function MapView({ reps, selectedId, route }: { reps: Rep[]; selectedId: string | null; route: RouteResponse | null }) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
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
  useEffect(() => {
    const instance = map.current, group = layer.current;
    if (!instance || !group) return;
    group.clearLayers();
    const bounds: L.LatLngExpression[] = [];
    const positions = reps.filter(r => r.location);
    const path = (route?.points || []).map(p => [p.lat, p.lng] as [number, number]);
    if (route && path.length > 1) {
      const drawn = selectedId ? reps.find(r => r.id === selectedId) : undefined;
      L.polyline(path, { color: drawn?.color || '#1f513f', weight: 4, opacity: 0.8 }).addTo(group);
      const start = path[0], end = path[path.length - 1];
      L.circleMarker(start, { radius: 6, color: '#1f513f', fillColor: '#ffffff', fillOpacity: 1, weight: 2 }).addTo(group).bindTooltip('بداية المسار');
      L.circleMarker(end, { radius: 6, color: '#b45309', fillColor: '#fde68a', fillOpacity: 1, weight: 2 }).addTo(group).bindTooltip('آخر نقطة');
      bounds.push(...path);
    }
    for (const rep of positions) {
      const { lat, lng, accuracy } = rep.location!;
      const selected = rep.id === selectedId;
      const marker = L.circleMarker([lat, lng], {
        radius: selected ? 12 : 9, color: '#ffffff', weight: 2.5, fillColor: rep.color, fillOpacity: 0.95,
      }).addTo(group);
      marker.bindTooltip(`<b>${escapeHtml(rep.name)}</b><br/>${rep.online ? 'متصل' : 'غير متصل'} · ${rep.tracking ? 'في وردية' : 'لا يتتبع'}`, { direction: 'top', offset: [0, -8] });
      if (rep.online) L.circle([lat, lng], { radius: 140, color: rep.color, weight: 0, fillColor: rep.color, fillOpacity: 0.14 }).addTo(group);
      if (accuracy && accuracy < 200) L.circle([lat, lng], { radius: accuracy, color: rep.color, weight: 1, opacity: 0.25, fillColor: rep.color, fillOpacity: 0.05 }).addTo(group);
      bounds.push([lat, lng]);
    }
    if (bounds.length === 1) instance.setView(bounds[0], 14, { animate: true });
    else if (bounds.length > 1) instance.fitBounds(L.latLngBounds(bounds).pad(0.15), { animate: true, maxZoom: 15 });
  }, [reps, selectedId, route]);
  const noFixYet = !reps.some(r => r.location);
  return (
    <div className="map-shell">
      <div ref={host} className="map" role="application" aria-label="خريطة مواقع المهندسين" />
      {noFixYet && <div className="map-empty">لا توجد إحداثيات بعد. سيظهر المهندس على الخريطة فور استلام أول نقطة موقع من التطبيق.</div>}
      <div className="map-badge">التحديث كل ثانية · {route?.truncated ? 'المسار مقطوع عند ٢٠٠٠٠ نقطة' : 'المسار الكامل'}</div>
    </div>
  );
}
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
