/* Playwright validation: species name-matching must not let a non-gamefish
   that merely SHARES A FIRST WORD masquerade as a curated gamefish.

   The live bug: a lake whose only recorded species was "Rainbow Smelt" (or
   "Rainbow Darter") — real Wisconsin fish, neither a trout — got its whole
   species list collapsed to just "Rainbow/Brown Trout", with a confident
   "📋 <lake>" badge and a hero reading "a fair night for trout". Cause: the
   curated name was split on "/" into a bare token "rainbow" that substring-
   matched "rainbow smelt". The fix matches on full phrases at word
   boundaries, so "rainbow trout" is NOT found inside "rainbow smelt".

   This test proves (1) a Rainbow-Smelt-only lake falls back to the full
   curated list with an honest "All species" badge, and (2) legitimate
   matches still work (a Brown Trout record DOES surface Rainbow/Brown Trout,
   a White Crappie record DOES surface Crappie), and the list stays filtered.

   Run: node test/species_namematch.spec.mjs
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
  { type: 'Feature', properties: { GNIS_NAME: 'Bass Lake', AREASQKM: 1.5, FTYPE: 390 },
    geometry: { type: 'Polygon', coordinates: [[[-92.40,45.93],[-92.36,45.93],[-92.36,45.95],[-92.40,45.95],[-92.40,45.93]]] } }
] };

// Returns { options, badge, hero } after selecting the mocked lake, whose only
// iNaturalist records are `inatNames` (no DNR stocking records).
async function loadLake(inatNames) {
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
    if (url.includes('FM_Fish_Stocking_Public'))
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [] }) });
    if (url.includes('api.inaturalist.org')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        results: inatNames.map(n => ({ taxon: { preferred_common_name: n } }))
      }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#advisor-body', { timeout: 15000 });
  await page.evaluate(() => window.__testHooks.selectMapPoint(45.94, -92.38));
  await page.waitForTimeout(3000);

  const options = await page.$$eval('#conditions-species-select option', els => els.map(e => e.textContent));
  const badge = await page.$eval('.species-source-badge', el => el.textContent).catch(() => '');
  const hero = await page.$eval('#hero', el => el.textContent).catch(() => '');
  await browser.close();
  return { options, badge, hero };
}

// --- Scenario 1: the bug — a Rainbow-Smelt-only lake must NOT become a trout lake.
const smelt = await loadLake(['Rainbow Smelt']);
console.log('Rainbow Smelt lake — options: ' + JSON.stringify(smelt.options));
console.log('Rainbow Smelt lake — badge: ' + smelt.badge);
check('Rainbow Smelt does NOT collapse the list to only Rainbow/Brown Trout',
  !(smelt.options.length === 1 && smelt.options[0] === 'Rainbow/Brown Trout'));
check('Rainbow Smelt lake falls back to the full curated list (14)', smelt.options.length === 14);
check('Rainbow Smelt lake badge honestly says "All species"', smelt.badge.includes('All species'));
check('Rainbow Smelt lake hero is not mislabeled a trout lake', smelt.hero.toLowerCase().indexOf('trout') === -1);

// --- Scenario 2: legitimate matches still work and the list stays filtered.
const legit = await loadLake(['Brown Trout', 'White Crappie', 'Walleye']);
console.log('Legit lake — options: ' + JSON.stringify(legit.options));
console.log('Legit lake — badge: ' + legit.badge);
check('Brown Trout record surfaces Rainbow/Brown Trout', legit.options.includes('Rainbow/Brown Trout'));
check('White Crappie record surfaces Crappie', legit.options.includes('Crappie'));
check('Walleye record surfaces Walleye', legit.options.includes('Walleye'));
check('List is genuinely filtered — Largemouth Bass excluded', !legit.options.includes('Largemouth Bass'));
check('Legit lake badge claims lake-specific filtering (not "All species")', !legit.badge.includes('All species'));

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
