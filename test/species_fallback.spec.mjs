/* Playwright validation: when the real recorded species at a lake don't
   overlap our 12 curated gamefish species (e.g. the only confirmed record is
   "Mooneye", a real but non-gamefish species), the Bite Conditions dropdown
   and Species Outlook list must fall back to showing all species rather than
   going empty/broken.

   This reproduces the exact bug seen in a live screenshot: "Species present:
   Mooneye" showed correctly, but "SPECIES OUTLOOK" below it showed
   'No species match ""' (empty list) and the Bite Conditions dropdown had no
   visible options — both because none of the 12 curated species matched
   "Mooneye".

   Run: node test/species_fallback.spec.mjs
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
  { type: 'Feature', properties: { GNIS_NAME: 'Bass Lake', AREASQKM: 1.5, FTYPE: 390 },
    geometry: { type: 'Polygon', coordinates: [[[-92.40,45.93],[-92.36,45.93],[-92.36,45.95],[-92.40,45.95],[-92.40,45.93]]] } }
] };

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
  if (url.includes('FM_Fish_Stocking_Public'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [] }) }); // no DNR stocking records
  if (url.includes('api.inaturalist.org')) {
    // The ONLY real observation nearby is a non-gamefish species.
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [
      { taxon: { preferred_common_name: 'Mooneye' } }
    ] }) });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});

await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#advisor-body', { timeout: 15000 });

// Select "Bass Lake" via the map-tap test hook (USGS resolves it).
await page.evaluate(() => window.__testHooks.selectMapPoint(45.94, -92.38));
await page.waitForTimeout(3000); // let lake-info + species fetches settle

const lakeInfoText = await page.$eval('#lake-info', el => el.textContent).catch(() => '');
console.log('Lake info: ' + lakeInfoText.replace(/\s+/g, ' ').trim());
check('lake-info shows the real species (Mooneye)', lakeInfoText.includes('Mooneye'));

const dropdownOptions = await page.$$eval('#conditions-species-select option', els => els.map(e => e.textContent));
console.log('Bite Conditions dropdown options: ' + JSON.stringify(dropdownOptions));
check('Bite Conditions dropdown is NOT empty (was broken before fix)', dropdownOptions.length > 0);
check('Bite Conditions dropdown falls back to the full curated species list (13 incl. salmon)', dropdownOptions.length === 13);

const outlookText = await page.$eval('#species-rows', el => el.textContent).catch(() => '');
console.log('Species Outlook rows text (first 150 chars): ' + outlookText.slice(0, 150));
check('Species Outlook is NOT the broken empty-match message', !outlookText.includes('No species match'));
check('Species Outlook shows real curated species (e.g. Walleye) as fallback', outlookText.includes('Walleye'));

const badgeText = await page.$eval('.species-source-badge', el => el.textContent).catch(() => '');
console.log('Species source badge: ' + badgeText);
check('Badge honestly says "All species" (not falsely claiming lake-specific filtering)', badgeText.includes('All species'));

await browser.close();
console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
