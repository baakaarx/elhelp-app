import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { DEFAULT_TIMEZONE, timeText } from './dates';
import type { Rep, RouteResponse } from './types';
import { displayRoute, routeSegments } from './routeDisplay';

// Keyless basemaps: no API key, so no token can expire or leak in the client bundle.
//
// The street map is the default: following a field engineer means reading street names and
// blocks, which satellite imagery does not give — imagery is kept as a second option for
// checking a site from above. Labels come from the street tiles themselves, so no overlay.
const BASEMAPS = {
  street: {
    label: 'شوارع',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    attribution: '&copy; <a href="https://www.esri.com/">Esri</a> — World Street Map',
    maxZoom: 19,
    maxNativeZoom: 18,
  },
  satellite: {
    label: 'قمر صناعي',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'صور الأقمار الصناعية &copy; <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics',
    maxZoom: 19,
    maxNativeZoom: 19,
  },
} as const;
type BasemapKey = keyof typeof BASEMAPS;

// Only the imagery needs a separate label layer for readable street/place names.
const LABELS: Record<BasemapKey, string | null> = {
  street: null,
  satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
};

// The pilot runs inside Egypt only, so the map is bounded instead of drifting into empty sea.
const EGYPT_BOUNDS = L.latLngBounds([21.9, 24.5], [31.75, 37.0]);
const EGYPT_CENTER: [number, number] = [26.9, 30.4];
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('');

function SyncAge({ at, live }: { at: number | null; live: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const seconds = at ? Math.max(0, Math.round((now - at) / 1000)) : null;
  const freshness = seconds === null ? '' : seconds <= 1 ? ' · آخر تحديث الآن' : ` · آخر تحديث قبل ${seconds} ث`;
  return <>{live ? 'بثّ لحظي' : 'تحديث كل ثانيتين'}{freshness}</>;
}

export default function MapView({ reps, selectedId, route, live = false, syncedAt = null, timezone = DEFAULT_TIMEZONE }: { reps: Rep[]; selectedId: string | null; route: RouteResponse | null; live?: boolean; syncedAt?: number | null; timezone?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const baseLayer = useRef<L.TileLayer | null>(null);
  const labelLayer = useRef<L.TileLayer | null>(null);
  const [basemap, setBasemap] = useState<BasemapKey>('street');
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(1);
  const [speed, setSpeed] = useState(120);
  const [expanded, setExpanded] = useState(false);
  const [rawRoute, setRawRoute] = useState(false);
  const fitKey = useRef('');

  const selected = useMemo(() => reps.find(r => r.id === selectedId) ?? null, [reps, selectedId]);
  const recordTimezone = route?.timezone || timezone;
  const points = useMemo(() => route?.points ?? [], [route]);
  const path = useMemo(() => displayRoute(route?.points ?? [], rawRoute), [route, rawRoute]);
  // The first point identifies the loaded route without changing on every live poll. The key
  // therefore changes for a new engineer/day, but a growing same-day route never steals the map.
  const routeViewKey = `${selectedId ?? 'all'}|${route?.date ?? ''}|${route?.points[0]?.id ?? ''}`;

  useEffect(() => {
    if (!host.current || map.current) return;
    // SVG avoids Leaflet's queued canvas redraw after rapid unmounts.
    const instance = L.map(host.current, {
      zoomControl: false, attributionControl: true,
      maxBounds: EGYPT_BOUNDS.pad(0.05), maxBoundsViscosity: 0.9, minZoom: 6, worldCopyJump: false,
    }).setView(EGYPT_CENTER, 6);
    const config = BASEMAPS[basemap];
    baseLayer.current = L.tileLayer(config.url, { attribution: config.attribution, maxZoom: config.maxZoom, maxNativeZoom: config.maxNativeZoom }).addTo(instance);
    const labelUrl = LABELS[basemap];
    labelLayer.current = labelUrl ? L.tileLayer(labelUrl, { maxZoom: 19, maxNativeZoom: 16, opacity: 0.9 }).addTo(instance) : null;
    L.control.zoom({ position: 'bottomleft' }).addTo(instance);
    L.control.scale({ position: 'bottomleft', metric: true, imperial: false }).addTo(instance);
    layer.current = L.layerGroup().addTo(instance);
    map.current = instance;
    const resize = () => instance.invalidateSize();
    const busy = () => host.current?.classList.add('map-moving');
    const idle = () => host.current?.classList.remove('map-moving');
    instance.on('movestart zoomstart', busy);
    instance.on('moveend zoomend', idle);
    window.addEventListener('resize', resize);
    const resizeTimer = window.setTimeout(resize, 250);
    return () => {
      window.clearTimeout(resizeTimer);
      window.removeEventListener('resize', resize);
      // Remove vector paths before Leaflet destroys their canvas renderer.
      layer.current?.clearLayers();
      layer.current = null;
      instance.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap the basemap in place; the map, the route and the zoom level stay untouched.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !baseLayer.current) return;
    const config = BASEMAPS[basemap];
    baseLayer.current.setUrl(config.url);
    baseLayer.current.options.attribution = config.attribution;
    baseLayer.current.options.maxNativeZoom = config.maxNativeZoom;
    const labelUrl = LABELS[basemap];
    if (labelUrl && !labelLayer.current) labelLayer.current = L.tileLayer(labelUrl, { maxZoom: 19, maxNativeZoom: 16, opacity: 0.9 }).addTo(instance);
    else if (labelUrl && labelLayer.current) labelLayer.current.setUrl(labelUrl);
    else if (!labelUrl && labelLayer.current) { instance.removeLayer(labelLayer.current); labelLayer.current = null; }
    instance.attributionControl.setPrefix('<a href="https://leafletjs.com/">Leaflet</a>');
  }, [basemap]);

  // New live points must not reset an in-progress replay.
  useEffect(() => { setProgress(1); setPlaying(false); }, [route?.date, selectedId]);

  // `progress` is deliberately not a dependency: it changes ten times a second while the
  // replay runs, which tore down and rebuilt the interval on every single tick.
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setProgress(current => {
        const next = current + speed / Math.max(1, path.length);
        return next >= 1 ? 1 : next;
      });
    }, 100);
    return () => window.clearInterval(timer);
  }, [playing, speed, path.length]);

  // Stop the clock once the head reaches the end instead of spinning an idle interval.
  useEffect(() => { if (playing && progress >= 1) setPlaying(false); }, [playing, progress]);

  useEffect(() => {
    const instance = map.current, group = layer.current;
    if (!instance || !group) return;
    group.clearLayers();
    const bounds: L.LatLngExpression[] = [];
    if (route && points.length) {
      const cutoff = Math.max(1, Math.round(path.length * progress));
      const traveled = path.slice(0, cutoff);
      const remaining = path.slice(Math.max(0, cutoff - 1));
      const color = selected?.color || '#2fa8dc';
      const coords = (list: typeof path) => list.map(p => [p.lat, p.lng] as [number, number]);
      for (const segment of routeSegments(remaining)) if (segment.length > 1) {
        L.polyline(coords(segment), { color, weight: 3, opacity: 0.5, dashArray: '2 8', lineCap: 'round' }).addTo(group);
      }
      for (const segment of routeSegments(traveled)) if (segment.length > 1) {
        L.polyline(coords(segment), { color, weight: 13, opacity: 0.18, lineCap: 'round' }).addTo(group);
        L.polyline(coords(segment), { className: 'route-line', color, weight: 4.5, opacity: 0.95, lineCap: 'round' }).addTo(group);
      }
      const start = path[0];
      if (start) L.marker([start.lat, start.lng], {
        icon: L.divIcon({ className: 'pin pin-start', html: '<span></span>', iconSize: [16, 16], iconAnchor: [8, 8] }),
      }).addTo(group).bindTooltip('أول نقطة معروضة', { direction: 'top', offset: [0, -10] });
      // The last actual reading is never replaced by the filtered anchor. Show its uncertainty
      // even when the selected engineer's usual marker is hidden during replay.
      const head = progress >= 1 || !traveled.length ? points[points.length - 1] : traveled[traveled.length - 1];
      if (typeof head.accuracy === 'number' && head.accuracy > 0) L.circle([head.lat, head.lng], {
        radius: head.accuracy, color, weight: 1, opacity: 0.5, fillColor: color, fillOpacity: 0.1,
      }).addTo(group);
      const headIcon = L.divIcon({
        className: 'pin pin-head', html: `<span style="--pin:${color}"></span>`,
        iconSize: [34, 34], iconAnchor: [17, 17],
      });
      const headMarker = L.marker([head.lat, head.lng], { icon: headIcon, zIndexOffset: 1000 }).addTo(group);
      const accuracyText = head.accuracy == null ? 'الدقة غير متاحة' : `دقة الإشارة ±${Math.round(head.accuracy)} م`;
      headMarker.bindTooltip(
        `<b>${escapeHtml(selected?.name || 'المهندس')}</b><br/>${progress >= 1 ? 'آخر قراءة مسجلة' : 'أثناء المسار'} · ${timeText(head.recordedAt, recordTimezone)}<br/>${accuracyText}`,
        { direction: 'top', offset: [0, -16] },
      );
      bounds.push(...points.map(p => [p.lat, p.lng] as [number, number]));
    }
    for (const rep of reps.filter(r => r.location)) {
      const { lat, lng } = rep.location!;
      const isSelected = rep.id === selectedId;
      if (route && points.length && isSelected) continue;
      const icon = L.divIcon({
        className: `pin pin-rep${rep.online ? ' is-online' : ''}${isSelected ? ' is-selected' : ''}`,
        html: `<span style="--pin:${rep.color}">${escapeHtml(initials(rep.name))}</span>`,
        iconSize: [38, 38], iconAnchor: [19, 19],
      });
      // How sure we are about the fix, drawn to scale: a wide circle means "the engineer is
      // somewhere in here", which stops a weak reading from looking like a precise position.
      const accuracy = rep.location?.accuracy;
      if (typeof accuracy === 'number' && accuracy >= 8) {
        L.circle([lat, lng], {
          radius: accuracy, color: rep.color, weight: 1, opacity: 0.5,
          fillColor: rep.color, fillOpacity: 0.1,
        }).addTo(group);
      }
      const marker = L.marker([lat, lng], { icon }).addTo(group);
      const state = rep.tracking ? (rep.online ? 'في وردية · متصل' : 'في وردية · غير متصل') : 'خارج الوردية';
      const accuracyText = typeof accuracy === 'number' ? `<br/>دقة الإشارة ±${Math.round(accuracy)} م` : '';
      marker.bindTooltip(
        `<b>${escapeHtml(rep.name)}</b><br/>${state}${rep.openVisit ? `<br/>زيارة مفتوحة: ${escapeHtml(rep.openVisit.customerName)}` : ''}${accuracyText}`,
        { direction: 'top', offset: [0, -20] },
      );
      bounds.push([lat, lng]);
    }
    // Re-frame when the selected engineer or loaded day changes, but not when a live poll adds
    // points to the same route; otherwise the map would fight the manager's pan/zoom.
    if (routeViewKey !== fitKey.current) {
      if (selectedId && points.length > 0) {
        fitKey.current = routeViewKey;
        const routeBounds = points.map(point => [point.lat, point.lng] as L.LatLngExpression);
        if (routeBounds.length === 1) instance.setView(routeBounds[0], 14, { animate: true });
        else instance.fitBounds(L.latLngBounds(routeBounds).pad(0.18), { animate: true, maxZoom: 15 });
      } else if (selectedId && selected?.location) {
        // Until the route loads, keep the selected engineer visible. The loaded route will
        // change routeViewKey and then fit the full historical path.
        fitKey.current = routeViewKey;
        instance.setView([selected.location.lat, selected.location.lng], 14, { animate: true });
      } else if (!selectedId && bounds.length) {
        fitKey.current = routeViewKey;
        if (bounds.length === 1) instance.setView(bounds[0], 14, { animate: true });
        else instance.fitBounds(L.latLngBounds(bounds).pad(0.18), { animate: true, maxZoom: 15 });
      }
    }
  }, [reps, selectedId, path, points, progress, selected, routeViewKey, recordTimezone]);

  async function toggleFullscreen() {
    const node = host.current?.closest('.map-panel') as HTMLElement | null;
    if (!node) return;
    try {
      if (document.fullscreenElement) { await document.exitFullscreen(); setExpanded(false); }
      else { await node.requestFullscreen(); setExpanded(true); }
    } catch { setExpanded(false); }
  }

  const noFixYet = !reps.some(r => r.location);
  const headTime = path.length ? timeText((progress >= 1 && points.length ? points[points.length - 1] : path[Math.min(path.length - 1, Math.max(0, Math.round(path.length * progress) - 1))]).recordedAt, recordTimezone) : null;
  return (
    <div className="map-shell">
      <div ref={host} className="map" role="application" aria-label="خريطة مواقع المهندسين" />
      <div className="map-tools" role="group" aria-label="أدوات الخريطة">
        <div className="map-switch">
          {(Object.keys(BASEMAPS) as BasemapKey[]).map(key => (
            <button key={key} type="button" className={basemap === key ? 'active' : ''} onClick={() => setBasemap(key)} aria-pressed={basemap === key}>
              {BASEMAPS[key].label}
            </button>
          ))}
        </div>
        {route && <button type="button" className="map-tool map-route-toggle" onClick={() => setRawRoute(value => !value)} aria-pressed={rawRoute} title="تبديل طريقة عرض قراءات الموقع">
          {rawRoute ? 'عرض تقريبي' : 'عرض القراءات الخام'}
        </button>}
        <button type="button" className="map-tool" onClick={toggleFullscreen} aria-label="ملء الشاشة" title="ملء الشاشة">
          {expanded ? '⤡' : '⤢'}
        </button>
      </div>
      {noFixYet && <div className="map-empty">لا توجد إحداثيات بعد. سيظهر المهندس على الخريطة فور استلام أول نقطة موقع من التطبيق.</div>}
      <div className="map-badge"><span className="map-badge-dot" /> <SyncAge at={syncedAt} live={live} /> · {route?.truncated ? 'القراءات مقطوعة عند ٢٠٠٠٠ نقطة · ' : route?.sampled ? 'عينة من القراءات · ' : ''}{rawRoute ? 'قراءات خام؛ ليست دليلًا على الحركة' : 'مسار تقريبي؛ الحركة الصغيرة قد لا تظهر'}</div>
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
