# Fishing Advisor — project guide for Claude

Single-file PWA fishing app. Built from `src/` into `dist/solunar.html` by
`build.mjs`, deployed to GitHub Pages on push to **`master`** (the deploy
workflow triggers on `master`, not `main`).

## Working model preference (set by the user)

Use an **Opus model as the ADVISOR**; the **EXECUTOR is Sonnet or Haiku**,
chosen per task to maximize token efficiency (fewest total tokens to a
*correct* result — not lowest price per token; a weak executor that loops on
failing tests costs more than one clean pass).
- Opus (advisor): understands the request, inspects the codebase, designs the
  approach, writes a precise self-contained spec, and reviews the result.
- Executor (Agent tool with `model: "haiku"` or `"sonnet"`): implements code,
  builds, runs tests. Pick the tier:
  - **Haiku** for tightly-specced, mechanical work — reusing existing
    functions, contained edits, clear acceptance criteria.
  - **Sonnet** for iterative test-debugging-to-green, novel integration (new
    data source / new UI mode), or anything not fully pinnable up front.
  - **Haiku-first with escalation** when borderline: start Haiku; if it stalls
    (tests won't go green, loops), escalate that task to Sonnet.
- The advisor handles final review, commit/push to `master`, and deploy
  verification.

### Response format (user preference)

Start every response with: (1) which model is running the main thread
(Haiku/Sonnet/Opus), and (2) a short token + cost summary so far. Note that
exact main-thread token/cost isn't precisely measurable from inside the
session — report subagent token totals (visible in task-notification results)
precisely, estimate the rest, and point to the Claude Console usage dashboard
as the authoritative source.

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
