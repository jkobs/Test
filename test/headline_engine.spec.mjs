/* Playwright validation: Stage 3 species-aware headline engine (composeHeadline)
   and the Field Notes tile.

   Scenario A: clear sky, default species (Walleye) — hero headline/kicker/deck
   are populated and species-aware; switching species via the header pill
   (#species-pill-select) updates the hero headline AND the Field Notes tile
   header together (same _onSpeciesChange path). A Field Notes chip click is
   also verified to drive the same path (switches the pill value).

   Scenario B: overcast sky — the hero deck's sky/pressure clause reflects it
   ("Overcast light...").

   Daily sunrise/sunset are mocked far from "now" (matching sky_conditions.spec.mjs)
   so weather-driven golden-hour notes never interfere with the deterministic
   assertions here — the headline engine's own solunar timing is unmocked
   (real astronomy), which is fine because the fixed-copy templates all embed
   the species name in one of a few invariant fragments regardless of score/
   window state (see the /for walleye|walleye are|walleye want/i style regex).

   Run: node test/headline_engine.spec.mjs
*/
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = 'file://' + resolve(__dirname, '../dist/solunar.html');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let failures = 0;
function check(label, cond) { console.log((cond ? 'PASS  ' : 'FAIL  ') + label); if (!cond) failures++; }

async function openScenario(cloudCover, precip) {
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await (await browser.newContext()).newPage();

  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('file://')) return route.continue();

    if (url.includes('api.open-meteo.com/v1/forecast')) {
      const now = Math.floor(Date.now() / 1000);
      // Sunrise 5h before / sunset 5h after "now" — well outside the
      // 45-minute golden-hour window computeAdvice() checks.
      const sunriseUnix = now - (5 * 3600);
      const sunsetUnix = now + (5 * 3600);

      if (url.includes('&current=')) {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
          current: {
            temperature_2m: 72,
            wind_speed_10m: 8,
            wind_direction_10m: 180,
            cloud_cover: cloudCover,
            precipitation: precip
          },
          hourly: {
            time: [now - 4*3600, now - 3*3600, now - 2*3600, now - 3600, now, now + 3600, now + 2*3600, now + 3*3600, now + 4*3600],
            surface_pressure: [1013, 1013, 1013, 1013, 1013, 1013, 1013, 1013, 1013]
          }
        }) });
      } else if (url.includes('&daily=')) {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
          daily: {
            time: ['2026-07-08'],
            temperature_2m_max: [82],
            temperature_2m_min: [62],
            wind_speed_10m_max: [9],
            weather_code: [1],
            sunrise: ['2026-07-08T' + new Date(sunriseUnix * 1000).toISOString().split('T')[1].split('.')[0]],
            sunset: ['2026-07-08T' + new Date(sunsetUnix * 1000).toISOString().split('T')[1].split('.')[0]]
          }
        }) });
      }
    }

    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000); // let pressure/weather fetches + first render settle
  return { browser, page };
}

// ---- Scenario A: clear sky, default species (Walleye) ----
console.log('\n=== Scenario A: clear sky, default species ===');
const { browser: browserA, page: pageA } = await openScenario(10, 0);

const heroTextA = await pageA.$eval('#hero', el => el.textContent);
check('A: headline mentions walleye', /for walleye|walleye are|walleye want/i.test(heroTextA));
check('A: #hero has no "undefined"', !/undefined/.test(heroTextA));
check('A: #hero has no "NaN"', !/NaN/.test(heroTextA));
const deckTextA = await pageA.$eval('#hero .hero-deck', el => el.textContent.trim());
check('A: deck is non-empty', deckTextA.length > 0);

// Switch species via the header pill -> headline + Field Notes both follow.
await pageA.selectOption('#species-pill-select', 'Northern Pike');
await pageA.waitForTimeout(300);
const heroTextA2 = await pageA.$eval('#hero', el => el.textContent);
check('A: after pill switch, headline mentions pike', /for pike|pike are|pike want/i.test(heroTextA2));
const fieldNotesHdA = await pageA.$eval('#field-notes .t-hd', el => el.textContent);
check('A: Field Notes header follows pill (NORTHERN PIKE)', fieldNotesHdA.includes('NORTHERN PIKE'));

// A Field Notes chip click drives the same _onSpeciesChange path — pick a
// chip whose species differs from the currently-selected one.
const pillValueBefore = await pageA.$eval('#species-pill-select', el => el.value);
const chipSpecies = await pageA.evaluate((current) => {
  const chips = Array.from(document.querySelectorAll('#field-notes .fn-chip'));
  const other = chips.find(c => c.getAttribute('data-species') !== current);
  if (!other) return null;
  other.click();
  return other.getAttribute('data-species');
}, pillValueBefore);
await pageA.waitForTimeout(300);
if (chipSpecies) {
  const pillValueAfter = await pageA.$eval('#species-pill-select', el => el.value);
  check('A: Field Notes chip click switches the pill value', pillValueAfter === chipSpecies);
} else {
  check('A: Field Notes chip click switches the pill value', false);
}

await browserA.close();

// ---- Scenario B: overcast sky ----
console.log('\n=== Scenario B: overcast sky ===');
const { browser: browserB, page: pageB } = await openScenario(85, 0);
const deckTextB = await pageB.$eval('#hero .hero-deck', el => el.textContent);
check('B: deck contains "Overcast light"', deckTextB.includes('Overcast light'));
await browserB.close();

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
