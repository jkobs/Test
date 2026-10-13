/* Runs every Playwright spec in test/ sequentially and fails if any fail.

   Exists so CI can gate deploys on the browser specs — the ones that enforce
   real CSS visibility and caught nearly every real bug in this app. Until this
   runner, they only ever ran by hand. No retries on purpose: a flaky spec
   should be visible and fixed, not silently re-rolled.

   Run: node test/run-specs.mjs  (after `node build.mjs`)
*/
import { readdirSync } from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const dir = dirname(fileURLToPath(import.meta.url));
const specs = readdirSync(dir).filter(f => f.endsWith('.spec.mjs')).sort();
const failed = [];
const t0 = Date.now();
for (const f of specs) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [join(dir, f)], { encoding: 'utf8' });
  const ok = r.status === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${f}  (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  if (!ok) {
    failed.push(f);
    // Show the spec's own FAIL lines (and any crash) so CI logs are diagnosable.
    const out = (r.stdout || '') + (r.stderr || '');
    out.split('\n').filter(l => /^FAIL|Error|error/.test(l)).slice(0, 12)
      .forEach(l => console.log('      ' + l));
  }
}
console.log(`\n${specs.length - failed.length}/${specs.length} specs passed in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
process.exit(failed.length ? 1 : 0);
