/* Playwright validation: after Show frames a sonar log, the map stays on it.

   Reproduces a live-site report: on the real site, Show sometimes left the map
   on farmland around the GPS dot instead of the imported log. Show fits the
   map to the log, but two things re-centered it afterwards:
     1. a late conditions response (Open-Meteo pressure) re-renders the advisor,
        and initMap() always did setView(location, 14);
     2. a GPS update recenters the map whenever no water was picked by hand.
   Whichever landed after Show won. Here the log is at Cedar Lake and the app's
   location is Yellow Lake, ~80 km away, so a re-center leaves no track on screen.

   Run: node test/sonar_show_framing.spec.mjs
*/
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = 'file://' + resolve(__dirname, '../dist/solunar.html');
const { existsSync } = await import('fs');
const PINNED_CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const CHROME = existsSync(PINNED_CHROME) ? PINNED_CHROME : undefined;

let failures = 0;
function check(label, cond) { console.log((cond ? 'PASS  ' : 'FAIL  ') + label); if (!cond) failures++; }

// ---- synthesise a Lowrance .sl2 log (same format as sonar_import.spec) ----
const R = 6356752.3142, LAT0 = 45.216, LNG0 = -92.572;
const mLat = 111320, mLng = 111320 * Math.cos(LAT0 * Math.PI / 180);
function sl2(frames) {
  const buf = Buffer.alloc(8 + frames.length * 144);
  buf.writeUInt16LE(2, 0); buf.writeUInt16LE(0, 2); buf.writeUInt16LE(1970, 4);
  frames.forEach((f, i) => {
    const o = 8 + i * 144;
    buf.writeUInt32LE(o, o);
    buf.writeUInt16LE(144, o + 28);
    buf.writeUInt16LE(0, o + 32);
    buf.writeFloatLE(f.depthFt, o + 64);
    buf.writeInt32LE(Math.round(f.lng * Math.PI / 180 * R), o + 108);
    buf.writeInt32LE(Math.round(R * Math.log(Math.tan(Math.PI / 4 + f.lat * Math.PI / 360))), o + 112);
    buf.writeUInt16LE(0x0010, o + 132);
  });
  return buf;
}
const frames = [];
for (let y = -300; y <= 300; y += 25) for (let x = -300; x <= 300; x += 1)
  frames.push({ lat: LAT0 + y / mLat, lng: LNG0 + x / mLng, depthFt: Math.max(1, 32 - Math.hypot(x, y) / 10) });
const LOG = sl2(frames);

const YELLOW = { latitude: 45.94, longitude: -92.38, accuracy: 10 };
const METEO_DELAY_MS = 4000;

const browser = await chromium.launch({ executablePath: CHROME });

// A named water at Yellow Lake, so a map tap there selects it (case 2).
const YELLOW_WB = { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { GNIS_NAME: 'Yellow Lake', AREASQKM: 9.5, FTYPE: 390 },
    geometry: { type: 'Polygon', coordinates: [[[-92.42,45.92],[-92.36,45.92],[-92.36,45.96],[-92.42,45.96],[-92.42,45.92]]] } }
] };

async function newPage(opts, waters) {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 }, ...opts });
  const page = await context.newPage();
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('file://')) return route.continue();
    if (url.includes('api.open-meteo.com/v1/forecast')) {
      // Conditions arrive late, as they do on a slow connection.
      await new Promise(r => setTimeout(r, METEO_DELAY_MS));
      const nowS = Math.floor(Date.now() / 1000), time = [], sp = [];
      for (let i = -4; i <= 4; i++) { time.push(nowS + i * 3600); sp.push(1013); }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        current: { temperature_2m: 62, wind_speed_10m: 5, wind_direction_10m: 180 }, hourly: { time, surface_pressure: sp } }) }).catch(() => {});
    }
    if (waters && url.includes('hydro.nationalmap.gov') && !url.includes('MapServer/6'))
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(waters) });
    if (url.includes('/api/interpreter')) return route.abort('failed');
    if (url.includes('api.inaturalist.org'))
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [] }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#advisor-body', { timeout: 15000 });
  return { context, page, errs };
}

async function importAndShow(page) {
  await page.click('.tab[data-tab="lake"]');
  await page.waitForSelector('#sonar-card .sonar-import', { timeout: 5000 });
  await page.setInputFiles('#sonar-file', { name: 'cedar.sl2', mimeType: 'application/octet-stream', buffer: LOG });
  await page.waitForSelector('.sonar-log', { timeout: 15000 });
  await page.click('[data-sonar-show]');
}

// Painted pixels on the map's sonar canvas: zero once the map has moved away.
const painted = page => page.$eval('#advisor-map .leaflet-overlay-pane canvas', c => {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n;
}).catch(() => 0);

// 1. Show is tapped while the conditions request is still in flight.
{
  const { context, page, errs } = await newPage({});
  await importAndShow(page);
  await page.waitForTimeout(800);
  const before = await painted(page);
  console.log('painted right after Show: ' + before);
  check('Show frames the log (track on screen)', before > 20000);
  await page.waitForTimeout(METEO_DELAY_MS + 2500);
  const after = await painted(page);
  console.log('painted after the late conditions response: ' + after);
  check('a late conditions response does not pull the map off the log', after > 20000);
  check('no page errors (late response)', errs.length === 0);
  await context.close();
}

// 2. A GPS update arrives while the angler is looking at the log.
{
  const { context, page, errs } = await newPage({ geolocation: YELLOW, permissions: ['geolocation'] }, YELLOW_WB);
  await page.waitForTimeout(METEO_DELAY_MS + 1500);        // let the startup conditions land first
  await importAndShow(page);
  await page.waitForTimeout(800);
  check('Show frames the log with GPS on', (await painted(page)) > 20000);
  await context.setGeolocation({ ...YELLOW, latitude: YELLOW.latitude + 0.002 });
  await page.waitForTimeout(METEO_DELAY_MS + 2500);
  const after = await painted(page);
  console.log('painted after a GPS update: ' + after);
  check('a GPS update does not pull the map off the log', after > 20000);

  // Picking a different water is a deliberate move, so the map follows it.
  // (A tap with no named water under it changes nothing, so it keeps the hold.)
  await page.evaluate(() => window.__testHooks.selectMapPoint(45.94, -92.38));
  await page.waitForFunction(() => /Yellow Lake/.test(document.getElementById('loc').textContent), null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(METEO_DELAY_MS + 2500);
  check('picking another water releases the hold (map leaves the log)', (await painted(page)) === 0);
  check('no page errors (GPS)', errs.length === 0);
  if (errs.length) console.log(errs.join('\n'));
  await context.close();
}

await browser.close();
console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
