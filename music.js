// music.js — slow generative ambient music with Web Audio (no audio files, no copyright).
// Soft detuned pads drift through a chord progression; sparse pentatonic bells float on top.
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

  class Ambient {
    constructor(opts = {}) {
      this.key = KEYS[opts.key] || KEYS.D;
      this.prog = PROGRESSIONS[opts.mood] || PROGRESSIONS.calm;
      this.chordSeconds = opts.chordSeconds || 11;
      this.volume = opts.volume != null ? opts.volume : 0.55;
      this.duckLevel = 0.28;
      this.ctx = null; this.running = false; this.ducked = false; this.idx = 0; this.timers = [];
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
      if (this.ctx) return this.ctx;
      const AC = global.AudioContext || global.webkitAudioContext;
      const ctx = this.ctx = new AC({ latencyHint: 'playback' });
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
    chime(dir) {
      const ctx = this.ensureContext(); const t = ctx.currentTime + 0.02;
      const notes = dir === 'left' ? [79, 74] : dir === 'right' ? [74, 79] : [76, 76];
      notes.forEach((n, k) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = mtof(n);
        g.gain.setValueAtTime(0, t + k * 0.18); g.gain.linearRampToValueAtTime(0.22, t + k * 0.18 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + k * 0.18 + 0.7);
        o.connect(g).connect(ctx.destination); o.start(t + k * 0.18); o.stop(t + k * 0.18 + 0.8);
      });
    }

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

  global.BTAmbient = Ambient;
})(window);
