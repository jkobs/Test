/* Playwright validation: the nearby-waters dropdown isn't truncated to only
   15 results, which silently capped the effective search range well inside
   the actual 20 mi radius in lake-dense areas.

   Reproduces the exact bug from a live screenshot: in a dense lake region,
   the dropdown stopped at exactly the 15th-closest water (~8.8 mi) even
   though the underlying search covers 20 mi — so a real, named lake within
   10 mi (Perch Lake) never had a chance to appear because 15+ other waters
   were closer.

   This test mocks 25 named lakes at increasing distances (some beyond the
   old 15-item cap but still well within 20 mi) and confirms all of them
   surface in the dropdown.

   Run: node test/nearby_waters_cap.spec.mjs
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
// 25 lakes spaced ~0.7 mi apart, so #20 ("Lake 20") sits at ~14 mi — well
// past the old 15-result cap's effective range, still well inside 20 mi.
const LAKES = [];
for (let i = 1; i <= 25; i++) {
  const dLat = (i * 0.7) / 69; // ~0.7 mi steps northward
  LAKES.push({
    type: 'Feature',
    properties: { GNIS_NAME: 'Lake ' + i, AREASQKM: 1.0, FTYPE: 390 },
    geometry: { type: 'Polygon', coordinates: [[
      [BASE.lng - 0.01, BASE.lat + dLat - 0.01], [BASE.lng + 0.01, BASE.lat + dLat - 0.01],
      [BASE.lng + 0.01, BASE.lat + dLat + 0.01], [BASE.lng - 0.01, BASE.lat + dLat + 0.01],
      [BASE.lng - 0.01, BASE.lat + dLat - 0.01]
    ]] }
  });
}
const NHD_WB = { type: 'FeatureCollection', features: LAKES };

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
// The search stack lives in a sheet toggled by #loc-pill (Stage 2 header
// collapse) — open it before the first search interaction.
await page.click('#loc-pill');
await page.fill('#city-input', 'Test City, Wisconsin');
await page.click('#city-go');
await page.waitForSelector('.city-result', { timeout: 15000 });
await page.click('.city-result');
await page.click('.tab[data-tab="lake"]');
await page.waitForSelector('#nearby-select', { timeout: 20000 });
await page.waitForTimeout(2500);

const opts = await page.$$eval('#nearby-select option', els => els.map(e => e.textContent));
console.log('Result count: ' + opts.length);
console.log('Last few: ' + opts.slice(-5).join(' | '));

check('more than 15 results returned (old cap)', opts.length > 15);
check('a lake ~14 mi out (Lake 20) is present, not truncated', opts.some(o => o.includes('Lake 20')));
check('a lake near the 20 mi edge (Lake 25, ~17.5 mi) is present', opts.some(o => o.includes('Lake 25')));

await browser.close();
console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
