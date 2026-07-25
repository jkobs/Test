/* Playwright validation: the nearby-waters list filters by TRUE surface area
   and water type, not by bounding-box span.

   The old rule (MIN_LAKE_MI = 0.2, longest bbox dimension) measured the wrong
   thing in both directions:
     - it demanded ~20 acres of a COMPACT pond (a 0.2 mi diameter circle), so
       genuinely fishable mid-size ponds were silently dropped; and
     - it happily passed a ~2-acre marsh finger that merely sprawled 0.3 mi
       end to end.
   It also never excluded NHD swamp/marsh/playa types, which _nhdTypeLabel
   already recognized and then listed as fishing destinations anyway.

   New rule: exclude under MIN_LAKE_ACRES (5) of real area, exclude non-fishing
   NHD types, fall back to the (area-overstating, therefore lenient) bounding
   box when no area is reported, and NEVER exclude for missing data — the Esri
   source reports no area at all.

   Run: node test/small_water_filter.spec.mjs
*/
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = 'file://' + resolve(__dirname, '../dist/solunar.html');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let failures = 0;
function check(label, cond) { console.log((cond ? 'PASS  ' : 'FAIL  ') + label); if (!cond) failures++; }

const BASE = { lat: 45.09, lng: -92.51 };
const ACRES_PER_SQKM = 247.105;
const MI_PER_DEG_LAT = 69;
const MI_PER_DEG_LNG = 69 * Math.cos(BASE.lat * Math.PI / 180);

// Build a rectangular water `offsetMi` north of BASE, spanning latMi x lngMi.
// `acres` sets AREASQKM explicitly (null = source reports no area, like Esri).
function water(name, offsetMi, latMi, lngMi, acres, ftype = 390) {
  const cLat = BASE.lat + offsetMi / MI_PER_DEG_LAT;
  const dLat = (latMi / 2) / MI_PER_DEG_LAT;
  const dLng = (lngMi / 2) / MI_PER_DEG_LNG;
  const props = { GNIS_NAME: name, FTYPE: ftype };
  if (acres != null) props.AREASQKM = acres / ACRES_PER_SQKM;
  return { type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [[
    [BASE.lng - dLng, cLat - dLat], [BASE.lng + dLng, cLat - dLat],
    [BASE.lng + dLng, cLat + dLat], [BASE.lng - dLng, cLat + dLat],
    [BASE.lng - dLng, cLat - dLat]
  ]] } };
}

const NHD_WB = { type: 'FeatureCollection', features: [
  //      name                 offset  latMi  lngMi  acres  ftype
  water('Big Lake',              1.0,  0.90,  0.90,  200),          // control: plainly fishable
  water('Compact Pond',          2.0,  0.14,  0.14,   12),          // REGRESSION: old bbox rule dropped this
  water('Skinny Channel',        3.0,  0.012, 0.40,    2),          // sprawls, but only 2 acres
  water('Spring Pond',           4.0,  0.10,  0.10,    3),          // under the 5-acre floor
  water('Marsh Water',           5.0,  0.60,  0.60,  500,   466),   // big, but a marsh
  water('Unknown Area Lake',     6.0,  0.30,  0.30, null),          // no area reported -> keep
  water('Tiny Unknown',          7.0,  0.02,  0.02, null)           // no area, but definitely tiny
] };

const browser = await chromium.launch({ executablePath: CHROME });
const page = await (await browser.newContext()).newPage();

await page.route('**/*', async (route) => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('geocoding-api.open-meteo.com')) {
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      results: [{ name: 'Test City', admin1: 'Wisconsin', country_code: 'US',
        latitude: BASE.lat, longitude: BASE.lng, timezone: 'America/Chicago' }]
    }) });
  }
  if (url.includes('api.open-meteo.com/v1/forecast')) {
    const nowS = Math.floor(Date.now() / 1000);
    const time = [], sp = [];
    for (let i = -4; i <= 4; i++) { time.push(nowS + i * 3600); sp.push(1013); }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      current: { temperature_2m: 65, wind_speed_10m: 5, wind_direction_10m: 180 },
      hourly: { time, surface_pressure: sp }
    }) });
  }
  if (url.includes('hydro.nationalmap.gov') && !url.includes('MapServer/6'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(NHD_WB) });
  if (url.includes('hydro.nationalmap.gov') || url.includes('services.arcgis.com') || url.includes('wikipedia.org'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: [] }) });
  if (url.includes('/api/interpreter')) return route.abort('failed');
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});

await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.click('#loc-pill');                     // search stack lives in a sheet
await page.fill('#city-input', 'Test City, Wisconsin');
await page.click('#city-go');
await page.waitForSelector('.city-result', { timeout: 15000 });
await page.click('.city-result');
await page.click('.tab[data-tab="lake"]');
await page.waitForSelector('#nearby-select', { timeout: 20000 });
await page.waitForTimeout(2500);

const opts = (await page.$$eval('#nearby-select option', els => els.map(e => e.textContent))).join(' | ');
console.log('Dropdown: ' + opts);
const has = (n) => opts.includes(n);

check('fishable control lake is listed (Big Lake, 200 ac)', has('Big Lake'));
check('compact 12-acre pond is now INCLUDED (old bbox rule wrongly dropped it)', has('Compact Pond'));
check('2-acre sprawling channel is EXCLUDED despite its long bbox', !has('Skinny Channel'));
check('3-acre pond is EXCLUDED (under the 5-acre floor)', !has('Spring Pond'));
check('marsh is EXCLUDED by type even at 500 acres', !has('Marsh Water'));
check('water with NO reported area is KEPT (never drop on missing data)', has('Unknown Area Lake'));
check('water with no area but a definitely-tiny bbox is EXCLUDED', !has('Tiny Unknown'));

// Small waters must stay reachable by explicit name search — the floor is for
// browsing the nearby list, not for hiding a water the user asks for by name.
await page.click('#loc-pill');
await page.waitForTimeout(300);
const modeBtns = await page.$$('.sm-btn');
for (const b of modeBtns) {
  const t = (await b.textContent()) || '';
  if (/lake/i.test(t)) { await b.click(); break; }
}
await page.fill('#city-input', 'Spring Pond');
await page.click('#city-go');
await page.waitForTimeout(3000);
const results = await page.$eval('#city-results', el => el.textContent).catch(() => '');
console.log('Name-search results: ' + results.replace(/\s+/g, ' ').slice(0, 200));
check('a sub-floor pond is still findable by explicit name search', results.includes('Spring Pond'));

await browser.close();
console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
