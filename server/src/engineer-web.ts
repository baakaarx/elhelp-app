import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { contentSecurityPolicy } from './csp.js';

const unavailable = (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(404).type('html').send(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" /><title>مهندس الميدان · الهلب</title></head>
    <body><main><h1>موقع المهندسين غير جاهز على هذا السيرفر</h1><p>أعد البناء باستخدام <code>npm run build</code> ثم أعد تشغيل الخدمة.</p>
    <p><a href="/">لوحة متابعة الإدارة</a></p></main></body></html>`);
};

/** Mount the Expo engineer client without letting its deep links fall through to the manager SPA. */
export function mountEngineerWebClient(app: Express, directory: string): void {
  const root = resolve(directory);
  const index = join(root, 'index.html');

  // The engineer site stores its browser session in origin-scoped storage. Keep the web policy
  // strict and permit only Apple's official JS SDK when configured; manager pages get no change.
  app.use('/app', (req, res, next) => {
    res.setHeader('Content-Security-Policy', contentSecurityPolicy(req.headers.host, 'engineer'));
    // Google/Apple OAuth returns to a same-origin popup; `same-origin` from Helmet would sever
    // window.opener when that popup visits the provider and prevent the ID token from returning.
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  if (!existsSync(index)) {
    app.get('/app', unavailable);
    app.get('/app/', unavailable);
    app.get('/app/{*path}', unavailable);
    return;
  }

  const sendIndex = (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(index, error => { if (error) next(error); });
  };

  // Expo's filenames are content-hashed. Keep those assets cacheable, while the HTML shell is
  // always fresh so a deployment cannot leave iPhone Safari pointing at removed bundles.
  app.use('/app', express.static(root, {
    index: false,
    maxAge: '1d',
    fallthrough: true,
    setHeaders(res) { res.setHeader('X-Content-Type-Options', 'nosniff'); },
  }));

  app.get('/app', sendIndex);
  app.get('/app/', sendIndex);
  app.get('/app/{*path}', (req, res) => {
    const relativePath = req.path.replace(/^\/app\/?/, '');
    // Existing files were served by express.static. Missing files (especially JS/CSS) must stay
    // 404s instead of returning HTML with the wrong MIME type or falling through to the manager.
    if (extname(relativePath) || !req.accepts('html')) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(404).type('text/plain').send('Not found');
    }
    return sendIndex(req, res, error => {
      if (error) res.status(500).end();
    });
  });
}
