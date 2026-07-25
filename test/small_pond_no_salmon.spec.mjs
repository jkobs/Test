/* Playwright validation: a small warm pond must not offer — or stay switched
   to — salmon or trout.

   Reproduces a real on-device report. Screenshot showed "Long Pond" (a small
   pond 1.3 mi away) with the species pill reading "Chinook/Coho Salmon" and the
   headline "A fair morning for salmon; the 10:06 AM window can tip it… Salmon:
   40–90 ft — Offshore temperature breaks and bait schools." Offshore trolling
   advice on a farm pond.

   Two defects, both covered here:
     1. Habitat-implausible species were only DEMOTED into an "unlikely"
        optgroup, so they stayed selectable.
     2. The species pick persists in localStorage, so salmon chosen on Lake
        Superior followed the angler to the next water and drove the headline —
        the selection was reconciled only against record filtering, never
        against habitat.

   Run: node test/small_pond_no_salmon.spec.mjs
*/
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = 'file://' + resolve(__dirname, '../dist/solunar.html');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let failures = 0;
function check(label, cond) { console.log((cond ? 'PASS  ' : 'FAIL  ') + label); if (!cond) failures++; }

const COLDWATER = ['Chinook/Coho Salmon', 'Lake Trout', 'Rainbow/Brown Trout', 'Brook Trout'];

// A small pond in Wisconsin, comfortably over the 5-acre browse floor so the
// filter under test is habitat, not size.
const NHD_WB = { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { GNIS_NAME: 'Long Pond', AREASQKM: 0.10, FTYPE: 390 },
    geometry: { type: 'Polygon', coordinates: [[[-92.395,45.935],[-92.385,45.935],[-92.385,45.945],[-92.395,45.945],[-92.395,45.935]]] } }
] };

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext();
const page = await ctx.newPage();

await page.route('**/*', async (route) => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('api.open-meteo.com/v1/forecast')) {
    const nowS = Math.floor(Date.now() / 1000);
    const time = [], sp = [];
    for (let i = -4; i <= 4; i++) { time.push(nowS + i * 3600); sp.push(1013); }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      current: { temperature_2m: 68, wind_speed_10m: 5, wind_direction_10m: 180, cloud_cover: 80 },
      hourly: { time, surface_pressure: sp }
    }) });
  }
  if (url.includes('hydro.nationalmap.gov') && !url.includes('MapServer/6'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(NHD_WB) });
  if (url.includes('hydro.nationalmap.gov') || url.includes('services.arcgis.com'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: [] }) });
  if (url.includes('/api/interpreter')) return route.abort('failed');
  // A small pond: no stocking records, no iNaturalist observations, and — the
  // decisive part — NO record in the DNR trout lake/pond regulations layer.
  if (url.includes('FM_Fish_Stocking_Public'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [] }) });
  if (url.includes('api.inaturalist.org'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [] }) });
  if (url.includes('FM_TROUT_REGS'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [] }) });
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});

// Salmon was picked on a previous water (Lake Superior) and persisted.
await ctx.addInitScript(() => {
  try { localStorage.setItem('targetSpecies', 'Chinook/Coho Salmon'); } catch (e) {}
});

await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#advisor-body', { timeout: 15000 });
const persisted = await page.evaluate(() => localStorage.getItem('targetSpecies'));
check('salmon really is the persisted pick going in', persisted === 'Chinook/Coho Salmon');

await page.evaluate(() => window.__testHooks.selectMapPoint(45.94, -92.39));
await page.waitForTimeout(3500);

const bite = await page.$$eval('#conditions-species-select option', els => els.map(e => e.textContent));
const pill = await page.$$eval('#species-pill-select option', els => els.map(e => e.textContent));
const pillSel = await page.$eval('#species-pill-select', el => el.value);
const hero = await page.$eval('#hero', el => el.textContent.replace(/\s+/g, ' '));
const notes = await page.$eval('#field-notes', el => el.textContent.replace(/\s+/g, ' ')).catch(() => '');

console.log('Bite dropdown: ' + JSON.stringify(bite));
console.log('Pill selection: ' + pillSel);
console.log('Hero: ' + hero.slice(0, 150));

// --- The core ask: salmon must not be selectable on a small pond.
check('salmon is NOT selectable in the Bite Conditions dropdown', !bite.includes('Chinook/Coho Salmon'));
check('salmon is NOT selectable in the header species pill', !pill.includes('Chinook/Coho Salmon'));
check('no coldwater species at all is selectable',
  COLDWATER.every(n => !bite.includes(n) && !pill.includes(n)));

// --- The persisted pick must not survive onto this water.
check('pill switched off salmon to a plausible species', pillSel !== 'Chinook/Coho Salmon' && pillSel.length > 0);
check('hero headline is no longer about salmon', !/salmon/i.test(hero));
check('hero shows no offshore/thermal-band advice', !/offshore|thermal band|downrigger/i.test(hero));
check('field notes are not about salmon', !/salmon/i.test(notes));

// --- But the pond still works as a fishery: warmwater species remain.
check('warmwater species are still offered (Largemouth Bass)', bite.includes('Largemouth Bass'));
check('panfish are still offered (Crappie)', bite.includes('Crappie'));
check('a usable number of species remains', bite.length >= 8);

await browser.close();
console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
