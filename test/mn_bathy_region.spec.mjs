/* Playwright validation: Minnesota DNR lake-depth contours are requested for
   Minnesota waters only, not for Wisconsin lakes across the border river, and
   they come from the live MN host as labeled vectors.

   The old WMS on arcgis.dnr.state.mn.us went 404 (seen 2026-10-28) and drew
   blank tiles with no error. The contours now come from MN's enterprise host
   as GeoJSON (field abs_depth, feet) and are drawn with depth labels.

   The MN layer used to be gated by a lat/lng box (lng <= -89.4) that took in
   most of western Wisconsin, so WI lakes like Cedar and Yellow got MN tiles
   requested over them and an "MN DNR" credit on the map. The border is the
   St. Croix / Mississippi, so the region is now the real MN–WI border line
   (US Census 1:500k, simplified to 50 m), with 400 m of slack toward MN on the
   river itself.

   Run: node test/mn_bathy_region.spec.mjs
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

// Pairs facing each other across the border rivers, plus interior controls.
const MN = [['Lake Minnetonka', 44.93, -93.6], ['Chisago Lake', 45.38, -92.87], ['Big Marine Lake', 45.21, -92.89],
  ['Taylors Falls', 45.41222, -92.66444], ['Duluth', 46.7867, -92.1005], ['Lake City (Lake Pepin)', 44.449, -92.267],
  ['La Crescent', 43.828, -91.304], ['Winona', 44.0499, -91.6393], ['Grand Marais (North Shore)', 47.75, -90.33]];
const WI = [['Cedar Lake', 45.216, -92.572], ['Yellow Lake', 45.92, -92.38], ['Pepin (Lake Pepin)', 44.441, -92.148],
  ['La Crosse', 43.8138, -91.2519], ['Superior', 46.7208, -92.1041], ['Grantsburg', 45.7764, -92.6827],
  ['St. Croix Falls', 45.4097, -92.6391], ['Danbury', 46.0072, -92.2707], ['Lake Mendota', 43.105, -89.42]];

const browser = await chromium.launch({ executablePath: CHROME });
let mnTiles = 0, oldHost = 0;
// GeoJSON like the MN service returns: three nested 5 ft contours around the
// center of whatever envelope the app asked for.
function mnContours(url) {
  const [x1, y1, x2, y2] = decodeURIComponent(new URL(url).searchParams.get('geometry') || '0,0,0,0').split(',').map(Number);
  const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
  const ring = r => Array.from({ length: 41 }, (_, i) => [cx + r * 1.4 * Math.cos(i * Math.PI / 20), cy + r * Math.sin(i * Math.PI / 20)]);
  return { type: 'FeatureCollection', features: [5, 10, 15].map((d, i) => ({ type: 'Feature',
    properties: { abs_depth: d }, geometry: { type: 'MultiLineString', coordinates: [ring(0.012 - i * 0.004)] } })) };
}
// Location is driven by simulated GPS: a map tap needs a mocked waterbody
// lookup to resolve, while a GPS fix moves the map like it does on the water.
const context = await browser.newContext({ geolocation: { latitude: 45.216, longitude: -92.572 }, permissions: ['geolocation'] });
const page = await context.newPage();
await page.route('**/*', async (route) => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('arcgis.dnr.state.mn.us')) { oldHost++; return route.fulfill({ status: 404, body: 'gone' }); }
  if (url.includes('enterprise.gisdata.mn.gov') && url.includes('water_lake_bathymetry')) {
    mnTiles++; return route.fulfill({ contentType: 'application/json', body: JSON.stringify(mnContours(url)) });
  }
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
await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#advisor-body', { timeout: 15000 });

const inMN = (la, ln) => page.evaluate(([a, b]) => window.__testHooks.inMinnesotaRegion(a, b), [la, ln]);
for (const [n, la, ln] of MN) check('MN layer offered for ' + n + ', MN', await inMN(la, ln));
for (const [n, la, ln] of WI) check('no MN layer for ' + n + ', WI', !(await inMN(la, ln)));

// End to end: what the map actually requests.
// expectTiles: count from before the move, so a fast first tile can't slip in
// ahead of the reset. Otherwise count only once the move has landed, so tiles
// still loading for the previous (MN) view don't count against a WI lake.
async function tilesAt(la, ln, expectTiles) {
  if (expectTiles) mnTiles = 0;
  await context.setGeolocation({ latitude: la, longitude: ln, accuracy: 10 });
  await page.waitForFunction(([a, b]) => { const l = window.__testHooks.getLoc();
    return Math.abs(l.lat - a) < 1e-3 && Math.abs(l.lng - b) < 1e-3; }, [la, ln], { timeout: 10000 }).catch(() => {});
  if (!expectTiles) mnTiles = 0;
  await page.waitForTimeout(2500);
  return mnTiles;
}
const wiTiles = await tilesAt(45.216, -92.572);
console.log('MN tile requests at Cedar Lake (WI): ' + wiTiles);
check('at a WI lake, no MN DNR tiles are requested', wiTiles === 0);
check('no "MN DNR" credit on a WI lake', !/MN DNR/.test(await page.textContent('#advisor-map')));
const mnSeen = await tilesAt(44.93, -93.6, true);
console.log('MN tile requests at Lake Minnetonka (MN): ' + mnSeen);
check('at a MN lake, MN DNR depth tiles are still requested', mnSeen > 0);
check('"MN DNR" credit shown on a MN lake', /MN DNR/.test(await page.textContent('#advisor-map')));
const mnLabels = await page.$$eval('#advisor-map .bathy-depth-label span', els => els.map(e => +e.textContent));
console.log('MN depth labels: ' + JSON.stringify(mnLabels));
check('MN contours are drawn with depth labels', [5, 10, 15].every(d => mnLabels.includes(d)));
check('the dead WMS host is never requested', oldHost === 0);
const backWi = await tilesAt(45.92, -92.38);
console.log('MN tile requests back at Yellow Lake (WI): ' + backWi);
check('moving back to a WI lake removes the MN layer', backWi === 0 && !/MN DNR/.test(await page.textContent('#advisor-map')));
check('no MN depth labels left on a WI lake', (await page.$$('#advisor-map .bathy-depth-label')).length === 0);

await browser.close();
console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
