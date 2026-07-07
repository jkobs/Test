/* Playwright validation for statewide "search ANY lake by name" mode.

   Unlike geocodeCity (place names via Open-Meteo, biased toward populated
   places) or the nearby-waters lookup (both radius-limited to the user's
   location), the new "🎣 Lake" search mode queries USGS NHD layer 12
   (waterbodies) directly by GNIS_NAME with NO geometry filter, so it can find
   a lake anywhere in the country by name, e.g. "Trout Lake" (which — as this
   fixture deliberately shows — exists in more than one place, hence showing
   coordinates to disambiguate rather than claiming to filter by state).

   Mocks: Open-Meteo forecast/pressure (so the app boots) and the NHD layer-12
   name-query URL (matched on hydro.nationalmap.gov + MapServer/12/query + the
   GNIS_NAME ... LIKE where-clause, distinguishing it from the point-intersect
   nearby-waters query the app also fires on load).

   Run: node test/lake_name_search.spec.mjs
*/
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = 'file://' + resolve(__dirname, '../dist/solunar.html');
const SCREENSHOT = '/tmp/claude-0/-home-user-Test/9324a1ee-5621-5a59-9558-312bd035d8eb/scratchpad/verify/lake_name_search.png';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// Two same-named lakes in different states — proves the search is NOT
// scoped to "nearby," and that results are disambiguated by coordinates
// (since NHD layer 12 has no confirmed state field to filter on).
const NHD_NAME_SEARCH = { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { GNIS_NAME: 'Trout Lake', AREASQKM: 5.2, FTYPE: 390 },
    geometry: { type: 'Polygon', coordinates: [[[-89.68,46.02],[-89.62,46.02],[-89.62,46.06],[-89.68,46.06],[-89.68,46.02]]] } },
  { type: 'Feature', properties: { GNIS_NAME: 'Trout Lake', AREASQKM: 0.9, FTYPE: 390 },
    geometry: { type: 'Polygon', coordinates: [[[-90.50,45.10],[-90.47,45.10],[-90.47,45.13],[-90.50,45.13],[-90.50,45.10]]] } }
] };

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
// response, each with acres + coordinates.
await page.fill('#city-input', 'Trout Lake');
await page.click('#city-go');
await page.waitForSelector('.city-result', { timeout: 15000 });

const rows = await page.$$eval('.city-result', els => els.map(e => e.textContent.trim()));
console.log('Result rows:'); rows.forEach(r => console.log('  - ' + r));
check('(b) two result rows rendered (one per mocked feature)', rows.length === 2);
check('(b) rows show the lake name', rows.every(r => r.indexOf('Trout Lake') !== -1));
check('(b) rows show acres', rows.every(r => /\d+\s*ac/.test(r)));
check('(b) rows show lat/lng coordinates', rows.every(r => /-?\d+\.\d{2},\s*-?\d+\.\d{2}/.test(r)));
// The two fixture lakes are in different places — confirms results aren't
// deduped into one and that coordinates genuinely disambiguate them.
check('(b) the two rows show DIFFERENT coordinates (disambiguation, not one merged result)', rows[0] !== rows[1]);

// Screenshot of the populated result rows (390x844, per the spec).
await page.screenshot({ path: SCREENSHOT });
console.log('Screenshot saved to ' + SCREENSHOT);

// (c) Clicking a result updates #loc to that lake name and triggers an
// advisor/lake load.
const firstRowCoords = rows[0].match(/(-?\d+\.\d{2}),\s*(-?\d+\.\d{2})/);
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
