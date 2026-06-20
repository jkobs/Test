# UAT Plan — Solunar Fishing Times

Two layers of verification, both automated and runnable offline:

1. **Accuracy** — the astronomy must match validated ground truth.
2. **Acceptance** — the rendered app must show the right things to the user.

## Ground truth (validated, Yellow Lake / Danbury WI, 2026-06-20)
| Event              | Value     |
|--------------------|-----------|
| Sunrise            | 5:18 AM   |
| Sunset             | 9:03 PM   |
| Moon underfoot (lower transit) | 6:05 AM |
| Moon overhead (upper transit)  | 6:27 PM |
| Moonrise           | 11:56 AM  |
| Moonset            | 12:27 AM  |

Tolerance: **±2 minutes**. Independently reproduced by two engines:
- JS runtime: astronomy-engine (`src/solunar.js`)
- Oracle cross-check: PyEphem (`oracle/oracle.py`)

## Acceptance criteria (checked by `test/uat.test.mjs`)
| ID  | Criterion |
|-----|-----------|
| AC1 | Defaults to Yellow Lake when geolocation is unavailable |
| AC2 | Renders a 7-day forecast (7 day cards) |
| AC3 | Today's card shows the validated sun + solunar period times |
| AC4 | Majors = moon overhead/underfoot; minors = moonrise/moonset; 2 majors/day |
| AC5 | Live "next period" countdown is visible and ticking |
| AC6 | Every day shows a star rating |
| AC7 | App renders with no network (weather degrades gracefully) |

## How to run (full suite)
```bash
node test/solunar.test.mjs   # AC: accuracy vs validated values
python3 oracle/oracle.py     # independent PyEphem cross-check
node build.mjs               # rebuild dist/solunar.html
node test/uat.test.mjs       # acceptance tests on the rendered page
```
Or use the `uat-runner` subagent (`.claude/agents/uat-runner.md`), which runs all
of the above and reports a RELEASE-READY / BLOCKED verdict.

## Manual on-device UAT (do once per release on the actual iPhone)
1. Host `dist/solunar.html` over HTTPS (or open locally to test the fallback).
2. Open in iPhone Safari. Confirm: no horizontal scroll, times readable in sun.
3. Tap "Use my location" → allow → periods recompute for your position.
4. Add to Home Screen → "Enable alerts" → confirm a 10-min warning fires.
5. Toggle airplane mode → reload → app still shows periods (weather shows
   "unavailable offline").

## Definition of done for a release
- All accuracy + acceptance tests PASS.
- Manual on-device checklist completed.
- `ux-reviewer` has no open top-3 issues.
