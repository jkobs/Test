/* Build one lake's depth chart from every Lowrance log recorded on it.

   A single trip only crosses each contour as a short tick, but years of trips
   on the same lake cover most of it: 77 Yellow Lake logs (2014–2021) put a
   measured sounding within 40 m of three quarters of the lake. Re-parsing
   57 GB on a phone is not an option, so this runs offline and writes one small
   JSON chart per lake that the app can load.

   Pipeline: lake outline from WI DNR (by WBIC) -> parse every .sl2/.sl3 under
   --logs with src/sonarlog.js, primary channel only -> keep soundings inside
   the outline -> median per 4 m cell across all trips (single bad pings and
   bottom-lock losses vanish) -> drop cells that disagree with their
   neighbourhood (spikes like 92 ft in a 31 ft lake) -> contour with
   SonarLog.contour -> simplify lines and drop short fragments.

   Run: node tools/charts/build-lake-chart.mjs --wbic 2675200 --logs ~/SonarLogs-cache [--out charts] [--interval 5]
*/
import { readdirSync, statSync, openSync, readSync, closeSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename, resolve, dirname } from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SonarLog = createRequire(import.meta.url)(join(ROOT, 'src/sonarlog.js'));

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) =>
  (v.startsWith('--') ? a.concat([[v.slice(2), all[i + 1]]]) : a), []));
const WBIC = +args.wbic;
const LOGS = (args.logs || '').replace(/^~/, process.env.HOME);
const OUT = resolve(args.out || join(ROOT, 'charts'));
const INTERVAL = +(args.interval || 5);
if (!WBIC || !LOGS) { console.error('usage: --wbic <WBIC> --logs <dir> [--out dir] [--interval ft]'); process.exit(2); }

const CELL_M = 4;            // median cell size
const SAMPLES_PER_CELL = 63; // values kept per cell for the median
const SPIKE_FT = 4, SPIKE_FRAC = 0.25, SPIKE_RADIUS = 5, SPIKE_PASSES = 4;
const MIN_LINE_M = 60;       // shorter isolines are noise along a single pass
const SIMPLIFY_M = 1.5;
const DEPTH_CAP_X = 1.25;     // nothing deeper than 1.25 x the DNR's surveyed max depth
const SHORE_SLOPE = 1;       // depth (m) <= distance to shore (m) * slope + 1 m: a 45-degree bottom
const NEAR_LAKE_M = 1500;    // a log is checked in full if its first chunk is within this of the lake
const CHUNK = 16 * 1024 * 1024;

// ---- lake outline (WI DNR inland waters layer, the one the app already uses) ----
const LAYER = 'https://dnrmaps.wi.gov/arcgis/rest/services/WT_SWDV/WY_INLAND_WATER_RESOURCES/MapServer/3/query';
const gj = await (await fetch(`${LAYER}?where=WATERBODY_WBIC%3D${WBIC}&outFields=WATERBODY_ROW_NAME&returnGeometry=true&outSR=4326&f=geojson`)).json();
const feat = (gj.features || [])[0];
if (!feat) { console.error(`No WI DNR waterbody for WBIC ${WBIC}`); process.exit(1); }
const NAME = args.name || feat.properties.WATERBODY_ROW_NAME;
const rings = (feat.geometry.type === 'Polygon' ? [feat.geometry.coordinates] : feat.geometry.coordinates).flat();
const bb = { minlat: 90, minlng: 180, maxlat: -90, maxlng: -180 };
rings.forEach(r => r.forEach(([x, y]) => {
  bb.minlat = Math.min(bb.minlat, y); bb.maxlat = Math.max(bb.maxlat, y);
  bb.minlng = Math.min(bb.minlng, x); bb.maxlng = Math.max(bb.maxlng, x); }));
// Even-odd over every ring, so islands (holes) are excluded.
function inLake(lat, lng) {
  if (lat < bb.minlat || lat > bb.maxlat || lng < bb.minlng || lng > bb.maxlng) return false;
  let inside = false;
  for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// The DNR's surveyed max depth for this lake, if it has one (natural-community layer).
const NATCOMM = 'https://dnrmaps.wi.gov/arcgis/rest/services/WT_SWDV/WY_NATURAL_COMMUNITY_MODELING/MapServer/0/query';
let dnrMaxFt = null;
try {
  const nc = await (await fetch(`${NATCOMM}?where=WBIC%3D${WBIC}&outFields=MAX_DEPTH,MAX_DEPTH_UNITS&returnGeometry=false&f=json`)).json();
  const a = ((nc.features || [])[0] || {}).attributes;
  if (a && a.MAX_DEPTH > 0) dnrMaxFt = /m/i.test(a.MAX_DEPTH_UNITS || '') && !/ft|feet/i.test(a.MAX_DEPTH_UNITS) ? a.MAX_DEPTH * 3.281 : a.MAX_DEPTH;
} catch (e) { /* no cap */ }
const capFt = dnrMaxFt ? dnrMaxFt * DEPTH_CAP_X : Infinity;
console.log(`${NAME} (WBIC ${WBIC})${dnrMaxFt ? `, DNR max depth ${Math.round(dnrMaxFt)} ft, cap ${Math.round(capFt)} ft` : ''}`);

// ---- every log under --logs ----
function walk(d) {
  return readdirSync(d).flatMap(f => {
    const p = join(d, f), s = statSync(p);
    return s.isDirectory() ? walk(p) : /\.sl[23]$/i.test(f) ? [p] : [];
  });
}
const mLat = 111320, mLng = 111320 * Math.cos((bb.minlat + bb.maxlat) / 2 * Math.PI / 180);
const nearLake = p => p.lat > bb.minlat - NEAR_LAKE_M / mLat && p.lat < bb.maxlat + NEAR_LAKE_M / mLat &&
  p.lng > bb.minlng - NEAR_LAKE_M / mLng && p.lng < bb.maxlng + NEAR_LAKE_M / mLng;
// Metres from a point to the nearest shoreline (any ring, islands included).
function shoreM(lat, lng) {
  let best = Infinity;
  const px = lng * mLng, py = lat * mLat;
  for (const r of rings) for (let i = 1; i < r.length; i++) {
    const ax = r[i - 1][0] * mLng, ay = r[i - 1][1] * mLat, bx = r[i][0] * mLng, by = r[i][1] * mLat;
    const vx = bx - ax, vy = by - ay, vv = vx * vx + vy * vy;
    const t = vv ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / vv)) : 0;
    const d = Math.hypot(px - ax - t * vx, py - ay - t * vy);
    if (d < best) best = d;
  }
  return best;
}
const cells = new Map(); // key -> { gx, gy, v: Float32Array, n }
const used = [];
let soundings = 0;
const buf = Buffer.alloc(CHUNK);

for (const file of walk(LOGS).sort()) {
  const fd = openSync(file, 'r'), parser = SonarLog.createParser();
  let first = true, onLake = false, n;
  try {
    while ((n = readSync(fd, buf, 0, CHUNK, null)) > 0) {
      parser.push(buf.subarray(0, n));
      // Logs from other lakes: give up after the first chunk if nothing is here.
      if (first) {
        first = false;
        let res; try { res = parser.finish(); } catch (e) { res = null; }
        if (res && !res.points.some(nearLake)) break;
      }
    }
    var res = parser.finish();
  } catch (e) { closeSync(fd); console.log(`fail ${basename(file)}  ${e.message}`); continue; }
  closeSync(fd);
  let kept = 0;
  for (const p of res.points) {
    if (p.depthFt > capFt || !inLake(p.lat, p.lng)) continue;
    const gx = Math.round(p.lng * mLng / CELL_M), gy = Math.round(p.lat * mLat / CELL_M), k = gx * 1e8 + gy;
    let c = cells.get(k);
    if (!c) cells.set(k, c = { gx, gy, v: new Float32Array(SAMPLES_PER_CELL), n: 0 });
    c.v[c.n % SAMPLES_PER_CELL] = p.depthFt; c.n++; kept++;
  }
  if (kept) { onLake = true; used.push(basename(file)); soundings += kept; }
  console.log(`${onLake ? 'use ' : 'skip'} ${basename(file)}${kept ? '  ' + kept.toLocaleString('en-US') + ' soundings' : ''}`);
}
if (!cells.size) { console.error('No soundings inside this lake.'); process.exit(1); }

// ---- median per cell, then reject cells that disagree with their neighbours ----
const median = a => { const s = Array.from(a).sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
cells.forEach(c => { c.d = median(c.v.subarray(0, Math.min(c.n, SAMPLES_PER_CELL))); });
// A boat at the dock or in a few feet of water often loses bottom lock and logs
// 30-60 ft readings right against the shore. No real bottom drops faster than
// about 45 degrees from the shoreline, so drop cells deeper than that allows.
let steep = 0;
cells.forEach((c, k) => {
  const depthM = c.d / 3.281;
  if (depthM > 2 && depthM > shoreM(c.gy * CELL_M / mLat, c.gx * CELL_M / mLng) * SHORE_SLOPE + 1) { cells.delete(k); steep++; }
});
// A bad stretch of one trip spans several cells that agree with each other,
// so repeat the pass: each one peels the cluster's edge cells off.
let spikes = 0;
for (let pass = 0; pass < SPIKE_PASSES; pass++) {
  const bad = [];
  cells.forEach((c, k) => {
    const nb = [];
    for (let dy = -SPIKE_RADIUS; dy <= SPIKE_RADIUS; dy++) for (let dx = -SPIKE_RADIUS; dx <= SPIKE_RADIUS; dx++) {
      if (!dx && !dy) continue;
      const o = cells.get((c.gx + dx) * 1e8 + c.gy + dy); if (o) nb.push(o.d);
    }
    if (nb.length >= 3) {
      const m = median(nb);
      if (Math.abs(c.d - m) > Math.max(SPIKE_FT, SPIKE_FRAC * m)) bad.push(k);
    }
  });
  bad.forEach(k => cells.delete(k));
  spikes += bad.length;
  if (!bad.length) break;
}
const pts = [];
cells.forEach(c => pts.push({ lat: c.gy * CELL_M / mLat, lng: c.gx * CELL_M / mLng, depthFt: c.d }));

// ---- contour, simplify, drop fragments ----
const chart = SonarLog.contour(pts, { intervalFt: INTERVAL });
const toM = ([la, ln], [la0, ln0]) => Math.hypot((la - la0) * mLat, (ln - ln0) * mLng);
function lengthM(l) { let s = 0; for (let i = 1; i < l.length; i++) s += toM(l[i], l[i - 1]); return s; }
function simplify(l, tol) { // Douglas-Peucker in metres
  if (l.length < 3) return l;
  const [a, b] = [l[0], l[l.length - 1]];
  let best = -1, bi = 0;
  for (let i = 1; i < l.length - 1; i++) {
    const px = (l[i][1] - a[1]) * mLng, py = (l[i][0] - a[0]) * mLat;
    const vx = (b[1] - a[1]) * mLng, vy = (b[0] - a[0]) * mLat, vv = vx * vx + vy * vy;
    const t = vv ? Math.max(0, Math.min(1, (px * vx + py * vy) / vv)) : 0;
    const d = Math.hypot(px - t * vx, py - t * vy);
    if (d > best) { best = d; bi = i; }
  }
  return best <= tol ? [a, b] : simplify(l.slice(0, bi + 1), tol).slice(0, -1).concat(simplify(l.slice(bi), tol));
}
let dropped = 0;
const levels = chart.levels.map(lv => ({
  depthFt: lv.depthFt,
  lines: lv.lines.filter(l => lengthM(l) >= MIN_LINE_M || (dropped++, false))
    .map(l => simplify(l, SIMPLIFY_M).map(([la, ln]) => [+la.toFixed(6), +ln.toFixed(6)]))
})).filter(lv => lv.lines.length);

// ---- coverage: share of the lake's 4 m cells with a kept sounding ----
let lakeCells = 0;
for (let gy = Math.floor(bb.minlat * mLat / CELL_M); gy <= Math.ceil(bb.maxlat * mLat / CELL_M); gy++)
  for (let gx = Math.floor(bb.minlng * mLng / CELL_M); gx <= Math.ceil(bb.maxlng * mLng / CELL_M); gx++)
    if (inLake(gy * CELL_M / mLat, gx * CELL_M / mLng)) lakeCells++;

const years = [...new Set(used.map(f => (f.match(/(20\d\d)/) || [])[1]).filter(Boolean))].sort();
const out = {
  wbic: WBIC, name: NAME, intervalFt: INTERVAL,
  maxDepthFt: Math.round(Math.max(...pts.map(p => p.depthFt)) * 10) / 10,
  bounds: bb, logs: used.length, years, soundings, cells: pts.length,
  coveragePct: Math.round(pts.length / lakeCells * 1000) / 10,
  levels
};
mkdirSync(OUT, { recursive: true });
const file = join(OUT, `${WBIC}.json`);
writeFileSync(file, JSON.stringify(out));
console.log(`\n${used.length} logs, ${soundings.toLocaleString('en-US')} soundings -> ${pts.length.toLocaleString('en-US')} cells ` +
  `(${spikes} spikes, ${steep} too deep for their distance from shore), ${out.coveragePct}% of the lake, deepest ${out.maxDepthFt} ft`);
console.log(`${levels.length} levels, ${levels.reduce((s, l) => s + l.lines.length, 0)} lines (${dropped} fragments dropped) -> ${file} ` +
  `(${Math.round(statSync(file).size / 1024)} KB)`);
