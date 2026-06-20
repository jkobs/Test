/*
 screenshot.mjs — render the built app in a phone-sized headless browser and save
 a PNG to dist/. Used for visual review (and by the ux-reviewer subagent).
 Clock is pinned to 2026-06-20 so the shot matches the validated example day.
 Run: node scripts/screenshot.mjs
*/
import { chromium } from 'playwright';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = 'file://' + join(root, 'dist/solunar.html');

// Prefer Microsoft Edge (user preference), then a cached chromium, then default.
import { existsSync } from 'fs';
const CACHED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
async function launch() {
  try {
    const b = await chromium.launch({ channel: 'msedge' });
    console.log('Using Microsoft Edge.');
    return b;
  } catch (e) {
    if (existsSync(CACHED)) {
      console.log('Edge not available; using cached chromium.');
      return chromium.launch({ executablePath: CACHED });
    }
    console.log('Edge/cached chromium not available; using default chromium.');
    return chromium.launch();
  }
}
const browser = await launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },     // iPhone 14-ish
  deviceScaleFactor: 2,
  locale: 'en-US',
});
const page = await ctx.newPage();

// Pin the clock to 2026-06-20 ~10:00 CDT and block geolocation (Yellow Lake default).
await page.addInitScript(() => {
  const FIXED = new Date('2026-06-20T15:00:00Z').getTime();
  const RealDate = Date;
  // eslint-disable-next-line no-global-assign
  Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [FIXED])); }
    static now() { return FIXED; }
  };
});

await page.goto(file, { waitUntil: 'load' });
await page.waitForSelector('#days .card');
await page.waitForTimeout(500);

const out = join(root, 'dist/preview.png');
await page.screenshot({ path: out, fullPage: true });
console.log('Saved ' + out);
await browser.close();
