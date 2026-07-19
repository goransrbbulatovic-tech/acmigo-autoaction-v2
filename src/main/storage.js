'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Storage — čuva makroe kao JSON fajlove i podešavanja u userData folderu.
 *
 *   <userData>/macros/<id>.json
 *   <userData>/settings.json
 */
class Storage {
  constructor(userDataDir) {
    this.dir = userDataDir;
    this.macrosDir = path.join(userDataDir, 'macros');
    this.settingsPath = path.join(userDataDir, 'settings.json');
    fs.mkdirSync(this.macrosDir, { recursive: true });
  }

  // ---- Podešavanja ----
  defaultSettings() {
    return {
      repeat: 1,
      loopForever: false,
      speed: 1,
      countdown: 3,
      captureMouseMove: true,
      moveThrottleMs: 16,
      maxDelayMs: 5000,
      scrollStrength: 100,
      hotkeys: {
        toggleRecord: 'F6',
        play: 'F7',
        stop: 'Escape',
      },
      minimizeToTray: false,
    };
  }

  getSettings() {
    try {
      const raw = fs.readFileSync(this.settingsPath, 'utf8');
      return { ...this.defaultSettings(), ...JSON.parse(raw) };
    } catch (_) {
      return this.defaultSettings();
    }
  }

  setSettings(patch) {
    const merged = { ...this.getSettings(), ...patch };
    fs.writeFileSync(this.settingsPath, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  }

  // ---- Makroi ----
  _pathFor(id) {
    return path.join(this.macrosDir, `${id}.json`);
  }

  list() {
    let files = [];
    try {
      files = fs.readdirSync(this.macrosDir).filter((f) => f.endsWith('.json'));
    } catch (_) {
      return [];
    }
    const out = [];
    for (const f of files) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(this.macrosDir, f), 'utf8'));
        out.push({
          id: m.id,
          name: m.name,
          createdAt: m.createdAt,
          updatedAt: m.updatedAt,
          stepCount: Array.isArray(m.steps) ? m.steps.length : 0,
          durationMs: m.durationMs || 0,
          hotkey: m.hotkey || null,
          smart: !!m.smart,
          follow: !!m.follow,
          context: m.context || null,
        });
      } catch (_) { /* preskoči neispravan fajl */ }
    }
    out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return out;
  }

  get(id) {
    try {
      return JSON.parse(fs.readFileSync(this._pathFor(id), 'utf8'));
    } catch (_) {
      return null;
    }
  }

  save({ id, name, steps, context, smart, follow }) {
    const now = Date.now();
    const existing = id ? this.get(id) : null;
    const macro = {
      id: id || crypto.randomUUID(),
      name: name || existing?.name || 'Novi makro',
      steps: steps || existing?.steps || [],
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      durationMs: (steps && steps.length) ? steps[steps.length - 1].t || 0 : (existing?.durationMs || 0),
      hotkey: existing?.hotkey || null,
      smart: (typeof smart === 'boolean') ? smart : !!existing?.smart,
      follow: (typeof follow === 'boolean') ? follow : !!existing?.follow,
      context: context || existing?.context || null,
      version: 1,
    };
    fs.writeFileSync(this._pathFor(macro.id), JSON.stringify(macro), 'utf8');
    return macro;
  }

  rename(id, name) {
    const m = this.get(id);
    if (!m) return null;
    m.name = name;
    m.updatedAt = Date.now();
    fs.writeFileSync(this._pathFor(id), JSON.stringify(m), 'utf8');
    return m;
  }

  /** Uključuje/isključuje kontekstno svjesnu reprodukciju za makro. */
  setSmart(id, smart) {
    const m = this.get(id);
    if (!m) return null;
    m.smart = !!smart;
    m.updatedAt = Date.now();
    fs.writeFileSync(this._pathFor(id), JSON.stringify(m), 'utf8');
    return m;
  }

  /** Uključuje/isključuje prilagođavanje koordinata prozoru. */
  setFollow(id, follow) {
    const m = this.get(id);
    if (!m) return null;
    m.follow = !!follow;
    m.updatedAt = Date.now();
    fs.writeFileSync(this._pathFor(id), JSON.stringify(m), 'utf8');
    return m;
  }

  /** Pamti ciljnu aplikaciju (proces, putanja, naslov prozora) za makro. */
  setContext(id, ctx) {
    const m = this.get(id);
    if (!m) return null;
    m.context = ctx || null;
    m.updatedAt = Date.now();
    fs.writeFileSync(this._pathFor(id), JSON.stringify(m), 'utf8');
    return m;
  }

  /** Postavlja (ili uklanja, ako je hotkey null) globalnu prečicu za makro. */
  setHotkey(id, hotkey) {
    const m = this.get(id);
    if (!m) return null;
    m.hotkey = hotkey || null;
    m.updatedAt = Date.now();
    fs.writeFileSync(this._pathFor(id), JSON.stringify(m), 'utf8');
    return m;
  }

  delete(id) {
    try {
      fs.unlinkSync(this._pathFor(id));
      return true;
    } catch (_) {
      return false;
    }
  }

  // ---- Uvoz / izvoz ----
  exportToFile(id, destPath) {
    const m = this.get(id);
    if (!m) return false;
    fs.writeFileSync(destPath, JSON.stringify(m, null, 2), 'utf8');
    return true;
  }

  importFromFile(srcPath) {
    const raw = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
    if (!Array.isArray(raw.steps)) throw new Error('Neispravan fajl makroa');
    // novi id da ne pregazi postojeći
    return this.save({ id: null, name: raw.name || 'Uvezeni makro', steps: raw.steps });
  }
}

module.exports = Storage;
