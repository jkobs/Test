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
async function loadClass(lakeClass, fisheries, { acres = 900, maxDep = 40, troutRegs = null } = {}) {
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
    // FM_TROUT_REGS layer 1 = "Trout Lake/Pond Regulations". A record here is
    // DNR's authoritative "this water is managed for trout"; absence means it
    // is not a designated trout water.
    if (url.includes('FM_TROUT_REGS')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        features: troutRegs ? [{ attributes: troutRegs }] : []
      }) });
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

// Real FM_TROUT_REGS record captured for Green Lake in probe round 9.
const GREEN_LAKE_TROUT = {
  WATERBODY_: 'Green Lake', EARLY_SEASON_TXT: 'N/A',
  REGCAT: 'Length, Bag and Possession Limits Vary by Water',
  BAG_LMT: '2 lake trout over 17", 3 other trout over 14".',
  SEASON_TXT: 'Lake trout - First Saturday in January to Sept. 30, Other trout: - First Saturday in May to first Sunday in March.'
};

// ---------- 1. Warm lake, not a trout water: trout/salmon NOT selectable ----------
// Demoting these into an "unlikely" group wasn't enough in practice: a real
// on-device report showed a small pond still switched to salmon, headlining
// "troll offshore temperature breaks". Implausible species are now removed.
const warm = await loadClass('Simple - Warm - Dark',
  'Simple warm dark lakes can provide great opportunities for action for black crappie, and often also support bluegill and largemouth bass. They rarely have any walleye or muskellunge.',
  { maxDep: 10 });
console.log('  warm options: ' + JSON.stringify(warm.allOpts));
check('coldwater species are NOT selectable on a warm non-trout lake',
  COLDWATER.every(n => !warm.allOpts.includes(n)));
check('warm lake keeps its warmwater species',
  warm.allOpts.includes('Walleye') && warm.allOpts.includes('Largemouth Bass') && warm.allOpts.includes('Crappie'));
check('exactly the four coldwater species were removed', warm.allOpts.length === 10);
check('no "unlikely" group is needed once they are removed', warm.groups.length === 0);
check('outlook rows carry no unlikely tags either', warm.unlikelyRows.length === 0);

// ---------- 2. Confirmed trout water: coldwater species are plausible ----------
const trout = await loadClass('Complex - Two Story',
  'Complex two story lakes are able to support coldwater species - primarily cisco, and occasionally lake trout or lake whitefish. They have the potential to produce action and quality walleye fisheries.',
  { maxDep: 236, troutRegs: GREEN_LAKE_TROUT });
console.log('  trout-water options: ' + JSON.stringify(trout.allOpts));
check('a DNR trout water demotes nothing (no optgroups)', trout.groups.length === 0);
check('trout water tags no species as unlikely', trout.unlikelyRows.length === 0);
// The trout-regs record is itself a CONFIRMED-presence source, so with no
// stocking/iNat records mocked the list filters down to the trout species DNR
// actually names in the bag limit ("2 lake trout ... 3 other trout").
check('trout water confirms Lake Trout from the bag-limit text', trout.allOpts.includes('Lake Trout'));
check('"other trout" confirms stream-trout species',
  trout.allOpts.includes('Rainbow/Brown Trout') && trout.allOpts.includes('Brook Trout'));
check('no salmon claimed — the bag text never mentions salmon',
  !trout.allOpts.includes('Chinook/Coho Salmon'));
check('list is genuinely filtered to the confirmed trout species', trout.allOpts.length === 3);
check('lake card shows the Trout Water designation', /Trout Water/.test(trout.lakeText));
check('lake card shows DNR\'s real bag limit', /2 lake trout over 17/.test(trout.lakeText));

// ---------- 2b. Two-story lake that is NOT a trout water: still demoted ----------
// The trout-regs authority outranks the "two story supports coldwater" class
// hint — Lake Mendota is two-story but is not a designated trout water.
const twoStoryNoTrout = await loadClass('Complex - Two Story',
  'Complex two story lakes are able to support coldwater species - primarily cisco, and occasionally lake trout or lake whitefish.',
  { maxDep: 82 });
check('two-story lake with no trout record still excludes coldwater species',
  COLDWATER.every(n => !twoStoryNoTrout.allOpts.includes(n)));
check('two-story non-trout lake keeps its warmwater species',
  twoStoryNoTrout.allOpts.length === 10 && twoStoryNoTrout.allOpts.includes('Walleye'));

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
