/* Playwright validation: searching Ashland, WI surfaces Lake Superior /
   Chequamegon Bay in the nearby-waters dropdown.

   The sandbox blocks live network egress, so we intercept the geocoding and
   Overpass requests and serve canned responses shaped exactly like the real
   APIs. This exercises the real parse -> size-filter -> nearest-edge-distance
   -> render path in a real browser (Chromium).

   Run: node test/nearby_waters.spec.mjs
*/
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = 'file://' + resolve(__dirname, '../dist/solunar.html');

// Ashland, WI
const ASHLAND = { lat: 46.5919, lng: -90.8835 };

// Geocoding response (Open-Meteo shape)
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
      tags: { name: 'Tiny Pond', natural: 'water' } }, // too small -> must be filtered out
    { type: 'way', id: 5, bounds: { minlat: 46.40, minlon: -90.95, maxlat: 46.62, maxlon: -90.60 },
      tags: { name: 'White River', waterway: 'river' } }
  ]
};

// Overpass "relations" pass: Lake Superior (huge multipolygon bbox).
const OVP_RELS = {
  elements: [
    { type: 'relation', id: 100, bounds: { minlat: 46.4, minlon: -92.2, maxlat: 48.0, maxlon: -84.3 },
      tags: { name: 'Lake Superior', natural: 'water', water: 'lake' } }
  ]
};

function isRelationQuery(body) { return /relation\[/.test(body) && !/way\["natural"="water"\]/.test(body); }

let failures = 0;
function check(label, cond) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label);
  if (!cond) failures++;
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext();
const page = await ctx.newPage();

// Silence unrelated network (weather, tiles, USGS, wikidata, inat, dnr)
await page.route('**/*', async (route) => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();

  if (url.includes('geocoding-api.open-meteo.com')) {
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(GEOCODE) });
  }
  if (url.includes('/api/interpreter')) {
    // Simulate the two primary mirrors being down/overloaded; only the 3rd
    // (openstreetmap.fr) responds. The parallel race must still succeed.
    if (url.includes('overpass-api.de')) return route.abort('failed');          // overloaded
    if (url.includes('kumi.systems')) return route.fulfill({ status: 504, body: 'gateway timeout' });
    const body = route.request().postData() || '';
    const payload = isRelationQuery(decodeURIComponent(body)) ? OVP_RELS : OVP_WAYS;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
  }
  // everything else: empty/no-op
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});

await page.goto(APP, { waitUntil: 'domcontentloaded' });

// Type the city and search
await page.fill('#city-input', 'Ashland, Wisconsin');
await page.click('#city-go');

// Pick the first geocode result (the Go button only lists matches)
await page.waitForSelector('.city-result', { timeout: 15000 });
await page.click('.city-result');

// Wait for the nearby-waters <select> to exist (options read via DOM, not visibility)
await page.waitForSelector('#nearby-select', { timeout: 15000 });
// Give the best-effort relation pass time to merge Lake Superior in
await page.waitForTimeout(2000);

const options = await page.$$eval('#nearby-select option', els => els.map(e => e.textContent.trim()));
console.log('\nDropdown options:');
options.forEach(o => console.log('  - ' + o));
console.log('');

const joined = options.join('\n').toLowerCase();
check('dropdown has at least 3 waters', options.length >= 3);
check('Chequamegon Bay present', joined.includes('chequamegon'));
check('Lake Superior present (relation merge)', joined.includes('lake superior'));
check('White River present', joined.includes('white river'));
check('Otter Lake present', joined.includes('otter lake'));
check('Tiny Pond filtered out by size', !joined.includes('tiny pond'));

// Lake Superior should show ~0 mi (nearest-edge distance), not a far centroid
const superiorOpt = options.find(o => o.toLowerCase().includes('lake superior')) || '';
check('Lake Superior shows near-0 distance (nearest-edge)', /(<\s*0\.1|0\.0)\s*mi/.test(superiorOpt));

await browser.close();
console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
