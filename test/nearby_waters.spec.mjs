/* Playwright validation for the multi-source nearby-waters lookup.

   The sandbox blocks live network egress, so we intercept every data source
   (Open-Meteo geocode, USGS NHD, Esri Water Bodies, Wikipedia GeoSearch,
   Overpass) and serve canned responses shaped like the real APIs. This
   exercises the real parse -> filter -> nearest-edge-distance -> merge -> render
   path in Chromium across several source-failure scenarios.

   Run: node test/nearby_waters.spec.mjs
*/
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = 'file://' + resolve(__dirname, '../dist/solunar.html');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const ASHLAND = { lat: 46.5919, lng: -90.8835 };
const GEOCODE = {
  results: [{ name: 'Ashland', admin1: 'Wisconsin', country_code: 'US',
    latitude: ASHLAND.lat, longitude: ASHLAND.lng, timezone: 'America/Chicago' }]
};

// USGS NHD layer 12 = waterbodies (GeoJSON), layer 6 = flowlines/rivers.
const NHD_WB = { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { GNIS_NAME: 'Bass Lake', AREASQKM: 1.2, FTYPE: 390 },
    geometry: { type: 'Polygon', coordinates: [[[-90.87,46.60],[-90.84,46.60],[-90.84,46.62],[-90.87,46.62],[-90.87,46.60]]] } }
] };
const NHD_FL = { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { GNIS_NAME: 'Bad River', FTYPE: 460 },
    geometry: { type: 'LineString', coordinates: [[-90.90,46.55],[-90.80,46.62]] } }
] };
// Esri USA Water Bodies (GeoJSON), name field NAME.
const ESRI = { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { NAME: 'Long Lake' },
    geometry: { type: 'Polygon', coordinates: [[[-90.95,46.55],[-90.93,46.55],[-90.93,46.57],[-90.95,46.57],[-90.95,46.55]]] } }
] };
// Overpass
const OVP_WAYS = { elements: [
  { type: 'node', id: 1, lat: 46.65, lon: -90.85, tags: { name: 'Chequamegon Bay', natural: 'bay' } },
  { type: 'way', id: 2, bounds: { minlat: 46.55, minlon: -90.95, maxlat: 46.59, maxlon: -90.90 }, tags: { name: 'Otter Lake', natural: 'water' } },
  { type: 'way', id: 4, bounds: { minlat: 46.591, minlon: -90.884, maxlat: 46.5911, maxlon: -90.8839 }, tags: { name: 'Tiny Pond', natural: 'water' } }
] };
const OVP_RELS = { elements: [
  { type: 'relation', id: 100, bounds: { minlat: 46.4, minlon: -92.2, maxlat: 48.0, maxlon: -84.3 }, tags: { name: 'Lake Superior', natural: 'water', water: 'lake' } }
] };
// Wikipedia GeoSearch — includes real-world noise to confirm filtering.
const WIKI = { query: { geosearch: [
  { title: 'White River (Wisconsin)', lat: 46.55, lon: -90.80, dist: 6000 },
  { title: 'Swedish Evangelical Lutheran Church (Coon Lake Township)', lat: 46.60, lon: -90.90, dist: 2000 },
  { title: 'Ham Lake, Minnesota', lat: 46.57, lon: -90.82, dist: 4800 },
  { title: 'Lake Mills', lat: 46.61, lon: -90.91, dist: 3000 }
] } };

// fetchLakeInfo's detail query uses name~regex + out tags (no bb); distinguish
// it from the nearby-waters exact-match queries.
function isDetailQuery(body) { return /"name"~"/.test(body); }
function isRel(body) { return /relation\[/.test(body) && !/way\["natural"="water"\]/.test(body); }

// Overpass detail response for Bass Lake: has a wikidata QID.
const OVP_DETAIL = { elements: [
  { type: 'way', id: 9, tags: { name: 'Bass Lake', natural: 'water', wikidata: 'Q999001' } }
] };
// Wikidata entity: TWO P4511 ("depth") statements — 24 ft and 9 ft. The larger
// must become Max depth, the smaller Avg depth (mean-depth-<=-max heuristic).
const WIKIDATA_BASS = { entities: { Q999001: { claims: {
  P4511: [
    { mainsnak: { datavalue: { value: { amount: '+24', unit: 'http://www.wikidata.org/entity/Q3710' } } } },
    { mainsnak: { datavalue: { value: { amount: '+9',  unit: 'http://www.wikidata.org/entity/Q3710' } } } }
  ]
} } } };
// WI DNR fish stocking response: species + WBIC for the deep-link.
const DNR_STOCKING = { features: [
  { attributes: { SPECIES_NAME: 'Walleye', WBIC: '2345600' } },
  { attributes: { SPECIES_NAME: 'Largemouth Bass', WBIC: '2345600' } }
] };

let failures = 0;
function check(label, cond) { console.log((cond ? 'PASS  ' : 'FAIL  ') + label); if (!cond) failures++; }

// down: object of { usgs, esri, wiki, overpass } booleans (true = simulate down)
async function run(label, down) {
  console.log('\n=== ' + label + ' ===');
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await (await browser.newContext()).newPage();
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('file://')) return route.continue();
    if (url.includes('geocoding-api.open-meteo.com'))
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(GEOCODE) });
    // Pressure/weather forecast — needed so the advisor (which contains #lake-info) renders.
    if (url.includes('api.open-meteo.com/v1/forecast')) {
      const nowS = Math.floor(Date.now() / 1000);
      const time = [], sp = [];
      for (let i = -4; i <= 4; i++) { time.push(nowS + i * 3600); sp.push(1013 - i * 0.3); }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        current: { temperature_2m: 65, wind_speed_10m: 6, wind_direction_10m: 200 },
        hourly: { time: time, surface_pressure: sp }
      }) });
    }
    if (url.includes('hydro.nationalmap.gov')) {
      if (down.usgs) return route.abort('failed');
      const body = /MapServer\/6\/query/.test(url) ? NHD_FL : NHD_WB;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (url.includes('services.arcgis.com') && url.includes('USA_Water_Bodies')) {
      if (down.esri) return route.abort('failed');
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(ESRI) });
    }
    if (url.includes('wikipedia.org')) {
      if (down.wiki) return route.abort('failed');
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(WIKI) });
    }
    if (url.includes('/api/interpreter')) {
      if (down.overpass) return route.abort('failed');
      const body = decodeURIComponent(route.request().postData() || '');
      const payload = isDetailQuery(body) ? OVP_DETAIL : (isRel(body) ? OVP_RELS : OVP_WAYS);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
    }
    if (url.includes('wikidata.org')) {
      if (down.wikidata) return route.abort('failed');
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(WIKIDATA_BASS) });
    }
    if (url.includes('FM_Fish_Stocking_Public')) {
      if (down.dnr) return route.abort('failed');
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(DNR_STOCKING) });
    }
    if (url.includes('api.inaturalist.org')) {
      if (down.inat) return route.abort('failed');
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [] }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.fill('#city-input', 'Ashland, Wisconsin');
  await page.click('#city-go');
  await page.waitForSelector('.city-result', { timeout: 15000 });
  await page.click('.city-result');
  let opts = [];
  try {
    await page.waitForSelector('#nearby-select', { timeout: 20000 });
    await page.waitForTimeout(3200);
    opts = await page.$$eval('#nearby-select option', els => els.map(e => e.textContent.trim()));
  } catch (e) { /* no select rendered */ }
  const retry = await page.$('#nearby-retry');
  let lakeInfo = '';
  try { lakeInfo = (await page.$eval('#lake-info', el => el.textContent)) || ''; } catch (e) {}
  console.log('Options:'); opts.forEach(o => console.log('  - ' + o));
  if (lakeInfo) console.log('Lake info: ' + lakeInfo.replace(/\s+/g, ' ').trim());
  if (retry) console.log('  (retry button shown)');
  await browser.close();
  return { opts, joined: opts.join('\n').toLowerCase(), hasRetry: !!retry,
           lakeInfo: lakeInfo.toLowerCase() };
}

// Scenario A: all sources healthy.
const A = await run('All sources up', {});
check('A: has waters', A.opts.length >= 3);
check('A: USGS Bass Lake present', A.joined.includes('bass lake'));
check('A: Esri Long Lake present', A.joined.includes('long lake'));
check('A: Overpass Lake Superior present', A.joined.includes('lake superior'));
check('A: Wikipedia White River present', A.joined.includes('white river'));
check('A: Tiny Pond filtered by size', !A.joined.includes('tiny pond'));
check('A: church filtered out', !A.joined.includes('church'));
check('A: no retry button', !A.hasRetry);
check('A: lake-info shows USGS type (Lake/Pond)', A.lakeInfo.indexOf('lake/pond') !== -1);
check('A: lake-info shows surface area (acres)', A.lakeInfo.indexOf('acres') !== -1);
check('A: lake-info shows max depth (24 ft, larger of two P4511 values)', A.lakeInfo.indexOf('24 ft') !== -1);
check('A: lake-info shows avg depth (9 ft, smaller of two P4511 values)', A.lakeInfo.indexOf('9 ft') !== -1);
check('A: lake-info shows species present (from DNR stocking)', A.lakeInfo.indexOf('walleye') !== -1 && A.lakeInfo.indexOf('largemouth bass') !== -1);
check('A: lake-info shows WBIC report link', A.lakeInfo.indexOf('full wi dnr lake report') !== -1);

// Scenario B: Overpass down (the common failure) — others carry it.
const B = await run('Overpass down', { overpass: true });
check('B: still populated', B.opts.length >= 2 && !B.hasRetry);
check('B: USGS Bass Lake present', B.joined.includes('bass lake'));
check('B: Esri Long Lake present', B.joined.includes('long lake'));

// Scenario C (the exact user failure): Overpass AND Wikipedia both down.
// USGS + Esri (reliable govt/Esri infra) must still populate the dropdown.
const C = await run('Overpass + Wikipedia down — USGS/Esri carry it', { overpass: true, wiki: true });
check('C: dropdown populated, no retry', C.opts.length >= 1 && !C.hasRetry);
check('C: USGS Bass Lake present', C.joined.includes('bass lake'));
check('C: USGS Bad River present', C.joined.includes('bad river'));
check('C: Esri Long Lake present', C.joined.includes('long lake'));

// Scenario D: only USGS up (everything else down) — still works.
const D = await run('Only USGS up', { overpass: true, wiki: true, esri: true });
check('D: USGS alone populates dropdown', D.joined.includes('bass lake') && !D.hasRetry);

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
