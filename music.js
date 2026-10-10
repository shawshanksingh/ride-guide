// music.js — generative music with Web Audio (no audio files, no copyright).
// Two styles: 'ambient' (soft detuned pads + sparse pentatonic bells) and
// 'tribal' (rolling tribal techno: four-on-the-floor kick, tuned toms, shakers, offbeat bass).
// window.BTMusic wraps both behind one interface so the style can be switched live.
(function (global) {
  'use strict';

  const KEYS = { C: 48, D: 50, E: 52, F: 53, G: 55, A: 57 }; // MIDI root (C3 = 48)
  // Chord progressions as scale-degree voicings (semitones from root).
  const PROGRESSIONS = {
    calm:   [[0, 7, 11, 16], [-3, 4, 7, 12], [-7, 0, 4, 9], [-5, 2, 7, 14]],   // Imaj7 – vi – IVmaj7(add9) – V(sus)
    dreamy: [[0, 7, 14, 16], [-7, 0, 7, 11], [-3, 7, 12, 14], [-5, 2, 9, 14]],
    warm:   [[0, 4, 7, 14], [-5, 2, 7, 11], [-3, 4, 9, 12], [-7, 0, 5, 9]]
  };
  const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
  const newContext = () => { const AC = global.AudioContext || global.webkitAudioContext; return new AC({ latencyHint: 'playback' }); };

  // A short two-note chime to get attention before a turn instruction (falls for left, rises for right).
  function chimeOn(ctx, dir) {
    const t = ctx.currentTime + 0.02;
    const notes = dir === 'left' ? [79, 74] : dir === 'right' ? [74, 79] : [76, 76];
    notes.forEach((n, k) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = mtof(n);
      g.gain.setValueAtTime(0, t + k * 0.18); g.gain.linearRampToValueAtTime(0.22, t + k * 0.18 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + k * 0.18 + 0.7);
      o.connect(g).connect(ctx.destination); o.start(t + k * 0.18); o.stop(t + k * 0.18 + 0.8);
    });
  }

  function impulse(ctx, seconds, decay) {
    const rate = ctx.sampleRate, len = Math.floor(rate * seconds), buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay); }
    return buf;
  }

  class Ambient {
    constructor(opts = {}) {
      this.key = opts.keyMidi || KEYS[opts.key] || KEYS.D;
      this.prog = PROGRESSIONS[opts.mood] || PROGRESSIONS.calm;
      this.chordSeconds = opts.chordSeconds || 11;
      this.volume = opts.volume != null ? opts.volume : 0.55;
      this.duckLevel = 0.28;
      this.ctx = opts.ctx || null; this.running = false; this.ducked = false; this.idx = 0; this.timers = [];
    }

    _impulse(seconds = 4.5, decay = 2.6) {
      const ctx = this.ctx, rate = ctx.sampleRate, len = Math.floor(rate * seconds);
      const buf = ctx.createBuffer(2, len, rate);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
      return buf;
    }

    ensureContext() {
      if (this.master) return this.ctx;
      const ctx = this.ctx || (this.ctx = newContext());
      this.master = ctx.createGain(); this.master.gain.value = 0;
      this.duck = ctx.createGain(); this.duck.gain.value = 1;
      const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -20; comp.ratio.value = 3;
      const makeup = ctx.createGain(); makeup.gain.value = 1.7;
      this.master.connect(this.duck).connect(makeup).connect(comp).connect(ctx.destination);
      this.reverb = ctx.createConvolver(); this.reverb.buffer = this._impulse();
      const wet = ctx.createGain(); wet.gain.value = 0.55; this.reverb.connect(wet).connect(this.master);
      this.dry = ctx.createGain(); this.dry.gain.value = 0.6; this.dry.connect(this.master);
      // shared warm lowpass with a very slow sweep
      this.filter = ctx.createBiquadFilter(); this.filter.type = 'lowpass'; this.filter.frequency.value = 900; this.filter.Q.value = 0.4;
      const lfo = ctx.createOscillator(), lfoGain = ctx.createGain();
      lfo.frequency.value = 0.03; lfoGain.gain.value = 350; lfo.connect(lfoGain).connect(this.filter.frequency); lfo.start();
      this.filter.connect(this.dry); this.filter.connect(this.reverb);
      this.bellBus = ctx.createGain(); this.bellBus.gain.value = 0.35; this.bellBus.connect(this.reverb); this.bellBus.connect(this.dry);
      return ctx;
    }

    // A short two-note chime to get attention before a turn instruction.
    chime(dir) { chimeOn(this.ensureContext(), dir); }

    _pad(chord, start, dur) {
      const ctx = this.ctx, atk = 4.5, rel = 6;
      chord.forEach((semi, k) => {
        const f = mtof(this.key + semi);
        [-6, 6].forEach((det, j) => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.type = j ? 'triangle' : 'sine'; o.frequency.value = f; o.detune.value = det + (Math.random() * 4 - 2);
          const peak = (j ? 0.035 : 0.05) * (k === 0 ? 1.1 : 0.9);
          g.gain.setValueAtTime(0, start); g.gain.linearRampToValueAtTime(peak, start + atk);
          g.gain.setValueAtTime(peak, start + dur); g.gain.linearRampToValueAtTime(0, start + dur + rel);
          o.connect(g).connect(this.filter); o.start(start); o.stop(start + dur + rel + 0.1);
        });
      });
      // soft sub drone on the chord root
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = mtof(this.key + chord[0] - 12);
      g.gain.setValueAtTime(0, start); g.gain.linearRampToValueAtTime(0.06, start + atk);
      g.gain.setValueAtTime(0.06, start + dur); g.gain.linearRampToValueAtTime(0, start + dur + rel);
      o.connect(g).connect(this.dry); o.start(start); o.stop(start + dur + rel + 0.1);
    }

    _bell(t) {
      const ctx = this.ctx; const n = this.key + 24 + PENTA[Math.floor(Math.random() * PENTA.length)];
      const o = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = mtof(n); o2.type = 'sine'; o2.frequency.value = mtof(n) * 2.01;
      const g2 = ctx.createGain(); g2.gain.value = 0.18;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.09 + Math.random() * 0.04, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 5);
      o.connect(g); o2.connect(g2).connect(g); g.connect(this.bellBus);
      o.start(t); o2.start(t); o.stop(t + 5.2); o2.stop(t + 5.2);
    }

    _loop() {
      if (!this.running) return;
      const ctx = this.ctx, now = ctx.currentTime;
      const chord = this.prog[this.idx % this.prog.length]; this.idx++;
      this._pad(chord, now + 0.05, this.chordSeconds);
      const bells = 1 + Math.floor(Math.random() * 3);
      for (let b = 0; b < bells; b++) this._bell(now + 1.5 + Math.random() * (this.chordSeconds - 2));
      this.timers.push(setTimeout(() => this._loop(), this.chordSeconds * 1000));
    }

    async start() {
      const ctx = this.ensureContext();
      if (ctx.state !== 'running') await ctx.resume();
      if (this.running) return;
      this.running = true; this._loop();
      this.master.gain.cancelScheduledValues(ctx.currentTime);
      this.master.gain.setValueAtTime(this.master.gain.value, ctx.currentTime);
      this.master.gain.linearRampToValueAtTime(this.volume, ctx.currentTime + 4);
    }

    stop() {
      if (!this.ctx) return; this.running = false;
      this.timers.forEach(clearTimeout); this.timers = [];
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t); this.master.gain.setValueAtTime(this.master.gain.value, t);
      this.master.gain.linearRampToValueAtTime(0, t + 2);
    }

    setVolume(v) {
      this.volume = v; if (!this.ctx || !this.running) return;
      const t = this.ctx.currentTime; this.master.gain.cancelScheduledValues(t); this.master.gain.setTargetAtTime(v, t, 0.2);
    }

    setDucked(on) {
      if (!this.ctx || this.ducked === on) return; this.ducked = on;
      const t = this.ctx.currentTime; this.duck.gain.cancelScheduledValues(t);
      this.duck.gain.setTargetAtTime(on ? this.duckLevel : 1, t, on ? 0.15 : 0.8);
    }

    resume() { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume(); }
  }

  // ---------- Tribal techno ----------
  // 16-step sequencer scheduled a few seconds ahead (survives throttled timers when the screen is
  // dimmed). Arrangement moves through 8-bar phrases: percussion intro → kick → rolling bass →
  // full groove with claps and a 3-against-4 conga line → breakdown → full again, with fresh
  // tom patterns each time round.
  const TOM_BANKS = [
    { low: [0, 3, 6, 10, 13], mid: [8, 11], high: [14] },          // 3-3-4-3-3 "tresillo" roll
    { low: [0, 6, 12], mid: [3, 9, 15], high: [10, 13] },
    { low: [0, 7, 10], mid: [4, 12, 14], high: [2, 15] },
    { low: [0, 2, 8, 11], mid: [5, 13], high: [6, 14, 15] }
  ];
  // per phrase: which layers play
  const PHRASES = [
    { toms: 1, shaker: 1, drone: 1 },                                                        // 0 intro (first time only)
    { toms: 1, shaker: 1, kick: 1, hats: 1 },                                                // 1
    { toms: 1, shaker: 1, kick: 1, hats: 1, bass: 1 },                                       // 2
    { toms: 1, shaker: 1, kick: 1, hats: 1, bass: 1, clap: 1, rim: 1, conga: 1 },             // 3
    { toms: 1, shaker: 1, drone: 1, conga: 1, sweep: 1 },                                     // 4 breakdown
    { toms: 1, shaker: 1, kick: 1, hats: 1, bass: 1, clap: 1, rim: 1, conga: 1, drone: 1 }    // 5
  ];

  class Tribal {
    constructor(opts = {}) {
      this.key = opts.keyMidi || KEYS[opts.key] || KEYS.D;
      this.bpm = opts.bpm || 124;
      this.volume = opts.volume != null ? opts.volume : 0.55;
      this.duckLevel = 0.2;
      this.ctx = opts.ctx || null; this.running = false; this.ducked = false;
      this.timer = null; this.bar = 0; this.nextBarTime = 0; this.bank = TOM_BANKS[0]; this.bassAlt = 0;
    }
    get barSec() { return 240 / this.bpm; }

    ensureContext() {
      if (this.master) return this.ctx;
      const ctx = this.ctx || (this.ctx = newContext());
      this.master = ctx.createGain(); this.master.gain.value = 0;
      this.duck = ctx.createGain(); this.duck.gain.value = 1;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.15;
      const makeup = ctx.createGain(); makeup.gain.value = 0.7; // matched to the ambient style's loudness
      this.master.connect(this.duck).connect(comp).connect(makeup).connect(ctx.destination);
      this.reverb = ctx.createConvolver(); this.reverb.buffer = impulse(ctx, 2.2, 3);
      const wet = ctx.createGain(); wet.gain.value = 0.3; this.reverb.connect(wet).connect(this.master);
      const n = ctx.sampleRate; this.noise = ctx.createBuffer(1, n, n);
      const d = this.noise.getChannelData(0); for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      return ctx;
    }

    // a fresh output bus per start(), so notes already scheduled by a previous run can be faded away
    _newBus() {
      const ctx = this.ctx;
      this.bus = ctx.createGain(); this.bus.gain.value = 1; this.bus.connect(this.master);
      this.send = ctx.createGain(); this.send.gain.value = 1; this.send.connect(this.reverb);
    }

    _out(node, pan = 0, sendAmt = 0) {
      const ctx = this.ctx; let n = node;
      if (pan && ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; n.connect(p); n = p; }
      n.connect(this.bus);
      if (sendAmt) { const s = ctx.createGain(); s.gain.value = sendAmt; n.connect(s).connect(this.send); }
    }

    _env(g, t, peak, decay, attack = 0.002) {
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    }

    _noise(t, dur) {
      const s = this.ctx.createBufferSource(); s.buffer = this.noise;
      s.start(t, Math.random() * 0.8); s.stop(t + dur + 0.02); return s;
    }

    kick(t, v = 1) {
      const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(46, t + 0.11);
      this._env(g, t, 0.95 * v, 0.42);
      o.connect(g); this._out(g); o.start(t); o.stop(t + 0.5);
      const c = this._noise(t, 0.012), hp = ctx.createBiquadFilter(), cg = ctx.createGain();
      hp.type = 'highpass'; hp.frequency.value = 3000; this._env(cg, t, 0.12 * v, 0.01, 0.0005);
      c.connect(hp).connect(cg); this._out(cg);
    }

    tom(t, f, v = 1, decay = 0.3, pan = 0, send = 0.25) {
      const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(f * 1.55, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.045);
      this._env(g, t, 0.42 * v, decay);
      o.connect(g); this._out(g, pan, send); o.start(t); o.stop(t + decay + 0.05);
      // skin slap
      const s = this._noise(t, 0.03), bp = ctx.createBiquadFilter(), sg = ctx.createGain();
      bp.type = 'bandpass'; bp.frequency.value = f * 6; bp.Q.value = 1.5; this._env(sg, t, 0.06 * v, 0.025, 0.001);
      s.connect(bp).connect(sg); this._out(sg, pan);
    }

    hat(t, v = 1, open = false) {
      const ctx = this.ctx, dur = open ? 0.2 : 0.035, s = this._noise(t, dur);
      const hp = ctx.createBiquadFilter(), g = ctx.createGain();
      hp.type = 'highpass'; hp.frequency.value = open ? 7500 : 9000;
      this._env(g, t, (open ? 0.11 : 0.09) * v, dur, 0.001);
      s.connect(hp).connect(g); this._out(g, open ? 0.15 : -0.1, open ? 0.15 : 0);
    }

    shaker(t, v = 1, pan = 0.35) {
      const ctx = this.ctx, s = this._noise(t, 0.07), bp = ctx.createBiquadFilter(), g = ctx.createGain();
      bp.type = 'bandpass'; bp.frequency.value = 6000; bp.Q.value = 1.1;
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.1 * v, t + 0.018);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      s.connect(bp).connect(g); this._out(g, pan);
    }

    rim(t, v = 1) {
      const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'triangle'; o.frequency.value = 1750; this._env(g, t, 0.1 * v, 0.03, 0.0005);
      o.connect(g); this._out(g, -0.3, 0.3); o.start(t); o.stop(t + 0.06);
    }

    clap(t, v = 1) {
      const ctx = this.ctx, bp = ctx.createBiquadFilter(), g = ctx.createGain();
      bp.type = 'bandpass'; bp.frequency.value = 1300; bp.Q.value = 0.9;
      g.gain.setValueAtTime(0.0001, t);
      [0, 0.011, 0.022].forEach(d => { g.gain.linearRampToValueAtTime(0.32 * v, t + d + 0.001); g.gain.exponentialRampToValueAtTime(0.05 * v, t + d + 0.009); });
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      this._noise(t, 0.22).connect(bp).connect(g); this._out(g, 0, 0.35);
    }

    bass(t, semi, dur, v = 1, cutoff = 650) {
      const ctx = this.ctx, o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      o.type = 'sawtooth'; o.frequency.value = mtof(this.key - 12 + semi);
      f.type = 'lowpass'; f.Q.value = 7;
      f.frequency.setValueAtTime(cutoff, t); f.frequency.exponentialRampToValueAtTime(140, t + dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.2 * v, t + 0.004);
      g.gain.setValueAtTime(0.2 * v, t + dur * 0.6); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(f).connect(g); this._out(g); o.start(t); o.stop(t + dur + 0.02);
    }

    drone(t, dur) {
      const ctx = this.ctx, f = ctx.createBiquadFilter(), g = ctx.createGain();
      f.type = 'lowpass'; f.frequency.setValueAtTime(300, t); f.frequency.linearRampToValueAtTime(900, t + dur * 0.6); f.frequency.linearRampToValueAtTime(300, t + dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.05, t + dur * 0.3);
      g.gain.setValueAtTime(0.05, t + dur * 0.7); g.gain.linearRampToValueAtTime(0.0001, t + dur);
      [0, 7, 12].forEach((semi, k) => {
        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(this.key - 12 + semi);
        o.detune.value = (k - 1) * 7; o.connect(f); o.start(t); o.stop(t + dur + 0.05);
      });
      f.connect(g); this._out(g, 0, 0.6);
    }

    // schedule one 16-step bar starting at time t
    scheduleBar(bar, t) {
      const step = this.barSec / 16, swing = step * 0.12;
      const first = bar < 8, cyc = first ? 0 : 1 + Math.floor((bar - 8) / 8) % 5; // intro once, then phrases 1..5
      const L = PHRASES[cyc], inPhrase = bar % 8, lastBar = inPhrase === 7;
      if (inPhrase === 0) {
        this.bank = TOM_BANKS[Math.floor(Math.random() * TOM_BANKS.length)];
        this.bassAlt = [3, 7, 10, 5][Math.floor(Math.random() * 4)];
        if (L.drone) this.drone(t, this.barSec * 8);
      }
      const at = s => t + s * step + (s % 2 ? swing : 0) + (Math.random() - 0.5) * 0.004;
      const tomF = { low: mtof(this.key - 12 + 7), mid: mtof(this.key), high: mtof(this.key + 5), conga: mtof(this.key + 12) };
      const sweepCut = L.sweep ? 300 + 1200 * (inPhrase / 7) : 650;
      for (let s = 0; s < 16; s++) {
        const fill = lastBar && s >= 12; // tom roll into the next phrase
        if (L.kick && s % 4 === 0 && !(lastBar && s >= 8)) this.kick(t + s * step, s === 0 ? 1 : 0.92);
        if (L.hats) { if (s % 4 === 2) this.hat(at(s), 0.9, true); else if (s % 2) this.hat(at(s), 0.45); }
        if (L.shaker) this.shaker(at(s), [0.9, 0.35, 0.6, 0.35][s % 4], s % 2 ? 0.4 : 0.25);
        if (L.toms && !fill) {
          if (this.bank.low.includes(s)) this.tom(at(s), tomF.low, 0.95, 0.34, -0.25);
          if (this.bank.mid.includes(s)) this.tom(at(s), tomF.mid, 0.8, 0.26, 0.2);
          if (this.bank.high.includes(s)) this.tom(at(s), tomF.high, 0.7, 0.2, 0.4);
        }
        if (fill) this.tom(at(s), [tomF.high, tomF.mid, tomF.mid, tomF.low][s - 12], 0.6 + 0.1 * (s - 12), 0.22, (s - 13.5) * 0.2);
        if (L.conga && (bar * 16 + s) % 3 === 0) this.tom(at(s), tomF.conga, 0.38, 0.12, -0.45, 0.2); // 3-against-4
        if (L.clap && (s === 4 || s === 12) && !fill) this.clap(at(s), 0.8);
        if (L.rim && (s === 3 || s === 11 || (s === 14 && bar % 2))) this.rim(at(s), 0.8);
        if (L.bass && s % 4 >= 2 && !(lastBar && s >= 8)) {
          const semi = s === 14 && bar % 4 === 3 ? this.bassAlt : 0;
          this.bass(t + s * step, semi, step * 0.9, s % 4 === 2 ? 1 : 0.7, sweepCut);
        }
      }
    }

    _tick() {
      if (!this.running) return;
      const ctx = this.ctx;
      if (this.nextBarTime < ctx.currentTime) this.nextBarTime = ctx.currentTime + 0.1; // timers were paused
      while (this.nextBarTime < ctx.currentTime + 3) { this.scheduleBar(this.bar++, this.nextBarTime); this.nextBarTime += this.barSec; }
    }

    chime(dir) { chimeOn(this.ensureContext(), dir); }

    async start() {
      const ctx = this.ensureContext();
      if (ctx.state !== 'running') await ctx.resume();
      if (this.running) return;
      this.running = true; this._newBus();
      this.nextBarTime = ctx.currentTime + 0.15; this._tick();
      this.timer = setInterval(() => this._tick(), 500);
      this.master.gain.cancelScheduledValues(ctx.currentTime);
      this.master.gain.setValueAtTime(this.master.gain.value, ctx.currentTime);
      this.master.gain.linearRampToValueAtTime(this.volume, ctx.currentTime + 3);
    }

    stop() {
      if (!this.ctx) return; this.running = false; clearInterval(this.timer); this.timer = null;
      const t = this.ctx.currentTime, bus = this.bus, send = this.send;
      if (bus) {
        bus.gain.cancelScheduledValues(t); bus.gain.setValueAtTime(bus.gain.value, t); bus.gain.linearRampToValueAtTime(0, t + 1.5);
        send.gain.cancelScheduledValues(t); send.gain.setValueAtTime(send.gain.value, t); send.gain.linearRampToValueAtTime(0, t + 1.5);
        setTimeout(() => { try { bus.disconnect(); send.disconnect(); } catch (e) {} }, 5000);
      }
    }

    setVolume(v) {
      this.volume = v; if (!this.ctx || !this.running) return;
      const t = this.ctx.currentTime; this.master.gain.cancelScheduledValues(t); this.master.gain.setTargetAtTime(v, t, 0.2);
    }

    setDucked(on) {
      if (!this.ctx || this.ducked === on) return; this.ducked = on;
      const t = this.ctx.currentTime; this.duck.gain.cancelScheduledValues(t);
      this.duck.gain.setTargetAtTime(on ? this.duckLevel : 1, t, on ? 0.08 : 0.6);
    }

    resume() { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume(); }
  }

  // ---------- one player, switchable style ----------
  const STYLES = { ambient: Ambient, tribal: Tribal };
  class Music {
    constructor(opts = {}) {
      this.opts = Object.assign({}, opts);
      this.style = STYLES[opts.style] ? opts.style : 'ambient';
      this.engine = new STYLES[this.style](this.opts);
    }
    get running() { return this.engine.running; }
    get key() { return this.engine.key; }
    set key(k) { this.engine.key = k; this.opts.keyMidi = k; }
    get ctx() { return this.engine.ctx; }
    setStyle(style) {
      if (!STYLES[style] || style === this.style) return;
      const was = this.engine.running, old = this.engine;
      old.stop();
      this.style = style;
      this.engine = new STYLES[style](Object.assign({}, this.opts, { ctx: old.ctx, keyMidi: old.key, volume: old.volume }));
      if (old.ducked) { this.engine.ensureContext(); this.engine.setDucked(true); }
      if (was) this.engine.start().catch(() => {});
    }
    start() { return this.engine.start(); }
    stop() { this.engine.stop(); }
    setVolume(v) { this.opts.volume = v; this.engine.setVolume(v); }
    setDucked(on) { this.engine.setDucked(on); }
    chime(dir) { this.engine.chime(dir); }
    resume() { this.engine.resume(); }
  }

  global.BTAmbient = Ambient;
  global.BTTribal = Tribal;
  global.BTMusic = Music;
})(window);
