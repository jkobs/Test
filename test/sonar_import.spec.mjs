/* Playwright validation: importing a Lowrance sonar log draws depth contours
   from the angler's own soundings on the map, and the log survives a reload.

   Wisconsin publishes no usable bathymetry and the commercial charts are
   licensed, so the app builds contours from the user's own .sl2/.sl3 logs
   (src/sonarlog.js). This spec synthesises a real-format .sl2 file — a bowl-
   shaped lake bottom at Cedar Lake, surveyed in lawnmower passes — so the whole
   path runs end to end: file picker -> chunked parser -> IndexedDB -> contour
   -> map. The parser's field offsets were separately checked against the
   community decoders' own sample logs.

   Run: node test/sonar_import.spec.mjs
*/
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = 'file://' + resolve(__dirname, '../dist/solunar.html');
// The dev sandbox ships a pinned Chromium; anywhere else (CI) fall back to
// Playwright's own browser by leaving executablePath undefined.
const { existsSync } = await import('fs');
const PINNED_CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const CHROME = existsSync(PINNED_CHROME) ? PINNED_CHROME : undefined;

let failures = 0;
function check(label, cond) { console.log((cond ? 'PASS  ' : 'FAIL  ') + label); if (!cond) failures++; }

// ---- synthesise a Lowrance .sl2 log ----
const R = 6356752.3142, LAT0 = 45.216, LNG0 = -92.572;
const mLat = 111320, mLng = 111320 * Math.cos(LAT0 * Math.PI / 180);
function sl2(frames) {
  const buf = Buffer.alloc(8 + frames.length * 144);
  buf.writeUInt16LE(2, 0); buf.writeUInt16LE(0, 2); buf.writeUInt16LE(1970, 4);
  frames.forEach((f, i) => {
    const o = 8 + i * 144;
    buf.writeUInt32LE(o, o);
    buf.writeUInt16LE(144, o + 28);                       // frame size
    buf.writeUInt16LE(f.channel, o + 32);
    buf.writeFloatLE(f.depthFt, o + 64);
    buf.writeInt32LE(Math.round(f.lng * Math.PI / 180 * R), o + 108);
    buf.writeInt32LE(Math.round(R * Math.log(Math.tan(Math.PI / 4 + f.lat * Math.PI / 360))), o + 112);
    buf.writeUInt16LE(f.posValid === false ? 0 : 0x0010, o + 132);
  });
  return buf;
}
const frames = [];
for (let y = -300; y <= 300; y += 25) for (let x = -300; x <= 300; x += 1) {
  const lat = LAT0 + y / mLat, lng = LNG0 + x / mLng, depthFt = Math.max(1, 32 - Math.hypot(x, y) / 10);
  frames.push({ channel: 0, lat, lng, depthFt });
  // Downscan repeats the ping; a bogus depth here would show if channels were mixed.
  frames.push({ channel: 2, lat, lng, depthFt: 999 });
}
frames.push({ channel: 0, lat: 0, lng: 0, depthFt: 50, posValid: false }); // no GPS fix: ignored
const LOG = sl2(frames);

const browser = await chromium.launch({ executablePath: CHROME });
const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
const page = await context.newPage();
await page.route('**/*', async (route) => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('api.open-meteo.com/v1/forecast')) {
    const nowS = Math.floor(Date.now() / 1000), time = [], sp = [];
    for (let i = -4; i <= 4; i++) { time.push(nowS + i * 3600); sp.push(1013); }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      current: { temperature_2m: 62, wind_speed_10m: 5, wind_direction_10m: 180 }, hourly: { time, surface_pressure: sp } }) });
  }
  if (url.includes('/api/interpreter')) return route.abort('failed');
  if (url.includes('api.inaturalist.org'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [] }) });
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});
const errs = [];
page.on('pageerror', e => errs.push(String(e)));

async function open() {
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#advisor-body', { timeout: 15000 });
  await page.click('.tab[data-tab="lake"]');
  await page.waitForSelector('#sonar-card .sonar-import', { timeout: 5000 });
}

await open();
check('Lake tab offers sonar-log import', await page.isVisible('#sonar-card .sonar-import'));
check('file picker has no accept filter (iOS would grey out .sl2/.sl3)',
  await page.$eval('#sonar-file', el => !el.hasAttribute('accept')));

// A file that isn't a log is rejected with a readable reason, and nothing is stored.
await page.setInputFiles('#sonar-file', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello world, not sonar') });
await page.waitForFunction(() => /Not a Lowrance/.test(document.getElementById('sonar-status')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
check('non-log file is rejected with a clear message',
  /Not a Lowrance \.sl2\/\.sl3 sonar log/.test(await page.textContent('#sonar-status')));
check('rejected file is not listed', (await page.$$('.sonar-log')).length === 0);

await page.setInputFiles('#sonar-file', { name: 'cedar-2026-06-14.sl2', mimeType: 'application/octet-stream', buffer: LOG });
await page.waitForSelector('.sonar-log', { timeout: 15000 });
const card = await page.textContent('#sonar-card');
console.log('card: ' + card.replace(/\s+/g, ' ').trim());
check('import reports success', /Added 1 log/.test(card));
check('log is listed with its primary-channel sounding count (downscan + no-fix frames excluded)',
  card.includes('cedar-2026-06-14.sl2') && card.includes(((frames.length - 1) / 2).toLocaleString("en-US")));
check('deepest sounding reflects primary channel only (32 ft bowl, not the 999 ft downscan value)',
  /deepest sounding 3[01] ft/.test(card));
check('contours every 5 ft', /contour levels every 5 ft/.test(card));
check('depth legend runs 0 ft to the deepest sounding', /0 ft.*31 ft/.test(card.replace(/\s+/g, ' ')));

// Show -> jumps to the map on the Today tab with contours + depth labels drawn.
await page.click('[data-sonar-show]');
await page.waitForTimeout(800);
check('Show switches to the map tab', await page.isVisible('#advisor-map'));
const labels = await page.$$eval('#advisor-map .sonar-depth-label span', els => els.map(e => {
  const r = e.getBoundingClientRect(); return { t: e.textContent, x: Math.round(r.x), y: Math.round(r.y), w: r.width };
}));
console.log('labels: ' + JSON.stringify(labels.slice(0, 8)));
const depths = [...new Set(labels.map(l => +l.t))].sort((a, b) => a - b);
check('depth labels drawn on the 5 ft contours', depths.length >= 4 && depths.every(d => d % 5 === 0 && d >= 5 && d <= 30));
const LABEL_PX = 44;
check('labels never crowd each other (≥44 px apart)', labels.every((a, i) => labels.every((b, j) =>
  i === j || Math.hypot(a.x + a.w / 2 - b.x - b.w / 2, a.y - b.y) >= LABEL_PX - 2)));
const mapBox = await page.$eval('#advisor-map', el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
check('labels are positioned on the map, not stacked at one corner',
  new Set(labels.map(l => l.x + ',' + l.y)).size === labels.length &&
  labels.every(l => l.x > mapBox.x && l.x < mapBox.x + mapBox.w && l.y > mapBox.y && l.y < mapBox.y + mapBox.h));
check('contour lines drawn on a canvas', (await page.$$('#advisor-map .leaflet-overlay-pane canvas')).length > 0);
// The soundings themselves are drawn too (a single trip only crosses each
// contour as a short tick). Sample canvas pixels along the survey area.
const painted = await page.$eval('#advisor-map .leaflet-overlay-pane canvas', c => {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; });
console.log('painted canvas pixels: ' + painted);
check('soundings drawn as a depth-colored track, not just contour ticks', painted > 20000);

// Zooming in re-lays out labels in screen space: the small 30 ft deep-hole
// ring, too small to label at the fitted zoom, gets its label.
await page.click('#advisor-map .leaflet-control-zoom-in'); await page.waitForTimeout(500);
await page.click('#advisor-map .leaflet-control-zoom-in'); await page.waitForTimeout(500);
const zoomed = await page.$$eval('#advisor-map .sonar-depth-label span', els => els.map(e => +e.textContent));
console.log('labels after zoom-in: ' + JSON.stringify(zoomed));
check('zooming in labels the 30 ft deep hole', zoomed.includes(30));
await page.click('#advisor-map .leaflet-control-zoom-out'); await page.waitForTimeout(500);
await page.click('#advisor-map .leaflet-control-zoom-out'); await page.waitForTimeout(500);

// Hide contours removes them; Show contours brings them back.
await page.click('#dnr-toggle');
check('Hide contours removes the sonar contours', (await page.$$('#advisor-map .sonar-depth-label')).length === 0);
await page.click('#dnr-toggle');
check('Show contours restores them', (await page.$$('#advisor-map .sonar-depth-label')).length > 0);

// Persisted on-device: survives a full reload.
await open();
await page.waitForSelector('.sonar-log', { timeout: 5000 }).catch(() => {});
check('imported log survives a reload', (await page.$$('.sonar-log')).length === 1);

// Remove clears the list and the map.
await page.click('[data-sonar-del]');
await page.waitForFunction(() => document.querySelectorAll('.sonar-log').length === 0, null, { timeout: 5000 }).catch(() => {});
check('Remove deletes the log', (await page.$$('.sonar-log')).length === 0);
check('no contour summary once all logs are removed', !/contour levels/.test(await page.textContent('#sonar-card')));
check('no contours left on the map', (await page.$$('#advisor-map .sonar-depth-label')).length === 0);

check('no page errors', errs.length === 0);
if (errs.length) console.log(errs.join('\n'));
await browser.close();
console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
