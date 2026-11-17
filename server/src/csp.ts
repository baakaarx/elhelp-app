/**
 * Browser policy for the manager website, public pages, and the separately mounted engineer site.
 * Both surfaces keep a strict same-origin script policy; only the engineer site may load Apple's
 * official Sign in with Apple JS SDK when that provider is configured.
 *
 * `connect-src` names the websocket origin explicitly: Socket.IO upgrades the same origin, and a
 * handful of browsers do not treat the websocket scheme as covered by `'self'`. The caller passes
 * the request's own host, and the scheme falls back to `wss:` only when that host cannot be used.
 */
const BASE = {
  script: "script-src 'self'",
  style: "style-src 'self' 'unsafe-inline'",
  // Map tiles come from one keyless provider (`dashboard/src/MapView.tsx`).
  img: "img-src 'self' data: blob: https://server.arcgisonline.com",
  // Reverse geocoding for the map pin label, plus the tile host itself.
  connect: 'https://geocode.arcgis.com https://server.arcgisonline.com',
};

/** A `Host` header safe to paste into a policy: letters, digits, dots, dashes, brackets, a port. */
const HOST = /^[a-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-f:.]+\](:\d{1,5})?$/i;

export function contentSecurityPolicy(host?: string | null, surface: 'manager' | 'engineer' = 'manager'): string {
  // Same-origin websockets only. An unusable header (missing, or something a proxy invented)
  // falls back to the scheme-wide form rather than locking live updates out of its own server.
  const socket = host && HOST.test(host) ? `wss://${host} ws://${host}` : 'wss:';
  const script = surface === 'engineer'
    ? "script-src 'self' https://appleid.cdn-apple.com"
    : BASE.script;
  const connect = surface === 'engineer'
    ? `${BASE.connect} https://appleid.apple.com`
    : BASE.connect;
  const frame = surface === 'engineer'
    ? 'frame-src https://appleid.apple.com https://appleid.cdn-apple.com'
    : "frame-src 'none'";
  return [
    "default-src 'self'",
    script,
    BASE.style,
    "font-src 'self' data:",
    BASE.img,
    `connect-src 'self' ${socket} ${connect}`,
    frame,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
}
