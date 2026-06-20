/* app.js — UI for the solunar fishing-times app. Uses global Solunar (engine). */
(function () {
  'use strict';

  var DEFAULT = { name: 'Yellow Lake, WI', lat: 45.94, lng: -92.38, tz: 'America/Chicago' };
  var RANGE_OPTIONS = [7, 14, 30];

  var state = { loc: DEFAULT, days: [], notify: false, range: 7 };

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
  var PHASE_ICON = ['🌑','🌒','🌓','🌔','🌕','🌖','🌗','🌘'];

  function phaseIcon(phase) {
    return PHASE_ICON[Math.floor((phase * 8) + 0.5) % 8];
  }

  // ---- compute ----
  function recompute() {
    var t = todayYmd(state.loc.tz);
    state.days = Solunar.computeForecast({
      year: t.year, month: t.month, day: t.day,
      lat: state.loc.lat, lng: state.loc.lng, tz: state.loc.tz
    }, state.range);
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

  function dayCard(d, isFirst, idx) {
    var tz = d.tz;
    var sub = 'Sunrise ' + fmtTime(d.sunrise, tz) + ' · Sunset ' + fmtTime(d.sunset, tz) +
              ' · ' + d.moon.phaseName + ' (' + Math.round(d.moon.illumination * 100) + '%)';
    var rows = d.periods.map(function (p) { return periodRow(p, tz); }).join('');
    var weather = isFirst ? '<div class="weather" id="weather"></div>' : '';
    return '<div class="card' + (isFirst ? ' today' : '') + '" data-idx="' + idx + '" role="button" tabindex="0" aria-label="Open details for ' + fmtDayLabel(d.date, tz) + '">' +
      '<div class="day-head"><span class="date">' + fmtDayLabel(d.date, tz) + '</span>' +
        '<span class="stars" title="' + d.rating.stars + '/5">' + stars(d.rating.stars) + ' <span class="tap-hint">tap for details</span></span></div>' +
      '<div class="day-sub">' + sub + '</div>' +
      '<div class="periods">' + rows + '</div>' + weather +
      '</div>';
  }

  // ---- day-timeline SVG (visual 24-hr bar) ----
  function timelineBar(d) {
    var tz = d.tz;
    function pct(date) {
      if (!date) return null;
      var ms = date.getTime();
      // position as fraction of the local day
      var parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour: 'numeric', minute: '2-digit', second: '2-digit',
        hour12: false
      }).formatToParts(date);
      var hp = {}, pp = {};
      parts.forEach(function (x) { hp[x.type] = +x.value; });
      return ((hp.hour * 3600 + hp.minute * 60 + (hp.second || 0)) / 86400) * 100;
    }

    var W = 100; // percentage-based
    var rows = [];

    // Daylight band
    var srP = pct(d.sunrise), ssP = pct(d.sunset);
    if (srP !== null && ssP !== null) {
      rows.push('<div class="tl-band daylight" style="left:' + srP + '%;width:' + (ssP - srP) + '%"></div>');
    }

    // Period bands
    d.periods.forEach(function (p) {
      var s = pct(p.start), e = pct(p.end), c = pct(p.center);
      if (s === null) return;
      // handle wrap-around midnight: clamp to 0-100
      if (e < s) e = 100;
      rows.push('<div class="tl-band ' + p.type + (p.sunOverlap ? ' sun' : '') + '" style="left:' + Math.max(0,s) + '%;width:' + Math.min(100-Math.max(0,s), e-Math.max(0,s)) + '%"></div>');
      if (c !== null) rows.push('<div class="tl-tick" style="left:' + c + '%"></div>');
    });

    // Sun markers
    if (srP !== null) rows.push('<div class="tl-sun-mark" style="left:' + srP + '%" title="Sunrise"></div>');
    if (ssP !== null) rows.push('<div class="tl-sun-mark" style="left:' + ssP + '%" title="Sunset"></div>');

    // Hour labels
    var hourLabels = '';
    [6, 12, 18].forEach(function (h) {
      var label = h === 6 ? '6am' : h === 12 ? 'noon' : '6pm';
      hourLabels += '<span style="left:' + (h/24*100) + '%">' + label + '</span>';
    });

    return '<div class="tl-wrap">' +
      '<div class="tl-bar">' + rows.join('') + '</div>' +
      '<div class="tl-labels">' + hourLabels + '</div>' +
      '</div>';
  }

  // ---- modal ----
  function openModal(idx) {
    var d = state.days[idx];
    if (!d) return;
    var tz = d.tz;

    var pRows = d.periods.map(function (p) {
      return '<div class="period ' + p.type + (p.sunOverlap ? ' sun' : '') + '">' +
        '<span class="tag">' + p.type + '</span>' +
        '<span class="kind">' + KIND[p.kind] + (p.sunOverlap ? ' <span class="sun-badge">☀ near sun</span>' : '') + '</span>' +
        '<span class="time">' + fmtTime(p.center, tz) +
          ' <span class="range">' + fmtTime(p.start, tz) + '–' + fmtTime(p.end, tz) + '</span></span>' +
        '</div>';
    }).join('');

    var html =
      '<div class="modal-overlay" id="modal-overlay">' +
        '<div class="modal" role="dialog" aria-modal="true">' +
          '<div class="modal-head">' +
            '<div>' +
              '<div class="modal-date">' + fmtDayLabel(d.date, tz) + '</div>' +
              '<div class="modal-stars">' + stars(d.rating.stars) + '</div>' +
            '</div>' +
            '<button class="modal-close" id="modal-close" aria-label="Close">✕</button>' +
          '</div>' +

          '<div class="modal-section">' +
            '<div class="modal-section-label">Day at a glance</div>' +
            timelineBar(d) +
            '<div class="tl-legend">' +
              '<span class="tl-leg-dot major"></span> Major &nbsp;' +
              '<span class="tl-leg-dot minor"></span> Minor &nbsp;' +
              '<span class="tl-leg-dot daylight"></span> Daylight' +
            '</div>' +
          '</div>' +

          '<div class="modal-section">' +
            '<div class="modal-section-label">Solunar periods</div>' +
            '<div class="periods">' + pRows + '</div>' +
          '</div>' +

          '<div class="modal-section modal-meta">' +
            '<div>' +
              '<div class="modal-section-label">Sun</div>' +
              '<div>Sunrise &nbsp;<strong>' + fmtTime(d.sunrise, tz) + '</strong></div>' +
              '<div>Sunset &nbsp;<strong>' + fmtTime(d.sunset, tz) + '</strong></div>' +
            '</div>' +
            '<div>' +
              '<div class="modal-section-label">Moon</div>' +
              '<div>' + phaseIcon(d.moon.phase) + ' ' + d.moon.phaseName + '</div>' +
              '<div>' + Math.round(d.moon.illumination * 100) + '% illuminated</div>' +
            '</div>' +
            '<div>' +
              '<div class="modal-section-label">Rating</div>' +
              '<div>' + stars(d.rating.stars) + ' ' + d.rating.stars + '/5</div>' +
              '<div class="muted">Phase ' + Math.round(d.rating.phaseScore * 100) + '%' +
                (d.rating.sunBoost > 0 ? ' + sun overlap' : '') + '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    var el = document.createElement('div');
    el.innerHTML = html;
    document.body.appendChild(el.firstChild);

    document.getElementById('modal-close').onclick = closeModal;
    document.getElementById('modal-overlay').onclick = function (e) {
      if (e.target.id === 'modal-overlay') closeModal();
    };
    document.addEventListener('keydown', onEsc);
  }

  function closeModal() {
    var el = document.getElementById('modal-overlay');
    if (el) el.remove();
    document.removeEventListener('keydown', onEsc);
  }
  function onEsc(e) { if (e.key === 'Escape') closeModal(); }

  function render() {
    var loc = state.loc;
    document.getElementById('loc').innerHTML =
      loc.name + ' · ' + loc.lat.toFixed(2) + ', ' + loc.lng.toFixed(2) +
      '<button id="useloc">Use my location</button>';
    document.getElementById('useloc').onclick = useMyLocation;

    // Range picker
    var rangeHtml = RANGE_OPTIONS.map(function (n) {
      return '<button class="range-btn' + (n === state.range ? ' active' : '') +
        '" data-range="' + n + '">' + n + ' days</button>';
    }).join('');
    document.getElementById('range-picker').innerHTML = rangeHtml;
    document.querySelectorAll('.range-btn').forEach(function (btn) {
      btn.onclick = function () {
        state.range = +btn.dataset.range;
        recompute();
      };
    });

    var cards = state.days.map(function (d, i) { return dayCard(d, i === 0, i); }).join('');
    document.getElementById('days').innerHTML = cards;

    // Wire card click/keyboard for modal
    document.querySelectorAll('#days .card').forEach(function (card) {
      card.onclick = function () { openModal(+card.dataset.idx); };
      card.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') openModal(+card.dataset.idx); };
    });

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

  // ---- opportunistic notification ----
  var notified = {};
  function maybeNotify(p, active, secs) {
    if (!state.notify || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    var key = p.center.getTime();
    if (!active && secs <= 600 && !notified[key]) {
      notified[key] = true;
      try {
        new Notification('Solunar: ' + p.type + ' period soon', {
          body: KIND[p.kind] + ' at ' + fmtTime(p.center, state.loc.tz)
        });
      } catch (e) {}
    }
  }

  // ---- weather overlay ----
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
      alert('Could not get location. Using Yellow Lake.');
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
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(function (pos) {
        state.loc = {
          name: 'Current location',
          lat: +pos.coords.latitude.toFixed(4),
          lng: +pos.coords.longitude.toFixed(4),
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT.tz
        };
        recompute();
      }, function () {}, { timeout: 6000, maximumAge: 600000 });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
