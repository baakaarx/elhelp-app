/**
 * One content-security-policy for the two web surfaces this server serves.
 *
 * The manager dashboard is a plain ESM bundle that never loads a third-party script, a remote
 * font or a remote stylesheet: every font is copied into the build (`scripts/copy-fonts`), and
 * the social sign-in buttons live in the *native* app only (`mobile/src/oauth.ts` hides them on
 * web). Allowing `accounts.google.com`, `apis.google.com`, `www.gstatic.com` and the Apple CDN
 * in `script-src` therefore bought nothing and would have let any of those origins run code
 * inside a signed-in manager session if one of them were ever compromised.
 *
 * The engineer web build under `/app` keeps the two exceptions it genuinely needs:
 *   - `'unsafe-eval'`, because Metro's bundle contains its lazy-`require` helper;
 *   - `fonts.gstatic.com`, because the exported bundle references the Noto Naskh Arabic files
 *     from there.
 *
 * `connect-src` names the websocket origin explicitly: Socket.IO upgrades the same origin, and a
 * handful of browsers do not treat the websocket scheme as covered by `'self'`. It used to be the
 * bare scheme (`wss:`), which allows a websocket to *any* host — the one channel the rest of this
 * policy closes. The caller passes the request's own host, and the scheme falls back to `wss:`
 * only when that host cannot be used verbatim.
 *
 * `script-src 'unsafe-inline'` is kept for the engineer build only. The manager dashboard ships a
 * Vite bundle plus three HTML pages built here (`/privacy`, `/delete-account`, the `/app`
 * placeholder) and none of them contains an inline `<script>` — only inline `<style>`, which
 * `style-src` still allows. Leaving the exception in place would have let any HTML injection on
 * the manager surface run as a script.
 */
const BASE = {
  script: "script-src 'self'",
  engineerScript: "script-src 'self' 'unsafe-inline'",
  style: "style-src 'self' 'unsafe-inline'",
  // Map tiles come from one keyless provider (`dashboard/src/MapView.tsx`).
  img: "img-src 'self' data: blob: https://server.arcgisonline.com",
  // Reverse geocoding for the map pin label, plus the tile host itself.
  connect: 'https://geocode.arcgis.com https://server.arcgisonline.com',
};

/** A `Host` header safe to paste into a policy: letters, digits, dots, dashes, brackets, a port. */
const HOST = /^[a-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-f:.]+\](:\d{1,5})?$/i;

export function contentSecurityPolicy(engineerApp: boolean, host?: string | null): string {
  // Same-origin websockets only. An unusable header (missing, or something a proxy invented)
  // falls back to the scheme-wide form rather than locking live updates out of its own server.
  const socket = host && HOST.test(host) ? `wss://${host} ws://${host}` : 'wss:';
  return [
    "default-src 'self'",
    engineerApp ? `${BASE.engineerScript} 'unsafe-eval'` : BASE.script,
    BASE.style,
    engineerApp ? "font-src 'self' data: https://fonts.gstatic.com" : "font-src 'self' data:",
    BASE.img,
    `connect-src 'self' ${socket} ${BASE.connect}`,
    // Nothing on either surface frames a provider page; the native app uses the OS sheets.
    "frame-src 'none'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
}
