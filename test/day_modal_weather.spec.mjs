/* Playwright validation: the day-detail modal shows weather (hi/lo/wind/conditions),
   matching what the preview card already showed before expanding.

   Run: node test/day_modal_weather.spec.mjs
*/
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = 'file://' + resolve(__dirname, '../dist/solunar.html');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let failures = 0;
function check(label, cond) { console.log((cond ? 'PASS  ' : 'FAIL  ') + label); if (!cond) failures++; }

const browser = await chromium.launch({ executablePath: CHROME });
const page = await (await browser.newContext()).newPage();

await page.route('**/*', async (route) => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('api.open-meteo.com/v1/forecast')) {
    const days = 7, time = [], hi = [], lo = [], wind = [], code = [];
    for (let i = 0; i < days; i++) {
      time.push('2026-07-0' + (i + 1));
      hi.push(82); lo.push(62); wind.push(9); code.push(1);
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      daily: { time, temperature_2m_max: hi, temperature_2m_min: lo, wind_speed_10m_max: wind, weather_code: code }
    }) });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});

await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.card', { timeout: 15000 });
await page.waitForTimeout(1000); // let fetchWeather populate the preview cards

const previewText = await page.$eval('#weather-0', el => el.textContent);
console.log('Preview card weather: ' + previewText.trim());
check('preview card shows weather', /82°\/62°F/.test(previewText));

// Open the day-detail modal (tap the first day card).
await page.click('.card');
await page.waitForSelector('.modal', { timeout: 5000 });
const modalText = await page.$eval('.modal', el => el.textContent);
console.log('Modal text snippet: ' + modalText.replace(/\s+/g, ' ').slice(0, 300));

check('modal shows the Weather section label', modalText.includes('Weather'));
check('modal shows hi/lo temps', /82°\/62°F/.test(modalText));
check('modal shows wind + conditions', /Wind to 9 mph/.test(modalText) && /mainly clear/.test(modalText));

await browser.close();
console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
