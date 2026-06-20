# 🎣 Solunar Fishing Times

Today's and the next 7 days' **major** and **minor** solunar fishing periods for a
location — default **Yellow Lake / Danbury, WI**. Built for a walleye angler
planning weekend trips, usable on an **iPhone** and **offline** at the lake.

## What it shows
- **Major periods** (~2 h): moon **overhead** and **underfoot** (transit ± 1 h).
- **Minor periods** (~1 h): **moonrise** and **moonset** (event ± 30 min).
- Sunrise/sunset, moon phase, a 1–5★ day rating (phase + sunrise/sunset overlap),
  a live **next-period countdown**, and a weather overlay (when online).

## Accuracy (validated)
Cross-checked to **±2 min** against USNO / timeanddate.com, and reproduced by
**two independent engines**:
- Runtime: **astronomy-engine** (pure JS, no download) — `src/solunar.js`
- Oracle:  **PyEphem** — `oracle/oracle.py`

Both reproduce the validated Yellow Lake 2026-06-20 values exactly (sunrise 5:18,
sunset 9:03, underfoot 6:05, overhead 6:27, moonrise 11:56, moonset 12:27).

## Use it
- **On the phone:** put `dist/solunar.html` on the iPhone and open it — one
  self-contained file, works offline.
- **Live location + alerts on iOS** need HTTPS hosting + "Add to Home Screen"
  (WebKit blocks geolocation/push from local `file://`). Hosted, tap **Use my
  location** and **Enable alerts**. Local-file falls back to Yellow Lake + an
  in-page countdown.
- **On Windows:** open `dist/solunar.html` in Edge.

## Develop / build / test
```bash
npm install
npm run build      # bundle src/* -> dist/solunar.html (the shippable file)
npm test           # full suite: engine accuracy + PyEphem oracle + build + UAT
npm run shot       # render a phone-sized screenshot (prefers Microsoft Edge)
```
Source lives in `src/` (dev, separate files); `dist/solunar.html` is the inlined
single-file build.

## Quality process
- **UX design:** `docs/UX_DESIGN.md` — goals, hierarchy, wireframe, constraints.
  Review with the **`ux-reviewer`** subagent after UI changes.
- **UAT:** `docs/UAT_PLAN.md` — acceptance criteria (AC1–AC7) checked by
  `test/uat.test.mjs` against the rendered page. Run with the **`uat-runner`**
  subagent for a RELEASE-READY / BLOCKED verdict.
- Browser testing prefers **Microsoft Edge** (Playwright `msedge` channel),
  falling back to chromium where Edge isn't installed.

## Layout
```
src/            index.html, styles.css, app.js, solunar.js, vendor/
oracle/         oracle.py        PyEphem cross-check
test/           solunar.test.mjs (accuracy), uat.test.mjs (acceptance)
scripts/        screenshot.mjs   Edge-first visual render
docs/           UX_DESIGN.md, UAT_PLAN.md
.claude/agents/ ux-reviewer.md, uat-runner.md
build.mjs       inlines everything -> dist/solunar.html
```
