/*
 solunar.js — solunar fishing-period engine.

 Validated methodology (cross-checked to ~2 min of USNO / timeanddate.com,
 and reproduced exactly by a PyEphem oracle in oracle/oracle.py):
   - Major periods (~2 h): moon upper transit (overhead) and lower transit
     (underfoot), window = transit +/- 1 h.
   - Minor periods (~1 h): moonrise and moonset, window = event +/- 30 min.
   - Day rating: moon phase (near new/full best, quarter average) PLUS a boost
     when any major/minor overlaps sunrise or sunset.

 Astronomy comes from astronomy-engine (Don Cross, MIT) — a high-precision,
 pure-JS ephemeris (~1 arcmin) that needs no data download and runs in the
 browser (offline, file://) and Node. Rise/set/transit times are anchored to
 "next event after local midnight", matching the PyEphem oracle's semantics.

 Works as a classic <script> (defines global Solunar; expects global Astronomy
 from astronomy.browser.min.js) and under Node (require).
*/
(function (global, factory) {
  var A = (typeof module !== 'undefined' && module.exports)
    ? require('astronomy-engine')
    : global.Astronomy;
  var api = factory(A);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Solunar = api;
})(typeof self !== 'undefined' ? self : this, function (A) {
  'use strict';

  var MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;

  // ---- timezone helpers (compute the UTC instant of local events in any IANA tz) ----

  // Milliseconds that local time in `tz` is ahead of UTC at instant `date`.
  function tzOffset(date, tz) {
    var dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    var p = {};
    dtf.formatToParts(date).forEach(function (x) { p[x.type] = x.value; });
    var asUTC = Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return asUTC - (Math.floor(date.getTime() / 1000) * 1000);
  }

  // UTC instant of 00:00 local-time in `tz` for the given calendar date.
  function localMidnightUTC(year, month, day, tz) {
    var guess = Date.UTC(year, month - 1, day, 0, 0, 0);
    var off = tzOffset(new Date(guess), tz);
    var ms = guess - off;
    var off2 = tzOffset(new Date(ms), tz); // re-check across DST boundaries
    if (off2 !== off) ms = guess - off2;
    return new Date(ms);
  }

  // Calendar Y/M/D of an instant as seen in `tz`.
  function ymdInTz(date, tz) {
    var p = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(date).split('-');
    return { year: +p[0], month: +p[1], day: +p[2] };
  }

  // ---- astronomy lookups (next event after `start`) ----

  function observer(lat, lng, elevM) { return new A.Observer(lat, lng, elevM || 0); }

  function riseSet(body, obs, dir, start, elevM) {
    var t = A.SearchRiseSet(body, obs, dir, start, 2, elevM || 0);
    return t ? t.date : null;
  }

  function transit(body, obs, hourAngle, start) {
    var ev = A.SearchHourAngle(body, obs, hourAngle, start, 1);
    return ev ? ev.time.date : null;
  }

  // ---- period + rating helpers ----

  function makePeriod(type, kind, center, halfH) {
    if (!center) return null;
    return {
      type: type,                 // 'major' | 'minor'
      kind: kind,                 // 'overhead' | 'underfoot' | 'moonrise' | 'moonset'
      center: center,
      start: new Date(center.getTime() - halfH * HOUR),
      end: new Date(center.getTime() + halfH * HOUR)
    };
  }

  // 0..1 phase (0/1 new, 0.5 full) -> phase score 0..1 (best near new/full).
  function phaseScore(phase) {
    var dNew = Math.min(phase, 1 - phase);
    var dFull = Math.abs(phase - 0.5);
    var d = Math.min(dNew, dFull); // 0 at new/full, 0.25 at quarters
    return 1 - d / 0.25;           // 1 at new/full, 0 at quarter
  }

  function phaseName(phase) {
    var names = ['New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous',
                 'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent'];
    return names[Math.floor((phase * 8) + 0.5) % 8];
  }

  // ---- public: compute one day ----

  // opts: { year, month, day, lat, lng, tz, elevM }  (month is 1-12)
  function computeDay(opts) {
    var lat = opts.lat, lng = opts.lng, tz = opts.tz, elevM = opts.elevM || 0;
    var mid = localMidnightUTC(opts.year, opts.month, opts.day, tz);
    var obs = observer(lat, lng, elevM);

    var sunrise = riseSet(A.Body.Sun, obs, +1, mid, elevM);
    var sunset = riseSet(A.Body.Sun, obs, -1, mid, elevM);
    var moonrise = riseSet(A.Body.Moon, obs, +1, mid, elevM);
    var moonset = riseSet(A.Body.Moon, obs, -1, mid, elevM);
    var overhead = transit(A.Body.Moon, obs, 0, mid);   // upper transit
    var underfoot = transit(A.Body.Moon, obs, 12, mid); // lower transit

    var noon = new Date(mid.getTime() + 12 * HOUR);
    var illum = A.Illumination(A.Body.Moon, noon);
    var phase = A.MoonPhase(noon) / 360; // 0 new, .25 first qtr, .5 full, .75 last

    var majors = [
      makePeriod('major', 'underfoot', underfoot, 1),
      makePeriod('major', 'overhead', overhead, 1)
    ].filter(Boolean);
    var minors = [
      makePeriod('minor', 'moonrise', moonrise, 0.5),
      makePeriod('minor', 'moonset', moonset, 0.5)
    ].filter(Boolean);

    var periods = majors.concat(minors).sort(function (a, b) { return a.center - b.center; });

    // Day rating: phase score (0..1) + sun-overlap boost.
    var pScore = phaseScore(phase);
    var sunEvents = [];
    if (sunrise) sunEvents.push(sunrise);
    if (sunset) sunEvents.push(sunset);
    var boost = 0;
    periods.forEach(function (p) {
      sunEvents.forEach(function (s) {
        if (s >= p.start && s <= p.end) {
          boost += (p.type === 'major') ? 0.25 : 0.15;
          p.sunOverlap = true;
        }
      });
    });
    boost = Math.min(boost, 0.45);
    var score = Math.min(1, pScore * 0.7 + boost + 0.05);
    var stars = Math.max(1, Math.min(5, Math.round(score * 5)));

    return {
      date: ymdInTz(mid, tz),
      tz: tz, lat: lat, lng: lng,
      sunrise: sunrise, sunset: sunset,
      moonrise: moonrise, moonset: moonset,
      overhead: overhead, underfoot: underfoot,
      majors: majors, minors: minors, periods: periods,
      moon: {
        phase: phase,
        illumination: illum.phase_fraction,
        phaseName: phaseName(phase)
      },
      rating: { score: score, stars: stars, phaseScore: pScore, sunBoost: boost }
    };
  }

  function computeForecast(opts, days) {
    var out = [];
    var base = localMidnightUTC(opts.year, opts.month, opts.day, opts.tz);
    for (var i = 0; i < days; i++) {
      var d = ymdInTz(new Date(base.getTime() + i * DAY + 6 * HOUR), opts.tz);
      out.push(computeDay({
        year: d.year, month: d.month, day: d.day,
        lat: opts.lat, lng: opts.lng, tz: opts.tz, elevM: opts.elevM
      }));
    }
    return out;
  }

  return {
    computeDay: computeDay,
    computeForecast: computeForecast,
    phaseName: phaseName,
    phaseScore: phaseScore,
    _internal: { localMidnightUTC: localMidnightUTC, tzOffset: tzOffset, ymdInTz: ymdInTz }
  };
});
