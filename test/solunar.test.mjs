/*
 Regression test for the JS solunar engine against the validated June 20, 2026
 Yellow Lake values. The engine must agree within TOLERANCE_MIN of each value.
 Run: node test/solunar.test.mjs
*/
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Solunar = require('../src/solunar.js');

const TOLERANCE_MIN = 2;

const LOC = { lat: 45.94, lng: -92.38, tz: 'America/Chicago' };

// Validated reference values (local Central time) for 2026-06-20.
const EXPECTED = {
  sunrise:   '05:18',
  sunset:    '21:03',
  underfoot: '06:05', // moon lower transit
  overhead:  '18:27', // moon upper transit
  moonrise:  '11:56',
  moonset:   '00:27', // early-morning setting after local midnight
};

function hhmmInTz(date, tz) {
  if (!date) return null;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(date);
}

function minutesOf(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function diffMin(aHHMM, bHHMM) {
  let d = Math.abs(minutesOf(aHHMM) - minutesOf(bHHMM));
  if (d > 720) d = 1440 - d; // wrap around midnight
  return d;
}

const day = Solunar.computeDay({ year: 2026, month: 6, day: 20, ...LOC });

const got = {
  sunrise:   hhmmInTz(day.sunrise, LOC.tz),
  sunset:    hhmmInTz(day.sunset, LOC.tz),
  underfoot: hhmmInTz(day.underfoot, LOC.tz),
  overhead:  hhmmInTz(day.overhead, LOC.tz),
  moonrise:  hhmmInTz(day.moonrise, LOC.tz),
  moonset:   hhmmInTz(day.moonset, LOC.tz),
};

let failures = 0;
console.log(`Solunar JS engine — Yellow Lake, 2026-06-20 (tolerance ${TOLERANCE_MIN} min)\n`);
for (const key of Object.keys(EXPECTED)) {
  const exp = EXPECTED[key], val = got[key];
  const d = val ? diffMin(val, exp) : Infinity;
  const ok = d <= TOLERANCE_MIN;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${key.padEnd(10)} expected ${exp}  got ${val ?? 'null'}  (${isFinite(d) ? d : '?'} min)`);
}

console.log(`\nMoon: ${day.moon.phaseName}, illumination ${(day.moon.illumination * 100).toFixed(0)}%`);
console.log(`Rating: ${day.rating.stars}/5 (score ${day.rating.score.toFixed(2)})`);

if (failures) {
  console.error(`\n${failures} value(s) outside tolerance.`);
  process.exit(1);
}
console.log('\nAll values within tolerance.');
