/* Playwright validation: same-family lake names ("Yellow Lake" vs. "Little
   Yellow Lake") don't get confused with each other.

   Real user-reported bug: standing at Yellow Lake, WI, the app's Lake tab
   showed "Little Yellow Lake" — a different, smaller nearby lake — for name,
   surface area, max depth, and lake class. Root cause: several WI DNR queries
   picked whichever feature the server returned FIRST within a 150m search
   radius, with no name check at all (classification/regulations/designated
   waters), or a name check (_nameMatch) that does an unanchored substring
   test — "littleyellowlake".indexOf("yellowlake") !== -1, so "Little Yellow
   Lake" incorrectly satisfies a match against "Yellow Lake".

   This test mocks EVERY affected endpoint returning "Little Yellow Lake"
   FIRST and the real "Yellow Lake" SECOND, and confirms the app's fixed
   name-resolution (_pickByName: exact match wins outright, regardless of
   array order) picks the correct lake everywhere — including that
   regulations/designations for the wrong lake are skipped entirely rather
   than shown, since guessing wrong there is actively misleading.

   Run: node test/lake_name_collision.spec.mjs
*/
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = 'file://' + resolve(__dirname, '../dist/solunar.html');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let failures = 0;
function check(label, cond) { console.log((cond ? 'PASS  ' : 'FAIL  ') + label); if (!cond) failures++; }

// Little Yellow Lake sits well within a wide search radius of Yellow Lake's
// centroid (45.94, -92.38) — plausible real-world proximity for this bug.
const NHD_WB = { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { GNIS_NAME: 'Little Yellow Lake', AREASQKM: 1.34, FTYPE: 390 },
    geometry: { type: 'Polygon', coordinates: [[[-92.40,45.92],[-92.39,45.92],[-92.39,45.93],[-92.40,45.93],[-92.40,45.92]]] } },
  { type: 'Feature', properties: { GNIS_NAME: 'Yellow Lake', AREASQKM: 9.24, FTYPE: 390 },
    geometry: { type: 'Polygon', coordinates: [[[-92.42,45.90],[-92.34,45.90],[-92.34,45.98],[-92.42,45.98],[-92.42,45.90]]] } }
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
  // NHD point-intersect (fetchLakeInfo's Source A) — both lakes returned,
  // wrong one (Little Yellow Lake) listed FIRST.
  if (url.includes('hydro.nationalmap.gov') && !url.includes('MapServer/6'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(NHD_WB) });
  if (url.includes('hydro.nationalmap.gov') || url.includes('services.arcgis.com'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: [] }) });
  if (url.includes('/api/interpreter')) return route.abort('failed');
  if (url.includes('FM_Fish_Stocking_Public'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [] }) });
  if (url.includes('api.inaturalist.org'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [] }) });
  // Designated waters: Walleye layer has BOTH lakes, wrong one first.
  if (url.includes('WY_FISHERIES_WATERS')) {
    const isWalleye = /WY_FISHERIES_WATERS\/MapServer\/7\/query/.test(url);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      features: isWalleye ? [
        { attributes: { ROI_SHORT_NAME: 'LITTLE YELLOW LAKE', ROI_CODE_DESC: 'Walleye Water', ROI_SUBTYPE_DESC: 'Stocked', ROI_STATUS_DESC: 'Confirmed' } },
        { attributes: { ROI_SHORT_NAME: 'YELLOW LAKE', ROI_CODE_DESC: 'Walleye Water', ROI_SUBTYPE_DESC: 'Natural Reproduction Only', ROI_STATUS_DESC: 'Confirmed' } }
      ] : []
    }) });
  }
  // WBIC lookup: both lakes, wrong one first. Real Yellow Lake WBIC = 2683700.
  if (url.includes('WY_INLAND_WATER_RESOURCES'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      features: [
        { attributes: { WATERBODY_ROW_NAME: 'Little Yellow Lake', WATERBODY_WBIC: 2683600 } },
        { attributes: { WATERBODY_ROW_NAME: 'Yellow Lake', WATERBODY_WBIC: 2683700 } }
      ]
    }) });
  if (url.includes('WY_LAKE_SATELLITE_WATER_CLARITY_RESULTS'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [] }) });
  // Regulations: ONLY the wrong lake's record is in the search radius (no
  // Yellow Lake record at all) — must be SKIPPED, not shown as if correct.
  if (url.includes('FM_WFF_LAKE_REGULATIONS_WTM_EXT'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      features: [{ attributes: { WATERBODY_NAME: 'Little Yellow Lake', WALLEYE_SAUGER_AND_HYBRIDS: 'Minimum length 10 in; daily bag 5.' } }]
    }) });
  // Classification: both lakes, wrong one first, DIFFERENT depth/class values.
  if (url.includes('FM_WFF_LAKE_CLASSIFICATIONS_WTM_EXT'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      features: [
        { attributes: { LAKE_NAME: 'Little Yellow Lake', LAKE_CLASS: 'Complex - Two Story', MAXDEP_FT: 31 } },
        { attributes: { LAKE_NAME: 'Yellow Lake', LAKE_CLASS: 'Complex - Warm - Clear', MAXDEP_FT: 47 } }
      ]
    }) });
  if (url.includes('FH_ANNUAL_STOCKING_SUMMARY'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [] }) });
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});

await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#advisor-body', { timeout: 15000 });
// Tap a point squarely inside Yellow Lake's own bounds (its picked water body
// comes from a separate USGS/Esri "nearest water" resolution not mocked with
// name collisions here — this test targets the DOWNSTREAM detail fetches,
// which is where the real bug lived).
await page.evaluate(() => window.__testHooks.selectMapPoint(45.94, -92.38));
await page.waitForTimeout(3000);

const lakeInfoText = await page.$eval('#lake-info', el => el.textContent).catch(() => '');
console.log('Lake info: ' + lakeInfoText.replace(/\s+/g, ' ').trim().slice(0, 400));

check('lake name resolves to "Yellow Lake", not "Little Yellow Lake"',
  /(^|[^a-z])Yellow Lake/i.test(lakeInfoText) &&
  (lakeInfoText.match(/Little Yellow Lake/gi) || []).length === 0);
check('surface area matches Yellow Lake (9.24 km² ≈ 2283 ac), not Little Yellow Lake (1.34 km² ≈ 331 ac)',
  lakeInfoText.includes('2283 acres'));
check('max depth matches Yellow Lake\'s classification record (47 ft), not Little Yellow Lake\'s (31 ft)',
  lakeInfoText.includes('47 ft') && !lakeInfoText.includes('31 ft'));
check('lake class matches Yellow Lake\'s record ("Complex - Warm - Clear"), not Little Yellow Lake\'s',
  lakeInfoText.includes('Complex - Warm - Clear') && !lakeInfoText.includes('Complex - Two Story'));
check('designation badge shows Yellow Lake\'s subtype ("Natural Reproduction Only"), not Little Yellow Lake\'s ("Stocked")',
  lakeInfoText.includes('Natural Reproduction Only') && !/Stocked(?!\s*\d)/.test(lakeInfoText.replace(/Stocked \d+ of/, '')));
check('regulations for the WRONG lake (no real match in radius) are skipped, not shown as fact',
  !lakeInfoText.includes('Minimum length 10 in'));

const wbicHref = await page.$eval('.lake-info-link', el => el.href).catch(() => '');
console.log('Report link: ' + wbicHref);
check('WBIC report link uses Yellow Lake\'s WBIC (2683700), not Little Yellow Lake\'s (2683600)',
  wbicHref.includes('wbic=2683700'));

await browser.close();
console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
