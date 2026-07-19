'use strict';

const { EventEmitter } = require('events');
const { buildKeyMap, buildButtonMap } = require('./keymap');

// Jedan zubac točkića miša u Windows jedinicama.
const WHEEL_DELTA = 120;

/**
 * Player — reprodukuje snimljene korake preko @nut-tree-fork/nut-js.
 *
 * Ključna osobina: reprodukcija se može prekinuti u SVAKOM trenutku
 * (STOP prečicom ili dugmetom). Petlja provjerava stop-zastavicu prije
 * svakog koraka i prije svake iteracije, a na kraju/prekidu oslobađa sve
 * tastere i dugmad koja su ostala pritisnuta (nema "zaglavljenog" Shift-a).
 *
 * Emituje:
 *   'progress' ({ index, total, loop, loops })
 *   'loop'     ({ loop, loops })
 *   'done'     ({ reason: 'finished' | 'stopped' | 'error' })
 *   'error'    (Error)
 */
class Player extends EventEmitter {
  constructor() {
    super();
    this.available = false;
    this.loadError = null;
    this.playing = false;
    this._stop = false;

    this._pressedKeys = new Set();
    this._pressedButtons = new Set();

    this._load();
  }

  _load() {
    try {
      // eslint-disable-next-line global-require
      const nut = require('@nut-tree-fork/nut-js');
      const mod = require('uiohook-napi');

      this.nut = nut;
      this.Point = nut.Point;
      this.Button = nut.Button;
      this.Key = nut.Key;
      this.mouse = nut.mouse;
      this.keyboard = nut.keyboard;

      // Mi sami kontrolišemo tajming — isključujemo interne pauze.
      this.keyboard.config.autoDelayMs = 0;
      this.mouse.config.autoDelayMs = 0;
      this.mouse.config.mouseSpeed = 999999; // trenutni skok na poziciju

      const km = buildKeyMap(mod.UiohookKey, nut.Key);
      this.keyMap = km.map;
      this.missingKeys = km.missing;
      this.buttonMap = buildButtonMap(nut.Button);

      this.available = true;
    } catch (err) {
      this.available = false;
      this.loadError = err;
    }
  }

  stop() {
    this._stop = true;
  }

  /**
   * Postavlja pretvaranje koordinata: snimljeni prozor -> trenutni prozor.
   * Zahvaljujući ovome makro radi i kad je prozor pomjeren ili druge veličine.
   */
  _setTransform(t) {
    this._tf = null;
    if (!t || !t.rec || !t.cur) return;
    const { rec, cur } = t;
    if (!rec.w || !rec.h || !cur.w || !cur.h) return;
    this._tf = {
      dx: cur.x, dy: cur.y,
      rx: rec.x, ry: rec.y,
      sx: cur.w / rec.w,
      sy: cur.h / rec.h,
    };
  }

  /** Prevodi apsolutnu tačku sa snimanja u tačku u trenutnom prozoru. */
  _pt(x, y) {
    if (!this._tf || x == null || y == null) return { x, y };
    const t = this._tf;
    return {
      x: Math.round(t.dx + (x - t.rx) * t.sx),
      y: Math.round(t.dy + (y - t.ry) * t.sy),
    };
  }

  /** Pritisne kombinaciju tastera (npr. Ctrl+Shift+A). */
  async pressCombo(names) {
    if (!this.available) return false;
    const keys = names.map((n) => this.Key[n]).filter((k) => k !== undefined);
    if (keys.length !== names.length) return false;
    for (const k of keys) await this.keyboard.pressKey(k);
    for (const k of keys.slice().reverse()) await this.keyboard.releaseKey(k);
    return true;
  }

  /** Otkuca tekst (koristi se za pretragu tabova / unos adrese). */
  async typeText(text) {
    if (!this.available) return false;
    await this.keyboard.type(String(text));
    return true;
  }

  _sleep(ms) {
    return new Promise((res) => setTimeout(res, Math.max(0, ms)));
  }

  /**
   * Spaja uzastopne okretaje točkića u isti smjer u jedan veći skrol.
   *
   * Kad brzo skrolaš, sistem javi desetine sitnih događaja. Ako ih puštamo
   * jedan po jedan, svaki nosi svoju pauzu i režiju poziva — pa reprodukcija
   * kasni i ne odskrola dokle treba. Spajanjem se ukupan put očuva, a skrol
   * postaje brz i tačan. Ukupno trajanje snimka ostaje isto jer se
   * "pojedene" pauze prebacuju na sljedeći korak.
   */
  _coalesceWheel(steps, windowMs = 140) {
    const out = [];
    let carry = 0; // nagomilane pauze koje treba dodati sljedećem koraku
    let i = 0;

    while (i < steps.length) {
      const s = steps[i];

      if (s.type !== 'wheel') {
        out.push(carry ? { ...s, dt: (s.dt || 0) + carry } : s);
        carry = 0;
        i += 1;
        continue;
      }

      const sign = (s.rotation || 0) < 0 ? -1 : 1;
      const horizontal = !!s.horizontal;
      const merged = { ...s, dt: (s.dt || 0) + carry, clicks: s.clicks || 1 };
      carry = 0;

      let j = i + 1;
      while (j < steps.length) {
        const n = steps[j];
        if (n.type !== 'wheel') break;
        if (!!n.horizontal !== horizontal) break;
        if (((n.rotation || 0) < 0 ? -1 : 1) !== sign) break;
        if ((n.dt || 0) > windowMs) break;
        merged.clicks += (n.clicks || 1);
        carry += (n.dt || 0);   // pauza se ne gubi — ide sljedećem koraku
        merged.x = n.x;
        merged.y = n.y;
        j += 1;
      }

      out.push(merged);
      i = j;
    }

    return out;
  }

  /**
   * @param {Array} steps  snimljeni koraci
   * @param {object} opts  { repeat=1, loopForever=false, speed=1, maxDelayMs }
   */
  async play(steps, opts = {}) {
    if (!this.available) {
      this.emit('error', this.loadError || new Error('nut-js nije dostupan'));
      this.emit('done', { reason: 'error' });
      return;
    }
    if (this.playing) return;
    if (!Array.isArray(steps) || steps.length === 0) {
      this.emit('done', { reason: 'finished' });
      return;
    }

    const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
    const repeat = opts.loopForever ? Infinity : Math.max(1, opts.repeat || 1);
    const loops = opts.loopForever ? Infinity : repeat;
    const maxDelay = typeof opts.maxDelayMs === 'number' ? opts.maxDelayMs : 5000;
    this._scrollScale = (opts.scrollStrength > 0 ? opts.scrollStrength : 100) / 100;
    this._setTransform(opts.transform);

    // Spoji samo prave "rafale" okretaja (kratak prozor), da tempo ostane
    // vjeran tvom skrolovanju umjesto da sve skoči odjednom.
    steps = this._coalesceWheel(steps, 50);

    this.playing = true;
    this._stop = false;

    let reason = 'finished';
    try {
      for (let loop = 1; loop <= repeat; loop++) {
        if (this._stop) { reason = 'stopped'; break; }
        this.emit('loop', { loop, loops });

        for (let i = 0; i < steps.length; i++) {
          if (this._stop) { reason = 'stopped'; break; }
          const step = steps[i];

          // Poštuj snimljeni razmak (skaliran brzinom), uz gornju granicu.
          let wait = (step.dt || 0) / speed;
          if (wait > maxDelay) wait = maxDelay;
          if (wait > 0) await this._sleep(wait);
          if (this._stop) { reason = 'stopped'; break; }

          await this._execute(step);
          this.emit('progress', { index: i + 1, total: steps.length, loop, loops });
        }
        if (this._stop) { reason = 'stopped'; break; }
      }
    } catch (err) {
      reason = 'error';
      this.emit('error', err);
    } finally {
      await this._releaseAll();
      this.playing = false;
      this._stop = false;
      this.emit('done', { reason });
    }
  }

  async _execute(step) {
    switch (step.type) {
      // "wait" je ručno dodat korak čekanja iz editora — pauza je već
      // odrađena preko dt prije poziva, pa ovdje nema šta da se radi.
      case 'wait':
        break;

      case 'mousemove': {
        const p = this._pt(step.x, step.y);
        await this.mouse.setPosition(new this.Point(p.x, p.y));
        break;
      }

      case 'mousedown': {
        const btn = this.buttonMap.get(step.button);
        if (btn === undefined) break;
        if (step.x != null) {
          const p = this._pt(step.x, step.y);
          await this.mouse.setPosition(new this.Point(p.x, p.y));
        }
        await this.mouse.pressButton(btn);
        this._pressedButtons.add(btn);
        break;
      }

      case 'mouseup': {
        const btn = this.buttonMap.get(step.button);
        if (btn === undefined) break;
        if (step.x != null) {
          const p = this._pt(step.x, step.y);
          await this.mouse.setPosition(new this.Point(p.x, p.y));
        }
        await this.mouse.releaseButton(btn);
        this._pressedButtons.delete(btn);
        break;
      }

      case 'keydown': {
        const key = this.keyMap.get(step.keycode);
        if (key === undefined) break;
        await this.keyboard.pressKey(key);
        this._pressedKeys.add(key);
        break;
      }

      case 'keyup': {
        const key = this.keyMap.get(step.keycode);
        if (key === undefined) break;
        await this.keyboard.releaseKey(key);
        this._pressedKeys.delete(key);
        break;
      }

      case 'wheel': {
        // Nativni sloj (libnut scrollMouse) šalje SIROVI Windows wheel delta,
        // gdje je JEDAN zubac točkića = WHEEL_DELTA = 120.
        // Zato zupce množimo sa 120 — tako reprodukcija skrola tačno onoliko
        // koliko si i ti skrolovao. (Ranije se slalo ~3, tj. 1/40 zupca → puzalo je.)
        let clicks = step.clicks;
        if (!clicks) {
          clicks = Math.abs(step.rotation || 0);
          if (clicks >= 100) clicks = Math.round(clicks / 120);
          if (!clicks) clicks = 1;
        }
        const amt = Math.max(1, Math.round(clicks * WHEEL_DELTA * this._scrollScale));
        const negative = (step.rotation || 0) < 0;
        try {
          if (step.horizontal) {
            if (negative) await this.mouse.scrollLeft(amt);
            else await this.mouse.scrollRight(amt);
          } else if (negative) {
            await this.mouse.scrollUp(amt);
          } else {
            await this.mouse.scrollDown(amt);
          }
        } catch (_) { /* ignore — neki sistemi nemaju horizontalni skrol */ }
        break;
      }

      default:
        break;
    }
  }

  /** Oslobađa sve tastere/dugmad da ništa ne ostane "zaglavljeno". */
  async _releaseAll() {
    for (const key of this._pressedKeys) {
      try { await this.keyboard.releaseKey(key); } catch (_) { /* ignore */ }
    }
    for (const btn of this._pressedButtons) {
      try { await this.mouse.releaseButton(btn); } catch (_) { /* ignore */ }
    }
    this._pressedKeys.clear();
    this._pressedButtons.clear();
  }
}

module.exports = Player;
