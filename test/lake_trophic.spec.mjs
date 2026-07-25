/* Playwright validation: the lake card reports trophic status (oligotrophic /
   mesotrophic / eutrophic / hypereutrophic) derived from DNR satellite water
   clarity, plus clarity and depth, for ordinary Wisconsin lakes.

   Why this exists: trophic status was previously sourced ONLY from Wikidata's
   explicitly-stated P6526 classification, which covers a tiny handful of
   Wisconsin lakes — so in practice the "Trophic status" row almost never
   appeared. It's now computed with Carlson's Trophic State Index
   (TSI = 60 - 14.41·ln(Secchi_m)), the standard classification WI DNR itself
   uses, from the satellite clarity value the app already fetches.

   Band boundaries under test land on the conventional Secchi cutoffs:
   4 m / 2 m / 0.5 m == TSI 40 / 50 / 70.

   Run: node test/lake_trophic.spec.mjs
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
  { type: 'Feature', properties: { GNIS_NAME: 'Clarity Lake', AREASQKM: 2.0, FTYPE: 390 },
    geometry: { type: 'Polygon', coordinates: [[[-92.40,45.93],[-92.36,45.93],[-92.36,45.95],[-92.40,45.95],[-92.40,45.93]]] } }
] };

// Loads the app, selects the mocked Wisconsin lake, and returns the rendered
// lake-info text. `clarityFt` drives the mocked DNR satellite clarity layer;
// `maxDepFt`/`meanDepFt` drive the classification layer.
async function loadLake(clarityFt, { maxDepFt = 42, meanDepFt = null } = {}) {
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
    if (url.includes('WY_LAKE_SATELLITE_WATER_CLARITY_RESULTS')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        features: clarityFt == null ? []
          : [{ attributes: { SATELLITE_CLARITY_FEET: clarityFt, YEAR: 2025 } }]
      }) });
    }
    if (url.includes('FM_WFF_LAKE_CLASSIFICATIONS')) {
      const attrs = { LAKE_NAME: 'Clarity Lake', LAKE_CLASS: 'Warmwater', MAXDEP_FT: maxDepFt };
      if (meanDepFt != null) attrs.MEANDEP_FT = meanDepFt;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [{ attributes: attrs }] }) });
    }
    if (url.includes('hydro.nationalmap.gov') && !url.includes('MapServer/6'))
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(NHD_WB) });
    if (url.includes('hydro.nationalmap.gov') || url.includes('services.arcgis.com'))
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: [] }) });
    if (url.includes('/api/interpreter')) return route.abort('failed');
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#advisor-body', { timeout: 15000 });
  await page.evaluate(() => window.__testHooks.selectMapPoint(45.94, -92.38));
  await page.waitForTimeout(3000);
  const text = await page.$eval('#lake-info', el => el.textContent.replace(/\s+/g, ' ')).catch(() => '');
  await browser.close();
  return text;
}

// --- Carlson TSI bands. Secchi 4 m (13.1 ft) and 2 m (6.6 ft) are the
// oligo/meso and meso/eutrophic boundaries; 0.5 m (1.6 ft) is hypereutrophic.
const bands = [
  [20, 'Oligotrophic', 34],   // 6.10 m -> TSI ~34
  [10, 'Mesotrophic',  44],   // 3.05 m -> TSI ~44
  [4,  'Eutrophic',    57],   // 1.22 m -> TSI ~57
  [1,  'Hypereutrophic', 77]  // 0.30 m -> TSI ~77
];
for (const [ft, label, tsi] of bands) {
  const text = await loadLake(ft);
  console.log('  clarity ' + ft + ' ft -> ' + (text.match(/Trophic status.{0,60}/) || ['(no trophic row)'])[0]);
  check('clarity ' + ft + ' ft is classified ' + label, text.includes(label));
  check('clarity ' + ft + ' ft reports TSI ' + tsi, text.includes('Carlson TSI ' + tsi));
}

// --- Clarity + depth still render alongside, with source attribution.
const full = await loadLake(10, { maxDepFt: 42, meanDepFt: 15 });
console.log('  full card: ' + full.slice(0, 260));
check('water clarity value is shown', /10\.0 ft/.test(full));
check('clarity is attributed to the DNR satellite survey, with year', full.includes('DNR satellite survey, 2025'));
check('max depth is shown', full.includes('42 ft'));
check('mean depth from DNR is shown when the field exists', full.includes('15 ft'));
check('trophic status is attributed to Carlson TSI', full.includes('Carlson TSI'));

// --- No clarity data: no trophic row invented, and nothing breaks.
const bare = await loadLake(null);
check('no clarity data -> no fabricated trophic status', !/Trophic status/.test(bare));
check('lake card still renders without clarity', bare.length > 0 && bare.includes('42 ft'));

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
