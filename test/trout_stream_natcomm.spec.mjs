/* Playwright validation: trout STREAMS count as trout waters, and DNR's Lake
   Natural Communities record surfaces on the lake card.

   Bug this catches: the trout-water gate originally queried only FM_TROUT_REGS
   layer 1, which is lake/pond POLYGONS. A stream is a LINE in layer 0, so a
   genuine trout stream matched nothing, was treated as "not a DNR trout water",
   and had its trout species excluded — on water that is literally managed for
   trout. Probe round 10 confirmed layer 0 returns real records: the North Fork
   Willow River carries "5 trout in total of any length".

   Also covers WY_NATURAL_COMMUNITY_MODELING layer 0 (probe round 10), whose
   values are richer than the FM_WFF class: NATURAL_COMMUNITY ("Two-Story",
   "Shallow Seepage"), TWO_STORY_TYPE, and a max depth carrying its own
   MAX_DEPTH_SOURCE so provenance is stated rather than guessed.

   Run: node test/trout_stream_natcomm.spec.mjs
*/
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = 'file://' + resolve(__dirname, '../dist/solunar.html');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let failures = 0;
function check(label, cond) { console.log((cond ? 'PASS  ' : 'FAIL  ') + label); if (!cond) failures++; }

// Real record captured at the user's GPS in probe round 10.
const WILLOW_RIVER_TROUT = {
  OBJECTID: 47775, STREAM: 'North Fork Willow River', GEAR_RESTRICTIONS: 'N/A',
  EARLY_SEASON_TXT: 'First Saturday in January to First Saturday in April all trout shall be immediately released. Only artificial lures may be used.',
  REGCAT: '5 Trout in Total of Any Length',
  BAG_LMT: '5 trout in total of any length.',
  SEASON_TXT: 'First Saturday in April at 5:00 a.m. to Oct. 15.'
};
// Real Lake Natural Communities record for Geneva Lake, probe round 10.
const GENEVA_NATCOMM = {
  NATURAL_COMMUNITY: 'Two-Story', OFFICIAL_NAME: 'Trout Water', WBIC: 758300,
  OFFICIAL_SIZE: 5400.99, MAX_DEPTH: 135, MAX_DEPTH_UNITS: 'FEET',
  MAX_DEPTH_SOURCE: 'WI LAKE MAP', MIX_STRATIFY_RATIO: 12.3,
  TWO_STORY_TYPE: 'NATURALLY_REPROD', WATERBODY_TYPE_CODE: 'LP'
};

const NHD_WB = { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { GNIS_NAME: 'Trout Water', AREASQKM: 2.0, FTYPE: 390 },
    geometry: { type: 'Polygon', coordinates: [[[-92.40,45.93],[-92.36,45.93],[-92.36,45.95],[-92.40,45.95],[-92.40,45.93]]] } }
] };

// streamRegs / lakeRegs are served from FM_TROUT_REGS layers 0 / 1 respectively.
async function load({ streamRegs = null, lakeRegs = null, natComm = null, classification = null } = {}) {
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
        current: { temperature_2m: 60, wind_speed_10m: 5, wind_direction_10m: 180 },
        hourly: { time, surface_pressure: sp }
      }) });
    }
    if (url.includes('FM_TROUT_REGS')) {
      // MapServer/<layerId>/query — pick the mock matching the layer requested.
      const m = url.match(/FM_TROUT_REGS_WTM_Ext\/MapServer\/(\d+)\//);
      const layer = m ? m[1] : '?';
      const rec = layer === '0' ? streamRegs : layer === '1' ? lakeRegs : null;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        features: rec ? [{ attributes: rec }] : []
      }) });
    }
    if (url.includes('WY_NATURAL_COMMUNITY_MODELING')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        features: natComm ? [{ attributes: natComm }] : []
      }) });
    }
    if (url.includes('FM_WFF_LAKE_CLASSIFICATIONS')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        features: classification ? [{ attributes: classification }] : []
      }) });
    }
    if (url.includes('hydro.nationalmap.gov') && !url.includes('MapServer/6'))
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(NHD_WB) });
    if (url.includes('hydro.nationalmap.gov') || url.includes('services.arcgis.com'))
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: [] }) });
    if (url.includes('/api/interpreter')) return route.abort('failed');
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
  const opts = await page.$$eval('#conditions-species-select option', els => els.map(e => e.textContent));
  const lake = await page.$eval('#lake-info', el => el.textContent.replace(/\s+/g, ' ')).catch(() => '');
  await browser.close();
  return { opts, lake };
}

// ---------- 1. A trout STREAM must count as a trout water (the bug) ----------
const stream = await load({ streamRegs: WILLOW_RIVER_TROUT });
console.log('  stream species: ' + JSON.stringify(stream.opts));
check('a trout stream is recognised as a trout water',
  stream.opts.includes('Rainbow/Brown Trout') && stream.opts.includes('Brook Trout'));
check('generic "5 trout" text does NOT claim lake trout', !stream.opts.includes('Lake Trout'));
check('no salmon claimed — the stream text never says salmon', !stream.opts.includes('Chinook/Coho Salmon'));
check('lake card shows the Trout Water designation', /Trout Water/.test(stream.lake));
check('lake card shows the stream bag limit', /5 trout in total of any length/.test(stream.lake));

// ---------- 2. No trout record on either layer -> coldwater excluded ----------
const plain = await load({});
console.log('  non-trout species: ' + JSON.stringify(plain.opts));
check('water with no trout record on EITHER layer excludes coldwater',
  ['Lake Trout', 'Rainbow/Brown Trout', 'Brook Trout', 'Chinook/Coho Salmon']
    .every(n => !plain.opts.includes(n)));
check('non-trout water keeps its warmwater species', plain.opts.includes('Walleye'));

// ---------- 3. Lake Natural Communities data reaches the card ----------
const nc = await load({ natComm: GENEVA_NATCOMM });
console.log('  natcomm card: ' + nc.lake.slice(0, 220));
check('natural community is shown', /Two-Story/.test(nc.lake));
check('two-story type is humanised', /Naturally Reprod/i.test(nc.lake));
check('community is attributed to DNR natural community modeling',
  /DNR natural community modeling/.test(nc.lake));
check('max depth comes through when the classification survey has none',
  /135 ft/.test(nc.lake));
check('depth provenance names the DNR record with correct acronym casing',
  nc.lake.includes('DNR WI Lake Map'));

// ---------- 4. The classification survey stays authoritative for depth ----------
const both = await load({
  natComm: GENEVA_NATCOMM,
  classification: { LAKE_NAME: 'Trout Water', LAKE_CLASS: 'Complex - Two Story', MAXDEP_FT: 140, AREA_ACRES_: 5262 }
});
check('classification depth (140 ft) outranks natural-community depth (135 ft)',
  /140 ft/.test(both.lake) && !/135 ft/.test(both.lake));
check('classification acreage is used', /5262 acres/.test(both.lake));

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
