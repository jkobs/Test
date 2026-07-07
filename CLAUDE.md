# Fishing Advisor — project guide for Claude

Single-file PWA fishing app. Built from `src/` into `dist/solunar.html` by
`build.mjs`, deployed to GitHub Pages on push to **`master`** (the deploy
workflow triggers on `master`, not `main`).

## Working model preference (set by the user)

Use an **Opus model as the ADVISOR** and a **Sonnet model as the EXECUTOR**.
- Opus (advisor): understands the request, inspects the codebase, designs the
  approach, writes a precise self-contained spec, and reviews the result.
- Sonnet (executor): implements the code changes, builds, and runs tests.
  Dispatch it via the Agent tool with `model: "sonnet"`.
- The advisor handles final review, commit/push to `master`, and deploy
  verification.

## Hard rules

- **Only make changes at ≥95% confidence.** Be explicit about uncertainty
  instead of presenting guesses as confident fixes. When an external data
  source/endpoint can't be verified from the sandbox, probe it on-device
  (see `tools/probe.html`) rather than guessing.
- Push to **`master`**. Do not open a PR unless explicitly asked.
- Escape external/API-derived strings before putting them in `innerHTML`
  (`esc()` / `_titleCase()` helpers exist in `src/app.js`).

## Build & test

```bash
node build.mjs                 # inlines src/ -> dist/solunar.html
node test/uat.test.mjs         # 21 JSDOM acceptance checks (no CSS visibility)
node test/<name>.spec.mjs      # Playwright specs (real Chromium, enforce visibility)
```

Playwright Chromium path: `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.
Run spec scripts from the project root so `playwright` resolves.

### Tab visibility gotcha

The UI is tabbed (`Today` / `Forecast` / `Lake`). Content in a hidden
`.tab-panel[hidden]` is in the DOM but not visible, so Playwright `.click()` /
default `waitForSelector()` fail until you click the owning tab
(`.tab[data-tab="lake"]` etc.). `page.$eval` / `page.evaluate` work regardless.

## Architecture notes

- **Nearby waters**: `fetchNearestLake(lat,lng)` fills `state.nearbyWaters`
  (sorted by distance, each `{name,lat,lng,clat,clng,dist,type,size,radiusM}`).
  `renderNearbyWaters()` draws the `#nearby-select` dropdown on the Lake tab.
  `selectWater(name,lat,lng,radiusM)` loads a chosen water — use a water's
  CENTER (`clat`/`clng`) for map framing, not the edge point.
- **WI DNR data** (`fetchWiDnrLakeData`): designated waters, WBIC, clarity,
  regs, classification — all endpoints confirmed on-device, not guessed.
- Test-only hook `window.__testHooks.selectMapPoint(lat,lng)` drives map-tap
  selection without pixel math.
