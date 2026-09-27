// nav.js — geometry, route building (OSRM), turn cues, progress tracking.
// No DOM access here so it can be unit-tested / reused.
(function (global) {
  'use strict';

  const OSRM_BASE = 'https://routing.openstreetmap.de/routed-bike/route/v1/bike/';

  // ---------- geometry ----------
  const R = 6371008.8, D2R = Math.PI / 180;

  function decodePolyline(str, precision = 5) {
    let i = 0, lat = 0, lng = 0; const out = []; const f = Math.pow(10, precision);
    while (i < str.length) {
      let b, s = 0, r = 0;
      do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << s; s += 5; } while (b >= 32);
      lat += (r & 1) ? ~(r >> 1) : (r >> 1);
      s = 0; r = 0;
      do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << s; s += 5; } while (b >= 32);
      lng += (r & 1) ? ~(r >> 1) : (r >> 1);
      out.push([lat / f, lng / f]);
    }
    return out;
  }

  function haversine(a, b) {
    const dLat = (b[0] - a[0]) * D2R, dLon = (b[1] - a[1]) * D2R;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * D2R) * Math.cos(b[0] * D2R) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  function bearing(a, b) {
    const f1 = a[0] * D2R, f2 = b[0] * D2R, dl = (b[1] - a[1]) * D2R;
    const y = Math.sin(dl) * Math.cos(f2);
    const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
    return (Math.atan2(y, x) / D2R + 360) % 360;
  }

  function angleDiff(a, b) { // signed b - a in [-180,180], positive = clockwise (right)
    let d = ((b - a) % 360 + 540) % 360 - 180;
    return d;
  }

  // Polyline with local planar projection for fast nearest-point queries.
  class Line {
    constructor(coords) {
      this.c = coords;
      const lat0 = coords.reduce((s, p) => s + p[0], 0) / coords.length;
      this.kx = Math.cos(lat0 * D2R) * 111320; this.ky = 110574;
      this.xy = coords.map(p => [p[1] * this.kx, p[0] * this.ky]);
      this.cum = [0];
      for (let i = 1; i < coords.length; i++) this.cum.push(this.cum[i - 1] + haversine(coords[i - 1], coords[i]));
      this.length = this.cum[this.cum.length - 1];
    }
    // Nearest point on the line to p, optionally restricted to along-distance window [from,to].
    nearest(p, from = -Infinity, to = Infinity) {
      const px = p[1] * this.kx, py = p[0] * this.ky;
      let best = { d: Infinity, at: 0, i: 0 };
      for (let i = 0; i < this.xy.length - 1; i++) {
        if (this.cum[i + 1] < from || this.cum[i] > to) continue;
        const [x1, y1] = this.xy[i], [x2, y2] = this.xy[i + 1];
        const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
        let t = L2 ? ((px - x1) * dx + (py - y1) * dy) / L2 : 0;
        t = Math.max(0, Math.min(1, t));
        const qx = x1 + t * dx, qy = y1 + t * dy;
        const d = Math.hypot(px - qx, py - qy);
        if (d < best.d - 1e-9) best = { d, at: this.cum[i] + t * (this.cum[i + 1] - this.cum[i]), i, pt: [qy / this.ky, qx / this.kx] };
      }
      return best;
    }
    // All local minima candidates (for ambiguous first fix); returns sorted by 'at'.
    candidates(p, maxD) {
      const out = []; const step = 250;
      for (let from = 0; from < this.length; from += step) {
        const n = this.nearest(p, from, from + step);
        if (n.d <= maxD) out.push(n);
      }
      return out;
    }
    pointAt(at) {
      at = Math.max(0, Math.min(this.length, at));
      let lo = 0, hi = this.cum.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.cum[m] <= at) lo = m; else hi = m; }
      const seg = this.cum[hi] - this.cum[lo] || 1, t = (at - this.cum[lo]) / seg;
      const a = this.c[lo], b = this.c[hi];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    headingAt(at) {
      const a = this.pointAt(at - 5), b = this.pointAt(at + 5);
      return bearing(a, b);
    }
  }

  // ---------- OSRM ----------
  function osrmUrl(waypoints) {
    return OSRM_BASE + waypoints.map(p => `${p[1].toFixed(6)},${p[0].toFixed(6)}`).join(';') +
      '?overview=full&steps=true&geometries=polyline&continue_straight=true';
  }

  function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }

  // Strip OSRM response down to what we need (keeps localStorage small).
  function compactOsrm(j) {
    const r = j.routes[0];
    return {
      geometry: r.geometry, distance: r.distance, duration: r.duration,
      legs: r.legs.map(l => ({
        steps: l.steps.map(s => ({
          name: s.name || '', ref: s.ref || '', distance: s.distance, mode: s.mode,
          m: { loc: [s.maneuver.location[1], s.maneuver.location[0]], type: s.maneuver.type, mod: s.maneuver.modifier || '',
               bb: s.maneuver.bearing_before, ba: s.maneuver.bearing_after, exit: s.maneuver.exit || 0 }
        }))
      }))
    };
  }

  async function loadRouteGeometry(route, { fetchImpl = fetch, storage = global.localStorage, force = false } = {}) {
    if (route.baked) return { data: route.baked, source: 'baked' };
    const key = 'osrm:' + route.id + ':' + hashStr(JSON.stringify(route.waypoints));
    if (!force) {
      try { const c = storage && storage.getItem(key); if (c) return { data: JSON.parse(c), source: 'cache' }; } catch (e) {}
    }
    const res = await fetchImpl(osrmUrl(route.waypoints));
    if (!res.ok) throw new Error('routing server replied ' + res.status);
    const j = await res.json();
    if (j.code !== 'Ok' || !j.routes || !j.routes.length) throw new Error('No route found (' + j.code + ')');
    const data = compactOsrm(j);
    try { storage && storage.setItem(key, JSON.stringify(data)); } catch (e) {}
    return { data, source: 'network' };
  }

  // ---------- cues ----------
  function fmtDist(m) {
    if (m >= 950) { const km = Math.round(m / 100) / 10; return (km % 1 === 0 ? km.toFixed(0) : km.toFixed(1)) + (km === 1 ? ' kilometre' : ' kilometres'); }
    const r = m >= 300 ? Math.round(m / 100) * 100 : Math.max(50, Math.round(m / 50) * 50);
    return r + ' metres';
  }
  function ordinal(n) { return ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'][n] || n + 'th'; }

  function buildCues(data, line, overrides) {
    const legs = data.legs;
    const raw = [];
    legs.forEach((leg, li) => {
      leg.steps.forEach((s, si) => {
        const m = s.m;
        const first = li === 0 && si === 0, last = li === legs.length - 1 && si === leg.steps.length - 1;
        if (m.type === 'notification' || m.type === 'new name') return;
        if (m.type === 'arrive' && !last) {
          // intermediate waypoint: fold arrive+depart into one virtual maneuver
          const nextLeg = legs[li + 1]; const dep = nextLeg && nextLeg.steps[0];
          if (dep) raw.push({ loc: m.loc, type: 'turn', mod: '', name: dep.name, bb: m.bb, ba: dep.m.ba, exit: 0, mode: dep.mode, via: true });
          return;
        }
        if (m.type === 'depart' && !first) return;
        raw.push({ loc: m.loc, type: m.type, mod: m.mod, name: s.name, bb: m.bb, ba: m.ba, exit: m.exit, mode: s.mode });
      });
    });
    // along-route position, snapped sequentially so repeated places map to the right pass
    let prevAt = 0;
    raw.forEach(r => {
      let n = line.nearest(r.loc, prevAt - 5, prevAt + 3000);
      if (n.d >= 25) n = line.nearest(r.loc, prevAt - 5);
      if (n.d > 60) { r.bad = true; return; } // doesn't sit on the route; ignore rather than derail the rest
      r.at = n.at; prevAt = n.at;
    });
    for (let k = raw.length - 1; k >= 0; k--) if (raw[k].bad) raw.splice(k, 1);
    // cluster maneuvers that are very close together (sidewalk jogs, crossings)
    const clusters = [];
    for (const r of raw) {
      const c = clusters[clusters.length - 1];
      if (c && r.type !== 'arrive' && c.items[0].type !== 'depart' && r.at - c.items[c.items.length - 1].at < 30) c.items.push(r);
      else clusters.push({ items: [r] });
    }
    const cues = [];
    for (const c of clusters) {
      const f = c.items[0], l = c.items[c.items.length - 1];
      const name = [...c.items].reverse().map(x => x.name).find(Boolean) || '';
      if (f.type === 'depart') {
        cues.push({ at: 0, kind: 'depart', dir: 'straight', name, text: 'Head off' + (name ? ' along ' + name : ''), loc: f.loc });
        continue;
      }
      if (l.type === 'arrive') {
        cues.push({ at: l.at, kind: 'arrive', dir: 'arrive', name: '', text: 'You have arrived', loc: l.loc });
        continue;
      }
      const round = c.items.find(x => x.type === 'roundabout' || x.type === 'rotary');
      if (round && round.exit) {
        cues.push({ at: f.at, kind: 'roundabout', dir: 'roundabout', name, text: `At the roundabout, take the ${ordinal(round.exit)} exit` + (name ? ' onto ' + name : ''), loc: f.loc });
        continue;
      }
      // turn angle from the route geometry (robust against OSRM's momentary kerb/crossing bearings)
      let a = angleDiff(f.bb, l.ba);
      if (f.at > 22 && l.at < line.length - 22) {
        const hin = bearing(line.pointAt(f.at - 22), line.pointAt(f.at - 2));
        const hout = bearing(line.pointAt(l.at + 2), line.pointAt(l.at + 22));
        a = angleDiff(hin, hout);
      }
      const abs = Math.abs(a), side = a > 0 ? 'right' : 'left';
      let verb = null, dir = null;
      if (abs < 20) {
        if (c.items.length > 1 && (l.at - f.at) >= 12) {
          const fa = angleDiff(f.bb, f.ba);
          if (Math.abs(fa) >= 45) {
            const s1 = fa > 0 ? 'right' : 'left', s2 = s1 === 'right' ? 'left' : 'right';
            verb = `Quick ${s1}, then ${s2}`; dir = 'jog-' + s1;
          }
        } else if (f.type === 'fork' && /left|right/.test(f.mod)) {
          const s = /left/.test(f.mod) ? 'left' : 'right'; verb = 'Keep ' + s; dir = 'slight-' + s;
        }
        if (!verb) continue; // effectively straight on — stay quiet
      } else if (abs < 50) { verb = (f.type === 'fork' ? 'Keep ' : 'Bear ') + side; dir = 'slight-' + side; }
      else if (abs < 140) { verb = 'Turn ' + side; dir = side; }
      else if (abs < 168) { verb = 'Turn sharp ' + side; dir = 'sharp-' + side; }
      else { verb = 'Make a U-turn'; dir = 'uturn'; }
      if (f.type === 'end of road' && dir === side) verb = 'At the end of the road, turn ' + side;
      const walk = c.items.some(x => x.mode === 'pushing bike');
      cues.push({ at: f.at, kind: 'turn', dir, name, text: verb + (name ? ' onto ' + name : ''), walk, loc: f.loc });
    }
    // hand-written overrides from the route file: {lat, lon, radius?, text?, dir?, drop?}
    (overrides || []).forEach(o => {
      const rad = o.radius || 40;
      cues.forEach(q => {
        if (q.kind !== 'turn' && q.kind !== 'roundabout') return;
        if (haversine(q.loc, [o.lat, o.lon]) > rad) return;
        if (o.drop) q.drop = true; else { if (o.text) q.text = o.text; if (o.dir) q.dir = o.dir; q.override = true; }
      });
    });
    for (let k = cues.length - 1; k >= 0; k--) if (cues[k].drop) cues.splice(k, 1);
    // de-duplicate identical consecutive cues within 40 m
    const out = [];
    for (const q of cues) { const p = out[out.length - 1]; if (p && q.kind === 'turn' && p.kind === 'turn' && q.at - p.at < 40 && q.text === p.text) continue; out.push(q); }
    out.forEach((q, i) => q.i = i);
    return out;
  }

  // Snap POIs in listed order so a place passed twice uses the right pass.
  function placePois(pois, line) {
    let prev = 0;
    return pois.map(p => {
      const q = p.trigger || [p.lat, p.lon]; // optional explicit trigger point on the route
      let n = line.nearest(q, prev - 20, prev + 4000);
      if (n.d > 400) n = line.nearest(q, prev - 20);
      prev = n.at;
      return Object.assign({}, p, { at: n.at, offRouteM: Math.round(n.d) });
    });
  }

  // ---------- progress tracker ----------
  class Tracker {
    constructor(line, opts = {}) {
      this.line = line; this.at = null; this.offCount = 0;
      this.onRouteM = opts.onRouteM || 45; this.offRouteM = opts.offRouteM || 60;
      this.last = null; this.heading = null; this.speed = 0;
    }
    update(p, ts, gpsHeading, gpsSpeed) {
      const L = this.line; let n;
      if (this.at == null) {
        const cands = L.candidates(p, 60);
        if (cands.length) { const best = Math.min(...cands.map(c => c.d)); n = cands.find(c => c.d <= best + 30); }
        else n = L.nearest(p);
      } else {
        n = L.nearest(p, this.at - 120, this.at + 500);
        if (n.d > this.onRouteM) { // maybe we jumped (e.g. short-cut); look everywhere ahead
          const g = L.nearest(p, this.at - 120);
          if (g.d < this.onRouteM && g.d < n.d - 30) n = g;
        }
      }
      // motion
      if (this.last) {
        const dt = (ts - this.last.ts) / 1000, dd = haversine(this.last.p, p);
        if (dt > 0) this.speed = gpsSpeed != null && !isNaN(gpsSpeed) ? gpsSpeed : dd / dt;
        if (dd > 4) this.heading = bearing(this.last.p, p);
      }
      if (gpsHeading != null && !isNaN(gpsHeading) && this.speed > 1.5) this.heading = gpsHeading;
      if (!this.last || haversine(this.last.p, p) > 4) this.last = { p, ts };
      const onRoute = n.d <= this.offRouteM;
      if (onRoute) {
        this.offCount = 0;
        // progress may only move backwards a little (GPS jitter), never jump back far
        this.at = this.at == null ? n.at : Math.max(this.at, n.at);
      } else this.offCount++;
      return { at: this.at, dist: n.d, nearest: n, off: this.offCount >= 2, heading: this.heading, speed: this.speed };
    }
  }

  function relDirection(heading, brg) {
    if (heading == null) {
      const names = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
      return 'to the ' + names[Math.round(brg / 45) % 8];
    }
    const a = angleDiff(heading, brg);
    if (Math.abs(a) < 30) return 'ahead of you';
    if (Math.abs(a) > 150) return 'behind you';
    return 'to your ' + (a > 0 ? 'right' : 'left');
  }

  global.BTNav = { decodePolyline, haversine, bearing, angleDiff, Line, osrmUrl, loadRouteGeometry, compactOsrm, buildCues, placePois, Tracker, fmtDist, relDirection, hashStr };
})(typeof window !== 'undefined' ? window : globalThis);
