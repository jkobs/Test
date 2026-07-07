/* Playwright validation for statewide "search ANY lake by name" mode.

   Unlike geocodeCity (place names via Open-Meteo, biased toward populated
   places) or the nearby-waters lookup (both radius-limited to the user's
   location), the new "🎣 Lake" search mode queries USGS NHD layer 12
   (waterbodies) directly by GNIS_NAME with NO geometry filter, so it can find
   a lake anywhere in the country by name, e.g. "Trout Lake" (which — as this
   fixture deliberately shows — exists in more than one place). Rows render
   immediately with a coordinate placeholder, then each result's centroid is
   reverse-geocoded (BigDataCloud's free client endpoint) to a "city, county,
   state" location label — that's what actually disambiguates the two
   same-named lakes now, not raw coordinates (which are de-emphasized into
   the row's `title` attribute as a fallback/tooltip).

   Mocks: Open-Meteo forecast/pressure (so the app boots), the NHD layer-12
   name-query URL (matched on hydro.nationalmap.gov + MapServer/12/query + the
   GNIS_NAME ... LIKE where-clause, distinguishing it from the point-intersect
   nearby-waters query the app also fires on load), and BigDataCloud's
   reverse-geocode-client endpoint (matched per-coordinate so the two fixture
   lakes resolve to two distinct, recognizable places).

   Run: node test/lake_name_search.spec.mjs
*/
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = 'file://' + resolve(__dirname, '../dist/solunar.html');
const SCREENSHOT = '/tmp/claude-0/-home-user-Test/9324a1ee-5621-5a59-9558-312bd035d8eb/scratchpad/verify/lake_name_search.png';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// Three same-named lakes — proves the search is NOT scoped to "nearby," and
// (now) that results are disambiguated by reverse-geocoded LOCATION (nearest
// city/county/state), not raw coordinates. The third fixture's centroid is
// deliberately routed to a failing reverse-geocode lookup below, to exercise
// the coordinate-fallback path when BigDataCloud errors.
// Centroids (from the bounds below): #1 = 46.04,-89.65 · #2 = 45.115,-90.485
// · #3 (fallback case) = 44.015,-90.985.
const NHD_NAME_SEARCH = { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { GNIS_NAME: 'Trout Lake', AREASQKM: 5.2, FTYPE: 390 },
    geometry: { type: 'Polygon', coordinates: [[[-89.68,46.02],[-89.62,46.02],[-89.62,46.06],[-89.68,46.06],[-89.68,46.02]]] } },
  { type: 'Feature', properties: { GNIS_NAME: 'Trout Lake', AREASQKM: 0.9, FTYPE: 390 },
    geometry: { type: 'Polygon', coordinates: [[[-90.50,45.10],[-90.47,45.10],[-90.47,45.13],[-90.50,45.13],[-90.50,45.10]]] } },
  { type: 'Feature', properties: { GNIS_NAME: 'Trout Lake', AREASQKM: 0.4, FTYPE: 390 },
    geometry: { type: 'Polygon', coordinates: [[[-91.00,44.00],[-90.97,44.00],[-90.97,44.03],[-91.00,44.03],[-91.00,44.00]]] } }
] };

// Mocked BigDataCloud reverse-geocode-client responses, keyed by which
// fixture centroid the app will request. Two resolve to clearly distinct
// places (proving disambiguation-by-location); the third is intentionally
// aborted (network failure) to exercise the coordinate fallback.
const BDC_LAKE1 = { city: 'Lake Villa', principalSubdivision: 'Illinois', principalSubdivisionCode: 'US-IL',
  localityInfo: { administrative: [ { name: 'Lake County' } ] } };
const BDC_LAKE2 = { city: 'Presque Isle', principalSubdivision: 'Wisconsin', principalSubdivisionCode: 'US-WI',
  localityInfo: { administrative: [ { name: 'Vilas County' } ] } };

let failures = 0;
function check(label, cond) { console.log((cond ? 'PASS  ' : 'FAIL  ') + label); if (!cond) failures++; }

const browser = await chromium.launch({ executablePath: CHROME });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();

await page.route('**/*', async (route) => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();

  if (url.includes('api.open-meteo.com/v1/forecast')) {
    const nowS = Math.floor(Date.now() / 1000);
    const time = [], sp = [];
    for (let i = -4; i <= 4; i++) { time.push(nowS + i * 3600); sp.push(1013 - i * 0.3); }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      current: { temperature_2m: 65, wind_speed_10m: 6, wind_direction_10m: 200 },
      hourly: { time: time, surface_pressure: sp }
    }) });
  }
  // NHD layer 12 (waterbodies) name-query: hydro.nationalmap.gov + MapServer/12/query
  // + a GNIS_NAME ... LIKE where-clause distinguishes this from the app's other
  // NHD point-intersect calls (nearby-waters lookup on load).
  if (url.includes('hydro.nationalmap.gov') && url.includes('MapServer/12/query') && url.includes('LIKE')) {
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(NHD_NAME_SEARCH) });
  }
  // BigDataCloud reverse-geocode-client — routed per-centroid so the two
  // "resolvable" fixture lakes get distinct place labels, and the third
  // (fallback-path) fixture's lookup fails outright.
  if (url.includes('api.bigdatacloud.net/data/reverse-geocode-client')) {
    if (url.includes('latitude=46.04')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(BDC_LAKE1) });
    }
    if (url.includes('latitude=45.115')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(BDC_LAKE2) });
    }
    // Third fixture centroid (44.015,-90.985) and anything unexpected: abort
    // to simulate a failed reverse-geocode request — the row must still fall
    // back to showing the raw coordinates rather than being left blank.
    return route.abort();
  }
  // Any other NHD/Esri/Wikipedia/Overpass call (the default-location nearby-
  // waters lookup fired on boot) — return empty so the app boots cleanly.
  if (url.includes('hydro.nationalmap.gov'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: [] }) });
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});

await page.goto(APP, { waitUntil: 'domcontentloaded' });

// The search box + mode toggle live in the header, outside any tab-panel —
// visible without clicking a tab (per CLAUDE.md's tabbed-UI gotcha).

// (a) Toggle switches mode: placeholder changes from city to lake wording.
const placeholderBefore = await page.$eval('#city-input', el => el.placeholder);
check('(a) default placeholder is city-mode', /city, state/i.test(placeholderBefore));

await page.click('.sm-btn[data-mode="lake"]');
const placeholderAfter = await page.$eval('#city-input', el => el.placeholder);
check('(a) clicking Lake toggle switches placeholder to lake-mode', /lake name/i.test(placeholderAfter));

const activeBtn = await page.$eval('.sm-btn.active', el => el.dataset.mode);
check('(a) Lake button now marked active', activeBtn === 'lake');

// (b) Typing a lake name + Go shows .city-result rows from the mocked NHD
// response immediately (name + acres + a "…" location placeholder), each
// carrying its raw coordinates in `title`. Coordinates are NOT expected in
// the row text anymore — reverse-geocoded location context is.
await page.fill('#city-input', 'Trout Lake');
await page.click('#city-go');
await page.waitForSelector('.city-result', { timeout: 15000 });

const rowsInitial = await page.$$eval('.city-result', els => els.map(e => e.textContent.trim()));
console.log('Result rows (before reverse-geocode resolves):'); rowsInitial.forEach(r => console.log('  - ' + r));
check('(b) three result rows rendered (one per mocked feature)', rowsInitial.length === 3);
check('(b) rows show the lake name', rowsInitial.every(r => r.indexOf('Trout Lake') !== -1));
check('(b) rows show acres', rowsInitial.every(r => /\d+\s*ac/.test(r)));

// Wait for the async per-row reverse-geocode lookups to resolve (placeholder
// "…" cleared on all three .loc-ctx spans) before asserting on labels.
await page.waitForFunction(() => {
  var spans = document.querySelectorAll('.loc-ctx');
  return spans.length === 3 && Array.prototype.every.call(spans, function(s) { return s.textContent !== '…'; });
}, { timeout: 15000 });

const rows = await page.$$eval('.city-result', els => els.map(e => e.textContent.trim()));
console.log('Result rows (after reverse-geocode):'); rows.forEach(r => console.log('  - ' + r));
check('(b) row 1 resolves to its mocked place (Lake Villa, Lake County, IL)',
  rows[0].indexOf('Lake Villa') !== -1 && rows[0].indexOf('Lake County') !== -1 && rows[0].indexOf('IL') !== -1);
check('(b) row 2 resolves to its (different) mocked place (Presque Isle, Vilas County, WI)',
  rows[1].indexOf('Presque Isle') !== -1 && rows[1].indexOf('Vilas County') !== -1 && rows[1].indexOf('WI') !== -1);
// The two resolvable fixture lakes are in different places — confirms
// results aren't deduped into one and that LOCATION genuinely disambiguates
// them now (not raw coordinates).
check('(b) the two resolved rows show DIFFERENT location labels (disambiguation, not one merged result)', rows[0] !== rows[1]);
// Row 3's reverse-geocode lookup was mocked to fail (aborted request) — it
// must fall back to showing raw coordinates rather than being left blank,
// proving the "nothing resolved / request errors" fallback path.
check('(b) row 3 (failed reverse-geocode) falls back to showing coordinates',
  /-?\d+\.\d{2},\s*-?\d+\.\d{2}/.test(rows[2]));

// Coordinates are de-emphasized (not lost) into each row's title attribute.
const titles = await page.$$eval('.city-result', els => els.map(e => e.getAttribute('title')));
check('(b) each row keeps raw coordinates in its title attribute',
  titles.every(t => /-?\d+\.\d{2},\s*-?\d+\.\d{2}/.test(t || '')));

// Screenshot of the populated, resolved result rows (390x844, per the spec).
await page.screenshot({ path: SCREENSHOT });
console.log('Screenshot saved to ' + SCREENSHOT);

// (c) Clicking a result updates #loc to that lake name and triggers an
// advisor/lake load. Selection still uses the result's stored lat/lng
// (unaffected by the reverse-geocode label), so pull expected coordinates
// from the row's title rather than its (now place-name) text.
const firstRowCoords = (titles[0] || '').match(/(-?\d+\.\d{2}),\s*(-?\d+\.\d{2})/);
await page.click('.city-result');
await page.waitForTimeout(300);

const locText = await page.$eval('#loc', el => el.textContent);
console.log('#loc after selecting result: ' + locText);
check('(c) #loc updates to the selected lake name', locText.indexOf('Trout Lake') !== -1);
check('(c) #loc reflects the selected coordinates', firstRowCoords && locText.indexOf(firstRowCoords[1]) !== -1 && locText.indexOf(firstRowCoords[2]) !== -1);

const advisorText = await page.$eval('#advisor-body', el => el.textContent);
console.log('#advisor-body after select: ' + advisorText);
check('(c) advisor body reflects a load for the selected lake', advisorText.indexOf('Trout Lake') !== -1);

const resultsCleared = await page.$eval('#city-results', el => el.innerHTML.trim());
check('(c) #city-results cleared after selection', resultsCleared === '');
const inputCleared = await page.$eval('#city-input', el => el.value);
check('(c) #city-input cleared after selection', inputCleared === '');

await browser.close();
console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
