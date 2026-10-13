/* Live contract check for the external data the app depends on.

   The app's species filtering and lake card rest on ~10 undocumented
   government endpoints and their exact field names (BAG_LMT, LAKE_CLASS,
   WATERBODY_WBIC, ...). Every one was discovered by on-device probing, and
   nothing would notice if DNR renamed a field — species filtering would just
   quietly go wrong. This hits each one for real and asserts:

     1. the layer is reachable,
     2. every field the app reads still exists (from the layer schema), and
     3. a known-good record still says what we built the logic around
        (e.g. Green Lake is still a trout water, Yellow Lake still is not).

   Runs in GitHub Actions, not the dev sandbox: the sandbox's proxy blocks every
   DNR/USGS/Esri host, while GitHub's runners reach the public internet. That
   also makes this the replacement for running probe pages by hand on a phone.

   Run: node tools/contract/check-sources.mjs   (Node 18+; uses global fetch)
*/
const ARC = 'https://dnrmaps.wi.gov/arcgis/rest/services';
const ARC2 = 'https://dnrmaps.wi.gov/arcgis2/rest/services';
const NHD = 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function getJson(url, ms = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'fishing-advisor-contract-check' } });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) { /* not JSON */ }
    return { status: r.status, body, text };
  } finally { clearTimeout(t); }
}

// Layer schema must still contain every field the app reads.
async function schema(name, layerUrl, fields) {
  try {
    const { status, body } = await getJson(layerUrl + '?f=json');
    if (status !== 200 || !body) return record(name + ' schema', false, `HTTP ${status}`);
    if (body.error) return record(name + ' schema', false, JSON.stringify(body.error).slice(0, 120));
    const have = new Set((body.fields || []).map(f => f.name));
    const missing = fields.filter(f => !have.has(f));
    record(name + ' schema', missing.length === 0,
      missing.length ? 'MISSING fields: ' + missing.join(', ') : `${fields.length} fields present`);
  } catch (e) { record(name + ' schema', false, 'unreachable: ' + e.message); }
}

// A query whose answer the app's logic is built around.
async function expectRecord(name, layerUrl, where, check) {
  const url = layerUrl + '/query?f=json&returnGeometry=false&outFields=*&resultRecordCount=5&where=' +
    encodeURIComponent(where);
  try {
    const { status, body } = await getJson(url);
    if (status !== 200 || !body || body.error) {
      return record(name, false, `HTTP ${status} ${body && body.error ? JSON.stringify(body.error).slice(0, 100) : ''}`);
    }
    const feats = (body.features || []).map(f => f.attributes || {});
    const [ok, detail] = check(feats);
    record(name, ok, detail);
  } catch (e) { record(name, false, 'unreachable: ' + e.message); }
}

const L = {
  inland:   ARC  + '/WT_SWDV/WY_INLAND_WATER_RESOURCES/MapServer/3',
  fishWtr:  ARC  + '/WT_SWDV/WY_FISHERIES_WATERS/MapServer/7',
  natComm:  ARC  + '/WT_SWDV/WY_NATURAL_COMMUNITY_MODELING/MapServer/0',
  clarity:  ARC  + '/WY_Lakes_AIS/WY_LAKE_SATELLITE_WATER_CLARITY_RESULTS/MapServer/9',
  stocking: ARC  + '/FM_Fisheries/FM_Fish_Stocking_Public/MapServer/0',
  troutLk:  ARC  + '/FM_Trout/FM_TROUT_REGS_WTM_Ext/MapServer/1',
  troutSt:  ARC  + '/FM_Trout/FM_TROUT_REGS_WTM_Ext/MapServer/0',
  lakeCls:  ARC2 + '/FM_WFF/FM_WFF_LAKE_CLASSIFICATIONS_WTM_EXT/MapServer/0',
  lakeRegs: ARC2 + '/FM_WFF/FM_WFF_LAKE_REGULATIONS_WTM_EXT/MapServer/2',
  nhdWb:    NHD  + '/12'
};

await Promise.all([
  // --- schemas: every field name app.js reads from each layer ---
  schema('WBIC lookup',            L.inland,   ['WATERBODY_ROW_NAME', 'WATERBODY_WBIC']),
  schema('designated waters',      L.fishWtr,  ['ROI_SHORT_NAME', 'ROI_CODE_DESC', 'ROI_SUBTYPE_DESC', 'ROI_STATUS_DESC']),
  schema('natural communities',    L.natComm,  ['NATURAL_COMMUNITY', 'OFFICIAL_NAME', 'TWO_STORY_TYPE', 'MAX_DEPTH', 'MAX_DEPTH_UNITS', 'MAX_DEPTH_SOURCE']),
  schema('satellite clarity',      L.clarity,  ['SATELLITE_CLARITY_FEET', 'YEAR']),
  schema('stocking',               L.stocking, ['SPECIES_NAME', 'WBIC', 'WATER_BODY_NAME']),
  schema('trout lake/pond regs',   L.troutLk,  ['WATERBODY_', 'BAG_LMT', 'SEASON_TXT', 'REGCAT', 'GEAR_RESTR']),
  schema('trout stream regs',      L.troutSt,  ['STREAM', 'BAG_LMT', 'SEASON_TXT', 'REGCAT', 'GEAR_RESTRICTIONS']),
  schema('lake classification',    L.lakeCls,  ['LAKE_NAME', 'WBIC', 'LAKE_CLASS', 'AREA_ACRES_', 'MAXDEP_FT', 'FISHERIES']),
  schema('lake regulations',       L.lakeRegs, ['WATERBODY_NAME', 'WBIC', 'PANFISH', 'TROUT_AND_SALMON']),
  schema('USGS NHD waterbodies',   L.nhdWb,    ['GNIS_NAME', 'AREASQKM', 'FTYPE']),

  // --- semantic: known answers the species logic is built around ---
  expectRecord('Green Lake is a trout water (lake trout bag limit)', L.troutLk,
    "WATERBODY_ = 'Green Lake'",
    f => [f.some(a => /lake trout/i.test(a.BAG_LMT || '')),
          f.length ? `BAG_LMT="${(f[0].BAG_LMT || '').slice(0, 60)}"` : 'no record']),
  expectRecord('North Fork Willow River is a trout stream', L.troutSt,
    "STREAM = 'North Fork Willow River'",
    f => [f.some(a => /trout/i.test(a.BAG_LMT || '')), `${f.length} record(s)`]),
  expectRecord('Cedar Lake WBIC 2615100 resolves', L.inland,
    'WATERBODY_WBIC = 2615100',
    f => [f.some(a => /cedar/i.test(a.WATERBODY_ROW_NAME || '')),
          f.length ? `name="${f[0].WATERBODY_ROW_NAME}"` : 'no record']),
  expectRecord('Lake Mendota is classed Two Story', L.lakeCls,
    'WBIC = 805400',
    f => [f.some(a => /two story/i.test(a.LAKE_CLASS || '')),
          f.length ? `LAKE_CLASS="${f[0].LAKE_CLASS}"` : 'no record']),
  expectRecord('Geneva Lake carries MAX_DEPTH_SOURCE', L.natComm,
    'WBIC = 758300',
    f => [f.some(a => a.MAX_DEPTH_SOURCE), f.length ? `source="${f[0].MAX_DEPTH_SOURCE}"` : 'no record']),

  // --- the depth-map PDF the lake card embeds ---
  (async () => {
    try {
      const r = await fetch('https://apps.dnr.wi.gov/doclink/lakes_maps/2615100a.pdf', { method: 'GET' });
      const ct = r.headers.get('content-type') || '';
      record('Cedar Lake survey PDF', r.status === 200 && /pdf/i.test(ct), `HTTP ${r.status} ${ct}`);
    } catch (e) { record('Cedar Lake survey PDF', false, 'unreachable: ' + e.message); }
  })()
]);

// Informational only: the trout-regulations web page blocked our research
// fetcher (403). Worth knowing whether a runner can read it — never fails CI.
try {
  const r = await fetch('https://dnr.wisconsin.gov/topic/Fishing/regulations/troutregs');
  console.log(`INFO  trout regulations web page: HTTP ${r.status}`);
} catch (e) { console.log('INFO  trout regulations web page unreachable: ' + e.message); }

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} contract checks passed`);
process.exit(failed.length ? 1 : 0);
