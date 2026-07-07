/* Playwright validation: WI DNR designated-waters data flows into the app.

   Reproduces the real Cedar Lake gap found on the user's device: the lake is
   a DNR-confirmed "Walleye Water · Natural Reproduction Only", but walleye
   were never stocked there, so the stocking-record query returned nothing and
   the app showed no walleye at all. This test mocks the endpoints discovered
   by the on-device probes (tools/probe.html) with the real field shapes from
   their sample records and confirms:
     1. the designation badge renders in the lake-info card,
     2. Walleye joins the species list in the official DNR bucket,
     3. WBIC resolved from the 24K hydrography layer powers the report link,
     4. satellite water clarity (most recent year) shows in the info grid,
     5. the lake-regulations presence note renders.

   Run: node test/dnr_designations.spec.mjs
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
  { type: 'Feature', properties: { GNIS_NAME: 'Cedar Lake', AREASQKM: 4.53, FTYPE: 390 },
    geometry: { type: 'Polygon', coordinates: [[[-92.60,45.19],[-92.54,45.19],[-92.54,45.25],[-92.60,45.25],[-92.60,45.19]]] } }
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
  // Source-of-truth regression: Wikidata claims Cedar Lake is 28 ft deep (a
  // stale/wrong crowd-sourced value); the WI DNR's own surveyed classification
  // below says 32 ft (matches the real embedded DNR lake-report page). The DNR
  // figure must win regardless of which async source answers first — so
  // Wikidata is wired to resolve via a real Overpass->wikidata.org chain here.
  if (url.includes('/api/interpreter')) {
    const body = decodeURIComponent(route.request().postData() || '');
    if (body.indexOf('Cedar Lake') !== -1 && body.indexOf('out tags;') !== -1) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        elements: [{ type: 'way', tags: { natural: 'water', name: 'Cedar Lake', wikidata: 'Q_CEDAR_TEST' } }]
      }) });
    }
    return route.abort('failed'); // other Overpass calls (nearby-waters fallback) — USGS/Esri already answer
  }
  if (url.includes('wikidata.org') && url.includes('Q_CEDAR_TEST'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      entities: { Q_CEDAR_TEST: { claims: { P4511: [
        { mainsnak: { datavalue: { value: { amount: '28', unit: 'http://www.wikidata.org/entity/Q3710' } } } }
      ] } } }
    }) });
  // Stocking records: EMPTY — the whole point is walleye were never stocked here.
  if (url.includes('FM_Fish_Stocking_Public'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [] }) });
  if (url.includes('api.inaturalist.org'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [] }) });
  // Designated waters: Walleye Waters layer (7) has Cedar Lake; other layers empty.
  if (url.includes('WY_FISHERIES_WATERS')) {
    const isWalleye = /WY_FISHERIES_WATERS\/MapServer\/7\/query/.test(url);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      features: isWalleye ? [{ attributes: {
        ROI_CODE: 'WALLEYE', ROI_SHORT_NAME: 'CEDAR LAKE', WBIC: '2615100',
        ROI_STATUS_DESC: 'Confirmed', ROI_SUBTYPE_DESC: 'Natural Reproduction Only',
        ROI_CODE_DESC: 'Walleye Water'
      } }] : []
    }) });
  }
  // 24K hydrography: WBIC lookup.
  if (url.includes('WY_INLAND_WATER_RESOURCES'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      features: [{ attributes: { WATERBODY_ROW_NAME: 'Cedar Lake', WATERBODY_WBIC: 2615100 } }]
    }) });
  // Satellite clarity: two years on file; most recent must win.
  if (url.includes('WY_LAKE_SATELLITE_WATER_CLARITY_RESULTS'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      features: [
        { attributes: { SATELLITE_CLARITY_FEET: 4.34, YEAR: 2004 } },
        { attributes: { SATELLITE_CLARITY_FEET: 9.84, YEAR: 2017 } }
      ]
    }) });
  // Lake regulations with a real per-species field (probe round 4 schema).
  if (url.includes('FM_WFF_LAKE_REGULATIONS_WTM_EXT'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      features: [{ attributes: { ID: 1, WBIC: 2615100, WATERBODY_NAME: 'Cedar Lake',
        WALLEYE_SAUGER_AND_HYBRIDS: 'Minimum length 15 in; daily bag limit 3.',
        PANFISH: 'See Panfish.' /* cross-ref, should be filtered out */ } }]
    }) });
  // Lake classification (fish-community type + fishery note + max depth).
  if (url.includes('FM_WFF_LAKE_CLASSIFICATIONS_WTM_EXT'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      features: [{ attributes: { LAKE_CLASS: 'Complex - Riverine', MAXDEP_FT: 32,
        FISHERIES: 'Complex riverine lakes often support great fisheries for walleye.' } }]
    }) });
  // Annual stocking history keyed by WBIC (STOCKING_RECORDS_JSON blob).
  if (url.includes('FH_ANNUAL_STOCKING_SUMMARY'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      features: [{ attributes: { WBIC: 2615100, WATERBODY_NAME: 'Cedar Lake',
        STOCKING_RECORDS_JSON: JSON.stringify([
          { year: 2025, species: 'WALLEYE', number_stocked: 5000 },
          { year: 2023, species: 'MUSKELLUNGE', number_stocked: 300 },
          { year: 2021, species: 'WALLEYE', number_stocked: 4800 }
        ]) } }]
    }) });
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});

await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#advisor-body', { timeout: 15000 });
await page.evaluate(() => window.__testHooks.selectMapPoint(45.216, -92.571));
await page.waitForTimeout(3000);

const lakeInfoText = await page.$eval('#lake-info', el => el.textContent).catch(() => '');
console.log('Lake info: ' + lakeInfoText.replace(/\s+/g, ' ').trim().slice(0, 400));

check('designation badge renders (Walleye Water)',
  lakeInfoText.includes('Walleye Water'));
check('badge shows natural-reproduction subtype + confirmed status',
  lakeInfoText.includes('Natural Reproduction Only') && lakeInfoText.includes('Confirmed'));
check('Walleye appears as a species chip in the official DNR bucket',
  await page.$$eval('.species-group', els => {
    const g = els.find(e => e.textContent.includes('WI DNR record'));
    return !!g && g.textContent.includes('Walleye');
  }).catch(() => false));
check('water clarity row shows most recent year (9.8 ft, 2017 — not 2004)',
  lakeInfoText.includes('9.8 ft') && lakeInfoText.includes('2017') && !lakeInfoText.includes('4.3 ft'));
check('WBIC report link resolved from 24K hydrography (not stocking)',
  await page.$eval('.lake-info-link', el => el.href).then(h => h.includes('wbic=2615100')).catch(() => false));
check('real per-species regulation text renders (not just presence note)',
  lakeInfoText.includes('Minimum length 15 in') && lakeInfoText.includes('Walleye'));
check('cross-reference "See Panfish." regs are filtered out as noise',
  !lakeInfoText.includes('See Panfish'));
check('lake classification + fishery note render',
  lakeInfoText.includes('Complex - Riverine') && lakeInfoText.includes('support great fisheries'));
// Source-of-truth regression: Wikidata says 28 ft (mocked, stale/wrong); WI
// DNR's own survey says 32 ft (matches the real embedded lake-report page).
// The DNR figure must win regardless of which async fetch resolves first.
check('WI DNR surveyed max depth (32 ft) wins over conflicting Wikidata value (28 ft)',
  lakeInfoText.includes('32 ft') && !lakeInfoText.includes('28 ft'));
// Real-world follow-up: the WI DNR's OWN classification dataset can disagree
// with its separate public lake-report page (confirmed on-device: 28 ft vs
// 32 ft for an actual lake, both "official" WI DNR data with no code-level
// tie-breaker). Max depth and lake class are now source-attributed so that
// disagreement reads as "two datasets differ," not an app bug.
// Restyled to a 2-column inset stat-tile grid (.lake-info-grid/.lake-info-item
// -> .lake-stat-grid/.lake-stat-tile) as part of the Lake tab visual
// restructure; the attribution-text assertion itself is unchanged.
check('max depth stat is attributed to the DNR classification survey',
  await page.$$eval('.lake-stat-tile', els => {
    const item = els.find(e => e.textContent.includes('Max depth'));
    return !!item && item.textContent.includes('DNR lake classification survey');
  }).catch(() => false));
check('lake class stat is attributed to the DNR classification survey',
  await page.$$eval('.lake-stat-tile', els => {
    const item = els.find(e => e.textContent.includes('Lake class'));
    return !!item && item.textContent.includes('DNR lake classification survey');
  }).catch(() => false));
check('stocking-history summary renders (N of last 15 years + species)',
  /Stocked \d+ of the last 15 years/.test(lakeInfoText) && lakeInfoText.includes('Muskellunge'));

// The embedded DNR depth-map viewer must be present, pointed at the WBIC.
check('embedded WI DNR lake-map iframe present, keyed by WBIC',
  await page.$eval('.lake-map-frame', el => el.getAttribute('src'))
    .then(src => src.includes('LakeDetail.aspx') && src.includes('wbic=2615100')).catch(() => false));

// Species outlook must now include Walleye (it was invisible pre-fix).
const outlookText = await page.$eval('#species-rows', el => el.textContent).catch(() => '');
check('species outlook includes Walleye guidance', outlookText.includes('Walleye'));

await browser.close();
console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
