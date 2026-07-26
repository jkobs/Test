/* Playwright validation: a lake with a digitised DNR survey sheet gets its
   depth contours overlaid on the map, positioned by WBIC.

   Wisconsin publishes no bathymetry map service (settled by probe round 10), so
   these overlays are scanned survey sheets that have been georeferenced against
   satellite imagery and masked to their own shoreline (tools/bathy/). Cedar Lake
   (WBIC 2615100, 1960 sheet) is the first.

   The WBIC arrives from an async DNR lookup AFTER the map has already been
   drawn, so the overlay must be added when it lands — not only at map init.

   Run: node test/bathy_overlay.spec.mjs
*/
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = 'file://' + resolve(__dirname, '../dist/solunar.html');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let failures = 0;
function check(label, cond) { console.log((cond ? 'PASS  ' : 'FAIL  ') + label); if (!cond) failures++; }

// Cedar Lake sits at roughly 45.216, -92.572 (established by aligning the sheet
// against satellite imagery).
const LAT = 45.216, LNG = -92.572;
const NHD_WB = { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { GNIS_NAME: 'Cedar Lake', AREASQKM: 4.45, FTYPE: 390 },
    geometry: { type: 'Polygon', coordinates: [[[-92.588,45.200],[-92.558,45.200],
      [-92.558,45.233],[-92.588,45.233],[-92.588,45.200]]] } }
] };

async function load(wbic) {
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await (await browser.newContext()).newPage();
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('file://')) return route.continue();
    if (url.includes('api.open-meteo.com/v1/forecast')) {
      const nowS = Math.floor(Date.now() / 1000);
      const time = [], sp = [];
      for (let i = -4; i <= 4; i++) { time.push(nowS + i * 3600); sp.push(1013); }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        current: { temperature_2m: 62, wind_speed_10m: 5, wind_direction_10m: 180 },
        hourly: { time, surface_pressure: sp }
      }) });
    }
    // WY_INLAND_WATER_RESOURCES layer 3 is where the app resolves WBIC.
    if (url.includes('WY_INLAND_WATER_RESOURCES')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        features: wbic ? [{ attributes: { WATERBODY_ROW_NAME: 'Cedar Lake', WATERBODY_WBIC: wbic } }] : []
      }) });
    }
    if (url.includes('hydro.nationalmap.gov') && !url.includes('MapServer/6'))
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(NHD_WB) });
    if (url.includes('hydro.nationalmap.gov') || url.includes('services.arcgis.com'))
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: [] }) });
    if (url.includes('/api/interpreter')) return route.abort('failed');
    if (url.includes('FM_Fish_Stocking_Public') || url.includes('FM_TROUT_REGS'))
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [] }) });
    if (url.includes('api.inaturalist.org'))
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [] }) });
    // Map tiles and the overlay PNG itself aren't reachable offline; the app
    // must not depend on them loading.
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#advisor-body', { timeout: 15000 });
  await page.evaluate(([la, ln]) => window.__testHooks.selectMapPoint(la, ln), [LAT, LNG]);
  await page.waitForTimeout(3500);
  // Match the LOCAL asset only. A plain 'bathy' substring also catches MN DNR's
  // water_lake_bathymetry WMS tiles, which are requested for lakes near the
  // border and would mask a real failure.
  const overlays = await page.$$eval('#advisor-map img',
    els => els.map(e => e.getAttribute('src') || '')
              .filter(s => /(^|\/)bathy\/\d+\.png$/.test(s)));
  const wbicSeen = await page.evaluate(() => (window.__testHooks.getLoc && 1) ? null : null);
  await browser.close();
  return { overlays, errs };
}

// ---------- 1. A lake WITH a digitised sheet gets the overlay ----------
const withSheet = await load(2615100);
console.log('  overlay srcs: ' + JSON.stringify(withSheet.overlays));
check('survey overlay is added for WBIC 2615100', withSheet.overlays.length === 1);
check('overlay points at the per-WBIC asset', /bathy\/2615100\.png$/.test(withSheet.overlays[0] || ''));
check('no uncaught page errors', withSheet.errs.length === 0);

// ---------- 2. A lake WITHOUT one gets no overlay ----------
const without = await load(9999999);
console.log('  overlay srcs: ' + JSON.stringify(without.overlays));
check('no overlay for a WBIC we have not digitised', without.overlays.length === 0);
check('no uncaught page errors', without.errs.length === 0);

// ---------- 3. Bounds are sane and match the georeferenced sheet ----------
const browser = await chromium.launch({ executablePath: CHROME });
const p = await (await browser.newContext()).newPage();
await p.route('**/*', r => r.request().url().startsWith('file://') ? r.continue()
  : r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
await p.goto(APP, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(600);
const b = await p.evaluate(() => {
  const m = /'2615100':\s*\{[^}]*bounds:\s*\[\[([-\d.]+),\s*([-\d.]+)\],\s*\[([-\d.]+),\s*([-\d.]+)\]\]/
    .exec(document.documentElement.innerHTML);
  return m ? m.slice(1).map(Number) : null;
});
await browser.close();
console.log('  bounds parsed: ' + JSON.stringify(b));
check('overlay bounds are present in the build', !!b);
if (b) {
  const [s, w, n, e] = b;
  check('bounds bracket Cedar Lake latitude', s < LAT && LAT < n);
  check('bounds bracket Cedar Lake longitude', w < LNG && LNG < e);
  // ~2.3 mi tall, ~1.4 mi wide at this latitude — a 1,100 acre lake.
  check('bounds span a plausible lake extent (0.02-0.05 deg lat)', (n - s) > 0.02 && (n - s) < 0.05);
}

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
