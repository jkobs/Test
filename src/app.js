/* app.js — UI for the solunar fishing-times app. Uses global Solunar (engine). */
(function () {
  'use strict';

  var DEFAULT = { name: 'Yellow Lake, WI', lat: 45.94, lng: -92.38, tz: 'America/Chicago' };
  var RANGE_OPTIONS = [7, 14, 30];

  var state = { loc: DEFAULT, days: [], notify: false, range: 7, pressureDelta: null, baroData: null, lastAdv: null, nearbyWaters: [], knownSpecies: null, lakeInfo: null };

  // ---- Leaflet map state ----
  var _map = null, _modalMap = null, _locMarker = null, _windLine = null, _accCircle = null;
  var _topoLayer = null, _drnEnabled = true;
  var _pressureReqId = 0;
  var _geoWatchId = null;
  var _lastRecomputeLat = null, _lastRecomputeLng = null;
  var _manualLoc = false; // true when user picked a chip/map-click; suppresses GPS overrides
  var _speciesFilter = '';
  var _selectedSpeciesName = 'Walleye';

  var SATELLITE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  var TOPO_URL = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}';

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
  function stars(n) { return '🐟'.repeat(n) + '·'.repeat(5 - n); }
  var KIND = { overhead: 'Moon overhead', underfoot: 'Moon underfoot', moonrise: 'Moonrise', moonset: 'Moonset' };
  var PHASE_ICON = ['🌑','🌒','🌓','🌔','🌕','🌖','🌗','🌘'];

  // ---- bite scale + species outlook ----
  var BITE_LABELS = ['No Bite', 'Slow', 'Moderate', 'Active', 'Hot Bite'];

  var SPECIES = [
    { name: 'Walleye',         tempLo: 55, tempHi: 75, pref:  1,
      depth: function(d, t) {
        if (t < 55) return '3–15 ft (post-spawn/spring shallow)';
        if (d > 1)  return '15–25 ft (post-front, deep rock/humps)';
        if (d < -1) return '6–15 ft (pre-front, wind-blown shallows)';
        if (t > 78) return '15–25 ft (thermocline break, offshore)';
        return '10–18 ft';
      },
      structure: function(d, t) {
        if (d > 1)  return 'Steep inside turns 10–30 ft, deep rock humps, channel edges — post-front retreat';
        if (d < -1) return 'Wind-blown points and shorelines, weed edge with hard bottom underneath';
        if (t > 78) return 'Thermocline break 15–25 ft; offshore humps; open-water edges';
        return 'Weed-to-hard-bottom break, rocky reefs and points; outer cabbage edge at 8–12 ft';
      },
      gear: function(d, t, s) {
        if (d > 3)  return 'Lindy rig dragged very slowly, or dead-stick jig — fish lethargic, deep';
        if (d > 1)  return 'Slow jig (leech/crawler tip) or Lindy rig; quiet long-line presentation';
        if (d < -3) return 'Crankbait or spinner on wind-blown points — feeding frenzy pre-front';
        if (d < -1) return 'Crankbait along wind-blown points; jig + minnow on shallow rock edges';
        if (t < 55) return 'Live-bait jig tipped with minnow; slow snap-jig 2 in. off bottom';
        if (t > 78) return 'Troll crankbait 1.5–2.5 mph over thermocline break; planer boards to spread';
        return s >= 2 ? 'Snap-jig aggressively — solunar period active, low-light edge nearby' : 'Jig (leech in warm water, minnow in cold) or crankbait along drop-off edge';
      }},
    { name: 'Largemouth Bass', tempLo: 65, tempHi: 85, pref: -1,
      depth: function(d, t) {
        if (t > 82) return '2–6 ft at dawn/dusk; 12–20 ft midday near thermocline';
        if (d > 1)  return '10–20 ft (post-front; deep ledges and offshore humps)';
        if (d < -1) return '3–8 ft (pre-front; feeding up in shallows)';
        if (t < 62) return '5–12 ft (transitional structure, docks, wood)';
        return '5–15 ft';
      },
      structure: function(d, t) {
        if (t > 82) return 'Lily pad mats, dock shade, and grass mat edges at low light; deep timber midday';
        if (d < -1) return 'Sparse weed edges, emergent cover, shallow laydowns and wood — pre-front active';
        if (d > 1)  return 'Deep weed edges, offshore humps, creek channel bends; thermocline layer';
        if (t < 62) return 'Dock posts, submerged brush piles, hard-bottom transitions near heavy cover';
        return 'Aquatic vegetation (milfoil, cabbage, lily pads), laydowns, docks';
      },
      gear: function(d, t, s) {
        if (t > 82) return 'Topwater frog or walking bait at dawn/dusk; drop-shot or deep swimbait midday';
        if (d < -1) return 'Buzzbait or fast crankbait — aggressive pre-front; punch frog over grass mats';
        if (d > 1)  return 'Wacky/Ned rig Senko or Texas rig (finesse); slow football jig on bottom';
        if (t < 62) return 'Slow-roll spinnerbait through cover; flipping jig in dock pockets; square-bill off wood';
        return 'Texas rig through weeds, swim jig along weed edge, topwater at low light';
      }},
    { name: 'Northern Pike',   tempLo: 48, tempHi: 68, pref: -1,
      depth: function(d, t) {
        if (t < 50) return '1–6 ft (dark-bottom shallow bays, spring staging)';
        if (t > 68) return '15–30 ft (deep weed edge, thermocline break)';
        if (d < -1) return '3–12 ft (active, cruising weed edges pre-front)';
        if (d > 1)  return '8–18 ft (outer weed line, post-front retreat)';
        return '6–15 ft';
      },
      structure: function(d, t) {
        if (t < 50) return 'Dark-bottom shallow bays absorbing heat, flooded backwaters, tributary inflows';
        if (t > 68) return 'Deep cabbage outer edge 15–30 ft; rocky humps adjacent to weeds';
        if (d < -1) return 'Inside weed-bed pockets and points; shallow flat bays with weed cover';
        if (d > 1)  return 'Outer cabbage weed line; long points extending into basin';
        return 'Cabbage weed-bed edges and pockets (primary ambush habitat); weed points and cups';
      },
      gear: function(d, t, s) {
        if (t < 50) return 'Slow twitch-pause jerkbait or inline spinner in cold shallow bays — fish won\'t chase';
        if (t > 68) return 'Large spoon or swimbait trolled/burned along deep weed edge 2.8–3.5 mph';
        if (d < -1) return 'Blue Fox inline spinner (sz6) or large spoon burned across weed tops — reaction strikes';
        if (d > 1)  return 'Slow-roll large swimbait along outer weed line; figure-8 at boat after every cast';
        return 'Blue Fox inline spinner, spoon, or jerkbait with twitch-pause along weed edge; cast parallel to edge';
      }},
    { name: 'Crappie',         tempLo: 62, tempHi: 78, pref:  0,
      depth: function(d, t) {
        if (t < 55) return '12–20 ft (staging near brush/creek channels)';
        if (t < 65) return '1–6 ft (spawn over hard bottom/brush)';
        if (t > 78) return '15–25 ft (deep brush/timber in summer heat)';
        if (d > 1)  return '10–18 ft (suspended above deep brush)';
        return '6–15 ft (suspended)';
      },
      structure: function(d, t) {
        if (t < 55) return 'Brush piles and submerged timber 12–20 ft; creek channel staging edges';
        if (t < 65) return 'Shallow spawning flats 1–6 ft; sparse brush, dock edges, protected coves';
        if (t > 78) return 'Deep brush piles 15–25 ft; standing timber, submerged structure in basin';
        if (d > 1)  return 'Brush piles and submerged timber 10–18 ft — crappie feed upward, stay above school';
        return 'Brush piles (top structure), dock pilings, weed edges with perch-fry activity';
      },
      gear: function(d, t, s) {
        if (t < 55) return 'Spider rig troll at 0.2 mph — 1/16 oz jig + small minnow; double rig over deep brush';
        if (t < 65) return 'Small jig or minnow under slip float near spawning cover; 1/32 oz for slow fall';
        if (t > 78) return 'Vertical jig or Slab Rap over deep brush 15–25 ft — fish feed upward, never drop below them';
        if (d > 1)  return 'Vertical 1/16 oz jig just above brush pile — crappie always feed up; light jig = slow fall';
        return s >= 2 ? 'Active period — swim small jig through brush at steady pace' : '1/16 oz jig (orange/chartreuse) or small minnow near brush; vary color until they react';
      }},
    { name: 'Yellow Perch',    tempLo: 58, tempHi: 74, pref:  1,
      depth: function(d, t) {
        if (t < 58) return '4–10 ft (spring spawn, rocky/weed flats)';
        if (t > 74) return '20–35 ft (rocky humps, above thermocline)';
        if (d > 1)  return '15–25 ft (tight to rocky structure)';
        return '10–20 ft';
      },
      structure: function(d, t) {
        if (t < 58) return 'Hard-bottom flats with scattered vegetation; rocky shorelines 4–10 ft; spawn at 45–55°F';
        if (t > 74) return 'Rocky humps and offshore reefs 20–35 ft — move holes frequently, school by size';
        if (d > 1)  return 'Rocky humps and offshore reefs; locate school with sonar before dropping';
        if (d < -1) return 'Gravel points, wind-blown rocky shorelines, rock-to-sand transitions';
        return 'Rocky humps, reefs, and drop-offs (primary); weed edges and pilings in spring/fall';
      },
      gear: function(d, t, s) {
        if (t < 58) return 'Small minnow or nightcrawler piece on light jig near hard bottom; 4–6 lb line';
        if (t > 74) return 'Swedish Pimple or small jigging spoon over rocky humps 20–35 ft; dawn/dusk best';
        if (d > 1)  return 'Bottom rig (nightcrawler or small minnow) over sand/gravel; use sonar to find school first';
        if (d < -1) return 'Small blade bait or jigging spoon to trigger reaction bites; cover water until school found';
        return 'Small jig + maggot/waxworm/minnow; nightcrawler on dropper rig over rocky hard bottom';
      }},
    { name: 'Smallmouth Bass', tempLo: 58, tempHi: 72, pref:  0,
      depth: function(d, t) {
        if (t < 55) return '5–15 ft (prespawn staging, gravel/pea-gravel flats)';
        if (t > 75) return '20–40 ft (isolated boulders on flat basin bottom)';
        if (d < -1) return '5–12 ft (rocky points and shoals, pre-front aggressive)';
        if (d > 1)  return '15–30 ft (deep rock ledges — most pressure-sensitive fish)';
        return '8–20 ft';
      },
      structure: function(d, t) {
        if (t < 55) return 'Gravel and pea-gravel flats near future spawn sites; chunk rock and boulder fields';
        if (t > 75) return 'Isolated boulders on flat basin bottom 20–40 ft; main-lake rocky humps';
        if (d < -1) return 'Shallow boulder shoals, chunk rock banks, rocky points — pre-front aggressive';
        if (d > 1)  return 'Base of deep rock piles and ledge drop-offs; retreats hard from shallow post-front';
        return 'Rock and chunk rock (crayfish habitat), gravel points, rocky shorelines — clear water primary';
      },
      gear: function(d, t, s) {
        if (t < 55) return 'Jerkbait (Shad Rap/X-Rap) with long pause; tube bait crawled on gravel — prespawn magic';
        if (t > 75) return 'Drop shot or Ned rig near isolated boulders 20–40 ft; football jig on deep ledge';
        if (d < -1) return 'Topwater or crankbait deflecting off rocks — pre-front aggression; cast parallel to rocky bank';
        if (d > 1)  return 'Ned rig or tube dead-slow on deep rock — smallmouth most pressure-sensitive freshwater fish';
        return s >= 2 ? 'Crankbait (Shad Rap) over gravel or drop-shot near boulder in solunar window' : 'Plastic grub or tube dragged on gravel/rock — top crayfish imitation; 4–6 lb line';
      }},
    { name: 'Lake Sturgeon',   tempLo: 50, tempHi: 72, pref:  0,
      depth: function(d, t) {
        if (t < 50) return '20–35 ft (deep channel holes, slow current)';
        if (t > 72) return '20–30 ft (deepest river channel holes)';
        if (d > 1)  return '15–22 ft (main channel, gravel/sand flats)';
        return '15–22 ft (best consistent productive depth)';
      },
      structure: function(d, t) {
        if (t < 50 || t > 72) return 'Deepest river channel holes and current seams; river bends where invertebrates concentrate';
        if (d > 1)  return 'Gravel/sand flats adjacent to deep channel — anchor perpendicular, spread baits across hole';
        if (d < -1) return 'Main river channel, deep basin holes, channel bends with silt/gravel bottom';
        return 'Deep river holes with moderate current; sandy/silty/gravel bottom; channel edges near current seams';
      },
      gear: function(d, t, s) {
        if (t < 50 || t > 72) return 'Sucker meat (cut bait) on 6/0 hook; 2–3 oz no-roll sinker; soak at sunset in deepest hole';
        if (d > 1)  return 'Fresh nightcrawler (golf-ball gob) on 6/0 hook; hold position, re-anchor every 30 min';
        if (d < -1) return 'Crawler or sucker meat + scent; glass-bead clacker ahead of hook; anchor in deepest channel hole';
        return 'Nightcrawler gob or sucker meat; no-roll sinker 2–3 oz; move every 30 min; best action at sunset';
      }},
    { name: 'Muskellunge',     tempLo: 60, tempHi: 72, pref: -1,
      depth: function(d, t) {
        if (t < 58) return '10–20 ft (deep weed edge, rock transitions — jerkbait/live bait)';
        if (t > 75) return '10–25 ft (thermocline layer; above oxygen break)';
        if (d < -1) return '5–15 ft (active on weed edges pre-front)';
        if (d > 1)  return '10–20 ft (deeper structural edges post-front)';
        return '6–18 ft';
      },
      structure: function(d, t, s) {
        if (t < 58) return 'Rocky points, deep weed-to-rock transitions, inside turns on main-lake structure';
        if (t > 75) return 'Cabbage outer edge near thermocline 10–25 ft; shady inside turns; September = peak feeding';
        if (d < -1) return 'Primary cabbage weed edges and points with deep-water access — best muskie window';
        if (d > 1)  return 'Secondary weed lines, hard-bottom humps; fish neutral, need slow presentations';
        return s >= 2 ? 'Your highest-percentage muskie spot NOW — active solunar period, fish are catchable' : 'Cabbage weed edge, inside turns on breaks, creek mouths, weed-to-rock transitions';
      },
      gear: function(d, t, s) {
        if (t < 58) return 'Large jerkbait (Suick, Reef Hawg) — jerk-down, glide-up, LONG pause; or live sucker slow drift';
        if (t > 75) return 'Dawn/dusk only; topwater prop bait or walking bait near thermocline structure; overcast = all day';
        if (d < -1) return 'Double-bladed bucktail fast retrieve — best window; topwater at low light; figure-8 EVERY cast';
        if (d > 1)  return 'Large rubber swimbait or glide bait, very slow — fish are neutral; wide deep figure-8 at boat';
        return s >= 2 ? 'Bucktail fast on prime edges — solunar period active; figure-8 every cast without exception' : 'Bucktail or jerkbait; vary retrieve speed until fish reacts; always figure-8 at boatside';
      }},
    { name: 'Channel Catfish', tempLo: 72, tempHi: 90, pref: -1,
      depth: function(d, t) {
        if (t < 65) return '15–30 ft (deep holes and channel bends — cold = lethargic)';
        if (t > 85) return '3–10 ft at night; 20–30 ft daytime in summer heat';
        if (d < -1) return '3–10 ft (pre-front, move to shallows at dusk)';
        if (d > 1)  return '18–30 ft (post-front, retreat to deepest holes)';
        return '10–20 ft (channel edges and timber pockets)';
      },
      structure: function(d, t) {
        if (t < 65) return 'Deepest channel holes, submerged timber, river bends — fish lethargic in cold';
        if (d < -1) return 'Current seams below timber; outside channel bends; dam tailwaters — pre-front active';
        if (d > 1)  return 'Deepest holes 15–30 ft, main channel bottom, submerged brush near deep water';
        return 'Channel bends with current, submerged timber and brush, log jams, riprap edges';
      },
      gear: function(d, t, s) {
        if (t < 65) return 'Cut sucker meat or chicken liver on slip sinker — soak bottom of deepest hole, barely move';
        if (d < -1) return 'Punch bait or stink bait dip worm in current seam below snag; dusk to 2 am peak window';
        if (d > 1)  return 'Nightcrawler or live minnow on slip sinker 20–30 ft; fish lethargic post-front, soak longer';
        return s >= 2 ? 'Cut shad on slip sinker at dusk in current seam — solunar window aligns with catfish feeding time' : 'Cut shad, chicken liver, or commercial stink bait; 2/0–4/0 hook, no-roll sinker; patience';
      }},
    { name: 'Flathead Catfish', tempLo: 70, tempHi: 88, pref:  0,
      depth: function(d, t) {
        if (t < 60) return '20–40 ft (deep woody pools — inactive in cold)';
        if (t > 85) return '5–15 ft at night only; deepest pool daytime';
        if (d > 1)  return '12–25 ft (tight to deep woody structure post-front)';
        return '8–18 ft (woody pools with slow current — purely nocturnal)';
      },
      structure: function(d, t) {
        if (t < 60) return 'Deepest pool in system with woody debris; minimal movement';
        if (d > 1)  return 'Undercut banks with root wads, submerged logs 12–25 ft; post-front retreat to deepest wood';
        if (d < -1) return 'Slow-current eddies below log jams; woody pool exits — cruising and active pre-front';
        return 'Submerged logs and root wads, undercut banks, slow-current eddies, deep river bends';
      },
      gear: function(d, t, s) {
        if (t < 60) return 'Large live bream or sucker head under slip float near woody snag — extremely slow; fish barely active';
        if (d < -1) return 'Large live sunfish or bullhead (6–10 in.) under heavy float near snag — pre-front activity window';
        if (d > 1)  return 'Live bait on slip sinker near deepest wood; 5/0–7/0 hook; soak 10–15 min before moving';
        return 'Live sunfish, bullhead, perch, or chub (5–10 in.) ONLY — flatheads rarely strike cut bait; 10 pm–3 am prime';
      }},
    { name: 'Lake Trout',      tempLo: 48, tempHi: 60, pref: -1,
      depth: function(d, t) {
        if (t > 65) return '45–100 ft (below thermocline; track with downrigger)';
        if (t < 45) return '10–30 ft (shallows during ice-out and fall turnover)';
        if (d < -1) return '20–50 ft (pre-front active, may rise toward surface)';
        if (d > 1)  return '50–100 ft (post-front; very lethargic, hug bottom)';
        return '20–60 ft';
      },
      structure: function(d, t) {
        if (t > 65) return 'Deep main-lake basin below thermocline 45–100 ft; rocky humps at thermocline break';
        if (t < 45) return 'Shallow rocky shorelines and reefs 10–30 ft — active during fall/spring turnover';
        if (d > 1)  return 'Deepest rocky basin; coldest water; fish bottom-hugging post-front';
        if (d < -1) return 'Thermocline break 20–50 ft; rocky offshore humps; chase cisco and smelt schools';
        return 'Main-lake rocky humps and reefs 20–60 ft; cold clear oligotrophic basin';
      },
      gear: function(d, t, s) {
        if (t > 65) return 'Downrigger troll spoon or cisco-imitating flasher 45–100 ft; 2–2.5 mph; match thermocline depth exactly';
        if (t < 45) return 'Swedish Pimple jigged vertically or flutter spoon on shallow rock 10–30 ft';
        if (d > 1)  return 'Bladebait (Sonar) or tube jig dead-slow on deep rock bottom — fish barely active post-front';
        if (d < -1) return 'Troll spoon near thermocline or jig aggressively — pre-front window, highest activity';
        return s >= 2 ? 'Jig aggressively over rocky hump in solunar window — lakers respond well to periods' : 'Downrigger troll with spoon or tube jig; 1.5–2.5 mph over main-lake rocky structure';
      }},
    { name: 'Rainbow/Brown Trout', tempLo: 50, tempHi: 66, pref: -1,
      depth: function(d, t) {
        if (t > 68) return '10–25 ft (cold inflow zones or thermocline layer)';
        if (t < 45) return '5–15 ft near bottom (sluggish; slow presentations)';
        if (d < -1) return 'Surface to 8 ft (active pre-front; rising to feed)';
        if (d > 1)  return '8–20 ft (post-front retreat near cold inflows)';
        return '3–12 ft';
      },
      structure: function(d, t) {
        if (t > 68) return 'Cold spring inflows, thermocline break, dam tailwaters, deep shaded pools';
        if (t < 45) return 'Deep slow pools and runs; low light only — brown trout especially reluctant in cold';
        if (d < -1) return 'Riffles and current seams near surface — pre-front feeding window, most active';
        if (d > 1)  return 'Deep pools and undercut banks near cold spring inflows — post-front neutral';
        return 'Current seams, pool-riffle transitions, rocky points, undercut banks; overcast prime';
      },
      gear: function(d, t, s) {
        if (t > 68) return 'Small spoon or jig near cold inflow or thermocline depth — trout schooled deep in heat';
        if (t < 45) return 'Slow drift nymph or PowerBait on slip sinker near bottom — barely twitch the rod';
        if (d < -1) return 'Inline spinner (Rooster Tail/Mepps), small crankbait, or dry fly — peak pre-front aggression';
        if (d > 1)  return 'PowerBait or nightcrawler under float near pool bottom — finesse only, post-front lockup';
        return s >= 2 ? 'Inline spinner or streamer in solunar window — trout timing correlates well with moon periods' : 'Inline spinner, leech or worm under bobber, or soft-hackle wet fly; dawn/dusk/overcast best';
      }},
  ];

  function _speciesScore(sp, delta, airTemp, solBoost) {
    var t = (airTemp >= sp.tempLo && airTemp <= sp.tempHi) ? 2
          : (airTemp < sp.tempLo - 10 || airTemp > sp.tempHi + 10) ? 0 : 1;
    var p = sp.pref === 1  ? (delta > 1 ? 2 : delta < -1 ? 0 : 1)
          : sp.pref === -1 ? (delta < -1 ? 2 : delta > 1 ? 0 : 1)
          : (Math.abs(delta) < 1 ? 2 : 1);
    return Math.max(1, Math.min(5, t + p + solBoost));
  }

  function biteScaleHtml(score) {
    return '<div class="bite-bar">' +
      BITE_LABELS.map(function(label, i) {
        var n = i + 1;
        return '<div class="bite-seg bite-' + n + (n === score ? ' bite-current' : '') + '">' + label + '</div>';
      }).join('') +
    '</div>';
  }

  function _speciesInWater(sp) {
    if (!state.knownSpecies) return true;
    // Split "Rainbow/Brown Trout" → ["rainbow", "brown trout"] so either half matches
    var names = sp.name.toLowerCase().split('/').map(function(s) { return s.trim(); });
    return state.knownSpecies.some(function(k) {
      var kl = k.toLowerCase();
      return names.some(function(n) {
        return n.indexOf(kl) !== -1 || kl.indexOf(n) !== -1;
      });
    });
  }

  function _speciesRowsHtml(delta, airTemp, solBoost) {
    var f = _speciesFilter.toLowerCase();
    var list = SPECIES.filter(function(sp) {
      return _speciesInWater(sp) && (!f || sp.name.toLowerCase().indexOf(f) !== -1);
    });
    if (!list.length) return '<div class="species-no-match">No species match "' + _speciesFilter + '"</div>';
    return list.map(function(sp) {
      var sc = _speciesScore(sp, delta, airTemp, solBoost);
      var depth     = sp.depth(delta, airTemp);
      var structure = sp.structure(delta, airTemp, solBoost);
      var gear      = sp.gear(delta, airTemp, solBoost);
      return '<div class="species-row">' +
        '<div class="species-row-head">' +
          '<div class="species-name">' + sp.name + '</div>' +
          '<div class="species-badge score-' + sc + '">' + BITE_LABELS[sc - 1] + '</div>' +
        '</div>' +
        '<div class="species-detail">' +
          '<b>Depth</b> ' + depth + ' · ' +
          '<b>Structure</b> ' + structure + ' · ' +
          '<b>Presentation</b> ' + gear +
        '</div>' +
      '</div>';
    }).join('');
  }

  function speciesOutlookHtml(delta, airTemp, solBoost) {
    var sourceBadge = state.knownSpecies
      ? '<span class="species-source-badge">📋 ' + state.loc.name + '</span>'
      : '<span class="species-source-badge muted">All species</span>';
    return '<div class="species-section">' +
      '<div class="species-header">' +
        '<span class="modal-section-label">Species Outlook ' + sourceBadge + '</span>' +
        '<input type="search" class="species-filter" id="species-filter" placeholder="Filter…" value="' + _speciesFilter + '">' +
      '</div>' +
      '<div id="species-rows">' + _speciesRowsHtml(delta, airTemp, solBoost) + '</div>' +
    '</div>';
  }

  function rewireSpeciesFilter() {
    var el = document.getElementById('species-filter');
    if (!el) return;
    el.oninput = function() {
      _speciesFilter = el.value;
      var rows = document.getElementById('species-rows');
      if (rows && state.lastAdv) {
        var adv = state.lastAdv;
        rows.innerHTML = _speciesRowsHtml(adv.delta, adv.airTemp, adv.solunarBoost);
      }
    };
  }

  function _speciesBiteHtml(adv) {
    var sp = null;
    for (var i = 0; i < SPECIES.length; i++) {
      if (SPECIES[i].name === _selectedSpeciesName) { sp = SPECIES[i]; break; }
    }
    if (!sp) sp = SPECIES[0];
    var sc = _speciesScore(sp, adv.delta, adv.airTemp, adv.solunarBoost);
    var depth     = sp.depth(adv.delta, adv.airTemp);
    var structure = sp.structure(adv.delta, adv.airTemp, adv.solunarBoost);
    var gear      = sp.gear(adv.delta, adv.airTemp, adv.solunarBoost);
    var visibleSpecies = SPECIES.filter(_speciesInWater);
    if (!_speciesInWater(sp)) { sp = visibleSpecies[0] || SPECIES[0]; _selectedSpeciesName = sp.name; }
    var opts = visibleSpecies.map(function(s) {
      return '<option value="' + s.name + '"' + (s.name === sp.name ? ' selected' : '') + '>' + s.name + '</option>';
    }).join('');
    return '<div class="conditions-head">' +
        '<div class="bite-scale-label">Bite Conditions</div>' +
        '<select id="conditions-species-select" class="conditions-species-select">' + opts + '</select>' +
      '</div>' +
      '<div class="bite-scale-wrap">' + biteScaleHtml(sc) + '</div>' +
      '<div class="adv-grid">' +
        '<div class="adv-item"><div class="adv-label">Pressure</div><div class="adv-val">' + adv.pressureStr + '</div></div>' +
        '<div class="adv-item"><div class="adv-label">Target depth</div><div class="adv-val">' + depth + '</div></div>' +
        '<div class="adv-item adv-wide"><div class="adv-label">Structure</div><div class="adv-val">' + structure + '</div></div>' +
        '<div class="adv-item adv-wide"><div class="adv-label">Presentation</div><div class="adv-val">' + gear + '</div></div>' +
      '</div>';
  }

  function rewireSpeciesDropdown() {
    var el = document.getElementById('conditions-species-select');
    if (!el) return;
    el.onchange = function() {
      _selectedSpeciesName = el.value;
      var wrap = document.getElementById('species-conditions');
      if (wrap && state.lastAdv) {
        wrap.innerHTML = _speciesBiteHtml(state.lastAdv);
        rewireSpeciesDropdown();
      }
    };
  }

  function selectWater(wName, wLat, wLng) {
    state.loc = { name: wName, lat: wLat, lng: wLng, tz: state.loc.tz };
    state.knownSpecies = null;
    state.lakeInfo = null;
    _speciesReqKey = null;
    _lakeInfoKey = null;
    _manualLoc = true;
    var locEl = document.getElementById('loc');
    if (locEl) {
      locEl.innerHTML = wName + ' · ' + wLat.toFixed(2) + ', ' + wLng.toFixed(2) +
        '<button id="useloc">Use my location</button>';
      document.getElementById('useloc').onclick = useMyLocation;
    }
    renderNearbyWaters();
    recompute();
    fetchLakeInfo(wName, wLat, wLng);
    fetchSpeciesForWater(wName, wLat, wLng);
  }

  function renderNearbyWaters() {
    var el = document.getElementById('nearby-waters');
    if (!el || !state.nearbyWaters.length) return;
    var opts = state.nearbyWaters.map(function(w, i) {
      var selected = w.name === state.loc.name;
      var icon = w.type === 'river' ? '🏞' : '🫧';
      return '<option value="' + i + '"' + (selected ? ' selected' : '') + '>' +
        icon + ' ' + w.name + ' · ' + fmtDist(w.dist) +
      '</option>';
    }).join('');
    el.innerHTML =
      '<label class="nearby-label" for="nearby-select">Nearby waters</label>' +
      '<select id="nearby-select" class="nearby-select">' + opts + '</select>';
    var sel = document.getElementById('nearby-select');
    sel.onchange = function() {
      var w = state.nearbyWaters[+sel.value];
      if (w) selectWater(w.name, w.lat, w.lng);
    };
  }

  function fmtDist(degDist) {
    var mi = Math.sqrt(degDist) * 69;
    if (mi < 0.1) return '< 0.1 mi';
    if (mi < 10)  return mi.toFixed(1) + ' mi';
    return Math.round(mi) + ' mi';
  }

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
    fetchNearestGauge(state.loc.lat, state.loc.lng);
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
    var sunTimes = '<div class="sun-times">' +
      '<span>🌅 Sunrise <strong>' + fmtTime(d.sunrise, tz) + '</strong></span>' +
      '<span>🌇 Sunset <strong>' + fmtTime(d.sunset, tz) + '</strong></span>' +
      '</div>';
    var sub = phaseIcon(d.moon.phase) + ' ' + d.moon.phaseName + ' · ' + Math.round(d.moon.illumination * 100) + '% lit';
    var rows = d.periods.map(function (p) { return periodRow(p, tz); }).join('');
    return '<div class="card' + (isFirst ? ' today' : '') + '" data-idx="' + idx + '" role="button" tabindex="0" aria-label="Open details for ' + fmtDayLabel(d.date, tz) + '">' +
      '<div class="day-head"><span class="date">' + fmtDayLabel(d.date, tz) + '</span>' +
        '<span class="stars" title="' + d.rating.stars + '/5">' + stars(d.rating.stars) + ' <span class="tap-hint">tap for details</span></span></div>' +
      sunTimes +
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
      var parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour: 'numeric', minute: '2-digit', second: '2-digit',
        hour12: false
      }).formatToParts(date);
      var hp = {};
      parts.forEach(function (x) { hp[x.type] = +x.value; });
      return ((hp.hour * 3600 + hp.minute * 60 + (hp.second || 0)) / 86400) * 100;
    }

    var rows = [];
    var srP = pct(d.sunrise), ssP = pct(d.sunset);
    if (srP !== null && ssP !== null) {
      rows.push('<div class="tl-band daylight" style="left:' + srP + '%;width:' + (ssP - srP) + '%"></div>');
    }
    d.periods.forEach(function (p) {
      var s = pct(p.start), e = pct(p.end), c = pct(p.center);
      if (s === null) return;
      if (e < s) e = 100;
      rows.push('<div class="tl-band ' + p.type + (p.sunOverlap ? ' sun' : '') + '" style="left:' + Math.max(0,s) + '%;width:' + Math.min(100-Math.max(0,s), e-Math.max(0,s)) + '%"></div>');
      if (c !== null) rows.push('<div class="tl-tick" style="left:' + c + '%"></div>');
    });
    if (srP !== null) rows.push('<div class="tl-sun-mark" style="left:' + srP + '%" title="Sunrise"></div>');
    if (ssP !== null) rows.push('<div class="tl-sun-mark" style="left:' + ssP + '%" title="Sunset"></div>');

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

  // ---- modal infrastructure ----
  function _showModal(innerHtml, afterAppend) {
    closeModal();
    var wrap = document.createElement('div');
    wrap.innerHTML = '<div class="modal-overlay" id="modal-overlay"><div class="modal" role="dialog" aria-modal="true">' + innerHtml + '</div></div>';
    document.body.appendChild(wrap.firstChild);
    document.getElementById('modal-close').onclick = closeModal;
    document.getElementById('modal-overlay').onclick = function (e) {
      if (e.target.id === 'modal-overlay') closeModal();
    };
    document.addEventListener('keydown', onEsc);
    if (afterAppend) afterAppend();
  }

  function closeModal() {
    if (_modalMap) { try { _modalMap.remove(); } catch (e) {} _modalMap = null; }
    var el = document.getElementById('modal-overlay');
    if (el) el.remove();
    document.removeEventListener('keydown', onEsc);
  }
  function onEsc(e) { if (e.key === 'Escape') closeModal(); }

  function _modalHead(title, sub) {
    return '<div class="modal-head">' +
      '<div><div class="modal-date">' + title + '</div>' +
      (sub ? '<div class="modal-section-label" style="margin-top:2px">' + sub + '</div>' : '') +
      '</div>' +
      '<button class="modal-close" id="modal-close" aria-label="Close">✕</button>' +
    '</div>';
  }

  // ---- day-detail modal ----
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

    _showModal(
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
      '</div>'
    );
  }

  // ---- next-periods modal ----
  function openNextModal() {
    var tz = state.loc.tz;
    var now = Date.now();
    var upcoming = allPeriods().filter(function (p) { return p.end.getTime() >= now; }).slice(0, 16);
    if (!upcoming.length) return;

    var rows = upcoming.map(function (p) {
      var isActive = now >= p.start.getTime() && now <= p.end.getTime();
      return '<div class="period ' + p.type + (p.sunOverlap ? ' sun' : '') + (isActive ? ' period-now' : '') + '">' +
        '<span class="tag">' + p.type + '</span>' +
        '<span class="kind">' + KIND[p.kind] + (isActive ? ' <span class="sun-badge" style="color:var(--good)">● now</span>' : '') + '</span>' +
        '<span class="time">' + fmtTime(p.center, tz) +
          ' <span class="range">' + fmtTime(p.start, tz) + '–' + fmtTime(p.end, tz) + '</span></span>' +
        '</div>';
    }).join('');

    _showModal(
      _modalHead('Upcoming Periods', state.loc.name) +
      '<div class="modal-section">' +
        '<div class="modal-section-label">Next ' + upcoming.length + ' solunar periods</div>' +
        '<div class="periods">' + rows + '</div>' +
      '</div>'
    );
  }

  // ---- barometer modal ----
  function openBaroModal() {
    var bd = state.baroData;
    if (!bd) return;
    var vals = bd.vals, nowIdx = bd.nowIdx, cur = bd.cur, info = bd.info, delta = bd.delta;

    function sparkLarge(values, nIdx) {
      var W = 300, H = 80;
      var min = Math.min.apply(null, values) - 0.3;
      var max = Math.max.apply(null, values) + 0.3;
      var n = values.length;
      function px(i) { return (i / (n - 1)) * W; }
      function py(v) { return H - ((v - min) / (max - min)) * H; }
      var pastPts = values.slice(0, nIdx + 1).map(function (v, i) { return px(i) + ',' + py(v); }).join(' ');
      var futPts  = values.slice(nIdx).map(function (v, i) { return px(nIdx + i) + ',' + py(v); }).join(' ');
      var nowX = px(nIdx), nowY = py(values[nIdx]);
      return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="baro-spark" style="height:80px" aria-hidden="true">' +
        '<polyline points="' + pastPts + '" fill="none" stroke="var(--minor)" stroke-width="2.5" stroke-linejoin="round"/>' +
        '<polyline points="' + futPts + '" fill="none" stroke="var(--major)" stroke-width="2" stroke-linejoin="round" stroke-dasharray="5,4" opacity=".75"/>' +
        '<line x1="' + nowX + '" y1="0" x2="' + nowX + '" y2="' + H + '" stroke="rgba(255,255,255,.25)" stroke-width="1"/>' +
        '<circle cx="' + nowX + '" cy="' + nowY + '" r="4" fill="var(--ink)"/>' +
        '</svg>';
    }

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

    _showModal(
      _modalHead('Barometer') +
      '<div class="modal-section">' +
        '<div class="baro-head" style="margin-bottom:14px">' +
          '<span class="baro-val" style="font-size:30px">' + hpaToInHg(cur) + ' inHg</span>' +
          '<span class="baro-hpa">(' + Math.round(cur) + ' hPa)</span>' +
          '<span class="baro-arrow baro-' + (delta > 1 ? 'up' : delta < -1 ? 'down' : 'steady') + '" style="font-size:17px">' + info.arrow + ' ' + info.label + '</span>' +
        '</div>' +
        '<div class="baro-spark-wrap">' +
          sparkLarge(vals, nowIdx) +
          '<div class="baro-spark-labels">' + labelHTML + '</div>' +
        '</div>' +
        '<div class="baro-legend" style="margin-top:10px"><span class="baro-leg past"></span> Past &nbsp; <span class="baro-leg future"></span> Forecast</div>' +
        '<div class="baro-tip" style="font-size:14px;margin-top:14px">🎣 ' + info.tip + '</div>' +
      '</div>' +
      '<div class="modal-section">' +
        '<div class="modal-section-label">Walleye pressure guide</div>' +
        '<div class="adv-grid">' +
          '<div class="adv-item"><div class="adv-label">↑↑ Rising fast</div><div class="adv-val">Go deep — then turn on hard</div></div>' +
          '<div class="adv-item"><div class="adv-label">↑ Rising</div><div class="adv-val">Move to structure — good bite window</div></div>' +
          '<div class="adv-item"><div class="adv-label">→ Steady</div><div class="adv-val">Slow methodical sweep on structure</div></div>' +
          '<div class="adv-item"><div class="adv-label">↓ Falling</div><div class="adv-val">Feed up before front — fish edges</div></div>' +
          '<div class="adv-item adv-wide"><div class="adv-label">↓↓ Falling fast</div><div class="adv-val">Aggressive bite now before shut-down</div></div>' +
        '</div>' +
      '</div>'
    );
  }

  // ---- fishing advisor / map modal ----
  function openAdvisorModal() {
    var lat = state.loc.lat, lng = state.loc.lng;
    var adv = state.lastAdv;
    var bodyEl = document.getElementById('advisor-body');
    var bodyHtml = bodyEl ? bodyEl.innerHTML : '';

    _showModal(
      _modalHead('Fishing Advisor', state.loc.name) +
      '<div id="modal-map" class="modal-map-full"></div>' +
      '<div class="modal-section" style="padding-top:14px">' + bodyHtml + '</div>',
      function () {
        // Remove the inline toggle/footer from modal copy (buttons are wired to main map)
        var footer = document.querySelector('#modal-overlay .adv-map-footer');
        if (footer) footer.remove();

        if (typeof L === 'undefined' || !L.map) return;
        try {
          _modalMap = L.map('modal-map', { zoomControl: true, attributionControl: false });
          L.tileLayer(SATELLITE_URL, { maxZoom: 18 }).addTo(_modalMap);
          L.control.attribution({ prefix: '© Esri · USGS' }).addTo(_modalMap);
          if (_drnEnabled) {
            L.tileLayer(TOPO_URL, { opacity: 0.55, maxZoom: 16, pane: 'overlayPane' }).addTo(_modalMap);
          }
          var zoom = _map ? _map.getZoom() : 14;
          _modalMap.setView([lat, lng], zoom);
          L.circleMarker([lat, lng], {
            radius: 9, fillColor: '#4fd07a', color: '#fff', weight: 2.5, fillOpacity: 1
          }).addTo(_modalMap);
          if (adv && adv.towardDeg !== null && adv.windSpeed > 4) {
            var towardRad = adv.towardDeg * Math.PI / 180;
            var dd = 0.005;
            var dlat = dd * Math.cos(towardRad);
            var dlng = dd * Math.sin(towardRad) / Math.cos(lat * Math.PI / 180);
            L.polyline([[lat, lng], [lat + dlat, lng + dlng]], {
              color: '#56b3f0', weight: 3, opacity: 0.85, dashArray: '6,5'
            }).bindTooltip('Windward shore →', { permanent: false }).addTo(_modalMap);
          }
          setTimeout(function () { if (_modalMap) _modalMap.invalidateSize(); }, 100);
        } catch (e) {}
      }
    );
  }

  function render() {
    var loc = state.loc;
    document.getElementById('loc').innerHTML =
      loc.name + ' · ' + loc.lat.toFixed(2) + ', ' + loc.lng.toFixed(2) +
      '<button id="useloc">Use my location</button>';
    document.getElementById('useloc').onclick = useMyLocation;

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

    document.querySelectorAll('#days .card').forEach(function (card) {
      card.onclick = function () { openModal(+card.dataset.idx); };
      card.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') openModal(+card.dataset.idx); };
    });

    renderNext();
  }

  function renderClock() {
    var el = document.getElementById('clock');
    if (!el) return;
    el.textContent = new Intl.DateTimeFormat('en-US', {
      timeZone: state.loc.tz, weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true
    }).format(new Date());
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
      '<div class="when">' + KIND[p.kind] + ' · ' + fmtTime(p.center, state.loc.tz) + '</div>' +
      '<div class="next-hint">tap for all periods</div></div>' +
      '<div class="countdown">' + cd + '</div>';
    el.style.cursor = 'pointer';
    el.onclick = openNextModal;

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

  // ---- map depth overlay (WI DNR bathymetry WMS, falls back to USGS topo) ----
  var DNR_BATHY_WMS = 'https://dnrmaps.wi.gov/arcgis/services/WT_SWDV/WT_Lake_Bathymetry_WTM_Ext_v2/MapServer/WMSServer';

  function refreshDNRLayer() {
    if (!_map || !_drnEnabled) return;
    if (!_topoLayer) {
      _topoLayer = L.tileLayer.wms(DNR_BATHY_WMS, {
        layers: '0', format: 'image/png', transparent: true,
        opacity: 0.65, attribution: '© WI DNR'
      }).addTo(_map);
    }
  }

  function toggleDNRLayer() {
    var btn = document.getElementById('dnr-toggle');
    if (_drnEnabled) {
      _drnEnabled = false;
      if (_topoLayer && _map) { _map.removeLayer(_topoLayer); _topoLayer = null; }
      if (btn) btn.textContent = 'Show depth';
    } else {
      _drnEnabled = true;
      refreshDNRLayer();
      if (btn) btn.textContent = 'Hide depth';
    }
  }

  function initMap(lat, lng, towardDeg, windSpeed) {
    if (typeof L === 'undefined' || !L.map) return;
    var el = document.getElementById('advisor-map');
    if (!el) return;
    try {
      if (!_map) {
        _map = L.map('advisor-map', { zoomControl: true, attributionControl: false });
        L.tileLayer(SATELLITE_URL, { maxZoom: 18 }).addTo(_map);
        L.control.attribution({ prefix: '© Esri · USGS' }).addTo(_map);
        _map.on('click', function(e) {
          var clat = e.latlng.lat, clng = e.latlng.lng;
          var OVP = 'https://overpass-api.de/api/interpreter';
          var hdrs = { 'Content-Type': 'application/x-www-form-urlencoded' };

          function applyLake(elem, fallbackLat, fallbackLng) {
            if (!elem || !elem.tags || !elem.tags.name) return;
            var wName = elem.tags.name;
            var center = elem.center || elem;
            var wLat = center.lat || fallbackLat;
            var wLng = center.lon || center.lng || fallbackLng;
            state.loc = { name: wName, lat: wLat, lng: wLng, tz: state.loc.tz };
            state.knownSpecies = null; state.lakeInfo = null;
            _speciesReqKey = null; _lakeInfoKey = null; _manualLoc = true;
            var locEl = document.getElementById('loc');
            if (locEl) {
              locEl.innerHTML = wName + ' · ' + wLat.toFixed(2) + ', ' + wLng.toFixed(2) +
                '<button id="useloc">Use my location</button>';
              document.getElementById('useloc').onclick = useMyLocation;
            }
            recompute();
            fetchLakeInfo(wName, wLat, wLng);
            fetchSpeciesForWater(wName, wLat, wLng);
          }

          // Step 1: is_in — definitive: click is INSIDE this water body
          var q1 = '[out:json][timeout:8];is_in(' + clat + ',' + clng + ')->.pt;' +
            '(way(pivot.pt)["natural"="water"]["name"];' +
            'relation(pivot.pt)["natural"="water"]["name"];' +
            ');out tags center;';
          fetch(OVP, { method:'POST', headers:hdrs, body:'data='+encodeURIComponent(q1) })
            .then(function(r){return r.json();})
            .then(function(j){
              var hit = j.elements && j.elements.find(function(e2){ return e2.tags && e2.tags.name; });
              if (hit) { applyLake(hit, clat, clng); return; }
              // Step 2: proximity fallback — sort by center distance, closest wins
              var q2 = '[out:json][timeout:8];(' +
                'way["natural"="water"]["name"](around:1500,' + clat + ',' + clng + ');' +
                'relation["natural"="water"]["name"](around:1500,' + clat + ',' + clng + ');' +
                ');out tags center;';
              fetch(OVP, { method:'POST', headers:hdrs, body:'data='+encodeURIComponent(q2) })
                .then(function(r){return r.json();})
                .then(function(j2){
                  var named = (j2.elements||[]).filter(function(e2){ return e2.tags && e2.tags.name; });
                  if (!named.length) return;
                  named.sort(function(a,b){
                    var ca=a.center||a, cb=b.center||b;
                    var da=(ca.lat-clat)*(ca.lat-clat)+(ca.lon-clng)*(ca.lon-clng);
                    var db=(cb.lat-clat)*(cb.lat-clat)+(cb.lon-clng)*(cb.lon-clng);
                    return da-db;
                  });
                  applyLake(named[0], clat, clng);
                }).catch(function(){});
            }).catch(function(){});
        });
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

    var tempNote;
    if (airTemp < 45) {
      tempNote = 'Cold air — fish likely lethargic. Slow presentations deep near bottom.';
      pScore = Math.max(1, pScore - 1);
    } else if (airTemp < 60) {
      tempNote = 'Cool conditions — transition period; fish active on rock and gravel structure.';
    } else if (airTemp <= 80) {
      tempNote = 'Comfortable temps — most species in their active range; run a full structure sweep.';
    } else {
      tempNote = 'Hot air — midday fish likely deep or suspended; focus early/late on shallows.';
      pScore = Math.max(1, pScore - 1);
    }

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

    var lightNote = '';
    if (state.days && state.days[0]) {
      var sr = state.days[0].sunrise, ss = state.days[0].sunset;
      var nowMs = Date.now();
      var goldenMs = 45 * 60 * 1000;
      if (sr && Math.abs(nowMs - sr.getTime()) < goldenMs) {
        lightNote = '🌅 Sunrise golden hour — one of the strongest feeding triggers; be on the water now.';
        solunarBoost = Math.min(2, solunarBoost + 1);
      } else if (ss && Math.abs(nowMs - ss.getTime()) < goldenMs) {
        lightNote = '🌇 Sunset golden hour — one of the strongest feeding triggers; maximize time on water.';
        solunarBoost = Math.min(2, solunarBoost + 1);
      } else if (ss && nowMs > ss.getTime() + goldenMs) {
        lightNote = '🌙 Night — low-light predators shift shallow; catfish, walleye, and bass most active on points and edges.';
      } else if (sr && nowMs < sr.getTime() - goldenMs) {
        lightNote = '🌙 Pre-dawn — nocturnal feeders winding down; walleye and perch beginning to activate.';
      }
    }

    var score = Math.max(1, Math.min(5, pScore + windScore + solunarBoost));
    var labels = ['Very Slow', 'Slow', 'Moderate', 'Active', 'Hot Bite'];
    var dots = '●'.repeat(score) + '○'.repeat(5 - score);
    var dotColor = score >= 4 ? 'var(--good)' : score >= 3 ? 'var(--major)' : 'var(--muted)';

    return {
      score: score, label: labels[score - 1], dots: dots, dotColor: dotColor,
      pressureStr: pressureStr, depth: depth, structure: structure, presentation: presentation,
      windSpeed: windSpeed, fromDir: fromDir, towardDir: towardDir, towardDeg: towardDeg,
      windNote: windNote, tempNote: tempNote, solunarNote: solunarNote, lightNote: lightNote,
      delta: delta, airTemp: airTemp, solunarBoost: solunarBoost
    };
  }

  function renderAdvisor(adv, lat, lng) {
    state.lastAdv = adv;
    initMap(lat, lng, adv.towardDeg, adv.windSpeed);
    var el = document.getElementById('advisor-body');
    if (!el) return;
    el.innerHTML =
      '<div id="lake-info"></div>' +
      '<div id="species-conditions">' + _speciesBiteHtml(adv) + '</div>' +
      (adv.solunarNote ? '<div class="adv-note adv-solunar">' + adv.solunarNote + '</div>' : '') +
      (adv.lightNote  ? '<div class="adv-note adv-light">'   + adv.lightNote  + '</div>' : '') +
      '<div class="adv-note">' + adv.windNote + '</div>' +
      '<div class="adv-note">' + adv.tempNote + '</div>' +
      speciesOutlookHtml(adv.delta, adv.airTemp, adv.solunarBoost) +
      '<div class="adv-map-footer">' +
        '<span class="adv-dnr-badge">🛰 Satellite · ' + state.loc.name + '</span>' +
        '<button class="adv-dnr-btn" id="dnr-toggle">' + (_drnEnabled ? 'Hide depth' : 'Show depth') + '</button>' +
      '</div>';
    renderLakeInfo();

    var toggleBtn = document.getElementById('dnr-toggle');
    if (toggleBtn) toggleBtn.onclick = toggleDNRLayer;
    rewireSpeciesFilter();
    rewireSpeciesDropdown();

    // Wire the advisor header to expand modal (one-time)
    var hdEl = document.querySelector('.advisor-hd');
    if (hdEl && !hdEl._expandWired) {
      hdEl._expandWired = true;
      hdEl.innerHTML = '📍 Fishing Advisor <span class="tap-hint" style="float:right;letter-spacing:0">↗ expand</span>';
      hdEl.style.cursor = 'pointer';
      hdEl.onclick = openAdvisorModal;
    }
  }

  // ---- weather overlay ----
  function fetchWeather() {
    if (typeof fetch === 'undefined') return;
    var loc = state.loc;
    var days = Math.min(state.range, 16);
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

  // ---- barometer: 4h past + 4h forecast pressure ----
  function hpaToInHg(hpa) { return (hpa * 0.02953).toFixed(2); }

  function pressureTip(delta4h) {
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
    var pastPts = values.slice(0, nowIdx + 1).map(function (v, i) { return px(i) + ',' + py(v); }).join(' ');
    var futPts  = values.slice(nowIdx).map(function (v, i) { return px(nowIdx + i) + ',' + py(v); }).join(' ');
    var nowX = px(nowIdx), nowY = py(values[nowIdx]);
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
    var reqId = ++_pressureReqId;
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + loc.lat +
      '&longitude=' + loc.lng +
      '&current=temperature_2m,wind_speed_10m,wind_direction_10m' +
      '&hourly=surface_pressure&timezone=auto&past_hours=4&forecast_hours=4&timeformat=unixtime' +
      '&temperature_unit=fahrenheit&wind_speed_unit=mph';
    fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      if (reqId !== _pressureReqId) return;
      if (!j.hourly || !j.hourly.surface_pressure) return;
      var cur2 = j.current || {};
      var windSpeed = cur2.wind_speed_10m || 0;
      var windDir = cur2.wind_direction_10m || 0;
      var airTemp = cur2.temperature_2m || 65;
      var times = j.hourly.time;
      var vals  = j.hourly.surface_pressure;
      var nowS  = Math.floor(Date.now() / 1000);
      var nowIdx = 0, minDiff = Infinity;
      times.forEach(function (t, i) {
        var d = Math.abs(t - nowS);
        if (d < minDiff) { minDiff = d; nowIdx = i; }
      });
      var cur = vals[nowIdx];
      var past = vals[Math.max(0, nowIdx - 4)] || vals[0];
      var delta = cur - past;
      state.pressureDelta = delta;
      var info = pressureTip(delta);
      var adv = computeAdvice(delta, windSpeed, windDir, airTemp);
      renderAdvisor(adv, loc.lat, loc.lng);

      state.baroData = { vals: vals, nowIdx: nowIdx, cur: cur, info: info, delta: delta };

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
          '<span class="tap-hint baro-expand-hint">↗ expand</span>' +
        '</div>' +
        '<div class="baro-spark-wrap">' +
          pressureSparkSVG(vals, nowIdx) +
          '<div class="baro-spark-labels">' + labelHTML + '</div>' +
        '</div>' +
        '<div class="baro-legend"><span class="baro-leg past"></span> Past &nbsp; <span class="baro-leg future"></span> Forecast</div>' +
        '<div class="baro-tip">🎣 ' + info.tip + '</div>';

      el.style.cursor = 'pointer';
      el.onclick = openBaroModal;
    }).catch(function () {
      if (reqId !== _pressureReqId) return;
      if (el) el.innerHTML = '<span class="note">Barometer unavailable offline.</span>';
      initMap(loc.lat, loc.lng, null, 0);
      var advEl = document.getElementById('advisor-body');
      if (advEl) advEl.innerHTML = '<div class="adv-offline">Conditions unavailable offline — check solunar periods below for timing.</div>';
    });
  }

  // ---- nearest lake/river lookup (Overpass API) ----
  var _lakeReqLat = null, _lakeReqLng = null;
  function fetchNearestLake(lat, lng) {
    if (typeof fetch === 'undefined') return;
    if (_lakeReqLat !== null &&
        Math.abs(lat - _lakeReqLat) < 0.005 &&
        Math.abs(lng - _lakeReqLng) < 0.005) return;
    _lakeReqLat = lat; _lakeReqLng = lng;
    var R = 32187; // ~20 miles
    var q = '[out:json][timeout:15];(' +
      'way["natural"="water"]["name"](around:' + R + ',' + lat + ',' + lng + ');' +
      'relation["natural"="water"]["name"](around:' + R + ',' + lat + ',' + lng + ');' +
      'way["waterway"~"river|stream"]["name"](around:' + R + ',' + lat + ',' + lng + ');' +
      'relation["waterway"~"river|stream"]["name"](around:' + R + ',' + lat + ',' + lng + ');' +
    ');out center;';
    fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(q)
    }).then(function(r) { return r.json(); }).then(function(j) {
      if (!j.elements || !j.elements.length) return;
      var waters = [];
      j.elements.forEach(function(e) {
        if (!e.tags || !e.tags.name) return;
        var c = e.center || e;
        if (c.lat == null) return;
        var wlat = c.lat, wlng = c.lon || c.lng || 0;
        var dlat = wlat - lat, dlng = wlng - lng;
        var dist = dlat * dlat + dlng * dlng;
        var type = e.tags.waterway ? 'river' : 'lake';
        var existing = null;
        for (var i = 0; i < waters.length; i++) { if (waters[i].name === e.tags.name) { existing = waters[i]; break; } }
        if (existing) { if (dist < existing.dist) { existing.dist = dist; existing.lat = wlat; existing.lng = wlng; } }
        else waters.push({ name: e.tags.name, lat: wlat, lng: wlng, dist: dist, type: type });
      });
      waters.sort(function(a, b) { return a.dist - b.dist; });
      state.nearbyWaters = waters.slice(0, 10);
      var best = state.nearbyWaters[0];
      if (!best) return;
      state.loc.name = best.name;
      var locEl = document.getElementById('loc');
      if (locEl) {
        locEl.innerHTML = best.name + ' · ' +
          state.loc.lat.toFixed(2) + ', ' + state.loc.lng.toFixed(2) +
          '<button id="useloc">Use my location</button>';
        document.getElementById('useloc').onclick = useMyLocation;
      }
      renderNearbyWaters();
      fetchLakeInfo(best.name, best.lat, best.lng);
      fetchSpeciesForWater(best.name, best.lat, best.lng);
    }).catch(function() {});
  }

  // ---- USGS river gauge ----
  var _gaugeReqLat = null, _gaugeReqLng = null;
  function fetchNearestGauge(lat, lng) {
    if (typeof fetch === 'undefined') return;
    if (_gaugeReqLat !== null &&
        Math.abs(lat - _gaugeReqLat) < 0.05 &&
        Math.abs(lng - _gaugeReqLng) < 0.05) return;
    _gaugeReqLat = lat; _gaugeReqLng = lng;
    var pad = 0.5;
    var url = 'https://waterservices.usgs.gov/nwis/iv/?format=json' +
      '&bBox=' + (lng - pad).toFixed(4) + ',' + (lat - pad).toFixed(4) + ',' +
                (lng + pad).toFixed(4) + ',' + (lat + pad).toFixed(4) +
      '&parameterCd=00060,00010&period=PT2H&siteStatus=active&siteType=ST';
    fetch(url).then(function(r) { return r.json(); }).then(function(j) {
      var ts = (j.value && j.value.timeSeries) || [];
      if (!ts.length) return;
      var sites = {};
      ts.forEach(function(s) {
        var info = s.sourceInfo;
        var code = info.siteCode[0].value;
        var slat = info.geoLocation.geogLocation.latitude;
        var slng = info.geoLocation.geogLocation.longitude;
        var dlat = slat - lat, dlng = slng - lng;
        if (!sites[code]) sites[code] = { name: info.siteName, code: code, lat: slat, lng: slng, dist: dlat*dlat + dlng*dlng, flow: null, temp: null };
        var varCode = s.variable.variableCode[0].value;
        var vals = s.values[0] && s.values[0].value;
        var latest = vals && vals[vals.length - 1];
        if (latest && latest.value !== '-999999') {
          var v = parseFloat(latest.value);
          if (!isNaN(v)) {
            if (varCode === '00060') sites[code].flow = v;
            if (varCode === '00010') sites[code].temp = v;
          }
        }
      });
      var best = null, bestDist = Infinity;
      var MAX_GAUGE_DIST = 0.013; // ~8 miles in degree²
      Object.keys(sites).forEach(function(k) {
        var s = sites[k];
        if (s.flow !== null && s.dist < bestDist && s.dist < MAX_GAUGE_DIST) { bestDist = s.dist; best = s; }
      });
      if (best) renderGauge(best);
      else { var gc = document.getElementById('gauge-card'); if (gc) gc.innerHTML = ''; }
    }).catch(function() {});
  }

  function cleanGaugeName(raw) {
    return raw
      .replace(/\s+\d{6,}\s*/g, ' ')   // strip USGS station ID numbers
      .replace(/\s+/g, ' ').trim()
      .toLowerCase()
      .replace(/(?:^|\s)\S/g, function(c) { return c.toUpperCase(); }) // title case
      .replace(/, Wi$/i, ', WI');        // fix state abbrev capitalisation
  }

  function renderGauge(gauge) {
    var el = document.getElementById('gauge-card');
    if (!el) return;
    var dist = fmtDist(gauge.dist);
    var flowStr = Math.round(gauge.flow).toLocaleString() + ' cfs';
    var tempF   = gauge.temp !== null ? Math.round(gauge.temp * 9 / 5 + 32) : null;
    var flowTip = '';
    if (gauge.flow < 200)       flowTip = 'Low flow — catfish in deep pools, trout in slower runs';
    else if (gauge.flow < 800)  flowTip = 'Moderate flow — good catfish and smallmouth conditions';
    else if (gauge.flow < 2500) flowTip = 'High flow — target current breaks and eddies below structure';
    else                        flowTip = 'Near flood stage — wait for flow to drop';
    if (tempF !== null) {
      if (tempF < 50)      flowTip += ' · cold water (' + tempF + '°F) — trout peak, catfish slow';
      else if (tempF < 65) flowTip += ' · cool (' + tempF + '°F) — walleye and smallmouth prime';
      else if (tempF < 75) flowTip += ' · warm (' + tempF + '°F) — catfish and bass active';
      else                 flowTip += ' · hot water (' + tempF + '°F) — go deep or target cold inflows';
    }
    el.innerHTML =
      '<div class="gauge-head">' +
        '<span class="gauge-name">💧 ' + cleanGaugeName(gauge.name) + '</span>' +
        '<span class="gauge-dist">' + dist + ' away</span>' +
      '</div>' +
      '<div class="gauge-vals">' +
        '<span class="gauge-flow">' + flowStr + '</span>' +
        (tempF !== null ? '<span class="gauge-temp">' + tempF + '°F water</span>' : '') +
      '</div>' +
      '<div class="gauge-tip">' + flowTip + '</div>';
  }

  // ---- lake info fetch (Overpass OSM tags + Wikidata depth/area/trophic) ----
  var _lakeInfoKey = null;
  function fetchLakeInfo(name, lat, lng) {
    if (typeof fetch === 'undefined') return;
    var key = lat.toFixed(4) + '|' + lng.toFixed(4);
    if (_lakeInfoKey === key) return;
    _lakeInfoKey = key;
    state.lakeInfo = null;
    var liEl = document.getElementById('lake-info');
    if (liEl) liEl.innerHTML = '<div class="lake-info-loading">Fetching lake data…</div>';

    var safeName = name.replace(/,.*/, '').trim().replace(/['"]/g, '');
    var q = '[out:json][timeout:10];(' +
      'way["natural"="water"]["name"~"' + safeName + '",i](around:3000,' + lat + ',' + lng + ');' +
      'relation["natural"="water"]["name"~"' + safeName + '",i](around:3000,' + lat + ',' + lng + ');' +
    ');out tags;';
    fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(q)
    }).then(function(r) { return r.json(); }).then(function(j) {
      var elem = j.elements && j.elements[0];
      var tags = (elem && elem.tags) || {};
      var info = { name: tags.name || name, type: tags.water || null, wikidata: tags.wikidata || null };
      if (tags.ele) info.elevation = Math.round(+tags.ele * 3.281) + ' ft';

      if (info.wikidata) {
        fetch('https://www.wikidata.org/wiki/Special:EntityData/' + info.wikidata + '.json')
          .then(function(r) { return r.json(); })
          .then(function(wd) {
            var entity = wd.entities && wd.entities[info.wikidata];
            var claims = (entity && entity.claims) || {};

            function getNum(pid) {
              var c = claims[pid] && claims[pid][0];
              var dv = c && c.mainsnak && c.mainsnak.datavalue;
              return dv ? { amount: parseFloat(dv.value.amount), unit: dv.value.unit || '' } : null;
            }
            function getItem(pid) {
              var c = claims[pid] && claims[pid][0];
              var dv = c && c.mainsnak && c.mainsnak.datavalue;
              return dv && dv.value && dv.value.id;
            }

            var area = getNum('P2046');
            if (area) {
              if (area.unit.indexOf('Q712226') !== -1)      info.area = Math.round(area.amount * 247.105) + ' acres';
              else if (area.unit.indexOf('Q35852') !== -1)  info.area = Math.round(area.amount * 2.471) + ' acres';
              else if (area.unit.indexOf('Q81292') !== -1)  info.area = Math.round(area.amount) + ' acres';
            }
            var depth = getNum('P4511');
            if (depth) {
              if (depth.unit.indexOf('Q11573') !== -1)      { info.maxDepth = Math.round(depth.amount * 3.281) + ' ft'; info.maxDepthM = depth.amount; }
              else if (depth.unit.indexOf('Q3710') !== -1)  { info.maxDepth = Math.round(depth.amount) + ' ft'; info.maxDepthM = depth.amount / 3.281; }
            }
            var elev = getNum('P2044');
            if (elev && !info.elevation) {
              if (elev.unit.indexOf('Q11573') !== -1) info.elevation = Math.round(elev.amount * 3.281) + ' ft';
            }
            var trophicId = getItem('P6526');
            var trophicMap = { 'Q1250464': 'Oligotrophic', 'Q1250467': 'Mesotrophic', 'Q1250479': 'Eutrophic', 'Q20892765': 'Hypereutrophic' };
            if (trophicId && trophicMap[trophicId]) info.trophic = trophicMap[trophicId];

            state.lakeInfo = info;
            renderLakeInfo();
          }).catch(function() { state.lakeInfo = info; renderLakeInfo(); });
      } else {
        state.lakeInfo = info;
        renderLakeInfo();
      }
    }).catch(function() { state.lakeInfo = { name: name }; renderLakeInfo(); });
  }

  function _trophicFishingNote(info) {
    if (info.trophic === 'Oligotrophic')   return 'Clear, cold, low-nutrient — prime habitat for trout, walleye, and lake sturgeon; target deep structure in summer.';
    if (info.trophic === 'Mesotrophic')    return 'Moderate clarity and nutrients — good mixed fishery; walleye on break lines, bass and pike in weeds.';
    if (info.trophic === 'Eutrophic')      return 'Nutrient-rich with reduced clarity — excellent bass, crappie, catfish; target vegetation edges and deep holes.';
    if (info.trophic === 'Hypereutrophic') return 'Very high nutrients, low oxygen in depths — concentrate on shallow vegetation; carp, catfish, panfish.';
    if (info.maxDepthM) {
      if (info.maxDepthM > 30) return 'Deep lake — likely thermally stratified in summer; target thermocline 20–40 ft for walleye and trout.';
      if (info.maxDepthM < 4)  return 'Shallow lake — weed-based fishery; bass, panfish, and pike in vegetation edges.';
    }
    return '';
  }

  function renderLakeInfo() {
    var el = document.getElementById('lake-info');
    if (!el) return;
    var info = state.lakeInfo;
    if (!info) { el.innerHTML = ''; return; }
    var rows = [];
    if (info.type) rows.push(['Type', info.type.charAt(0).toUpperCase() + info.type.slice(1)]);
    if (info.area) rows.push(['Surface area', info.area]);
    if (info.maxDepth) rows.push(['Max depth', info.maxDepth]);
    if (info.elevation) rows.push(['Elevation', info.elevation]);
    if (info.trophic) rows.push(['Trophic status', info.trophic]);
    var note = _trophicFishingNote(info);
    el.innerHTML =
      '<div class="lake-info-name">' + info.name + '</div>' +
      (rows.length ? '<div class="lake-info-grid">' +
        rows.map(function(r) {
          return '<div class="lake-info-item"><div class="lake-info-label">' + r[0] + '</div><div class="lake-info-val">' + r[1] + '</div></div>';
        }).join('') + '</div>' : '<div class="lake-info-nodata">No additional lake data found</div>') +
      (note ? '<div class="lake-info-note">' + note + '</div>' : '');
  }

  // ---- species-by-water lookup (WI DNR ArcGIS + iNaturalist fallback) ----
  var _speciesReqKey = null;
  function fetchSpeciesForWater(name, lat, lng) {
    if (typeof fetch === 'undefined') return;
    var key = name + '|' + lat.toFixed(3) + '|' + lng.toFixed(3);
    if (_speciesReqKey === key) return;
    _speciesReqKey = key;
    state.knownSpecies = null;

    var collected = [];
    var pending = 2;

    function finish() {
      pending--;
      if (pending > 0) return;
      var seen = {};
      var unique = collected.filter(function(s) {
        var k = s.toLowerCase();
        if (seen[k]) return false;
        seen[k] = true;
        return true;
      });
      state.knownSpecies = unique.length ? unique : null;
      // Patch advisor DOM without full recompute
      var condEl = document.getElementById('species-conditions');
      if (condEl && state.lastAdv) {
        condEl.innerHTML = _speciesBiteHtml(state.lastAdv);
        rewireSpeciesDropdown();
      }
      var rowsEl = document.getElementById('species-rows');
      if (rowsEl && state.lastAdv) {
        var adv = state.lastAdv;
        rowsEl.innerHTML = _speciesRowsHtml(adv.delta, adv.airTemp, adv.solunarBoost);
      }
      // Update source badge text
      document.querySelectorAll('.species-source-badge').forEach(function(b) {
        if (state.knownSpecies) {
          b.textContent = '📋 ' + name;
          b.classList.remove('muted');
        } else {
          b.textContent = 'All species';
          b.classList.add('muted');
        }
      });
    }

    // Source 1: WI DNR ArcGIS fish stocking — stocked species for this water body
    var lakeName = name.replace(/,.*/, '').trim();
    var safeQ = "UPPER(WATER_BODY_NAME) LIKE UPPER('%" + lakeName.replace(/'/g, "''") + "%')";
    var dnrUrl = 'https://dnrmaps.wi.gov/arcgis/rest/services/FM_Fisheries/FM_Fish_Stocking_Public/MapServer/0/query' +
      '?where=' + encodeURIComponent(safeQ) +
      '&outFields=SPECIES_NAME&returnDistinctValues=true&resultRecordCount=200&f=json';
    fetch(dnrUrl).then(function(r) { return r.json(); }).then(function(j) {
      if (j.features) {
        j.features.forEach(function(feat) {
          var s = feat.attributes && (feat.attributes.SPECIES_NAME || feat.attributes.COMMON_NAME);
          if (s) collected.push(s);
        });
      }
      finish();
    }).catch(function() { finish(); });

    // Source 2: iNaturalist citizen-science observations within 3 km radius
    var inatUrl = 'https://api.inaturalist.org/v1/observations' +
      '?taxon_id=47178&lat=' + lat + '&lng=' + lng + '&radius=3&per_page=200&order_by=observed_on';
    fetch(inatUrl).then(function(r) { return r.json(); }).then(function(j) {
      if (j.results) {
        var seen = {};
        j.results.forEach(function(obs) {
          var cn = obs.taxon && obs.taxon.preferred_common_name;
          if (cn && !seen[cn]) { seen[cn] = true; collected.push(cn); }
        });
      }
      finish();
    }).catch(function() { finish(); });
  }

  // ---- geolocation ----
  function onGpsUpdate(pos) {
    var lat = +pos.coords.latitude.toFixed(5);
    var lng = +pos.coords.longitude.toFixed(5);
    var acc = Math.round(pos.coords.accuracy);

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
      // Only recenter map if the user hasn't manually picked a water body
      if (!_manualLoc) _map.setView([lat, lng], _map.getZoom());
    }

    // Skip location + recompute overrides when user has a manual selection
    if (_manualLoc) return;

    var moved = _lastRecomputeLat === null ||
      Math.abs(lat - _lastRecomputeLat) > 0.001 ||
      Math.abs(lng - _lastRecomputeLng) > 0.001;

    if (moved) {
      _lastRecomputeLat = lat; _lastRecomputeLng = lng;
      state.loc = {
        name: 'Current location ±' + Math.round(acc * 3.281) + ' ft',
        lat: lat, lng: lng,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT.tz
      };
      recompute();
      fetchNearestLake(lat, lng);
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

  // ---- manual location via city/state geocoding (Open-Meteo) ----
  function applyManualLocation(name, lat, lng, tz) {
    _manualLoc = true;
    state.knownSpecies = null;
    state.lakeInfo = null;
    state.nearbyWaters = [];
    _speciesReqKey = null;
    _lakeInfoKey = null;
    _gaugeReqLat = null; _gaugeReqLng = null;
    _lakeReqLat = null; _lakeReqLng = null;
    state.loc = { name: name, lat: lat, lng: lng, tz: tz || state.loc.tz };
    recompute();
    fetchNearestLake(lat, lng); // refreshes nearby-waters chips, lake info, species
  }

  var US_STATES = {
    'alabama':'AL','alaska':'AK','arizona':'AZ','arkansas':'AR','california':'CA','colorado':'CO',
    'connecticut':'CT','delaware':'DE','florida':'FL','georgia':'GA','hawaii':'HI','idaho':'ID',
    'illinois':'IL','indiana':'IN','iowa':'IA','kansas':'KS','kentucky':'KY','louisiana':'LA',
    'maine':'ME','maryland':'MD','massachusetts':'MA','michigan':'MI','minnesota':'MN',
    'mississippi':'MS','missouri':'MO','montana':'MT','nebraska':'NE','nevada':'NV',
    'new hampshire':'NH','new jersey':'NJ','new mexico':'NM','new york':'NY','north carolina':'NC',
    'north dakota':'ND','ohio':'OH','oklahoma':'OK','oregon':'OR','pennsylvania':'PA',
    'rhode island':'RI','south carolina':'SC','south dakota':'SD','tennessee':'TN','texas':'TX',
    'utah':'UT','vermont':'VT','virginia':'VA','washington':'WA','west virginia':'WV',
    'wisconsin':'WI','wyoming':'WY','district of columbia':'DC'
  };
  var US_ABBR = {};
  Object.keys(US_STATES).forEach(function(k) { US_ABBR[US_STATES[k]] = k; });

  // Parse "Superior, WI" / "superior wisconsin" / "Superior" into {city, stateName, abbr}
  function parseCityQuery(raw) {
    var q = raw.trim().replace(/\s+/g, ' ');
    var city = q, region = '';
    if (q.indexOf(',') !== -1) {
      var parts = q.split(',');
      city = parts[0].trim();
      region = parts.slice(1).join(',').trim();
    } else {
      // No comma — peel a trailing state name (1-2 words) or abbreviation off the end
      var lower = q.toLowerCase();
      var two = lower.split(' ').slice(-2).join(' ');
      var one = lower.split(' ').slice(-1)[0];
      if (q.split(' ').length > 2 && US_STATES[two]) {
        region = two; city = q.split(' ').slice(0, -2).join(' ');
      } else if (q.split(' ').length > 1 && US_STATES[one]) {
        region = one; city = q.split(' ').slice(0, -1).join(' ');
      } else if (q.split(' ').length > 1 && US_ABBR[one.toUpperCase()]) {
        region = one; city = q.split(' ').slice(0, -1).join(' ');
      }
    }
    var rl = region.toLowerCase();
    var stateName = US_STATES[rl] ? rl : (US_ABBR[region.toUpperCase()] || '');
    var abbr = US_STATES[rl] || (US_ABBR[region.toUpperCase()] ? region.toUpperCase() : '');
    return { city: city, stateName: stateName, abbr: abbr };
  }

  function geocodeCity(query) {
    var resEl = document.getElementById('city-results');
    if (!query || !query.trim()) return;
    if (typeof fetch === 'undefined') return;
    if (resEl) resEl.innerHTML = '<div class="city-loading">Searching…</div>';

    var parsed = parseCityQuery(query);
    // Query the API with the CITY name only — Open-Meteo matches place names, not "city, state"
    var url = 'https://geocoding-api.open-meteo.com/v1/search?count=20&language=en&format=json&name=' +
      encodeURIComponent(parsed.city);
    fetch(url).then(function(r) { return r.json(); }).then(function(j) {
      var results = (j && j.results) || [];

      // If a state was given, filter to matches on admin1 (full name) — keep US first
      if (parsed.stateName) {
        var filtered = results.filter(function(r) {
          return r.admin1 && r.admin1.toLowerCase() === parsed.stateName;
        });
        if (filtered.length) results = filtered;
      }
      // Rank US results ahead of foreign ones for ambiguous city names
      results.sort(function(a, b) {
        return (a.country_code === 'US' ? 0 : 1) - (b.country_code === 'US' ? 0 : 1);
      });
      results = results.slice(0, 6);

      if (!results.length) {
        if (resEl) resEl.innerHTML = '<div class="city-noresult">No match for "' + query.trim() + '"</div>';
        return;
      }
      if (!resEl) return;
      resEl.innerHTML = results.map(function(r, i) {
        var place = [r.name, r.admin1, r.country_code].filter(Boolean).join(', ');
        return '<div class="city-result" data-idx="' + i + '">📍 ' + place + '</div>';
      }).join('');
      resEl.querySelectorAll('.city-result').forEach(function(row) {
        row.onclick = function() {
          var r = results[+row.dataset.idx];
          var place = [r.name, r.admin1].filter(Boolean).join(', ');
          applyManualLocation(place, r.latitude, r.longitude, r.timezone);
          resEl.innerHTML = '';
          var inp = document.getElementById('city-input');
          if (inp) inp.value = '';
        };
      });
    }).catch(function() {
      if (resEl) resEl.innerHTML = '<div class="city-noresult">Search unavailable — check connection.</div>';
    });
  }

  function wireCitySearch() {
    var inp = document.getElementById('city-input');
    var btn = document.getElementById('city-go');
    if (btn) btn.onclick = function() { geocodeCity(inp ? inp.value : ''); };
    if (inp) inp.onkeydown = function(e) { if (e.key === 'Enter') { e.preventDefault(); geocodeCity(inp.value); } };
  }

  function useMyLocation() {
    if (!navigator.geolocation) { alert('Geolocation not available; using Yellow Lake.'); return; }
    _manualLoc = false;
    state.knownSpecies = null;
    state.lakeInfo = null;
    _speciesReqKey = null;
    _lakeInfoKey = null;
    _lastRecomputeLat = null; // force recompute on next GPS tick
    _lastRecomputeLng = null;
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
    wireCitySearch();
    recompute();
    renderClock();
    setInterval(function () { renderNext(); renderClock(); }, 1000);
    startGpsWatch();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
