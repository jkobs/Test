/* Playwright validation: sky conditions (cloud cover and precipitation) affect fishing advice.
   The advice engine now considers current cloud cover and precipitation from Open-Meteo
   and generates notes about overcast/clear skies and rain.

   Run: node test/sky_conditions.spec.mjs
*/
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = 'file://' + resolve(__dirname, '../dist/solunar.html');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let failures = 0;
function check(label, cond) { console.log((cond ? 'PASS  ' : 'FAIL  ') + label); if (!cond) failures++; }

async function testScenario(scenarioName, cloudCover, precip, expectedText) {
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await (await browser.newContext()).newPage();

  // Pin the clock to local midday (17:00 UTC ≈ 12:00 CDT at the default
  // Wisconsin location). The light-condition note in app.js keys off the
  // solunar engine's real astronomical sunrise/sunset for "now", NOT the
  // mocked daily.sunrise/sunset fields — so without pinning the clock, a run
  // after dark takes the "🌙 Night" branch and the overcast/clear-sky notes
  // this test asserts never render, making the test pass/fail by time of day.
  await page.addInitScript(() => {
    const FIXED = new Date('2026-07-08T17:00:00Z').getTime();
    const _Date = Date;
    function FakeDate(...args) { return args.length ? new _Date(...args) : new _Date(FIXED); }
    FakeDate.prototype = _Date.prototype;
    FakeDate.now = () => FIXED;
    FakeDate.parse = _Date.parse;
    FakeDate.UTC = _Date.UTC;
    // eslint-disable-next-line no-global-assign
    Date = FakeDate;
  });

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
            precipitation: precip
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

  const advisorBody = await page.$eval('#advisor-body', el => el.textContent);
  const hasExpectedText = advisorBody.includes(expectedText);
  check(scenarioName + ' — contains "' + expectedText + '"', hasExpectedText);

  await browser.close();
}

// Scenario A: Overcast (cloud_cover >= 70)
await testScenario('Scenario A: Overcast', 85, 0, 'Overcast skies');

// Scenario B: Clear (cloud_cover <= 25)
await testScenario('Scenario B: Clear', 10, 0, 'Clear, bright skies');

// Scenario C: Light rain (0 < precip <= 2.5)
await testScenario('Scenario C: Light rain', 50, 1.2, 'Light rain');

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
