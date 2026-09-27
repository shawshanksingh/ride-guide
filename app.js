// app.js — UI, speech, GPS, ride logic.
(function () {
  'use strict';
  const N = window.BTNav;
  const $ = s => document.querySelector(s);

  // ---------- settings ----------
  const DEFAULTS = { voice: '', rate: 1, music: 0.5, facts: true, chime: true, simSpeed: 6 };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  const settings = Object.assign({}, DEFAULTS, store.get('bt:settings', {}));
  const saveSettings = () => store.set('bt:settings', settings);

  function toast(msg, ms = 3000) {
    const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms);
  }
  function fetchTimeout(url, ms, opts = {}) {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
    return fetch(url, Object.assign({ cache: 'no-cache', signal: ac.signal }, opts))
      .catch(e => { throw new Error(e.name === 'AbortError' ? 'timed out — no response from ' + new URL(url, location.href).host : e.message); })
      .finally(() => clearTimeout(t));
  }
  window.addEventListener('error', e => toast('Error: ' + (e.message || e.error), 8000));
  window.addEventListener('unhandledrejection', e => toast('Error: ' + ((e.reason && e.reason.message) || e.reason), 8000));
  function show(id) { document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id)); }

  // ---------- speech ----------
  class Speaker {
    constructor() {
      this.synth = window.speechSynthesis; this.queue = []; this.current = null; this.voice = null;
      this.onIdle = () => {}; this.onBusy = () => {}; this.lastNav = '';
      if (this.synth) {
        this._loadVoices(); this.synth.onvoiceschanged = () => this._loadVoices();
      }
    }
    _loadVoices() {
      this.voices = (this.synth.getVoices() || []).filter(v => /^en/i.test(v.lang));
      this.pickVoice(settings.voice);
      const sel = $('#sVoice'); if (!sel) return;
      sel.innerHTML = '';
      if (!this.voices.length) { sel.innerHTML = '<option value="">System default</option>'; return; }
      this.voices.forEach(v => { const o = document.createElement('option'); o.value = v.name; o.textContent = `${v.name} (${v.lang})`; sel.appendChild(o); });
      if (this.voice) sel.value = this.voice.name;
    }
    pickVoice(name) {
      const vs = this.voices || [];
      this.voice = vs.find(v => v.name === name) || vs.find(v => /en-GB/i.test(v.lang) && /google/i.test(v.name)) ||
        vs.find(v => /en-GB/i.test(v.lang)) || vs.find(v => /en-US/i.test(v.lang)) || vs[0] || null;
    }
    busy() { return !!this.current || this.queue.length > 0; }
    // item: {text, kind:'nav'|'fact'|'info', id}
    say(item) {
      const sentences = item.kind === 'nav' ? [item.text] : splitSentences(item.text);
      const job = Object.assign({}, item, { sentences, idx: 0 });
      if (item.kind === 'nav') {
        this.lastNav = item.text;
        // navigation interrupts; an interrupted story resumes from its current sentence
        const navJobs = this.queue.filter(j => j.kind === 'nav');
        const others = this.queue.filter(j => j.kind !== 'nav');
        if (this.current && this.current.kind !== 'nav') { const c = this.current; this.current = null; this._cancel(); others.unshift(c); }
        this.queue = [...navJobs, job, ...others];
      } else this.queue.push(job);
      this._next();
    }
    skipStory() {
      this.queue = this.queue.filter(j => j.kind === 'nav');
      if (this.current && this.current.kind !== 'nav') { this.current = null; this._cancel(); this._next(); }
    }
    clear() { this.queue = []; this.current = null; this._cancel(); this.onIdle(); }
    _cancel() { clearTimeout(this._guard); if (this.synth) { this._cancelling = true; this.synth.cancel(); setTimeout(() => this._cancelling = false, 50); } }
    _next() {
      if (this.current) return;
      const job = this.queue.shift();
      if (!job) { this.onIdle(); return; }
      this.current = job; this.onBusy(job);
      this._speakSentence(job);
    }
    _speakSentence(job) {
      if (this.current !== job) return;
      if (job.idx >= job.sentences.length) { this.current = null; job.done && job.done(); this._next(); return; }
      const text = job.sentences[job.idx];
      const finish = () => { if (this.current !== job || job.idx !== myIdx) return; clearTimeout(this._guard); job.idx++; this._speakSentence(job); };
      const myIdx = job.idx;
      if (!this.synth) { this._guard = setTimeout(finish, 400 + text.length * 55); return; }
      const u = new SpeechSynthesisUtterance(text);
      if (this.voice) { u.voice = this.voice; u.lang = this.voice.lang; } else u.lang = 'en-GB';
      u.rate = settings.rate; u.pitch = 1; u.volume = 1;
      u.onend = finish; u.onerror = (e) => { if (e.error === 'interrupted' || e.error === 'canceled') return; if (e.error) toast('Speech error: ' + e.error + (e.error === 'not-allowed' ? ' — tap Test voice once to unlock audio' : ''), 5000); finish(); };
      // guard against Chrome occasionally never firing onend
      this._guard = setTimeout(finish, 2500 + text.split(/\s+/).length * 600 / settings.rate);
      this.synth.speak(u);
    }
  }
  // Split into sentences for smoother speech (and so navigation can interrupt between them).
  // Doesn't split after numbers like "17. Juni" or abbreviations like "Str.".
  function splitSentences(t) {
    const out = []; let cur = '';
    const parts = t.split(/(?<=[.!?]["')\]]?)\s+/);
    for (const p of parts) {
      cur = cur ? cur + ' ' + p : p;
      if (/(\b\d{1,2}|\bSt|\bStr|\bDr|\bNr|\bca)\.$/.test(cur)) continue;
      out.push(cur.trim()); cur = '';
    }
    if (cur.trim()) out.push(cur.trim());
    return out.filter(Boolean);
  }

  const speaker = new Speaker();
  const music = new window.BTAmbient({ key: 'D', mood: 'calm', volume: settings.music });
  speaker.onBusy = () => music.setDucked(true);
  speaker.onIdle = () => music.setDucked(false);

  // ---------- routes ----------
  let routesIndex = [];
  let R = null; // current prepared route {meta, line, cues, pois, data}

  async function loadIndex() {
    const list = $('#routeList');
    try {
      const res = await fetch('index.json', { cache: 'no-cache' });
      routesIndex = (await res.json()).routes;
      list.innerHTML = '';
      routesIndex.forEach(r => {
        const b = document.createElement('button'); b.className = 'card';
        b.innerHTML = `<h3></h3><p class="muted"></p><div class="meta"><span></span><span></span></div>`;
        b.querySelector('h3').textContent = r.name;
        b.querySelector('p').textContent = r.summary || '';
        const m = b.querySelectorAll('.meta span'); m[0].textContent = r.city || ''; m[1].textContent = r.distanceKmApprox ? `≈ ${r.distanceKmApprox} km` : '';
        b.onclick = () => openRoute(r.file);
        list.appendChild(b);
      });
      const want = new URLSearchParams(location.search).get('route');
      if (want) { const r = routesIndex.find(x => x.id === want); if (r) openRoute(r.file); }
    } catch (e) { list.innerHTML = '<p class="status err">Could not load the route list.</p>'; }
  }

  let detailMap = null, detailLayers = null;
  async function openRoute(file, force = false) {
    show('detail');
    $('#btnStart').disabled = true; $('#btnSim').disabled = true;
    const st = $('#dStatus'); st.className = 'status muted'; st.textContent = 'Loading route…';
    let meta;
    try { const r = await fetchTimeout(file, 15000); if (!r.ok) throw new Error('HTTP ' + r.status); meta = await r.json(); }
    catch (e) { st.className = 'status err'; st.textContent = 'Could not load route file (' + e.message + ').'; return; }
    meta.file = file;
    $('#dTitle').textContent = meta.name; $('#dCity').textContent = meta.city || ''; $('#dDesc').textContent = meta.description || '';
    if (meta.music) { music.key = ({ C: 48, D: 50, E: 52, F: 53, G: 55, A: 57 })[meta.music.key] || music.key; }
    try { initDetailMap(); } catch (e) { toast('Map could not load (' + e.message + ') — directions and audio still work.', 6000); }
    st.textContent = 'Calculating bike route…';
    try {
      const { data, source } = await N.loadRouteGeometry(meta, { force, fetchImpl: (u) => fetchTimeout(u, 25000) });
      R = prepare(meta, data);
      st.textContent = source === 'network' ? 'Route downloaded and saved on this phone ✓' : 'Route ready (saved on this phone) ✓';
      $('#btnStart').disabled = false; $('#btnSim').disabled = false;
    } catch (e) {
      st.className = 'status err'; st.textContent = 'Could not calculate the route: ' + e.message + '. Check your connection and try again.';
      return;
    }
    $('#dKm').textContent = (R.line.length / 1000).toFixed(1);
    const mins = Math.round(R.line.length / 1000 / 15 * 60);
    $('#dTime').textContent = mins >= 60 ? `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}` : mins + 'm';
    $('#dStops').textContent = R.pois.length; $('#dTurns').textContent = R.cues.filter(c => c.kind === 'turn' || c.kind === 'roundabout').length;
    const ol = $('#dPois'); ol.innerHTML = '';
    R.pois.forEach(p => { const li = document.createElement('li'); li.innerHTML = '<span></span><small></small>'; li.firstChild.textContent = p.name; li.lastChild.textContent = `at ${(p.at / 1000).toFixed(1)} km`; ol.appendChild(li); });
    if (detailMap) try { drawRoute(detailMap, detailLayers, R); } catch (e) {}
    const saved = store.get('bt:ride:' + meta.id, null);
    $('#resumeBox').classList.toggle('hidden', !(saved && Date.now() - saved.ts < 12 * 3600e3 && saved.fired && saved.fired.length));
  }

  function prepare(meta, data) {
    const coords = N.decodePolyline(data.geometry);
    const line = new N.Line(coords);
    const cues = N.buildCues(data, line, meta.cueOverrides);
    const pois = N.placePois(meta.pois || [], line);
    return { meta, data, line, cues, pois };
  }

  function tileLayer() {
    return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' });
  }
  function initDetailMap() {
    if (detailMap) return;
    detailMap = L.map('dMap', { zoomControl: false, attributionControl: true });
    tileLayer().addTo(detailMap); detailLayers = L.layerGroup().addTo(detailMap);
    detailMap.setView([52.52, 13.38], 12);
  }
  function poiIcon(n, done) { return L.divIcon({ className: '', html: `<div class="poi-num${done ? ' done' : ''}">${n}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }); }
  function drawRoute(map, group, R, opts = {}) {
    group.clearLayers();
    const pl = L.polyline(R.line.c, { color: '#7fd6a4', weight: 5, opacity: .95 }).addTo(group);
    const markers = R.pois.map((p, i) => L.marker([p.lat, p.lon], { icon: poiIcon(i + 1), keyboard: false }).bindTooltip(p.name).addTo(group));
    L.circleMarker(R.line.c[0], { radius: 7, color: '#fff', weight: 2, fillColor: '#4fa3ff', fillOpacity: 1 }).addTo(group).bindTooltip('Start');
    if (!opts.noFit) setTimeout(() => { map.invalidateSize(); map.fitBounds(pl.getBounds(), { padding: [20, 20] }); }, 50);
    return { pl, markers };
  }

  // ---------- ride ----------
  const PREP_M = 190;
  let ride = null;

  function arrowSvg(dir) {
    const rot = { straight: 0, depart: 0, 'slight-right': 40, right: 90, 'sharp-right': 135, 'slight-left': -40, left: -90, 'sharp-left': -135, 'jog-right': 30, 'jog-left': -30 }[dir];
    if (dir === 'arrive') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/></svg>';
    if (dir === 'uturn') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21V9a5 5 0 0 1 10 0v4"/><path d="M14 10l4 4 4-4" transform="translate(-4 0)"/></svg>';
    if (dir === 'roundabout') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="11" r="4"/><path d="M12 21v-6M12 7V3M9 5l3-3 3 3"/></svg>';
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><g transform="rotate(${rot || 0} 12 14)"><path d="M12 22V6"/><path d="M6 11l6-6 6 6"/></g></svg>`;
  }

  function startRide({ simulate = false, resume = false } = {}) {
    if (!R) return;
    const id = R.meta.id;
    const saved = resume ? store.get('bt:ride:' + id, null) : null;
    if (!resume) store.del('bt:ride:' + id);
    ride = {
      simulate, tracker: new N.Tracker(R.line), fired: new Set(saved ? saved.fired : []),
      cueState: R.cues.map(() => ({ prep: false, now: false, cont: false })), cueIdx: 0,
      lastFixTs: 0, offSince: 0, needFirst: !resume, lastOffMsg: 0, wasOff: false, introDone: false, arrived: false, follow: true,
      watchId: null, simTimer: null, simAt: 0, lastState: null, wakeLock: null
    };
    show('ride');
    try { initRideMap(); } catch (e) { rideMap = null; }
    music.setVolume(settings.music);
    music.start().catch(() => {});
    $('#btnMusic').textContent = 'Music ✓';
    requestWakeLock();
    // intro, then navigation
    const introText = resume ? 'Resuming your ride. ' + (R.meta.name || '') + '.' : (R.meta.intro || ('Starting ' + R.meta.name + '.'));
    speaker.say({ kind: 'info', text: introText, done: () => { ride && (ride.introDone = true); } });
    if (simulate) startSim(); else startGps();
  }

  function startGps() {
    if (!('geolocation' in navigator)) { warn('This browser has no GPS access.'); return; }
    ride.watchId = navigator.geolocation.watchPosition(pos => {
      onFix([pos.coords.latitude, pos.coords.longitude], pos.timestamp || Date.now(), pos.coords.heading, pos.coords.speed, pos.coords.accuracy);
    }, err => {
      warn(err.code === 1 ? 'Location permission denied — allow location for this site in Chrome settings.' : 'Waiting for GPS signal…');
    }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
  }

  function startSim() {
    const v = 4.4; // m/s ≈ 16 km/h
    let last = performance.now();
    ride.simAt = 0;
    ride.simTimer = setInterval(() => {
      const now = performance.now(); const dt = (now - last) / 1000; last = now;
      const k = Number(settings.simSpeed) || 1;
      ride.simAt = Math.min(R.line.length, ride.simAt + v * dt * k);
      const p = R.line.pointAt(ride.simAt);
      const j = [p[0] + (Math.random() - .5) * 0.00006, p[1] + (Math.random() - .5) * 0.00009];
      onFix(j, Date.now(), R.line.headingAt(ride.simAt), v * k, 5);
      if (ride.simAt >= R.line.length) { clearInterval(ride.simTimer); ride.simTimer = null; }
    }, 1000);
    toast('Preview: simulating the ride at ' + settings.simSpeed + '× speed');
  }

  function warn(msg) { const w = $('#rWarn'); if (!msg) { w.classList.add('hidden'); return; } w.textContent = msg; w.classList.remove('hidden'); }

  function onFix(p, ts, heading, speed, acc) {
    if (!ride || ride.arrived) return;
    if (acc && acc > 60) { warn('Weak GPS signal (±' + Math.round(acc) + ' m)…'); return; }
    warn(null);
    const st = ride.tracker.update(p, ts, heading, speed);
    ride.lastState = st; ride.lastFixTs = Date.now();
    updateMe(p);
    const at = st.at == null ? 0 : st.at;

    // off route
    if (st.off) {
      const brg = N.bearing(p, st.nearest.pt || R.line.pointAt(st.nearest.at));
      const dirTxt = N.relDirection(st.heading, brg);
      const d = Math.round(st.dist / 10) * 10;
      setCue('uturn', d + ' m', 'Off route — the route is ' + dirTxt);
      if (Date.now() - ride.lastOffMsg > 30000) {
        ride.lastOffMsg = Date.now();
        speaker.say({ kind: 'nav', text: `You're off the route. It's about ${d} metres ${dirTxt}.` });
      }
      ride.wasOff = true; return;
    }
    if (ride.wasOff) { ride.wasOff = false; ride.lastOffMsg = 0; speaker.say({ kind: 'nav', text: 'Back on route.' }); }

    // cues
    const cues = R.cues, cs = ride.cueState;
    while (ride.cueIdx < cues.length - 1 && at > cues[ride.cueIdx].at + 12) {
      const c = cs[ride.cueIdx];
      // after passing a turn, if the next one is far, say how far
      const nxt = cues[ride.cueIdx + 1];
      if (c.now && !c.cont && nxt && nxt.at - at > 900 && ride.introDone) {
        c.cont = true; speaker.say({ kind: 'nav', text: 'Continue for ' + N.fmtDist(nxt.at - at) + '.' });
      }
      ride.cueIdx++;
    }
    let cue = cues[ride.cueIdx];
    if (cue && cue.kind === 'depart') { cs[ride.cueIdx].now = true; ride.cueIdx = Math.min(ride.cueIdx + 1, cues.length - 1); cue = cues[ride.cueIdx]; }
    if (cue) {
      const s = cs[ride.cueIdx]; const dist = cue.at - at;
      const nowM = Math.max(28, Math.min(60, (st.speed || 4) * 5));
      setCue(cue.dir, dist > 0 ? N.fmtDist(dist).replace(' metres', ' m').replace(' kilometres', ' km').replace(' kilometre', ' km') : 'now', cue.text + (cue.walk ? ' (walk the bike)' : ''));
      if (cue.kind === 'arrive') {
        if (dist <= 35) return finishRide();
        if (!s.prep && dist <= PREP_M && ride.introDone) { s.prep = true; speaker.say({ kind: 'nav', text: 'In ' + N.fmtDist(dist) + ', you will arrive.' }); }
      } else {
        if (ride.needFirst && ride.introDone) {
          ride.needFirst = false;
          if (!s.prep && !s.now && dist > nowM + 10) { s.prep = true; speaker.say({ kind: 'nav', text: 'In ' + N.fmtDist(dist) + ', ' + lc(cue.text) + '.' }); }
        }
        if (!s.prep && !s.now && dist <= PREP_M && dist > nowM + 60 && ride.introDone) {
          s.prep = true; alertTurn(cue.dir);
          speaker.say({ kind: 'nav', text: 'In ' + N.fmtDist(dist) + ', ' + lc(cue.text) + '.' });
        }
        if (!s.now && dist <= nowM) {
          s.now = true; s.prep = true; alertTurn(cue.dir, true);
          let text = cue.text;
          const nxt = cues[ride.cueIdx + 1];
          if (nxt && nxt.kind !== 'arrive' && nxt.at - cue.at < 140) { text += ', then ' + lc(nxt.text); cs[ride.cueIdx + 1].prep = true; }
          speaker.say({ kind: 'nav', text: text + '.' });
        }
      }
    }

    // stories
    if (settings.facts) {
      const turnSoon = cue && cue.kind !== 'arrive' && !cs[ride.cueIdx].now && (cue.at - at) < 130;
      for (let i = 0; i < R.pois.length; i++) {
        const poi = R.pois[i];
        if (ride.fired.has(poi.id)) continue;
        if (at >= poi.at - 30) {
          if (at > poi.at + 1500) { ride.fired.add(poi.id); continue; } // long gone (e.g. resumed further on)
          if (turnSoon || !ride.introDone) break; // wait until the turn is done
          ride.fired.add(poi.id); markPoiDone(i);
          speaker.say({ kind: 'fact', id: poi.id, text: poi.text });
        } else break;
      }
    }
    // UI bits
    const nextPoi = R.pois.find(p => !ride.fired.has(p.id));
    $('#rNextPoi').textContent = nextPoi ? `Next story: ${nextPoi.name} · ${N.fmtDist(Math.max(0, nextPoi.at - at)).replace(' metres', ' m').replace(/ kilometres?/, ' km')}` : 'No more stories';
    $('#rRemain').textContent = ((R.line.length - at) / 1000).toFixed(1) + ' km to go';
    $('#pSub').textContent = $('#rRemain').textContent;
    if (Math.random() < 0.2) saveProgress();
  }

  function lc(s) { return s.charAt(0).toLowerCase() + s.slice(1); }
  function setCue(dir, dist, text) {
    $('#cueIcon').innerHTML = arrowSvg(dir); $('#cueDist').textContent = dist; $('#cueMain').textContent = text;
    $('#pCue').textContent = dist + ' · ' + text;
  }
  function alertTurn(dir, strong) {
    if (!settings.chime) return;
    const side = /left/.test(dir) ? 'left' : /right/.test(dir) ? 'right' : 'other';
    try { music.chime(side); } catch (e) {}
    if (navigator.vibrate) navigator.vibrate(side === 'left' ? [150, 120, 150] : side === 'right' ? [400] : [100, 80, 100, 80, 100]);
  }
  function saveProgress() { if (ride && R) store.set('bt:ride:' + R.meta.id, { fired: [...ride.fired], ts: Date.now() }); }

  function finishRide() {
    if (!ride || ride.arrived) return;
    ride.arrived = true; setCue('arrive', 'Done', 'You have arrived');
    speaker.say({ kind: 'info', text: R.meta.outro || 'You have arrived. Nice ride!' });
    store.del('bt:ride:' + R.meta.id);
    stopTracking();
  }
  function stopTracking() {
    if (!ride) return;
    if (ride.watchId != null) navigator.geolocation.clearWatch(ride.watchId);
    if (ride.simTimer) clearInterval(ride.simTimer);
    ride.watchId = null; ride.simTimer = null;
  }
  function endRide() {
    if (ride && !ride.arrived) saveProgress();
    stopTracking(); speaker.clear(); music.stop(); releaseWakeLock(); setPocket(false);
    ride = null; show('detail');
    if (R) { const saved = store.get('bt:ride:' + R.meta.id, null); $('#resumeBox').classList.toggle('hidden', !(saved && saved.fired && saved.fired.length)); }
  }

  // ride map
  let rideMap = null, rideGroup = null, meMarker = null, rideDrawn = null;
  function initRideMap() {
    if (!rideMap) {
      rideMap = L.map('rMap', { zoomControl: false });
      tileLayer().addTo(rideMap); rideGroup = L.layerGroup().addTo(rideMap);
      rideMap.on('dragstart', () => { if (ride) { ride.follow = false; $('#btnRecenter').classList.remove('hidden'); } });
    }
    rideDrawn = drawRoute(rideMap, rideGroup, R, { noFit: true });
    R.pois.forEach((p, i) => { if (ride.fired.has(p.id)) markPoiDone(i); });
    meMarker = null;
    setTimeout(() => { rideMap.invalidateSize(); rideMap.setView(R.line.c[0], 16); }, 60);
  }
  function markPoiDone(i) { if (rideDrawn && rideDrawn.markers[i]) rideDrawn.markers[i].setIcon(poiIcon(i + 1, true)); }
  function updateMe(p) {
    if (!rideMap) return;
    if (!meMarker) meMarker = L.marker(p, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [20, 20], iconAnchor: [10, 10] }), interactive: false, zIndexOffset: 1000 }).addTo(rideMap);
    else meMarker.setLatLng(p);
    if (ride && ride.follow && !pocketOn) rideMap.panTo(p, { animate: true, duration: 0.5 });
  }

  // ---------- wake lock & pocket mode ----------
  async function requestWakeLock() {
    try { if ('wakeLock' in navigator && ride) { ride.wakeLock = await navigator.wakeLock.request('screen'); } }
    catch (e) { toast('Could not keep the screen awake: ' + e.message); }
  }
  function releaseWakeLock() { try { ride && ride.wakeLock && ride.wakeLock.release(); } catch (e) {} }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ride) {
      requestWakeLock(); music.resume();
      if (ride.lastFixTs && Date.now() - ride.lastFixTs > 15000) toast('The screen was off, so GPS was paused. Use Pocket mode instead of the power button.', 6000);
    }
  });

  let pocketOn = false;
  function setPocket(on) {
    pocketOn = on; $('#pocket').classList.toggle('hidden', !on);
    try {
      if (on && document.documentElement.requestFullscreen && !document.fullscreenElement) document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
      if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    } catch (e) {}
  }
  (function holdToUnlock() {
    const el = $('#pHold'), fill = el.querySelector('.p-hold-fill'); let t0 = 0, raf = 0;
    const tick = () => { const k = Math.min(1, (performance.now() - t0) / 2000); fill.style.width = (k * 100) + '%'; if (k >= 1) { reset(); setPocket(false); } else raf = requestAnimationFrame(tick); };
    const reset = () => { cancelAnimationFrame(raf); fill.style.width = '0'; t0 = 0; };
    el.addEventListener('pointerdown', e => { e.preventDefault(); t0 = performance.now(); raf = requestAnimationFrame(tick); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => el.addEventListener(ev, reset));
    $('#pocket').addEventListener('contextmenu', e => e.preventDefault());
  })();

  // ---------- wire up ----------
  function initSettingsUI() {
    $('#sRate').value = settings.rate; $('#sMusic').value = settings.music; $('#sFacts').checked = settings.facts; $('#sChime').checked = settings.chime; $('#sSimSpeed').value = String(settings.simSpeed);
    $('#sVoice').onchange = e => { settings.voice = e.target.value; speaker.pickVoice(settings.voice); saveSettings(); };
    $('#sRate').oninput = e => { settings.rate = +e.target.value; saveSettings(); };
    $('#sMusic').oninput = e => { settings.music = +e.target.value; music.setVolume(settings.music); saveSettings(); };
    $('#sFacts').onchange = e => { settings.facts = e.target.checked; saveSettings(); };
    $('#sChime').onchange = e => { settings.chime = e.target.checked; saveSettings(); };
    $('#sSimSpeed').onchange = e => { settings.simSpeed = +e.target.value; saveSettings(); };
    $('#btnTestVoice').onclick = () => {
      // speak straight away inside the tap — Chrome only allows speech that starts from a user gesture
      if (!window.speechSynthesis) toast('This browser has no text-to-speech. Use Chrome.', 6000);
      else {
        const n = (speechSynthesis.getVoices() || []).length;
        speaker.say({ kind: 'nav', text: 'Voice check. In 200 metres, turn left onto Kastanienallee.' });
        toast(n ? `Speaking… (${n} voices on this phone)` : 'Speaking… If you hear nothing: phone media volume up, and check Android Settings → Text-to-speech output.', 6000);
      }
      try { music.start().catch(e => toast('Music could not start: ' + e.message)); } catch (e) { toast('Music could not start: ' + e.message); }
      alertTurn('left'); setTimeout(() => music.stop(), 10000);
    };
    $('#btnRefresh').onclick = () => { if (R) openRoute(R.meta.file, true); };
  }
  document.querySelectorAll('[data-back]').forEach(b => b.onclick = () => show('home'));
  $('#btnStart').onclick = () => startRide({ simulate: false, resume: false });
  $('#btnSim').onclick = () => startRide({ simulate: true, resume: false });
  $('#btnResume').onclick = () => startRide({ simulate: false, resume: true });
  $('#btnFresh').onclick = () => { if (R) store.del('bt:ride:' + R.meta.id); $('#resumeBox').classList.add('hidden'); };
  $('#btnPocket').onclick = () => setPocket(true);
  $('#btnRepeat').onclick = () => { if (speaker.lastNav) speaker.say({ kind: 'nav', text: speaker.lastNav }); else toast('Nothing to repeat yet'); };
  $('#btnSkip').onclick = () => speaker.skipStory();
  $('#btnMusic').onclick = () => { if (music.running) { music.stop(); $('#btnMusic').textContent = 'Music ✕'; } else { music.start(); $('#btnMusic').textContent = 'Music ✓'; } };
  $('#btnStop').onclick = () => { if (!ride || ride.arrived || ride.simulate) return endRide(); const b = $('#btnStop'); if (b.dataset.armed) { delete b.dataset.armed; b.textContent = 'End'; endRide(); } else { b.dataset.armed = '1'; b.textContent = 'Tap again'; setTimeout(() => { delete b.dataset.armed; b.textContent = 'End'; }, 3000); } };
  $('#btnRecenter').onclick = () => { if (ride) { ride.follow = true; $('#btnRecenter').classList.add('hidden'); if (meMarker) rideMap.setView(meMarker.getLatLng(), 16); } };

  initSettingsUI();
  loadIndex();
  (function diagnostics() {
    const bad = [];
    if (!window.isSecureContext) bad.push('page is not HTTPS, so GPS will be blocked');
    if (typeof L === 'undefined') bad.push('map library (leaflet.js) did not load');
    if (!window.speechSynthesis) bad.push('no text-to-speech in this browser');
    if (bad.length) { const p = document.createElement('p'); p.className = 'status err'; p.textContent = 'Problem: ' + bad.join('; ') + '.'; $('#routeList').before(p); }
  })();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

  // test hooks
  window.__bt = { get R() { return R; }, get ride() { return ride; }, speaker, music, onFix, startRide, settings };
})();
