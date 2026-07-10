# Fishing Advisor — project guide for Claude

Single-file PWA fishing app. Built from `src/` into `dist/solunar.html` by
`build.mjs`, deployed to GitHub Pages on push to **`master`** (the deploy
workflow triggers on `master`, not `main`).

## Working model preference (set by the user)

Use a **Sonnet model as the ADVISOR/ORCHESTRATOR**; the **EXECUTOR is Haiku**
by default, to maximize token efficiency (fewest total tokens to a *correct*
result — not lowest price per token; a weak executor that loops on failing
tests costs more than one clean pass).
- Sonnet (advisor): understands the request, inspects the codebase, designs
  the approach, writes a precise self-contained spec, and reviews the result.
- Haiku (executor, Agent tool with `model: "haiku"`): implements code, builds,
  runs tests, for tightly-specced, mechanical work — reusing existing
  functions, contained edits, clear acceptance criteria.
- **Escalate to Sonnet as executor** (`model: "sonnet"`) when a task needs
  iterative test-debugging-to-green, novel integration (new data source / new
  UI mode), or isn't fully pinnable up front — or when a Haiku attempt stalls
  (tests won't go green, loops).
- For small, surgical fixes (a few lines, precise root cause already known),
  the advisor may just make the edit directly rather than dispatching an
  executor — dispatch overhead isn't worth it for trivial diffs.
- The advisor handles final review, commit/push to `master`, and deploy
  verification.

(Historical note: this project started with Opus-advisor/Sonnet-executor,
then moved to Sonnet-advisor/Haiku-executor per the user's later preference,
set 2026-07 to cut token spend further.)

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

### Untestable-from-sandbox: the embedded DNR depth-map PDF

`.lake-map-frame` embeds a real `apps.dnr.wi.gov/doclink/lakes_maps/<WBIC>a.pdf`
survey PDF. This sandbox has no network access to fetch that file, so **no
automated test (mocked network) can verify how it actually renders** — only
that the iframe's `src` attribute is correct. Real third-party PDF-viewer
rendering behavior (zoom level, crop, whether `#view=FitH` is honored) varies
by browser/OS and can only be confirmed by the user on a real device. Any
change touching this embed (URL pattern, view params, sizing) must be called
out explicitly to the user for on-device visual confirmation as a standing
QA step — don't mark this kind of change "done" on green tests alone.

## Architecture notes

- **Nearby waters**: `fetchNearestLake(lat,lng)` fills `state.nearbyWaters`
  (sorted by distance, each `{name,lat,lng,clat,clng,dist,type,size,radiusM}`).
  `renderNearbyWaters()` draws the `#nearby-select` dropdown on the Lake tab.
  `selectWater(name,lat,lng,radiusM)` loads a chosen water — use a water's
  CENTER (`clat`/`clng`) for map framing, not the edge point.
- **WI DNR data** (`fetchWiDnrLakeData`): designated waters, WBIC, clarity,
  regs, classification — all endpoints confirmed on-device, not guessed.
- **Species search radius**: `_searchRadiusM` is uncapped at source; each
  consumer clamps to its own safe max (lake-info ~5 km; DNR stocking 30 km —
  safe because the query is ANDed with a lake-name match; iNaturalist 12 km,
  no name filter so kept tighter). Great Lakes (`GREAT_LAKES_SPECIES` table)
  additionally get a curated species baseline seeded in `fetchSpeciesForWater`
  since no point-radius lookup can cover water that size.
- Test-only hook `window.__testHooks.selectMapPoint(lat,lng)` drives map-tap
  selection without pixel math.
