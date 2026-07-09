/* Playwright validation for the top-of-page "jump to a nearby lake" dropdown.

   This is a quick-access duplicate of the Lake-tab "Nearby waters" dropdown,
   surfaced next to the city search box so it's visible without switching
   tabs. It reuses state.nearbyWaters / selectWater, so we exercise the same
   network-mock setup as test/nearby_waters.spec.mjs to get real waters
   populated, then assert on #lake-jump-select directly.

   Run: node test/lake_jump.spec.mjs
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
  { type: 'way', id: 2, bounds: { minlat: 46.55, minlon: -90.95, maxlat: 46.59, maxlon: -90.90 }, tags: { name: 'Otter Lake', natural: 'water' } }
] };
const OVP_RELS = { elements: [
  { type: 'relation', id: 100, bounds: { minlat: 46.4, minlon: -92.2, maxlat: 48.0, maxlon: -84.3 }, tags: { name: 'Lake Superior', natural: 'water', water: 'lake' } }
] };
// Wikipedia GeoSearch.
const WIKI = { query: { geosearch: [
  { title: 'White River (Wisconsin)', lat: 46.55, lon: -90.80, dist: 6000 }
] } };

function isDetailQuery(body) { return /"name"~"/.test(body); }
function isRel(body) { return /relation\[/.test(body) && !/way\["natural"="water"\]/.test(body); }

let failures = 0;
function check(label, cond) { console.log((cond ? 'PASS  ' : 'FAIL  ') + label); if (!cond) failures++; }

const browser = await chromium.launch({ executablePath: CHROME });
const page = await (await browser.newContext()).newPage();
await page.route('**/*', async (route) => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('geocoding-api.open-meteo.com'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(GEOCODE) });
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
    const body = /MapServer\/6\/query/.test(url) ? NHD_FL : NHD_WB;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  }
  if (url.includes('services.arcgis.com') && url.includes('USA_Water_Bodies'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(ESRI) });
  if (url.includes('wikipedia.org'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(WIKI) });
  if (url.includes('/api/interpreter')) {
    const body = decodeURIComponent(route.request().postData() || '');
    const payload = isDetailQuery(body) ? { elements: [] } : (isRel(body) ? OVP_RELS : OVP_WAYS);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
  }
  if (url.includes('wikidata.org'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entities: {} }) });
  if (url.includes('FM_Fish_Stocking_Public'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [] }) });
  if (url.includes('api.inaturalist.org'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [] }) });
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});

await page.goto(APP, { waitUntil: 'domcontentloaded' });

// (a) Before city search: #lake-jump-select should exist at the top even
// before any tab is clicked (it's not inside a tab-panel), with a
// "Finding nearby lakes…" placeholder since state.nearbyWaters is empty.
const initialText = await page.$eval('#lake-jump-select', el => el.options[0].textContent);
check('placeholder before waters load', /finding nearby lakes/i.test(initialText));

// City search + waters load. Note: #lake-jump lives outside any tab-panel,
// so it's visible/queryable without clicking the "lake" tab (unlike
// #nearby-select on the Lake tab, which needs the tab click per CLAUDE.md).
// The search stack now lives in a sheet toggled by #loc-pill (Stage 2 header
// collapse) — open it before the first search interaction.
await page.click('#loc-pill');
await page.fill('#city-input', 'Ashland, Wisconsin');
await page.click('#city-go');
await page.waitForSelector('.city-result', { timeout: 15000 });
await page.click('.city-result'); // selection closes the sheet — reopen it

await page.click('#loc-pill');
await page.waitForSelector('#lake-jump-select', { timeout: 20000 });
await page.waitForTimeout(3200);

const optCount = await page.$$eval('#lake-jump-select option', els => els.length);
check('(a) #lake-jump-select has more than one option', optCount > 1);

const optTexts = await page.$$eval('#lake-jump-select option', els => els.map(e => e.textContent.trim()));
console.log('Options:'); optTexts.forEach(o => console.log('  - ' + o));

const placeholderOpt = await page.$eval('#lake-jump-select option[value=""]', el => ({
  text: el.textContent, disabled: el.disabled
}));
check('(b) placeholder option present', /jump to a nearby lake/i.test(placeholderOpt.text));
check('(b) placeholder option is disabled (non-selectable as a real choice)', placeholderOpt.disabled === true);

// (c) Select a non-placeholder option and confirm selectWater fired by
// checking #loc / #advisor-body reflect the newly chosen lake.
const chosen = await page.$eval('#lake-jump-select', el => {
  const opt = Array.from(el.options).find(o => o.value !== '');
  return opt ? { value: opt.value, text: opt.textContent } : null;
});
check('found a selectable (non-placeholder) lake option', !!chosen);

if (chosen) {
  await page.selectOption('#lake-jump-select', chosen.value);
  await page.waitForTimeout(500);
  const locText = await page.$eval('#loc', el => el.textContent);
  const advisorText = await page.$eval('#advisor-body', el => el.textContent);
  // The option text is "<icon> <name> · <dist>"; extract the name portion.
  const lakeName = chosen.text.replace(/^\S+\s/, '').split(' · ')[0].trim();
  console.log('Chosen lake: ' + lakeName);
  console.log('#loc after select: ' + locText);
  check('(c) selecting a lake updates #loc to the chosen lake',
    locText.indexOf(lakeName) !== -1);
  check('(c) selecting a lake triggers advisor reload (loading or new content)',
    advisorText.length > 0);
}

await browser.close();
console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
