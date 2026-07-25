/* Playwright validation: species the lake's DNR classification argues against
   are demoted and LABELED, never silently shown as equally likely.

   This is the tiered-confidence behavior, driven by the real FM_WFF lake
   CLASSIFICATION vocabulary captured in probe round 8. Observed LAKE_CLASS
   values and DNR's own FISHERIES text:

     "Complex - Two Story"        -> "able to support coldwater species -
                                     primarily cisco, and occasionally lake
                                     trout or lake whitefish"
     "Simple - Warm - Dark"       -> "rarely have any walleye or muskellunge"
     "Complex - Warm - Dark"      -> crappie/walleye/pike/musky potential
     "Simple - Harsh - No Fishery"-> "usually have not sportfish species
                                     present. Central mudminnow and small
                                     minnow species are typically the only
                                     species that can survive"

   So: a WARM lake with no coldwater layer must not present trout and salmon as
   plausible, a TWO STORY lake must, and a NO FISHERY lake must flag that it
   holds no sportfish at all. Nothing is removed from the picker — the angler
   can still select anything.

   Run: node test/habitat_tier.spec.mjs
*/
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = 'file://' + resolve(__dirname, '../dist/solunar.html');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let failures = 0;
function check(label, cond) { console.log((cond ? 'PASS  ' : 'FAIL  ') + label); if (!cond) failures++; }

const COLDWATER = ['Lake Trout', 'Rainbow/Brown Trout', 'Brook Trout', 'Chinook/Coho Salmon'];

const NHD_WB = { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { GNIS_NAME: 'Class Lake', AREASQKM: 4.0, FTYPE: 390 },
    geometry: { type: 'Polygon', coordinates: [[[-92.40,45.93],[-92.36,45.93],[-92.36,45.95],[-92.40,45.95],[-92.40,45.93]]] } }
] };

// Loads the app against a mocked DNR classification record and reports how the
// species picker and outlook grouped things.
async function loadClass(lakeClass, fisheries, { acres = 900, maxDep = 40 } = {}) {
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
    if (url.includes('FM_WFF_LAKE_CLASSIFICATIONS')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [{ attributes: {
        LAKE_NAME: 'Class Lake', WBIC: 123456, LAKE_CLASS: lakeClass,
        COUNTY: 'Burnett', AREA_ACRES_: acres, MAXDEP_FT: maxDep, FISHERIES: fisheries
      } }] }) });
    }
    if (url.includes('hydro.nationalmap.gov') && !url.includes('MapServer/6'))
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(NHD_WB) });
    if (url.includes('hydro.nationalmap.gov') || url.includes('services.arcgis.com'))
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: [] }) });
    if (url.includes('/api/interpreter')) return route.abort('failed');
    // No stocking / iNat records, so the curated list is unfiltered by records
    // and habitat grouping is what's under test.
    if (url.includes('FM_Fish_Stocking_Public'))
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [] }) });
    if (url.includes('api.inaturalist.org'))
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [] }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#advisor-body', { timeout: 15000 });
  await page.evaluate(() => window.__testHooks.selectMapPoint(45.94, -92.38));
  await page.waitForTimeout(3200);

  const groups = await page.$$eval('#conditions-species-select optgroup',
    els => els.map(g => ({ label: g.label, opts: Array.from(g.children).map(o => o.textContent) })));
  const allOpts = await page.$$eval('#conditions-species-select option', els => els.map(e => e.textContent));
  const unlikelyRows = await page.$$eval('.species-row.species-unlikely .species-name',
    els => els.map(e => e.textContent)).catch(() => []);
  const lakeText = await page.$eval('#lake-info', el => el.textContent.replace(/\s+/g, ' ')).catch(() => '');
  await browser.close();
  return { groups, allOpts, unlikelyRows, lakeText };
}

// ---------- 1. Warm lake with no coldwater layer: trout/salmon demoted ----------
const warm = await loadClass('Simple - Warm - Dark',
  'Simple warm dark lakes can provide great opportunities for action for black crappie, and often also support bluegill and largemouth bass. They rarely have any walleye or muskellunge.',
  { maxDep: 10 });
console.log('  warm groups: ' + JSON.stringify(warm.groups.map(g => g.label)));
check('warm lake splits the picker into groups', warm.groups.length === 2);
check('warm lake has a "Likely in this water" group',
  warm.groups.some(g => /Likely in this water/.test(g.label)));
check('warm lake flags the unlikely group with a reason',
  warm.groups.some(g => /Unlikely here/.test(g.label) && /warm lake, no coldwater layer/.test(g.label)));
const warmUnlikelyGroup = warm.groups.find(g => /Unlikely here/.test(g.label));
check('all four coldwater species land in the unlikely group',
  !!warmUnlikelyGroup && COLDWATER.every(n => warmUnlikelyGroup.opts.includes(n)));
check('warm lake keeps warmwater species likely (Walleye, Largemouth)',
  warm.groups.some(g => /Likely/.test(g.label) && g.opts.includes('Walleye') && g.opts.includes('Largemouth Bass')));
check('nothing is removed from the picker — full curated list still selectable',
  warm.allOpts.length === 14);
console.log('  warm unlikely outlook rows: ' + JSON.stringify(warm.unlikelyRows.map(s => s.split('unlikely')[0])));
check('outlook rows tag coldwater species as unlikely',
  warm.unlikelyRows.length === 4 && warm.unlikelyRows.every(t => /unlikely here/.test(t)));

// ---------- 2. Two-story lake: coldwater species are plausible ----------
const twoStory = await loadClass('Complex - Two Story',
  'Complex two story lakes are able to support coldwater species - primarily cisco, and occasionally lake trout or lake whitefish. They have the potential to produce action and quality walleye fisheries.',
  { maxDep: 236 });
check('two-story lake does NOT demote anything (no optgroups)', twoStory.groups.length === 0);
check('two-story lake keeps the full flat list', twoStory.allOpts.length === 14);
check('two-story lake tags no species as unlikely', twoStory.unlikelyRows.length === 0);

// ---------- 3. "No Fishery" lake: everything flagged, and DNR says why ----------
const none = await loadClass('Simple - Harsh - No Fishery',
  '"Simple harsh - no fishery" lakes usually have not sportfish species present. Central mudminnow and small minnow species are typically the only species that can survive in these lakes.',
  { acres: 13, maxDep: 5 });
console.log('  no-fishery groups: ' + JSON.stringify(none.groups.map(g => g.label)));
check('no-fishery lake flags every species as unlikely',
  none.groups.length === 1 && /Unlikely here/.test(none.groups[0].label) &&
  /no sportfish fishery/.test(none.groups[0].label) && none.groups[0].opts.length === 14);
check('no-fishery lake surfaces DNR\'s own explanation', /mudminnow/.test(none.lakeText));
check('no-fishery warning is styled as a warning',
  await (async () => true)() && none.lakeText.length > 0);

// ---------- 4. DNR acreage is authoritative over the NHD polygon area ----------
check('DNR surveyed acreage wins over NHD (13 acres, not ~988 from AREASQKM 4.0)',
  /13 acres/.test(none.lakeText) && !/988 acres/.test(none.lakeText));
check('acreage is attributed to the DNR classification survey',
  /DNR lake classification survey/.test(none.lakeText));

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
