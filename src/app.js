/* app.js — UI for the solunar fishing-times app. Uses global Solunar (engine). */
(function () {
  'use strict';

  var DEFAULT = { name: 'Yellow Lake, WI', lat: 45.94, lng: -92.38, tz: 'America/Chicago' };
  var FORECAST_DAYS = 7;

  var state = { loc: DEFAULT, days: [], notify: false };

  // ---- formatting ----
  function fmtTime(date, tz) {
    if (!date) return '—';
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true
    }).format(date);
  }
  function fmtDayLabel(ymd, tz) {
    var d = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day, 12));
    var today = todayYmd(tz);
    var isToday = ymd.year === today.year && ymd.month === today.month && ymd.day === today.day;
    var label = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric'
    }).format(d);
    return (isToday ? 'Today · ' : '') + label;
  }
  function todayYmd(tz) {
    var p = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date()).split('-');
    return { year: +p[0], month: +p[1], day: +p[2] };
  }
  function stars(n) { return '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n); }
  var KIND = { overhead: 'Moon overhead', underfoot: 'Moon underfoot', moonrise: 'Moonrise', moonset: 'Moonset' };

  // ---- compute ----
  function recompute() {
    var t = todayYmd(state.loc.tz);
    state.days = Solunar.computeForecast({
      year: t.year, month: t.month, day: t.day,
      lat: state.loc.lat, lng: state.loc.lng, tz: state.loc.tz
    }, FORECAST_DAYS);
    render();
    fetchWeather();
  }

  // ---- next period (across the forecast) ----
  function allPeriods() {
    var out = [];
    state.days.forEach(function (d) { d.periods.forEach(function (p) { out.push(p); }); });
    return out.sort(function (a, b) { return a.center - b.center; });
  }
  function nextPeriod() {
    var now = Date.now();
    var ps = allPeriods();
    for (var i = 0; i < ps.length; i++) {
      if (ps[i].end.getTime() >= now) return ps[i];
    }
    return null;
  }

  // ---- rendering ----
  function periodRow(p, tz) {
    var cls = 'period ' + p.type + (p.sunOverlap ? ' sun' : '');
    return '<div class="' + cls + '">' +
      '<span class="tag">' + p.type + '</span>' +
      '<span class="kind">' + KIND[p.kind] + '</span>' +
      '<span class="time">' + fmtTime(p.center, tz) +
        ' <span class="range">' + fmtTime(p.start, tz) + '–' + fmtTime(p.end, tz) + '</span></span>' +
      '</div>';
  }

  function dayCard(d, isFirst) {
    var tz = d.tz;
    var sub = 'Sunrise ' + fmtTime(d.sunrise, tz) + ' · Sunset ' + fmtTime(d.sunset, tz) +
              ' · ' + d.moon.phaseName + ' (' + Math.round(d.moon.illumination * 100) + '%)';
    var rows = d.periods.map(function (p) { return periodRow(p, tz); }).join('');
    var weather = isFirst ? '<div class="weather" id="weather"></div>' : '';
    return '<div class="card' + (isFirst ? ' today' : '') + '">' +
      '<div class="day-head"><span class="date">' + fmtDayLabel(d.date, tz) + '</span>' +
        '<span class="stars" title="' + d.rating.stars + '/5">' + stars(d.rating.stars) + '</span></div>' +
      '<div class="day-sub">' + sub + '</div>' +
      '<div class="periods">' + rows + '</div>' + weather +
      '</div>';
  }

  function render() {
    var loc = state.loc;
    document.getElementById('loc').innerHTML =
      loc.name + ' · ' + loc.lat.toFixed(2) + ', ' + loc.lng.toFixed(2) +
      '<button id="useloc">Use my location</button>';
    document.getElementById('useloc').onclick = useMyLocation;

    var first = state.days[0];
    var cards = state.days.map(function (d, i) { return dayCard(d, i === 0); }).join('');
    document.getElementById('days').innerHTML = cards;
    renderNext();
  }

  function renderNext() {
    var el = document.getElementById('next');
    var p = nextPeriod();
    if (!p) { el.style.display = 'none'; return; }
    el.style.display = 'flex';
    var now = Date.now();
    var active = now >= p.start.getTime() && now <= p.end.getTime();
    el.className = 'next ' + p.type + (active ? ' active' : '');
    var target = active ? p.end.getTime() : p.start.getTime();
    var secs = Math.max(0, Math.round((target - now) / 1000));
    var h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
    var cd = (h > 0 ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    el.innerHTML =
      '<div><div class="label">' + (active ? 'Active now — ' + p.type : 'Next ' + p.type + ' period') + '</div>' +
      '<div class="when">' + KIND[p.kind] + ' · ' + fmtTime(p.center, state.loc.tz) + '</div></div>' +
      '<div class="countdown">' + cd + '</div>';

    maybeNotify(p, active, secs);
  }

  // ---- opportunistic notification (no-ops where unavailable, e.g. iOS file://) ----
  var notified = {};
  function maybeNotify(p, active, secs) {
    if (!state.notify || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    var key = p.center.getTime();
    if (!active && secs <= 600 && !notified[key]) { // 10 min warning
      notified[key] = true;
      try {
        new Notification('Solunar: ' + p.type + ' period soon', {
          body: KIND[p.kind] + ' at ' + fmtTime(p.center, state.loc.tz)
        });
      } catch (e) { /* iOS file:// or denied — silently ignore */ }
    }
  }

  // ---- weather overlay (Open-Meteo, no key; needs network) ----
  function fetchWeather() {
    var el = document.getElementById('weather');
    if (!el || typeof fetch === 'undefined') return;
    var loc = state.loc;
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + loc.lat +
      '&longitude=' + loc.lng +
      '&daily=temperature_2m_max,temperature_2m_min,wind_speed_10m_max,weather_code' +
      '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto';
    fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.daily) return;
      var d = j.daily, hi = Math.round(d.temperature_2m_max[0]), lo = Math.round(d.temperature_2m_min[0]);
      var wind = Math.round(d.wind_speed_10m_max[0]);
      el.innerHTML = '<strong>Weather today:</strong> ' + hi + '°/' + lo + '°F · wind to ' +
        wind + ' mph · ' + weatherText(d.weather_code[0]);
    }).catch(function () { el.innerHTML = '<span class="note">Weather unavailable offline.</span>'; });
  }
  function weatherText(code) {
    var m = { 0: 'clear', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
      45: 'fog', 48: 'rime fog', 51: 'light drizzle', 61: 'light rain', 63: 'rain',
      65: 'heavy rain', 71: 'snow', 80: 'showers', 95: 'thunderstorm' };
    return m[code] || 'see forecast';
  }

  // ---- geolocation ----
  function useMyLocation() {
    if (!navigator.geolocation) { alert('Geolocation not available; using Yellow Lake.'); return; }
    navigator.geolocation.getCurrentPosition(function (pos) {
      state.loc = {
        name: 'Current location',
        lat: +pos.coords.latitude.toFixed(4),
        lng: +pos.coords.longitude.toFixed(4),
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT.tz
      };
      recompute();
    }, function () {
      alert('Could not get location (blocked on local files in iOS Safari). Using Yellow Lake.');
    }, { timeout: 8000, maximumAge: 600000 });
  }

  function enableNotifications() {
    if (typeof Notification === 'undefined') { alert('Notifications not supported here.'); return; }
    Notification.requestPermission().then(function (perm) {
      state.notify = perm === 'granted';
      if (!state.notify) alert('Notifications not granted. On iOS, add to Home Screen first.');
    });
  }

  // ---- init ----
  function init() {
    document.getElementById('notify-btn').onclick = enableNotifications;
    recompute();
    setInterval(renderNext, 1000);
    // try geolocation automatically; falls back silently to Yellow Lake
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(function (pos) {
        state.loc = {
          name: 'Current location',
          lat: +pos.coords.latitude.toFixed(4),
          lng: +pos.coords.longitude.toFixed(4),
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT.tz
        };
        recompute();
      }, function () { /* keep Yellow Lake */ }, { timeout: 6000, maximumAge: 600000 });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
