/*
 build.mjs — inline vendor + engine + app + CSS into a single self-contained
 dist/solunar.html. This is the artifact to put on the iPhone (works offline
 from a local file; no separate files, no network needed for the core app).
 Run: node build.mjs
*/
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(fileURLToPath(import.meta.url));
const S = (p) => readFileSync(join(root, p), 'utf8');

const html = S('src/index.html');
const css = S('src/styles.css');
const vendor = S('src/vendor/astronomy.browser.min.js');
const engine = S('src/solunar.js');
const app = S('src/app.js');

const bundled = html
  .replace('<link rel="stylesheet" href="styles.css">', `<style>\n${css}\n</style>`)
  .replace('<script src="vendor/astronomy.browser.min.js"></script>', `<script>\n${vendor}\n</script>`)
  .replace('<script src="solunar.js"></script>', `<script>\n${engine}\n</script>`)
  .replace('<script src="app.js"></script>', `<script>\n${app}\n</script>`);

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/solunar.html'), bundled);
console.log(`Built dist/solunar.html (${(bundled.length / 1024).toFixed(0)} KB) — single self-contained file.`);
