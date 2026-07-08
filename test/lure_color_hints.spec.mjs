/* Playwright validation: light-condition-based lure/bait color guidance per species.
   The advice engine now considers cloud cover and appends color hints to species
   presentations. Sight-feeding species get color guidance, scent-feeders do not.

   Run: node test/lure_color_hints.spec.mjs
*/
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = 'file://' + resolve(__dirname, '../dist/solunar.html');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let failures = 0;
function check(label, cond) { console.log((cond ? 'PASS  ' : 'FAIL  ') + label); if (!cond) failures++; }

async function testScenario(scenarioName, cloudCover) {
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await (await browser.newContext()).newPage();

  // Mock Open-Meteo API responses
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('file://')) return route.continue();

    if (url.includes('api.open-meteo.com/v1/forecast')) {
      const now = Math.floor(Date.now() / 1000);
      // Return sunrise 5 hours before now and sunset 5 hours after now
      // This keeps us well outside the 45-minute golden-hour window
      const sunriseUnix = now - (5 * 3600);
      const sunsetUnix = now + (5 * 3600);

      // Determine if this is the current conditions request or daily request
      if (url.includes('&current=')) {
        // Current conditions endpoint
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
          current: {
            temperature_2m: 72,
            wind_speed_10m: 8,
            wind_direction_10m: 180,
            cloud_cover: cloudCover,
            precipitation: 0
          },
          hourly: {
            time: [now - 4*3600, now - 3*3600, now - 2*3600, now - 3600, now, now + 3600, now + 2*3600, now + 3*3600, now + 4*3600],
            surface_pressure: [1013, 1013, 1013, 1013, 1013, 1013, 1013, 1013, 1013]
          }
        }) });
      } else if (url.includes('&daily=')) {
        // Daily weather endpoint
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
  await page.waitForTimeout(2000); // Wait for API calls to settle

  return { browser, page };
}

// Scenario A: Overcast (cloud_cover >= 70)
console.log('\n=== Scenario A: Overcast (cloud_cover: 85) ===');
const { browser: browserA, page: pageA } = await testScenario('Scenario A', 85);

// Select Walleye in the Bite Conditions dropdown (may already be selected)
const selectEl = await pageA.$('#conditions-species-select');
const currentValue = await selectEl.evaluate(el => el.value);
if (currentValue !== 'Walleye') {
  await pageA.selectOption('#conditions-species-select', 'Walleye');
  await pageA.waitForTimeout(500);
}

// Check that Bite Conditions (advisor-body) contains the overcast Walleye guidance
const advisorBodyA = await pageA.$eval('#advisor-body', el => el.textContent);
const hasOvercastWalleye = advisorBodyA.includes('firetiger, chartreuse, or gold');
check('Scenario A (overcast) — Walleye Bite Conditions contains overcast guidance', hasOvercastWalleye);

// Check that Species Outlook list also contains the overcast Walleye guidance
const speciesRowsA = await pageA.$eval('#species-rows', el => el.textContent);
const hasOvercastInOutlook = speciesRowsA.includes('firetiger, chartreuse, or gold');
check('Scenario A (overcast) — Species Outlook includes overcast Walleye guidance', hasOvercastInOutlook);

// Check that Lake Sturgeon (scent-feeder) does NOT contain any color clause
const sturgeonRowA = await pageA.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('.species-row'));
  for (let row of rows) {
    const nameEl = row.querySelector('.species-name');
    if (nameEl && nameEl.textContent.includes('Lake Sturgeon')) {
      return row.textContent;
    }
  }
  return '';
});
const sturgeonNoColorA = !sturgeonRowA.includes('In today\'s overcast light');
check('Scenario A (overcast) — Lake Sturgeon row does NOT contain color hint', sturgeonNoColorA);

await browserA.close();

// Scenario B: Clear (cloud_cover <= 25)
console.log('\n=== Scenario B: Clear (cloud_cover: 10) ===');
const { browser: browserB, page: pageB } = await testScenario('Scenario B', 10);

// Select Walleye in the Bite Conditions dropdown
const selectElB = await pageB.$('#conditions-species-select');
const currentValueB = await selectElB.evaluate(el => el.value);
if (currentValueB !== 'Walleye') {
  await pageB.selectOption('#conditions-species-select', 'Walleye');
  await pageB.waitForTimeout(500);
}

// Check that Bite Conditions contains the clear Walleye guidance
const advisorBodyB = await pageB.$eval('#advisor-body', el => el.textContent);
const hasClearWalleye = advisorBodyB.includes('natural/silver or perch patterns');
check('Scenario B (clear) — Walleye Bite Conditions contains clear guidance', hasClearWalleye);

await browserB.close();

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
