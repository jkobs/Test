/* Playwright validation: species are labeled with their actual source and
   confidence level, instead of one flat "Species present" list implying
   equal certainty for every entry.

   Direct response to user feedback on a live screenshot (Perch Lake): DNR
   stocking records and iNaturalist citizen sightings were being presented
   identically, with no way to tell an official government record apart
   from a single unverified photo observation. This test mocks a lake with
   ONE DNR-stocked species and ONE iNaturalist-only species and confirms
   they're labeled and worded distinctly, with explicit caveat language.

   Run: node test/species_source_citation.spec.mjs
*/
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = 'file://' + resolve(__dirname, '../dist/solunar.html');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let failures = 0;
function check(label, cond) { console.log((cond ? 'PASS  ' : 'FAIL  ') + label); if (!cond) failures++; }

const NHD_WB = { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { GNIS_NAME: 'Perch Lake', AREASQKM: 0.18, FTYPE: 390 },
    geometry: { type: 'Polygon', coordinates: [[[-92.40,45.93],[-92.39,45.93],[-92.39,45.94],[-92.40,45.94],[-92.40,45.93]]] } }
] };

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
    // Official DNR record: only Black Crappie was ever stocked here.
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [
      { attributes: { SPECIES_NAME: 'Black Crappie', WBIC: '1234567' } }
    ] }) });
  }
  if (url.includes('api.inaturalist.org')) {
    // A citizen sighting of a species DNR never stocked here.
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [
      { taxon: { preferred_common_name: 'River Redhorse' } }
    ] }) });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});

await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#advisor-body', { timeout: 15000 });
await page.evaluate(() => window.__testHooks.selectMapPoint(45.935, -92.395));
await page.waitForTimeout(3000);

const lakeInfoText = await page.$eval('#lake-info', el => el.textContent).catch(() => '');
console.log('Lake info: ' + lakeInfoText.replace(/\s+/g, ' ').trim());

check('DNR-stocked species labeled distinctly ("Stocked · WI DNR record")',
  lakeInfoText.includes('Stocked · WI DNR record') && lakeInfoText.includes('Black Crappie'));
check('iNaturalist-only species labeled as unverified, NOT claimed as confirmed',
  lakeInfoText.includes('Reported nearby · unverified') && lakeInfoText.includes('River Redhorse'));
// textContent has no HTML tags, so bound each species claim by the position
// of the NEXT section header rather than by a tag boundary.
var dnrIdx = lakeInfoText.indexOf('Stocked · WI DNR record');
var unverifiedIdx = lakeInfoText.indexOf('Reported nearby · unverified');
var dnrSection = lakeInfoText.slice(dnrIdx, unverifiedIdx === -1 ? undefined : unverifiedIdx);
var unverifiedSection = unverifiedIdx === -1 ? '' : lakeInfoText.slice(unverifiedIdx);
check('DNR-only species does NOT appear in the unverified bucket',
  !unverifiedSection.includes('Black Crappie'));
check('unverified species does NOT appear in the DNR-confirmed bucket',
  !dnrSection.includes('River Redhorse'));
check('explicit caveat that neither source is a full species survey',
  lakeInfoText.toLowerCase().includes('is a full survey') || lakeInfoText.toLowerCase().includes('not independently confirmed'));

// Check the actual DOM structure gives the low-confidence entry a distinct class.
const lowConfEl = await page.$('.chip.low');
check('low-confidence species block has distinct CSS class for visual de-emphasis', !!lowConfEl);

await browser.close();
console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
