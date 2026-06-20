# UX Design — Solunar Fishing Times

## Who & where
A walleye angler checking the app on an **iPhone (Safari), often in bright
sunlight**, planning weekend trips to the camper at Yellow Lake, WI. Secondary
use: MS Edge on Windows. Must work **offline** (no cell signal at the lake).

## Design goals (in priority order)
1. **Glance value < 2 seconds**: today's rating + the next fishing period and a
   live countdown, visible without scrolling.
2. **Plan the weekend**: a 7-day list to compare days at a glance (star ratings).
3. **Trust**: times are accurate and clearly in the lake's local time; the app
   says when it's using your location vs. the Yellow Lake default.
4. **Sunlight legible**: high contrast, large tabular times, color + text labels.

## Information hierarchy
```
Header: title + location (with "Use my location")
┌─ NEXT PERIOD banner ─ live countdown (biggest number on screen)
├─ [Enable alerts] button
├─ TODAY card (highlighted): rating ★, sunrise/sunset, moon phase,
│     major/minor periods with center time + window, ☀ sun-overlap flag,
│     today's weather (when online)
├─ Day 2 … Day 7 cards: rating ★, sun/moon summary, periods
└─ Legend: what major/minor/☀ mean
```

## Visual language
- **Major periods** = warm amber (`--major`). **Minor** = cool blue (`--minor`).
- **Sun overlap** = orange ☀ + the text "near sun" (never color alone).
- **Active now** = green countdown.
- Dark teal background (low glare, battery-friendly OLED), tabular-numeric times.

## Wireframe (mobile, ~390px)
```
🎣 Solunar Times
Yellow Lake, WI · 45.94, -92.38   [Use my location]
┌───────────────────────────────────────────┐
│ NEXT MAJOR PERIOD              2:14:37      │
│ Moon overhead · 6:27 PM                     │
└───────────────────────────────────────────┘
[ 🔔 Enable next-period alerts ]
┌─ Today · Sat Jun 20 ───────────────  ★★☆☆☆ ┐
│ Sunrise 5:18 AM · Sunset 9:03 PM            │
│ First Quarter (38%)                         │
│ [MAJOR] Moon underfoot  6:05 AM 5:05–7:05   │
│ [MINOR] Moonrise       11:56 AM 11:26–12:26 │
│ [MAJOR] Moon overhead   6:27 PM 5:27–7:27   │
│ Weather: 78°/60°F · wind to 10 mph · clear  │
└─────────────────────────────────────────────┘
… 6 more day cards …
```

## Acceptance-relevant UX rules (checked in UAT)
- Defaults to Yellow Lake if geolocation is denied/unavailable (iOS `file://`).
- 7 day cards always render.
- Next-period countdown updates every second and flips to "Active now" in-window.
- Star rating on every day.
- No horizontal scroll at 375px; tap targets >= 44px.

## Known platform constraints (honest)
- On iOS opened as a local file, **geolocation and web-push are blocked** by
  WebKit — the app falls back to Yellow Lake and an in-page countdown. For live
  location + push, host over HTTPS and "Add to Home Screen".
- Current-location timezone uses the device's tz; the Yellow Lake default is
  forced to `America/Chicago` (CDT/CST handled automatically).

## Design review process
Run the `ux-reviewer` subagent after any UI change (see
`.claude/agents/ux-reviewer.md`). It reports the top 3 highest-impact fixes.
