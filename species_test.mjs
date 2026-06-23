import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';

const root = join(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(root, 'dist/solunar.html'), 'utf8');
const FIXED = new Date('2026-06-20T15:00:00Z').getTime();

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'https://localhost/',
  pretendToBeVisual: true,
  beforeParse(window) {
    const RealDate = window.Date;
    class FakeDate extends RealDate {
      constructor(...a) { super(...(a.length ? a : [FIXED])); }
      static now() { return FIXED; }
    }
    window.Date = FakeDate;
    window.navigator.geolocation = undefined;
    // Fake fetch: return stable pressure data so renderAdvisor fires
    window.fetch = () => Promise.resolve({
      json: () => Promise.resolve({
        current: { temperature_2m: 72, wind_speed_10m: 6, wind_direction_10m: 45 },
        hourly: {
          time: Array.from({length:9},(_,i)=>1000+i*3600),
          surface_pressure: [1013,1013,1013,1013,1013,1013,1013,1013,1013]
        }
      })
    });
    window.Notification = undefined;
  }
});

await new Promise(r => setTimeout(r, 500));

const doc = dom.window.document;

const select = doc.getElementById('conditions-species-select');
if (!select) { console.log('FAIL  #conditions-species-select not found'); process.exit(1); }

const species = Array.from(select.options).map(o => o.value);
console.log(`Species in dropdown (${species.length}): ${species.join(', ')}\n`);

const checks = [];
for (const sp of species) {
  select.value = sp;
  select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 50));

  const depth        = doc.querySelector('.adv-grid .adv-item:nth-child(2) .adv-val')?.textContent || '';
  const structure    = doc.querySelector('.adv-grid .adv-item:nth-child(3) .adv-val')?.textContent || '';
  const presentation = doc.querySelector('.adv-grid .adv-item:nth-child(4) .adv-val')?.textContent || '';
  const allText      = depth + ' ' + structure + ' ' + presentation;

  // Check for cross-species leaks
  const leaks = [];
  if (sp !== 'Walleye'          && /walleye/i.test(allText))           leaks.push('walleye mention');
  if (sp !== 'Largemouth Bass'  && /largemouth/i.test(allText))        leaks.push('largemouth mention');
  if (sp !== 'Northern Pike'    && /northern pike/i.test(allText))     leaks.push('pike mention');
  if (sp !== 'Lake Trout'       && /lake trout/i.test(allText))        leaks.push('lake trout mention');

  // Check content is non-empty and species-plausible
  const empty = depth.length < 3;

  const ok = leaks.length === 0 && !empty;
  checks.push({ sp, ok, leaks, depth: depth.substring(0, 50) });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${sp.padEnd(24)} depth="${depth.substring(0,45)}"${leaks.length ? '  LEAK: '+leaks.join(', ') : ''}`);
}

const fails = checks.filter(c => !c.ok);
console.log(`\n${checks.length - fails.length}/${checks.length} species checks passed.`);
dom.window.close();
process.exit(fails.length ? 1 : 0);
