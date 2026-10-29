# Fishing Advisor: improvement plan (2026-10-28)

Built from five read-only explorer reports (architecture, advisor logic,
charts + catch log, UX, contour sources). Work goes in this order; each
change ships with a spec that fails without it, and is pushed to `master`.

## 1. Contours

- [x] Minnesota depth from the new MN DNR server as labeled vector contours (old WMS was 404); verified live at Big Marine Lake
- [~] Offline script: build a contour file per lake (WBIC) from all cached logs, median per cell, despiked
- [ ] Build Yellow Lake (77 logs) and Cedar Lake (3 logs, marked partial) charts
- [ ] App loads the built charts and labels depths; WI PDF stays as fallback
- [ ] Verify on real imagery in Edge, screenshots
- [ ] Decide whether to keep the WI DNR survey PDF embed

## 2. Confirmed bugs

- [ ] Late nearby-waters response replaces a hand-picked lake
- [ ] Weather card shows the previous location's forecast
- [ ] Pressure updates undo the angler's map pan
- [ ] Bite Conditions grid shows advice for an unreconciled species (salmon on a pond)
- [ ] 0 °F air reads as 65 °F
- [ ] Unescaped water names in the nearby list

## 3. Smarter advisor

- [ ] Extract a pure, node-testable advisor engine module
- [ ] Golden-scenario test suite for the biology
- [ ] Estimated water temperature with a source chain (logs, USGS, air history)
- [ ] Season, spawn, turnover and ice phases per species
- [ ] Multi-factor bite score with a "why" per factor
- [ ] Use lake data already fetched (max depth, clarity, lake class)

## 4. Refactor and boat mode

- [ ] Split app.js into files, still one built HTML (no behavior change)
- [ ] Per-lake session with request tokens and abort
- [ ] Map controller: frame only on a new selection
- [ ] Service worker and manifest so it works offline
- [ ] Countdown as the visual hero; bigger tap targets
- [ ] Full-screen boat mode with screen wake lock
