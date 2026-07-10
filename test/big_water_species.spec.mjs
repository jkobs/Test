/* Playwright validation: on a Great Lakes-scale water the species list must be
   genuinely lake-filtered (Great Lakes baseline + widened, name-anchored DNR
   stocking radius) instead of silently falling back to "all species", which is
   the exact bug from a live report ("Lake Superior is not showing any salmon").

   This test validates the big-water fix: the 5km cap was too tight for huge
   lakes, causing species lookups to find nothing. The fix removes the cap at
   source and has each consumer clamp to its own safe maximum: lake-info ~5 km,
   DNR stocking 30 km, iNaturalist 12 km. Additionally, Great Lakes are seeded
   with a curated baseline so they are never empty even if point-radius lookups
   return nothing.

   Run: node test/big_water_species.spec.mjs
*/
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = 'file://' + resolve(__dirname, '../dist/solunar.html');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let failures = 0;
function check(label, cond) { console.log((cond ? 'PASS  ' : 'FAIL  ') + label); if (!cond) failures++; }

const browser = await chromium.launch({ executablePath: CHROME });
const page = await (await browser.newContext()).newPage();

const NHD_WB = { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { GNIS_NAME: 'Lake Superior', AREASQKM: 8000, FTYPE: 390 },
    geometry: { type: 'Polygon', coordinates: [[[-91.5,46.5],[-90.5,46.5],[-90.5,47.5],[-91.5,47.5],[-91.5,46.5]]] } }
] };

let stockingUrl = '';
let inatUrl = '';

await page.route('**/*', async (route) => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
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
  if (url.includes('hydro.nationalmap.gov') || url.includes('services.arcgis.com'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: [] }) });
  if (url.includes('/api/interpreter')) return route.abort('failed');
  if (url.includes('FM_Fish_Stocking_Public')) {
    stockingUrl = url;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [
      { attributes: { SPECIES_NAME: 'BROWN TROUT' } }
    ] }) });
  }
  if (url.includes('api.inaturalist.org')) {
    inatUrl = url;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [] }) });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});

await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#advisor-body', { timeout: 15000 });

// Select a point inside Lake Superior's polygon via the map-tap test hook.
await page.evaluate(() => window.__testHooks.selectMapPoint(46.8, -91.0));
await page.waitForTimeout(3000); // let lake-info + species fetches settle

// Log the captured URLs for debuggability.
console.log('Stocking URL: ' + stockingUrl);
console.log('iNaturalist URL: ' + inatUrl);

// Check 1: DNR stocking request used the widened 30 km radius.
check('DNR stocking request used 30 km radius', stockingUrl.includes('distance=30000'));

// Check 2: iNaturalist request used the 12 km cap.
check('iNaturalist request used 12 km cap', inatUrl.includes('radius=12.0'));

// Check 3: Species dropdown includes Chinook/Coho Salmon (the reported bug).
const dropdownOptions = await page.$$eval('#conditions-species-select option', els => els.map(e => e.textContent));
console.log('Species dropdown options: ' + JSON.stringify(dropdownOptions));
check('Species dropdown includes Chinook/Coho Salmon', dropdownOptions.includes('Chinook/Coho Salmon'));

// Check 4: List is genuinely filtered (not the all-species fallback).
check('Does NOT include Largemouth Bass (genuinely filtered)', !dropdownOptions.includes('Largemouth Bass'));
check('Does NOT include Crappie (genuinely filtered)', !dropdownOptions.includes('Crappie'));
check('Does NOT include Flathead Catfish (genuinely filtered)', !dropdownOptions.includes('Flathead Catfish'));

// Check 5: Exactly 8 options (the Superior baseline).
check('Exactly 8 options (Superior baseline)', dropdownOptions.length === 8);

// Check 6: Badge shows "Lake Superior" and NOT "All species".
const badgeText = await page.$eval('.species-source-badge', el => el.textContent).catch(() => '');
console.log('Species source badge: ' + badgeText);
check('Badge includes Lake Superior', badgeText.includes('Lake Superior'));
check('Badge does NOT say "All species"', !badgeText.includes('All species'));

await browser.close();
console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
