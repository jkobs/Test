/* Playwright validation for the multi-source nearby-waters lookup.

   The sandbox blocks live network egress, so we intercept the geocoding,
   Overpass, and Wikipedia GeoSearch requests and serve canned responses
   shaped exactly like the real APIs. This exercises the real
   parse -> size-filter -> nearest-edge-distance -> merge -> render path in a
   real browser (Chromium) under two failure scenarios.

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
  results: [{
    name: 'Ashland', admin1: 'Wisconsin', country_code: 'US',
    latitude: ASHLAND.lat, longitude: ASHLAND.lng, timezone: 'America/Chicago'
  }]
};

// Overpass "ways" pass: bay node + inland lakes + a river. (out tags bb shape)
const OVP_WAYS = {
  elements: [
    { type: 'node', id: 1, lat: 46.65, lon: -90.85, tags: { name: 'Chequamegon Bay', natural: 'bay' } },
    { type: 'way', id: 2, bounds: { minlat: 46.55, minlon: -90.95, maxlat: 46.59, maxlon: -90.90 },
      tags: { name: 'Otter Lake', natural: 'water' } },
    { type: 'way', id: 3, bounds: { minlat: 46.50, minlon: -90.99, maxlat: 46.52, maxlon: -90.96 },
      tags: { name: 'Deep Lake', natural: 'water' } },
    { type: 'way', id: 4, bounds: { minlat: 46.591, minlon: -90.884, maxlat: 46.5911, maxlon: -90.8839 },
      tags: { name: 'Tiny Pond', natural: 'water' } }, // too small -> filtered out
    { type: 'way', id: 5, bounds: { minlat: 46.40, minlon: -90.95, maxlat: 46.62, maxlon: -90.60 },
      tags: { name: 'White River', waterway: 'river' } }
  ]
};
const OVP_RELS = {
  elements: [
    { type: 'relation', id: 100, bounds: { minlat: 46.4, minlon: -92.2, maxlat: 48.0, maxlon: -84.3 },
      tags: { name: 'Lake Superior', natural: 'water', water: 'lake' } }
  ]
};
// Wikipedia GeoSearch shape — includes the real-world noise we must filter:
// a church (in a "...Lake Township"), a science reserve ("Cedar Creek..."),
// a city ("Ham Lake, Minnesota"), and the town itself.
const WIKI = {
  query: {
    geosearch: [
      { pageid: 1, title: 'Chequamegon Bay', lat: 46.66, lon: -90.84, dist: 5000 },
      { pageid: 2, title: 'White River (Wisconsin)', lat: 46.55, lon: -90.80, dist: 6000 },
      { pageid: 3, title: 'Coon Lake', lat: 46.62, lon: -90.86, dist: 4500 },
      { pageid: 4, title: 'Swedish Evangelical Lutheran Church (Coon Lake Township)', lat: 46.60, lon: -90.90, dist: 2000 },
      { pageid: 5, title: 'Cedar Creek Ecosystem Science Reserve', lat: 46.58, lon: -90.83, dist: 5500 },
      { pageid: 6, title: 'Ham Lake, Minnesota', lat: 46.57, lon: -90.82, dist: 4800 },
      { pageid: 7, title: 'Ashland, Wisconsin', lat: 46.59, lon: -90.88, dist: 100 },
      { pageid: 8, title: 'Prentice Park', lat: 46.60, lon: -90.90, dist: 1500 }
    ]
  }
};

function isRelationQuery(body) { return /relation\[/.test(body) && !/way\["natural"="water"\]/.test(body); }

let failures = 0;
function check(label, cond) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label);
  if (!cond) failures++;
}

async function getOptions(routeHandler, label) {
  console.log('\n=== Scenario: ' + label + ' ===');
  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.route('**/*', routeHandler);
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.fill('#city-input', 'Ashland, Wisconsin');
  await page.click('#city-go');
  await page.waitForSelector('.city-result', { timeout: 15000 });
  await page.click('.city-result');
  await page.waitForSelector('#nearby-select', { timeout: 20000 });
  await page.waitForTimeout(2500); // allow best-effort relation + wiki merges
  const options = await page.$$eval('#nearby-select option', els => els.map(e => e.textContent.trim()));
  console.log('Dropdown options:');
  options.forEach(o => console.log('  - ' + o));
  await browser.close();
  return options;
}

function baseRoute(handlerForData) {
  return async (route) => {
    const url = route.request().url();
    if (url.startsWith('file://')) return route.continue();
    if (url.includes('geocoding-api.open-meteo.com')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(GEOCODE) });
    }
    const handled = await handlerForData(route, url);
    if (handled) return;
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  };
}

// Scenario A: Overpass healthy (one mirror up), Wikipedia healthy.
const optsA = await getOptions(baseRoute(async (route, url) => {
  if (url.includes('/api/interpreter')) {
    const body = decodeURIComponent(route.request().postData() || '');
    return route.fulfill({ contentType: 'application/json',
      body: JSON.stringify(isRelationQuery(body) ? OVP_RELS : OVP_WAYS) }), true;
  }
  if (url.includes('wikipedia.org')) {
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(WIKI) }), true;
  }
  return false;
}), 'Overpass + Wikipedia both up');

{
  const j = optsA.join('\n').toLowerCase();
  check('A: has >= 3 waters', optsA.length >= 3);
  check('A: Chequamegon Bay present', j.includes('chequamegon'));
  check('A: Lake Superior present', j.includes('lake superior'));
  check('A: White River present', j.includes('white river'));
  check('A: Otter Lake present', j.includes('otter lake'));
  check('A: Tiny Pond filtered out', !j.includes('tiny pond'));
  const sup = optsA.find(o => o.toLowerCase().includes('lake superior')) || '';
  check('A: Lake Superior near-0 distance', /(<\s*0\.1|0\.0)\s*mi/.test(sup));
}

// Scenario B: ALL Overpass mirrors down. Wikipedia must still populate the list.
const optsB = await getOptions(baseRoute(async (route, url) => {
  if (url.includes('/api/interpreter')) {
    return route.abort('failed'), true; // every Overpass mirror fails
  }
  if (url.includes('wikipedia.org')) {
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(WIKI) }), true;
  }
  return false;
}), 'Overpass fully down — Wikipedia fallback');

{
  const j = optsB.join('\n').toLowerCase();
  check('B: dropdown still populated via Wikipedia', optsB.length >= 1);
  check('B: Chequamegon Bay present (wiki)', j.includes('chequamegon'));
  check('B: White River present (wiki)', j.includes('white river'));
  check('B: Coon Lake present (wiki)', j.includes('coon lake'));
  check('B: church filtered out', !j.includes('church'));
  check('B: science reserve filtered out', !j.includes('cedar creek') && !j.includes('reserve'));
  check('B: city "Ham Lake, Minnesota" filtered out', !j.includes('ham lake'));
  check('B: town/park filtered out', !j.includes('prentice') && !j.includes('ashland, wisconsin'));
}

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
