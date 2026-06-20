#!/usr/bin/env python3
"""
oracle.py — independent PyEphem cross-check of the validated solunar values.

This is the second, independent engine (the app runs on astronomy-engine in JS).
If both agree with the ground truth, we trust the methodology. Run:

    pip install ephem
    python3 oracle/oracle.py

Exits non-zero if any value is off by more than the tolerance.
"""
import datetime
import sys

try:
    import ephem
except ImportError:
    sys.exit("PyEphem not installed. Run: pip install ephem")

# Yellow Lake / Danbury, WI
LAT, LON, ELEV = "45.94", "-92.38", 380
TZ = -5            # June 20, 2026 is CDT (UTC-5)
TOL_MIN = 2

# Validated ground truth (local Central time), HH:MM 24h.
EXPECTED = {
    "Sunrise":         "05:18",
    "Sunset":          "21:03",
    "Moon underfoot":  "06:05",
    "Moon overhead":   "18:27",
    "Moonrise":        "11:56",
    "Moonset":         "00:27",
}


def local_hhmm(ephem_date):
    dt = ephem.Date(ephem_date).datetime() + datetime.timedelta(hours=TZ)
    return dt.strftime("%H:%M")


def diff_min(a, b):
    ah, am = map(int, a.split(":"))
    bh, bm = map(int, b.split(":"))
    d = abs((ah * 60 + am) - (bh * 60 + bm))
    return min(d, 1440 - d)  # wrap around midnight


def main():
    obs = ephem.Observer()
    obs.lat, obs.lon, obs.elevation = LAT, LON, ELEV
    obs.pressure = 1010  # enable atmospheric refraction

    anchor = ephem.Date(datetime.datetime(2026, 6, 20, 5, 0, 0))  # local midnight (CDT)
    sun, moon = ephem.Sun(), ephem.Moon()

    def at_anchor():
        obs.date = anchor
        return obs

    got = {
        "Sunrise":        local_hhmm(at_anchor().next_rising(sun)),
        "Sunset":         local_hhmm(at_anchor().next_setting(sun)),
        "Moonrise":       local_hhmm(at_anchor().next_rising(moon)),
        "Moonset":        local_hhmm(at_anchor().next_setting(moon)),
        "Moon overhead":  local_hhmm(at_anchor().next_transit(moon)),
        "Moon underfoot": local_hhmm(at_anchor().next_antitransit(moon)),
    }

    print(f"PyEphem oracle — Yellow Lake, 2026-06-20 (tolerance {TOL_MIN} min)\n")
    failures = 0
    for name, exp in EXPECTED.items():
        val = got[name]
        d = diff_min(val, exp)
        ok = d <= TOL_MIN
        if not ok:
            failures += 1
        print(f"  {'PASS' if ok else 'FAIL'}  {name:<14} expected {exp}  got {val}  ({d} min)")

    obs.date = anchor
    moon.compute(obs)
    print(f"\nMoon phase (illuminated): {moon.phase:.1f}%")

    if failures:
        print(f"\n{failures} value(s) outside tolerance.")
        sys.exit(1)
    print("\nAll values within tolerance — oracle confirms methodology.")


if __name__ == "__main__":
    main()
