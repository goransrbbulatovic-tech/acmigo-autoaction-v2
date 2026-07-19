'use strict';

const { EventEmitter } = require('events');

/**
 * Recorder — globalno snima događaje miša i tastature preko uiohook-napi.
 *
 * Emituje:
 *   'step'  (step)           kad se doda novi korak (za živi prikaz)
 *   'error' (Error)          ako nativni modul nije dostupan
 *
 * Snimljeni koraci su ravan niz oblika:
 *   { t, dt, type, ... }
 *   - t   apsolutno vrijeme (ms) od početka snimanja
 *   - dt  razmak (ms) od prethodnog koraka  (koristi se pri reprodukciji)
 *   - type: keydown | keyup | mousedown | mouseup | mousemove | wheel
 */
class Recorder extends EventEmitter {
  constructor() {
    super();
    this.uIOhook = null;
    this.available = false;
    this.loadError = null;

    this.recording = false;
    this.steps = [];
    this._startTime = 0;
    this._lastTime = 0;
    this._lastMoveTime = 0;

    // Podešavanja snimanja
    this.captureMouseMove = true;
    this.moveThrottleMs = 16; // ~60 uzoraka/s
    this.ignoreKeycodes = new Set(); // kontrolne prečice koje ne snimamo

    this._bind();
  }

  _bind() {
    try {
      // eslint-disable-next-line global-require
      const mod = require('uiohook-napi');
      this.uIOhook = mod.uIOhook;
      this.UiohookKey = mod.UiohookKey;
      this.available = true;

      this.uIOhook.on('keydown', (e) => this._onKey('keydown', e));
      this.uIOhook.on('keyup', (e) => this._onKey('keyup', e));
      this.uIOhook.on('mousedown', (e) => this._onMouseButton('mousedown', e));
      this.uIOhook.on('mouseup', (e) => this._onMouseButton('mouseup', e));
      this.uIOhook.on('mousemove', (e) => this._onMouseMove(e));
      this.uIOhook.on('wheel', (e) => this._onWheel(e));
    } catch (err) {
      this.available = false;
      this.loadError = err;
    }
  }

  /** Postavlja skup keycode-ova koji se NE snimaju (kontrolne prečice aplikacije). */
  setIgnoredKeycodes(codes) {
    this.ignoreKeycodes = new Set(codes || []);
  }

  configure(opts = {}) {
    if (typeof opts.captureMouseMove === 'boolean') this.captureMouseMove = opts.captureMouseMove;
    if (typeof opts.moveThrottleMs === 'number') this.moveThrottleMs = Math.max(1, opts.moveThrottleMs);
  }

  start() {
    if (!this.available) {
      this.emit('error', this.loadError || new Error('uiohook-napi nije dostupan'));
      return false;
    }
    if (this.recording) return true;

    this.steps = [];
    this._startTime = Date.now();
    this._lastTime = this._startTime;
    this._lastMoveTime = 0;
    this.recording = true;

    try {
      this.uIOhook.start();
    } catch (err) {
      this.recording = false;
      this.emit('error', err);
      return false;
    }
    return true;
  }

  stop() {
    if (!this.recording) return this.steps;
    this.recording = false;
    try {
      this.uIOhook.stop();
    } catch (_) { /* ignore */ }
    return this.steps;
  }

  /** Potpuno otpušta nativni slušač (poziva se pri gašenju aplikacije). */
  dispose() {
    try {
      if (this.uIOhook) {
        this.uIOhook.stop();
        if (typeof this.uIOhook.removeAllListeners === 'function') this.uIOhook.removeAllListeners();
      }
    } catch (_) { /* ignore */ }
    this.recording = false;
  }

  _push(step) {
    const now = Date.now();
    step.t = now - this._startTime;
    step.dt = now - this._lastTime;
    this._lastTime = now;
    this.steps.push(step);
    this.emit('step', step);
  }

  _onKey(type, e) {
    if (!this.recording) return;
    if (this.ignoreKeycodes.has(e.keycode)) return; // ne snimaj kontrolne prečice
    this._push({ type, keycode: e.keycode });
  }

  _onMouseButton(type, e) {
    if (!this.recording) return;
    this._push({ type, button: e.button, x: e.x, y: e.y });
  }

  _onMouseMove(e) {
    if (!this.recording || !this.captureMouseMove) return;
    const now = Date.now();
    if (now - this._lastMoveTime < this.moveThrottleMs) return;
    this._lastMoveTime = now;
    this._push({ type: 'mousemove', x: e.x, y: e.y });
  }

  _onWheel(e) {
    if (!this.recording) return;
    const rotation = typeof e.rotation === 'number' ? e.rotation : 0;

    // Normalizuj jačinu na broj "zubaca" (notch).
    // Neki sistemi javljaju ±120 po zupcu, neki ±1 — svedi na isti oblik.
    let clicks = Math.abs(rotation);
    if (clicks >= 100) clicks = Math.round(clicks / 120);
    if (!clicks) clicks = 1;

    this._push({
      type: 'wheel',
      x: e.x,
      y: e.y,
      rotation,
      direction: e.direction,
      amount: e.amount,
      clicks,                          // koliko zubaca (uvijek >= 1)
      horizontal: e.direction === 4,   // 3 = vertikalno, 4 = horizontalno
    });
  }
}

module.exports = Recorder;
