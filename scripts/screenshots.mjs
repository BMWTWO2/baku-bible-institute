// Usage: node scripts/screenshots.mjs [baseUrl]  (needs playwright; uses system Chrome if present)
import { createRequire } from 'module'; const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = await import('/usr/local/lib/pnpm/5/.pnpm/playwright@1.63.0-alpha-2026-08-31/node_modules/playwright/index.mjs'); }
const { chromium } = pw; const base = process.argv[2] || 'http://localhost:3050'; const out = new URL('../screenshots/', import.meta.url).pathname;
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome' }); const p = await b.newPage({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1.5 });
const shot = async (path, name, full = true) => { await p.goto(base + path, { waitUntil: 'networkidle' }); await p.waitForTimeout(1300); await p.screenshot({ path: out + name + '.png', fullPage: full }); console.log(out + name + '.png'); };
await shot('/', '01-home', false);
const login = async (e) => { await p.goto(base + '/login'); await p.fill('[name=email]', e); await p.fill('[name=password]', 'BakuDemo2026!'); await Promise.all([p.waitForNavigation(), p.click('button.btn')]); };
await login('admin@baku-bible.example');
await shot('/admin', '02-admin-dashboard'); await shot('/admin/whatsapp', '03-whatsapp-inbox'); await shot('/admin/students', '04-roster'); await shot('/admin/classes', '10-classes'); await shot('/admin/attendance', '05-attendance-flags');
await p.goto(base + '/admin/homework/1'); await Promise.all([p.waitForNavigation(), p.click('text=Draft Azeri correction')]); await p.waitForTimeout(1000); await p.screenshot({ path: out + '06-homework-review-azeri.png', fullPage: true }); console.log(out + '06-homework-review-azeri.png');
await shot('/admin/bots', '07-bots'); await shot('/admin/report', '08-weekly-report');
await p.context().clearCookies(); await login('nermin@student.baku-bible.example');
await shot('/telebe', '09-student-portal-az');
await p.context().clearCookies(); await login('bruce@baku-bible.example'); await p.waitForTimeout(1200); await p.screenshot({ path: out + '11-teacher-landing.png', fullPage: true }); console.log(out + '11-teacher-landing.png'); await shot('/admin/homework', '12-teacher-homework');
await b.close();
