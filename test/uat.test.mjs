/*
 UAT (User Acceptance Test) — loads the built single-file app in a headless DOM
 and asserts the rendered page meets the acceptance criteria a user cares about:

   AC1  Defaults to Yellow Lake when geolocation is unavailable.
   AC2  Renders a 7-day forecast (7 day cards).
   AC3  Today's card shows the validated sun + solunar period times.
   AC4  Major periods are moon overhead/underfoot; minors are moonrise/set.
   AC5  A live "next period" countdown is shown.
   AC6  Each day shows a star rating.
   AC7  App works with no network (weather degrades gracefully).

 Clock is pinned to 2026-06-20 so content is deterministic.
 Run: node test/uat.test.mjs
*/
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'dist/solunar.html'), 'utf8');

const FIXED = new Date('2026-06-20T15:00:00Z').getTime(); // ~10:00 CDT, June 20

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'https://localhost/',
  pretendToBeVisual: true,
  beforeParse(window) {
    // Pin the clock
    const RealDate = window.Date;
    class FakeDate extends RealDate {
      constructor(...a) { super(...(a.length ? a : [FIXED])); }
      static now() { return FIXED; }
    }
    window.Date = FakeDate;
    // Geolocation unavailable -> must fall back to Yellow Lake
    window.navigator.geolocation = undefined;
    // No network: weather fetch should fail gracefully
    window.fetch = () => Promise.reject(new Error('offline'));
    // Notifications absent
    window.Notification = undefined;
  }
});

const checks = [];
function check(name, cond, detail) {
  checks.push({ name, ok: !!cond, detail: detail || '' });
}

// Let init() + one countdown tick run.
await new Promise((r) => setTimeout(r, 300));

const doc = dom.window.document;
const text = doc.body.textContent.replace(/\s+/g, ' ');

// AC1
check('AC1 defaults to Yellow Lake', /Yellow Lake/.test(doc.getElementById('loc').textContent));

// AC2
const cards = doc.querySelectorAll('#days .card');
check('AC2 seven day cards', cards.length === 7, `got ${cards.length}`);

// AC3 — today's validated times (local Central)
const today = cards[0] ? cards[0].textContent : '';
[['Sunrise 5:18', /Sunrise 5:18/], ['Sunset 9:03', /Sunset 9:03/],
 ['underfoot 6:05', /6:05 AM/], ['overhead 6:27', /6:27 PM/],
 ['moonrise 11:56', /11:56 AM/]].forEach(([label, re]) => {
  check('AC3 today shows ' + label, re.test(today));
});

// AC4 — period labelling
check('AC4 major = overhead/underfoot', /Moon overhead/.test(today) && /Moon underfoot/.test(today));
check('AC4 minor = moonrise/moonset', /Moonrise/.test(today) && /Moonset/.test(today));
const majorTags = (cards[0] ? cards[0].querySelectorAll('.period.major').length : 0);
check('AC4 today has 2 major periods', majorTags === 2, `got ${majorTags}`);

// AC5 — countdown
const next = doc.getElementById('next');
check('AC5 next-period block visible', next && next.style.display !== 'none');
check('AC5 countdown is a timer', next && /\d?\d:\d\d/.test(next.querySelector('.countdown')?.textContent || ''));

// AC6 — rating
check('AC6 fish rating rendered', /🐟/.test(today));

// AC7 — offline weather degraded, app still rendered
check('AC7 app rendered without network', cards.length === 7);

let fails = 0;
console.log('UAT — Solunar Fishing Times (pinned 2026-06-20)\n');
for (const c of checks) {
  if (!c.ok) fails++;
  console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  [' + c.detail + ']' : ''}`);
}
console.log(`\n${checks.length - fails}/${checks.length} acceptance checks passed.`);
dom.window.close();
process.exit(fails ? 1 : 0);
