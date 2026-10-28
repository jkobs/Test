/* Spec: the nightly contract check retries a request once before failing.

   A single slow or 5xx answer from DNR/USGS used to turn the whole nightly run
   red (it timed out on the Lake Mendota query from GitHub's runners every
   night). One retry absorbs a blip; a genuine contract break fails both
   attempts and still fails the run. Pure Node: no browser, no network.

   Run: node test/contract_retry.spec.mjs
*/
import { getJson, getHead } from '../tools/contract/http.mjs';

let failures = 0;
function check(label, cond) { console.log((cond ? 'PASS  ' : 'FAIL  ') + label); if (!cond) failures++; }

const reply = (status, obj) => ({ status, text: async () => JSON.stringify(obj) });
// A fake fetch that plays back one scripted outcome per call; counts the calls.
function script(...steps) {
  let n = 0;
  const f = async () => {
    const s = steps[Math.min(n++, steps.length - 1)];
    if (s instanceof Error) throw s;
    return s;
  };
  f.calls = () => n;
  return f;
}
const opt = f => ({ fetchImpl: f, delayMs: 1, ms: 1000 });

{ const f = script(new Error('aborted'), reply(200, { ok: 1 }));
  const r = await getJson('u', opt(f));
  check('a thrown/aborted request is retried once and can succeed', r.status === 200 && r.body.ok === 1 && f.calls() === 2); }

{ const f = script(reply(504, {}), reply(200, { ok: 1 }));
  const r = await getJson('u', opt(f));
  check('an HTTP 5xx is retried once', r.status === 200 && f.calls() === 2); }

{ const f = script(reply(200, { error: { code: 400, message: 'Failed to execute query.' } }), reply(200, { features: [] }));
  const r = await getJson('u', opt(f));
  check('an in-body ArcGIS error on HTTP 200 is retried once', !r.body.error && f.calls() === 2); }

{ const f = script(reply(200, { error: { code: 400 } }));
  const r = await getJson('u', opt(f));
  check('a persistent error is reported after exactly one retry (2 calls)', !!r.body.error && f.calls() === 2); }

{ const f = script(new Error('down'));
  let threw = false; try { await getJson('u', opt(f)); } catch (e) { threw = true; }
  check('a request that keeps failing still throws (run stays red), after 2 calls', threw && f.calls() === 2); }

{ const f = script(reply(200, { features: [] }));
  await getJson('u', opt(f));
  check('a good first answer is not retried', f.calls() === 1); }

{ const f = script(reply(404, {}));
  const r = await getJson('u', opt(f));
  check('HTTP 404 (endpoint removed) is not retried: it is a real contract break', r.status === 404 && f.calls() === 1); }

{ const f = script(new Error('aborted'), { status: 200, headers: {} });
  const r = await getHead('u', opt(f));
  check('plain GET (PDF check) also retries once', r.status === 200 && f.calls() === 2); }

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('all contract retry checks passed');
