/* Playwright validation: DNR stocking history feeds species filtering, and only
   RECENT stocking counts as evidence.

   Background: stocking evidence came from FM_Fisheries/FM_Fish_Stocking_Public
   until DNR removed that service (404). Because the app treats a failed request
   as "no records", stocking silently dropped out of species filtering — caught
   by the live contract check on its first run. Stocking now comes from
   FH_ANNUAL_STOCKING_SUMMARY keyed by the lake's exact WBIC. That data was
   already fetched for the lake card's "Stocked N of the last 15 years" line but
   only displayed; it now also counts as a confirmed WI DNR record.

   Only the last 15 years count (STOCKING_EVIDENCE_YEARS), matching that card
   line: a walleye stocking two years ago is evidence they're there, a muskie
   stocking three decades ago is not.

   Run: node test/stocking_evidence.spec.mjs
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

const NOW = new Date().getFullYear();
const NHD_WB = { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { GNIS_NAME: 'Bass Lake', AREASQKM: 1.5, FTYPE: 390 },
    geometry: { type: 'Polygon', coordinates: [[[-92.40,45.93],[-92.36,45.93],[-92.36,45.95],[-92.40,45.95],[-92.40,45.93]]] } }
] };

async function load(stocking) {
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await (await browser.newContext()).newPage();
  let deadCalled = false;
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
    if (url.includes('WY_INLAND_WATER_RESOURCES'))
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [
        { attributes: { WATERBODY_ROW_NAME: 'Bass Lake', WATERBODY_WBIC: 1111111 } }] }) });
    if (url.includes('FH_ANNUAL_STOCKING_SUMMARY'))
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [
        { attributes: { WBIC: 1111111, STOCKING_RECORDS_JSON: JSON.stringify(stocking) } }] }) });
    if (url.includes('FM_Fish_Stocking_Public')) deadCalled = true;
    if (url.includes('FM_TROUT_REGS'))
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [] }) });
    if (url.includes('hydro.nationalmap.gov') && !url.includes('MapServer/6'))
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(NHD_WB) });
    if (url.includes('hydro.nationalmap.gov') || url.includes('services.arcgis.com'))
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: [] }) });
    if (url.includes('/api/interpreter')) return route.abort('failed');
    if (url.includes('api.inaturalist.org'))
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [] }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#advisor-body', { timeout: 15000 });
  await page.evaluate(() => window.__testHooks.selectMapPoint(45.94, -92.38));
  await page.waitForTimeout(3200);
  const opts = await page.$$eval('#conditions-species-select option', els => els.map(e => e.textContent));
  const confirmed = await page.$$eval('.species-group', els => {
    const g = els.find(e => /WI DNR record/.test(e.textContent));
    return g ? g.textContent : '';
  }).catch(() => '');
  const badge = await page.$eval('.species-source-badge', el => el.textContent).catch(() => '');
  await browser.close();
  return { opts, confirmed, badge, deadCalled };
}

// ---------- 1. Recent stocking is evidence; old stocking is not ----------
const mixed = await load([
  { year: NOW - 2,  species: 'WALLEYE',     number_stocked: 5000 },
  { year: NOW - 30, species: 'MUSKELLUNGE', number_stocked: 300 }
]);
console.log('  dropdown: ' + JSON.stringify(mixed.opts));
console.log('  confirmed group: ' + mixed.confirmed.replace(/\s+/g, ' ').slice(0, 120));
check('recently stocked Walleye is a confirmed WI DNR record', /Walleye/.test(mixed.confirmed));
check('Muskellunge stocked 30 years ago is NOT counted as evidence', !/Muskellunge/.test(mixed.confirmed));
check('species list is filtered to the evidence (Walleye offered)', mixed.opts.includes('Walleye'));
check('...and old stocking does not add Muskellunge to the filter', !mixed.opts.includes('Muskellunge'));
check('badge claims lake-specific filtering', !/All species/.test(mixed.badge));
check('the removed FM_Fish_Stocking_Public service is never called', mixed.deadCalled === false);

// ---------- 2. Only ancient stocking -> no evidence, honest fallback ----------
const old = await load([{ year: NOW - 40, species: 'WALLEYE', number_stocked: 2000 }]);
console.log('  old-only badge: ' + old.badge);
check('stocking only from 40 years ago yields no confirmed records', !/Walleye/.test(old.confirmed));
check('badge honestly says "All species" when there is no recent evidence', /All species/.test(old.badge));

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
