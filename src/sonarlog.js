/* sonarlog.js — read Lowrance sonar logs (.sl2 / .sl3) and turn the depth
   track into contour lines, entirely in the browser.

   Why: Wisconsin publishes no usable bathymetry (DNR survey sheets are 1940s–
   60s paper maps that don't georeference cleanly, and LakeMaster / Navionics /
   C-MAP are licensed). An angler's own Lowrance logs record GPS position and
   sonar depth for every ping, which is better data than any of those for the
   water they actually fish.

   Format: 8-byte file header (format 2 = sl2, 3 = sl3; 1 = the old slg, not
   supported), then variable-size frames. Field offsets below follow the
   MIT-licensed community decoders (node-sl2format, sonarlight) and were checked
   against their sample logs. Depth is in feet; position is Lowrance's
   spherical-Mercator integer encoding (polar radius 6356752.3142 m).

   Exposes window.SonarLog (and module.exports for node tests). */
(function (root) {
  'use strict';

  var R = 6356752.3142, DEG = 180 / Math.PI;
  var LAYOUT = {
    2: { head: 144, size: 28, chan: 32, depth: 64, x: 108, y: 112, flags: 132 },
    3: { head: 168, size: 8, chan: 12, depth: 48, x: 92, y: 96, flags: 116 }
  };
  var POSITION_VALID = 0x0010; // flags bit, as read little-endian

  function x2lng(x) { return x / R * DEG; }
  function y2lat(y) { return (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * DEG; }

  // Incremental reader: push() successive chunks of the file (Lowrance logs
  // with sidescan run to hundreds of MB, too big to load whole on a phone),
  // then finish() -> { format, frames, points: [{lat,lng,depthFt}], channel }.
  // Only each frame's fixed header is read; the sonar image data is skipped.
  // Errors are thrown with messages fit to show the user.
  function createParser() {
    var L = null, fmt = 0, carry = null, skip = 0, frames = 0, broken = false;
    var byChan = {}, firstChan = null;

    function push(chunk) {
      if (broken) return;
      var u = new Uint8Array(chunk);
      if (carry && carry.length) {
        var m = new Uint8Array(carry.length + u.length);
        m.set(carry); m.set(u, carry.length); u = m;
      }
      carry = null;
      var dv = new DataView(u.buffer, u.byteOffset, u.byteLength), n = u.length, pos = skip;
      if (!L) {
        if (n < 8) { carry = u; return; }
        fmt = dv.getUint16(0, true);
        if (fmt === 1) throw new Error('This is an older .slg log; only .sl2 and .sl3 are supported.');
        L = LAYOUT[fmt];
        if (!L) throw new Error('Not a Lowrance .sl2/.sl3 sonar log.');
        pos = 8;
      }
      while (pos + L.head <= n) {
        var size = dv.getUint16(pos + L.size, true);
        if (size < L.head) { broken = true; break; } // corrupt/truncated: keep what we have
        var ch = dv.getUint16(pos + L.chan, true);
        var flags = dv.getUint16(pos + L.flags, true);
        var depth = dv.getFloat32(pos + L.depth, true);
        if (ch <= 5 && (flags & POSITION_VALID) && depth > 0 && depth < 1000) {
          var lng = x2lng(dv.getInt32(pos + L.x, true));
          var lat = y2lat(dv.getInt32(pos + L.y, true));
          if (isFinite(lat) && isFinite(lng) && Math.abs(lat) > 0.01 && Math.abs(lat) < 85) {
            if (firstChan === null) firstChan = ch;
            (byChan[ch] = byChan[ch] || []).push({ lat: lat, lng: lng, depthFt: depth });
          }
        }
        frames++;
        pos += size;
      }
      if (pos >= n) { skip = pos - n; }               // next frame starts in a later chunk
      else { skip = 0; carry = u.slice(pos); }        // partial header: keep for next chunk
    }

    function finish() {
      if (!L) throw new Error('Not a Lowrance .sl2/.sl3 sonar log.');
      // Every channel (primary, downscan, sidescan…) repeats the same depth and
      // position for a ping cycle, so keep one channel to avoid counting each
      // reading several times. Prefer primary (0), else the first one seen.
      var channel = byChan[0] ? 0 : firstChan;
      var points = channel === null ? [] : byChan[channel];
      if (!points.length) throw new Error('No GPS-tagged depth readings found in this log.');
      return { format: fmt === 2 ? 'sl2' : 'sl3', frames: frames, points: points, channel: channel };
    }
    return { push: push, finish: finish };
  }

  function parse(buf) { var p = createParser(); p.push(buf); return p.finish(); }

  // Grid cells are addressed by a single numeric key so a sparse Map can hold
  // them: logs from several lakes miles apart then cost only the cells they
  // touch, never the empty bounding box between them.
  var OFF = 2e7, SPAN = 4e7;
  function ck(gx, gy) { return (gx + OFF) * SPAN + (gy + OFF); }

  // Average pings into cells (a log runs ~10–20 pings/s, so a drifting boat
  // stacks hundreds of readings on one spot). Scale is fixed per call from the
  // first point's latitude — fine at lake scale.
  function bin(points, cellM) {
    var lat0 = points[0].lat, mLat = 111320, mLng = 111320 * Math.cos(lat0 * Math.PI / 180);
    var cells = new Map();
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      var fx = p.lng * mLng / cellM, fy = p.lat * mLat / cellM;
      var gx = Math.round(fx), gy = Math.round(fy);
      var k = ck(gx, gy), c = cells.get(k);
      if (!c) { c = { gx: gx, gy: gy, sum: 0, sx: 0, sy: 0, n: 0 }; cells.set(k, c); }
      c.sum += p.depthFt; c.sx += fx; c.sy += fy; c.n++;
    }
    // Keep each cell's mean ping position (in grid units) as well as its mean
    // depth: snapping readings to the cell centre biases every contour by up
    // to half a cell.
    cells.forEach(function (c) { c.d = c.sum / c.n; c.x = c.sx / c.n; c.y = c.sy / c.n; });
    return { cells: cells, cellM: cellM, mLat: mLat, mLng: mLng };
  }

  // Interpolate the binned soundings onto every grid node within `reach` cells
  // of real data by inverse-distance weighting. Nodes farther than that from
  // any sounding are simply absent, so nothing is invented for water the boat
  // never covered — contours stop where the data stops.
  function grid(binned, reach) {
    var cells = binned.cells, nodes = new Map(), r2 = reach * reach;
    cells.forEach(function (c) {
      for (var dy = -reach; dy <= reach; dy++) for (var dx = -reach; dx <= reach; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        var k = ck(c.gx + dx, c.gy + dy);
        if (!nodes.has(k)) nodes.set(k, { gx: c.gx + dx, gy: c.gy + dy, v: 0 });
      }
    });
    nodes.forEach(function (nd) {
      var ws = 0, s = 0;
      for (var dy = -reach; dy <= reach; dy++) for (var dx = -reach; dx <= reach; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        var c = cells.get(ck(nd.gx + dx, nd.gy + dy)); if (!c) continue;
        var ex = c.x - nd.gx, ey = c.y - nd.gy, d2 = ex * ex + ey * ey;
        var w = 1 / (d2 + 0.05); // inverse distance squared
        ws += w; s += w * c.d;
      }
      nd.v = s / ws;
    });
    return { nodes: nodes, cellM: binned.cellM, mLat: binned.mLat, mLng: binned.mLng };
  }

  // Marching squares at one depth level -> array of [lat,lng] polylines.
  // Segments are emitted per grid square and then chained end-to-end.
  var CASES = {
    1: [['l', 'b']], 2: [['b', 'r']], 3: [['l', 'r']], 4: [['t', 'r']],
    5: [['l', 't'], ['b', 'r']], 6: [['t', 'b']], 7: [['l', 't']],
    8: [['l', 't']], 9: [['t', 'b']], 10: [['l', 'b'], ['t', 'r']],
    11: [['t', 'r']], 12: [['l', 'r']], 13: [['b', 'r']], 14: [['l', 'b']]
  };
  function isoline(g, level) {
    var nodes = g.nodes, segs = [];
    function val(gx, gy) { var n = nodes.get(ck(gx, gy)); return n ? n.v : NaN; }
    nodes.forEach(function (n) {
      var x = n.gx, y = n.gy;
      var a = n.v, b = val(x + 1, y), c = val(x + 1, y + 1), d = val(x, y + 1);
      if (b !== b || c !== c || d !== d) return; // square not fully covered
      var idx = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0);
      if (idx === 0 || idx === 15) return;
      var e = {
        t: [x + (level - a) / (b - a), y], r: [x + 1, y + (level - b) / (c - b)],
        b: [x + (level - d) / (c - d), y + 1], l: [x, y + (level - a) / (d - a)]
      };
      var pr = CASES[idx];
      for (var i = 0; i < pr.length; i++) segs.push([e[pr[i][0]], e[pr[i][1]]]);
    });
    var key = function (p) { return p[0].toFixed(5) + ',' + p[1].toFixed(5); };
    var ends = new Map(), used = new Uint8Array(segs.length), lines = [];
    segs.forEach(function (s, i) { for (var e = 0; e < 2; e++) {
      var k = key(s[e]); var l = ends.get(k); if (!l) ends.set(k, l = []); l.push(i); } });
    function next(p) {
      var list = ends.get(key(p)) || [];
      for (var i = 0; i < list.length; i++) if (!used[list[i]]) return list[i];
      return -1;
    }
    for (var i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      used[i] = 1;
      var line = [segs[i][0], segs[i][1]];
      for (var dir = 0; dir < 2; dir++) for (;;) {
        var tail = dir ? line[0] : line[line.length - 1];
        var j = next(tail); if (j < 0) break;
        used[j] = 1;
        var s = segs[j], o = key(s[0]) === key(tail) ? s[1] : s[0];
        if (dir) line.unshift(o); else line.push(o);
      }
      // grid units -> degrees (node gx sits exactly at gx * cellM metres)
      lines.push(line.map(function (p) {
        return [p[1] * g.cellM / g.mLat, p[0] * g.cellM / g.mLng];
      }));
    }
    return lines;
  }

  // Whole pipeline. Options: cellM (grid size, default 6 m), intervalFt
  // (default 5), reachCells (how far to interpolate from soundings, default 6
  // cells = 36 m — enough to join adjacent passes, not to bridge open water).
  function contour(points, opts) {
    opts = opts || {};
    var cellM = opts.cellM || 6, interval = opts.intervalFt || 5, reach = opts.reachCells || 6;
    var g = grid(bin(points, cellM), reach);
    var maxD = 0;
    g.nodes.forEach(function (n) { if (n.v > maxD) maxD = n.v; });
    var out = [];
    for (var lv = interval; lv < maxD; lv += interval) {
      var lines = isoline(g, lv).filter(function (l) { return l.length >= 3; });
      if (lines.length) out.push({ depthFt: lv, lines: lines });
    }
    return { levels: out, maxDepthFt: maxD, cellM: cellM, intervalFt: interval };
  }

  // Reduce raw pings to one averaged reading per `cellM` square before
  // storing: keeps every bit of coverage at a fraction of the size.
  function thin(points, cellM) {
    var b = bin(points, cellM), out = [];
    b.cells.forEach(function (c) {
      out.push({ lat: c.y * cellM / b.mLat, lng: c.x * cellM / b.mLng, depthFt: c.d });
    });
    return out;
  }

  function bounds(points) {
    var b = { minlat: 90, minlng: 180, maxlat: -90, maxlng: -180 };
    points.forEach(function (p) {
      if (p.lat < b.minlat) b.minlat = p.lat; if (p.lat > b.maxlat) b.maxlat = p.lat;
      if (p.lng < b.minlng) b.minlng = p.lng; if (p.lng > b.maxlng) b.maxlng = p.lng; });
    return b;
  }

  var api = { parse: parse, createParser: createParser, thin: thin, contour: contour, bounds: bounds, _bin: bin, _grid: grid, _isoline: isoline };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SonarLog = api;
})(this);
