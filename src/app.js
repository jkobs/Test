/* app.js — UI for the solunar fishing-times app. Uses global Solunar (engine). */
(function () {
  'use strict';

  var DEFAULT = { name: 'Yellow Lake, WI', lat: 45.94, lng: -92.38, tz: 'America/Chicago' };
  var RANGE_OPTIONS = [7, 14, 30];

  var state = { loc: DEFAULT, days: [], notify: false, range: 7, pressureDelta: null };

  // ---- Leaflet map state ----
  var _map = null, _locMarker = null, _windLine = null, _accCircle = null;
  var _drnOk = null;
  var _pressureReqId = 0; // incremented on each fetchPressure call; stale responses are dropped
  var _geoWatchId = null;
  var _lastRecomputeLat = null, _lastRecomputeLng = null;

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
    fetchPressure();
    // Update map pin immediately — don't wait for pressure fetch
    initMap(state.loc.lat, state.loc.lng, null, 0);
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
    return '<div class="card' + (isFirst ? ' today' : '') + '" data-idx="' + idx + '" role="button" tabindex="0" aria-label="Open details for ' + fmtDayLabel(d.date, tz) + '">' +
      '<div class="day-head"><span class="date">' + fmtDayLabel(d.date, tz) + '</span>' +
        '<span class="stars" title="' + d.rating.stars + '/5">' + stars(d.rating.stars) + ' <span class="tap-hint">tap for details</span></span></div>' +
      '<div class="day-sub">' + sub + '</div>' +
      '<div class="periods">' + rows + '</div>' +
      '<div class="weather" id="weather-' + idx + '"></div>' +
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

  // ---- map depth overlay (USGS Topo tile layer) ----
  var _topoLayer = null, _drnEnabled = true;

  function updateDNRBadge(ok) {
    _drnOk = ok;
    var el = document.getElementById('dnr-badge');
    if (!el) return;
    if (ok) {
      el.textContent = '🗺 Depth layer: USGS Topo';
      el.style.color = 'var(--good)';
    } else {
      el.textContent = 'Depth layer hidden';
      el.style.color = 'var(--muted)';
    }
  }

  function refreshDNRLayer() {
    if (!_map || !_drnEnabled) return;
    if (!_topoLayer) {
      _topoLayer = L.tileLayer(
        'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
        { opacity: 0.55, maxZoom: 16, pane: 'overlayPane' }
      ).addTo(_map);
      updateDNRBadge(true);
    }
  }

  function toggleDNRLayer() {
    var btn = document.getElementById('dnr-toggle');
    if (_drnEnabled) {
      _drnEnabled = false;
      if (_topoLayer && _map) { _map.removeLayer(_topoLayer); _topoLayer = null; }
      if (btn) btn.textContent = 'Show depth layer';
      updateDNRBadge(false);
    } else {
      _drnEnabled = true;
      refreshDNRLayer();
      if (btn) btn.textContent = 'Hide depth layer';
    }
  }

  function initMap(lat, lng, towardDeg, windSpeed) {
    if (typeof L === 'undefined' || !L.map) return;
    var el = document.getElementById('advisor-map');
    if (!el) return;
    try {
    if (!_map) {
      _map = L.map('advisor-map', { zoomControl: true, attributionControl: false });
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 18
      }).addTo(_map);
      L.control.attribution({ prefix: '© Esri · USGS' }).addTo(_map);
    }
    _map.setView([lat, lng], 14);
    if (_locMarker) _locMarker.remove();
    _locMarker = L.circleMarker([lat, lng], {
      radius: 9, fillColor: '#4fd07a', color: '#fff', weight: 2.5, fillOpacity: 1
    }).addTo(_map);

    if (_windLine) { _windLine.remove(); _windLine = null; }
    if (towardDeg !== null && windSpeed > 4) {
      var towardRad = towardDeg * Math.PI / 180;
      var d = 0.005;
      var dlat = d * Math.cos(towardRad);
      var dlng = d * Math.sin(towardRad) / Math.cos(lat * Math.PI / 180);
      _windLine = L.polyline([[lat, lng], [lat + dlat, lng + dlng]], {
        color: '#56b3f0', weight: 3, opacity: 0.85, dashArray: '6,5'
      }).bindTooltip('Windward shore →', { permanent: false }).addTo(_map);
    }
    setTimeout(function () { if (_map) { _map.invalidateSize(); refreshDNRLayer(); } }, 200);
    } catch(e) { /* map unavailable in non-visual environment */ }
  }

  // ---- fishing advice engine ----
  var DIRS8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  function bearing8(deg) { return DIRS8[Math.round(deg / 45) % 8]; }

  function computeAdvice(delta, windSpeed, windDir, airTemp) {
    // Pressure → depth zone & activity base score
    var depth, structure, presentation, pressureStr, pScore;
    if (delta > 3) {
      depth = '18–28 ft'; pressureStr = 'rising fast'; pScore = 1;
      structure = 'main basin, deep rock, river channel edges';
      presentation = 'dead-stick, very slow vertical jig';
    } else if (delta > 1) {
      depth = '12–20 ft'; pressureStr = 'rising'; pScore = 2;
      structure = 'outside points dropping to deep water, rock humps';
      presentation = 'slow jig, finesse drop-shot';
    } else if (delta >= -1) {
      depth = '10–18 ft'; pressureStr = 'stable'; pScore = 3;
      structure = 'mid-depth points, rock piles, weed-to-hard-bottom breaks';
      presentation = 'standard jig, shad-body crankbait';
    } else if (delta >= -3) {
      depth = '6–14 ft'; pressureStr = 'falling'; pScore = 4;
      structure = 'windward shoreline, weed edges, shallow rock flats';
      presentation = 'crankbait, inline spinner';
    } else {
      depth = '4–10 ft'; pressureStr = 'falling fast'; pScore = 5;
      structure = 'windward shore, emergent weeds, rocky shoals';
      presentation = 'fast crankbait, reaction jig';
    }

    // Wind modifier
    var windScore = 0, windNote;
    var fromDir = bearing8(windDir);
    var towardDeg = (windDir + 180) % 360;
    var towardDir = bearing8(towardDeg);
    if (windSpeed > 15) {
      windNote = 'Strong wind from ' + fromDir + ' — concentrate on ' + towardDir + ' windward shore; wave action piles baitfish.';
      windScore = 2;
    } else if (windSpeed > 8) {
      windNote = 'Wind from ' + fromDir + ' — ' + towardDir + ' windward points and edges are prime.';
      windScore = 1;
    } else if (windSpeed > 3) {
      windNote = 'Light wind from ' + fromDir + ' — subtle windward edge on ' + towardDir + ' side.';
    } else {
      windNote = 'Calm — no windward advantage. Work structure breaks with a slow, methodical approach.';
      windScore = -1;
    }

    // Temperature modifier
    var tempNote;
    if (airTemp < 45) {
      tempNote = 'Cold air — walleye likely lethargic. Fish slow and deep near bottom.';
      pScore = Math.max(1, pScore - 1);
    } else if (airTemp < 60) {
      tempNote = 'Cool conditions — transition period; expect fish on rock and gravel structure.';
    } else if (airTemp <= 80) {
      tempNote = 'Comfortable temps — walleye in their active range; run a full structure sweep.';
    } else {
      tempNote = 'Hot air — midday fish likely deep or suspended; focus early/late on shallows.';
      pScore = Math.max(1, pScore - 1);
    }

    // Solunar boost
    var solunarNote = '', solunarBoost = 0;
    var p = nextPeriod();
    var now = Date.now();
    if (p) {
      var toStart = p.start.getTime() - now;
      var isActive = now >= p.start.getTime() && now <= p.end.getTime();
      if (isActive) {
        solunarNote = '🔥 ' + (p.type === 'major' ? 'Major' : 'Minor') + ' solunar period ACTIVE — fish your best spot right now.';
        solunarBoost = p.type === 'major' ? 2 : 1;
      } else if (toStart > 0 && toStart < 30 * 60 * 1000) {
        solunarNote = '⏱ ' + (p.type === 'major' ? 'Major' : 'Minor') + ' period in ' + Math.round(toStart / 60000) + ' min — get in position.';
        solunarBoost = 1;
      }
    }

    var score = Math.max(1, Math.min(5, pScore + windScore + solunarBoost));
    var labels = ['Very Slow', 'Slow', 'Moderate', 'Active', 'Hot Bite'];
    var dots = '●'.repeat(score) + '○'.repeat(5 - score);
    var dotColor = score >= 4 ? 'var(--good)' : score >= 3 ? 'var(--major)' : 'var(--muted)';

    return {
      score, label: labels[score - 1], dots, dotColor,
      pressureStr, depth, structure, presentation,
      windSpeed, fromDir, towardDir, towardDeg,
      windNote, tempNote, solunarNote
    };
  }

  function renderAdvisor(adv, lat, lng) {
    initMap(lat, lng, adv.towardDeg, adv.windSpeed);
    var el = document.getElementById('advisor-body');
    if (!el) return;
    el.innerHTML =
      '<div class="adv-activity">' +
        '<span class="adv-dots" style="color:' + adv.dotColor + '">' + adv.dots + '</span>' +
        '<span class="adv-level">' + adv.label + '</span>' +
      '</div>' +
      '<div class="adv-grid">' +
        '<div class="adv-item"><div class="adv-label">Pressure</div><div class="adv-val">' + adv.pressureStr + '</div></div>' +
        '<div class="adv-item"><div class="adv-label">Target depth</div><div class="adv-val">' + adv.depth + '</div></div>' +
        '<div class="adv-item adv-wide"><div class="adv-label">Structure</div><div class="adv-val">' + adv.structure + '</div></div>' +
        '<div class="adv-item adv-wide"><div class="adv-label">Presentation</div><div class="adv-val">' + adv.presentation + '</div></div>' +
      '</div>' +
      (adv.solunarNote ? '<div class="adv-note adv-solunar">' + adv.solunarNote + '</div>' : '') +
      '<div class="adv-note">' + adv.windNote + '</div>' +
      '<div class="adv-note">' + adv.tempNote + '</div>' +
      '<div class="adv-map-footer">' +
        '<span id="dnr-badge" class="adv-dnr-badge">⏳ Loading depth layer…</span>' +
        '<button id="dnr-toggle" class="adv-dnr-btn">Hide depth layer</button>' +
      '</div>';
    var toggleBtn = document.getElementById('dnr-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', toggleDNRLayer);
      // Sync toggle label with current enabled state
      if (!_drnEnabled) toggleBtn.textContent = 'Show depth layer';
    }
    // Sync badge if we already know the status
    if (_drnOk !== null) updateDNRBadge(_drnOk);
  }

  // ---- weather overlay ----
  function fetchWeather() {
    if (typeof fetch === 'undefined') return;
    var loc = state.loc;
    var days = Math.min(state.range, 16); // Open-Meteo free tier max
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + loc.lat +
      '&longitude=' + loc.lng +
      '&daily=temperature_2m_max,temperature_2m_min,wind_speed_10m_max,weather_code' +
      '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=' + days;
    fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.daily) return;
      var d = j.daily;
      for (var i = 0; i < d.temperature_2m_max.length; i++) {
        var el = document.getElementById('weather-' + i);
        if (!el) continue;
        var hi = Math.round(d.temperature_2m_max[i]);
        var lo = Math.round(d.temperature_2m_min[i]);
        var wind = Math.round(d.wind_speed_10m_max[i]);
        el.innerHTML = (i === 0 ? '<strong>Weather:</strong> ' : '') +
          hi + '°/' + lo + '°F · wind to ' + wind + ' mph · ' + weatherText(d.weather_code[i]);
      }
    }).catch(function () {
      var el = document.getElementById('weather-0');
      if (el) el.innerHTML = '<span class="note">Weather unavailable offline.</span>';
    });
  }
  function weatherText(code) {
    var m = { 0: 'clear', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
      45: 'fog', 48: 'rime fog', 51: 'light drizzle', 61: 'light rain', 63: 'rain',
      65: 'heavy rain', 71: 'snow', 80: 'showers', 95: 'thunderstorm' };
    return m[code] || 'see forecast';
  }

  // ---- barometer: 4h past + 4h forecast pressure (Open-Meteo, no key) ----
  function hpaToInHg(hpa) { return (hpa * 0.02953).toFixed(2); }

  function pressureTip(delta4h, curHpa) {
    // Walleye-specific bite guidance based on pressure change over 4h
    var abs = Math.abs(delta4h);
    if (delta4h > 3)  return { arrow: '↑↑', label: 'Rising fast',  tip: 'Pressure spiking — walleye may go deep briefly, then turn on' };
    if (delta4h > 1)  return { arrow: '↑',  label: 'Rising',       tip: 'Rising pressure — walleye moving to structure, good bite window' };
    if (delta4h < -3) return { arrow: '↓↓', label: 'Falling fast', tip: 'Pressure dropping fast — aggressive bite now before they shut down' };
    if (delta4h < -1) return { arrow: '↓',  label: 'Falling',      tip: 'Falling pressure — feed up before the front, fish shallow edges' };
    return { arrow: '→', label: 'Steady', tip: 'Stable pressure — find structure, slower methodical presentation' };
  }

  function pressureSparkSVG(values, nowIdx) {
    var W = 200, H = 36;
    var min = Math.min.apply(null, values) - 0.3;
    var max = Math.max.apply(null, values) + 0.3;
    var n = values.length;
    function px(i) { return (i / (n - 1)) * W; }
    function py(v) { return H - ((v - min) / (max - min)) * H; }

    // Past polyline (solid blue)
    var pastPts = values.slice(0, nowIdx + 1).map(function (v, i) { return px(i) + ',' + py(v); }).join(' ');
    // Future polyline (dashed amber)
    var futPts  = values.slice(nowIdx).map(function (v, i) { return px(nowIdx + i) + ',' + py(v); }).join(' ');
    var nowX = px(nowIdx);
    var nowY = py(values[nowIdx]);

    return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="baro-spark" aria-hidden="true">' +
      '<polyline points="' + pastPts + '" fill="none" stroke="var(--minor)" stroke-width="2" stroke-linejoin="round"/>' +
      '<polyline points="' + futPts + '" fill="none" stroke="var(--major)" stroke-width="1.5" stroke-linejoin="round" stroke-dasharray="4,3" opacity=".75"/>' +
      '<line x1="' + nowX + '" y1="0" x2="' + nowX + '" y2="' + H + '" stroke="rgba(255,255,255,.25)" stroke-width="1"/>' +
      '<circle cx="' + nowX + '" cy="' + nowY + '" r="3" fill="var(--ink)"/>' +
      '</svg>';
  }

  function fetchPressure() {
    var el = document.getElementById('baro');
    if (typeof fetch === 'undefined') return;
    var loc = state.loc;
    var reqId = ++_pressureReqId; // claim this generation; any older response will be ignored
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + loc.lat +
      '&longitude=' + loc.lng +
      '&current=temperature_2m,wind_speed_10m,wind_direction_10m' +
      '&hourly=surface_pressure&timezone=auto&past_hours=4&forecast_hours=4&timeformat=unixtime' +
      '&temperature_unit=fahrenheit&wind_speed_unit=mph';
    fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      if (reqId !== _pressureReqId) return; // stale — a newer location fetch is in flight
      if (!j.hourly || !j.hourly.surface_pressure) return;
      var cur2 = j.current || {};
      var windSpeed = cur2.wind_speed_10m || 0;
      var windDir = cur2.wind_direction_10m || 0;
      var airTemp = cur2.temperature_2m || 65;
      var times = j.hourly.time;          // Unix timestamps (s)
      var vals  = j.hourly.surface_pressure;
      var nowS  = Math.floor(Date.now() / 1000);
      // Find closest hour to now
      var nowIdx = 0, minDiff = Infinity;
      times.forEach(function (t, i) {
        var d = Math.abs(t - nowS);
        if (d < minDiff) { minDiff = d; nowIdx = i; }
      });
      var cur = vals[nowIdx];
      var past = vals[Math.max(0, nowIdx - 4)] || vals[0]; // 4h ago
      var delta = cur - past;
      state.pressureDelta = delta;
      var info = pressureTip(delta, cur);
      var adv = computeAdvice(delta, windSpeed, windDir, airTemp);
      renderAdvisor(adv, loc.lat, loc.lng);

      // Hour labels: "−4h", "now", "+4h"
      function hLabel(i) {
        var diff = i - nowIdx;
        if (diff === 0) return 'now';
        return (diff > 0 ? '+' : '') + diff + 'h';
      }
      var labelHTML = '';
      [0, nowIdx, vals.length - 1].forEach(function (i) {
        var pct = (i / (vals.length - 1)) * 100;
        labelHTML += '<span style="left:' + pct + '%">' + hLabel(i) + '</span>';
      });

      el.innerHTML =
        '<div class="baro-head">' +
          '<span class="baro-val">' + hpaToInHg(cur) + ' inHg</span>' +
          '<span class="baro-hpa">(' + Math.round(cur) + ' hPa)</span>' +
          '<span class="baro-arrow baro-' + (delta > 1 ? 'up' : delta < -1 ? 'down' : 'steady') + '">' + info.arrow + ' ' + info.label + '</span>' +
        '</div>' +
        '<div class="baro-spark-wrap">' +
          pressureSparkSVG(vals, nowIdx) +
          '<div class="baro-spark-labels">' + labelHTML + '</div>' +
        '</div>' +
        '<div class="baro-legend"><span class="baro-leg past"></span> Past &nbsp; <span class="baro-leg future"></span> Forecast</div>' +
        '<div class="baro-tip">🎣 ' + info.tip + '</div>';
    }).catch(function () {
      if (reqId !== _pressureReqId) return;
      if (el) el.innerHTML = '<span class="note">Barometer unavailable offline.</span>';
      initMap(loc.lat, loc.lng, null, 0);
      var advEl = document.getElementById('advisor-body');
      if (advEl) advEl.innerHTML = '<div class="adv-offline">Conditions unavailable offline — check solunar periods below for timing.</div>';
    });
  }

  // ---- geolocation ----
  function onGpsUpdate(pos) {
    var lat = +pos.coords.latitude.toFixed(5);
    var lng = +pos.coords.longitude.toFixed(5);
    var acc = Math.round(pos.coords.accuracy); // metres

    // Always move the map pin immediately — no full recompute needed
    if (_map && _locMarker) {
      _locMarker.setLatLng([lat, lng]);
      if (_accCircle) { _accCircle.remove(); _accCircle = null; }
      if (acc < 300) {
        try {
          _accCircle = L.circle([lat, lng], {
            radius: acc, color: '#4fd07a', fillColor: '#4fd07a',
            fillOpacity: 0.08, weight: 1, interactive: false
          }).addTo(_map);
        } catch(e) {}
      }
      _map.setView([lat, lng], _map.getZoom());
    }

    // Full recompute (refetch weather/pressure) only when location changed >100 m
    var moved = _lastRecomputeLat === null ||
      Math.abs(lat - _lastRecomputeLat) > 0.001 ||
      Math.abs(lng - _lastRecomputeLng) > 0.001;

    if (moved) {
      _lastRecomputeLat = lat; _lastRecomputeLng = lng;
      state.loc = {
        name: 'Current location ±' + acc + ' m',
        lat: lat, lng: lng,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT.tz
      };
      recompute();
    }
  }

  function startGpsWatch() {
    if (!navigator.geolocation) return;
    if (_geoWatchId !== null) navigator.geolocation.clearWatch(_geoWatchId);
    _geoWatchId = navigator.geolocation.watchPosition(
      onGpsUpdate,
      function () {},
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  }

  function useMyLocation() {
    if (!navigator.geolocation) { alert('Geolocation not available; using Yellow Lake.'); return; }
    // Force a fresh one-shot fix then re-arm the watch
    navigator.geolocation.getCurrentPosition(
      function(pos) { onGpsUpdate(pos); startGpsWatch(); },
      function() { alert('Could not get location. Using Yellow Lake.'); },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
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
    startGpsWatch();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
