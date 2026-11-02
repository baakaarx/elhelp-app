'use strict';
/**
 * Vercel serverless entry for the hosted demo.
 *
 * The real product runs as a long-lived Node process (see server/src/index.ts) because it
 * keeps a writable SQLite file and a Socket.IO channel. On Vercel there is no long-lived
 * process, so this adapter:
 *   - keeps the SQLite file in /tmp (writable, per-instance, reset on cold start),
 *   - forces demo mode (the hosted copy is a showcase, never live data),
 *   - hands every request to the same Express app the server uses.
 * The dashboard already falls back to polling when the live socket is unavailable.
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let cachedApp;

function prepareEnv() {
  process.env.TIMEZONE = process.env.TIMEZONE || 'Africa/Cairo';
  process.env.DB_PATH = process.env.DB_PATH || '/tmp/mandoub.db';
  if (process.env.DEMO_MODE === undefined) process.env.DEMO_MODE = 'true';
  if (process.env.DEMO_MODE === 'true') {
    // The server refuses to start with DEMO_MODE in production on purpose: this adapter is
    // only ever used for the demo deployment, so it opts out of that guard explicitly.
    process.env.NODE_ENV = 'development';
    process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@mandoub.test';
    process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Demo1234!';
    // Every instance has its own /tmp database, so a database-backed session would be lost
    // as soon as the next request lands on another instance. Sign the session instead.
    process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'elhelp-hosted-demo-session-secret';
    // No background timers on serverless: move the demo team from the overview request instead.
    process.env.DEMO_SIMULATE = process.env.DEMO_SIMULATE || 'true';
  }
}

async function boot() {
  prepareEnv();
  const entry = pathToFileURL(path.join(__dirname, '..', 'server', 'dist', 'app.js')).href;
  const { createApp } = await import(entry);
  const instance = createApp();
  return instance.app;
}

module.exports = async function handler(req, res) {
  try {
    if (!cachedApp) cachedApp = boot();
    const app = await cachedApp;
    app(req, res);
  } catch (error) {
    cachedApp = undefined;
    const message = error && error.message ? String(error.message) : String(error);
    console.error('[vercel] failed to boot the API:', error);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'تعذر تشغيل الخادم على هذه النسخة.', detail: message }));
  }
};
