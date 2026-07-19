'use strict';

const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, dialog, nativeImage } = require('electron');
const path = require('path');

const Recorder = require('./recorder');
const Player = require('./player');
const Storage = require('./storage');
const context = require('./context');

const isDev = process.argv.includes('--dev');

let win = null;
let tray = null;
let storage = null;
let recorder = null;
let player = null;

let settings = null;
let currentSteps = [];          // koraci koji su spremni za reprodukciju
let currentContext = null;      // ciljna aplikacija (kontekstno svjesna reprodukcija)
let currentSmart = false;       // da li ovaj makro sam pronalazi svoju aplikaciju
let currentFollow = false;      // prilagodi koordinate položaju/veličini prozora
let currentMacroId = null;      // id makroa iz biblioteke (ako je učitan)
let state = 'idle';             // idle | recording | countdown | playing
let countdownTimer = null;
let recStatsTimer = null;
let captureContextTimer = null;
let lastSeenWindow = null;   // posljednji viđeni tuđi prozor dok snimamo
let contextLocked = false;   // kontekst se zaključava na PRVOM kliku/tasteru
let quitting = false;
let lastProgressSent = 0;

// ---------------------------------------------------------------- helpers
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function setState(next, extra = {}) {
  state = next;
  send('state', { state, ...extra });
  refreshTrayMenu();
}

/** Prevodi ime prečice (npr. "F6", "Escape") u uiohook keycode radi filtriranja. */
function hotkeyToUiohookCode(name) {
  if (!recorder || !recorder.UiohookKey) return undefined;
  return recorder.UiohookKey[name];
}

function updateIgnoredKeycodes() {
  const names = Object.values(settings.hotkeys || {});
  // dodaj i jednostavne prečice makroa (bez modifikatora) da se ne snime
  try {
    for (const m of storage.list()) {
      if (m.hotkey && !m.hotkey.includes('+')) names.push(m.hotkey);
    }
  } catch (_) { /* ignore */ }
  const codes = names.map(hotkeyToUiohookCode).filter((c) => c !== undefined);
  recorder.setIgnoredKeycodes(codes);
}

// ---------------------------------------------------------------- window
function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 940,
    minHeight: 600,
    frame: false,
    backgroundColor: '#0b0e15',
    show: false,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  win.on('close', (e) => {
    // X i Alt+F4 UVIJEK potpuno gase program (ne u tray).
    if (cleanedUp) return;
    e.preventDefault();
    cleanupAndExit();
  });
}

// ---------------------------------------------------------------- clean exit
let cleanedUp = false;
/**
 * Potpuno gasi aplikaciju: zaustavlja snimanje/reprodukciju, otpušta prečice,
 * uništava tray i FORSIRA izlaz preko app.exit(0).
 * Force-exit je bitan jer nativni uiohook-napi thread zna zadržati proces
 * živim u Task Manageru i nakon običnog app.quit().
 */
function cleanupAndExit() {
  if (cleanedUp) return;
  cleanedUp = true;
  quitting = true;
  try { if (recorder && state === 'recording') recorder.stop(); } catch (_) { /* ignore */ }
  try { if (player) player.stop(); } catch (_) { /* ignore */ }
  try { if (recorder && recorder.dispose) recorder.dispose(); } catch (_) { /* ignore */ }
  try { globalShortcut.unregisterAll(); } catch (_) { /* ignore */ }
  try { if (tray) { tray.destroy(); tray = null; } } catch (_) { /* ignore */ }
  app.exit(0); // tvrdi izlaz — garantuje da proces stvarno nestane
}

// ---------------------------------------------------------------- tray
function buildTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'build', 'tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 18, height: 18 }));
  tray.setToolTip('AutoAction Acmigo');
  tray.on('click', () => showWindow());
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const recording = state === 'recording';
  const busy = state === 'playing' || state === 'countdown' || state === 'preparing';
  const menu = Menu.buildFromTemplate([
    { label: 'Otvori AutoAction', click: () => showWindow() },
    { type: 'separator' },
    {
      label: recording ? 'Zaustavi snimanje' : 'Započni snimanje',
      enabled: !busy,
      click: () => (recording ? stopRecording() : startRecording()),
    },
    { label: 'Pokreni reprodukciju', enabled: !recording && !busy && currentSteps.length > 0, click: () => startPlayback() },
    { label: 'STOP', enabled: busy, click: () => stopPlayback() },
    { type: 'separator' },
    { label: 'Izlaz', click: () => cleanupAndExit() },
  ]);
  tray.setContextMenu(menu);
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------------------------------------------------------------- recording
function startRecording() {
  if (state !== 'idle') return;
  updateIgnoredKeycodes();
  recorder.configure({
    captureMouseMove: settings.captureMouseMove,
    moveThrottleMs: settings.moveThrottleMs,
  });
  const ok = recorder.start();
  if (!ok) return;
  currentMacroId = null;
  currentContext = null;
  currentSmart = false;
  setState('recording');

  // Prati u kojoj aplikaciji radiš DOK snimaš, umjesto jednog snimka na početku.
  // Tako nema jurnjave sa odbrojavanjem: slobodno tražiš pravi tab koliko treba —
  // na kraju se uzima aplikacija u kojoj si proveo najviše vremena.
  lastSeenWindow = null;
  contextLocked = false;
  const pollContext = async () => {
    try {
      const w = await context.getActiveWindow();
      if (!w || !w.name) return;
      if (/acmigo|electron/i.test(w.name)) return;   // preskoči naš prozor
      lastSeenWindow = w;

      // Zaključaj kontekst na PRVI tuđi prozor na koji se prebaciš.
      // Namjerno prije prvog klika: ako čekamo klik, program koji se tim klikom
      // otvori (npr. pregledač slika) stigne da preotme fokus i bude pogrešno
      // zapamćen. Odakle si kliknuo — to je pravi kontekst.
      if (!contextLocked) {
        contextLocked = true;
        currentContext = makeCtx(w);
        send('recorder:context', currentContext);
        // zapamti i položaj/veličinu prozora — treba za "Prati prozor"
        if (!currentContext.desktop) {
          context.getWindowRect(w.name, w.title).then((rect) => {
            if (rect && currentContext) currentContext.rect = rect;
          }).catch(() => { /* ignore */ });
        }
      }
    } catch (_) { /* ignore — kontekst je opcion */ }
  };
  pollContext();
  captureContextTimer = setInterval(pollContext, 600);

  // periodično šalji broj koraka (da ne preplavimo IPC svakim mousemove-om)
  recStatsTimer = setInterval(() => {
    send('recorder:stats', { count: recorder.steps.length, durationMs: recorder.steps.length ? recorder.steps[recorder.steps.length - 1].t : 0 });
  }, 120);
}

function stopRecording() {
  if (state !== 'recording') return;
  const steps = recorder.stop();
  currentSteps = steps.slice();
  if (recStatsTimer) { clearInterval(recStatsTimer); recStatsTimer = null; }
  if (captureContextTimer) { clearInterval(captureContextTimer); captureContextTimer = null; }

  // kontekst je već zaključan na prvom kliku; ako nije (npr. samo tastatura),
  // uzmi posljednji viđeni prozor kao rezervu
  if (!currentContext && lastSeenWindow) {
    currentContext = makeCtx(lastSeenWindow);
    send('recorder:context', currentContext);
  }
  lastSeenWindow = null;
  contextLocked = false;
  setState('idle');
  send('recorder:done', {
    count: currentSteps.length,
    durationMs: currentSteps.length ? currentSteps[currentSteps.length - 1].t : 0,
    steps: summarize(currentSteps),
  });
}

// ---------------------------------------------------------------- playback
function startPlayback() {
  if (state !== 'idle') return;
  if (!currentSteps.length) return;

  const cd = Math.max(0, settings.countdown || 0);
  registerStopHotkey(true);

  if (cd > 0) {
    setState('countdown', { value: cd });
    let n = cd;
    send('player:countdown', { value: n });
    countdownTimer = setInterval(() => {
      n -= 1;
      if (state !== 'countdown') { clearInterval(countdownTimer); countdownTimer = null; return; }
      if (n <= 0) {
        clearInterval(countdownTimer); countdownTimer = null;
        beginPlayback();
      } else {
        send('player:countdown', { value: n });
      }
    }, 1000);
  } else {
    beginPlayback();
  }
}

async function beginPlayback() {
  // Kontekstno svjesna reprodukcija: prvo nađi/otvori ciljnu aplikaciju,
  // pa tek onda kreni sa koracima — bez obzira gdje se trenutno nalaziš.
  if (currentSmart && currentContext && context.supported()) {
    setState('preparing');
    send('player:prepare', { message: 'Pripremam aplikaciju…' });
    try {
      const r = await context.ensureTarget(currentContext, (msg) => send('player:prepare', { message: msg }));
      if (!r.ok) {
        send('engine:error', { where: 'context', message: r.message });
        setState('idle');
        send('player:done', { reason: 'error' });
        return;
      }
      send('player:prepare', { message: r.message });
      await new Promise((res) => setTimeout(res, 400)); // da se prozor smiri

      // pretraživač → pronađi baš onaj tab, ne samo program
      if (context.isBrowser(currentContext)) {
        const okTab = await focusBrowserTab(currentContext, (m) => send('player:prepare', { message: m }));
        if (!okTab) send('player:prepare', { message: 'Tab nije nađen — nastavljam na trenutnom.' });
        await new Promise((res) => setTimeout(res, 400));
      }
    } catch (err) {
      send('engine:error', { where: 'context', message: String(err && err.message || err) });
      setState('idle');
      send('player:done', { reason: 'error' });
      return;
    }
    if (state !== 'preparing') return; // korisnik je u međuvremenu prekinuo
  }

  // "Prati prozor": prevedi snimljene koordinate u trenutni položaj prozora
  let transform = null;
  if (currentFollow && currentContext && currentContext.rect && !currentContext.desktop && context.supported()) {
    try {
      const cur = await context.getWindowRect(currentContext.name, currentContext.title);
      if (cur) {
        transform = { rec: currentContext.rect, cur };
        send('player:prepare', { message: 'Prilagođavam se prozoru…' });
      }
    } catch (_) { /* ignore — bez prilagođavanja */ }
  }

  setState('playing', { total: currentSteps.length });
  player.play(currentSteps, {
    transform,
    repeat: settings.repeat,
    loopForever: settings.loopForever,
    speed: settings.speed,
    maxDelayMs: settings.maxDelayMs,
    scrollStrength: settings.scrollStrength,
  });
}

function stopPlayback() {
  if (state === 'preparing') {
    registerStopHotkey(false);
    setState('idle');
    send('player:done', { reason: 'stopped' });
    return;
  }
  if (state === 'countdown') {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    registerStopHotkey(false);
    setState('idle');
    send('player:done', { reason: 'stopped' });
    return;
  }
  if (state === 'playing') {
    player.stop();
  }
}

// STOP prečica se registruje samo tokom reprodukcije/odbrojavanja
function registerStopHotkey(on) {
  const key = settings.hotkeys.stop;
  try {
    if (on) {
      globalShortcut.register(key, () => stopPlayback());
    } else {
      globalShortcut.unregister(key);
    }
  } catch (_) { /* ignore */ }
}

// ---------------------------------------------------------------- global hotkeys
function registerGlobalHotkeys() {
  globalShortcut.unregisterAll();
  const { toggleRecord, play } = settings.hotkeys;
  try {
    globalShortcut.register(toggleRecord, () => {
      if (state === 'recording') stopRecording();
      else if (state === 'idle') startRecording();
    });
  } catch (_) { /* ignore */ }
  try {
    globalShortcut.register(play, () => {
      if (state === 'idle' && currentSteps.length) startPlayback();
    });
  } catch (_) { /* ignore */ }
  registerMacroHotkeys();
}

// Pokreće baš određeni makro po id-u (koristi ga prečica makroa) — bez odbrojavanja,
// radi i dok je program u tray-u.
function playMacroById(id) {
  if (state !== 'idle') return;
  const m = storage.get(id);
  if (!m || !Array.isArray(m.steps) || !m.steps.length) return;
  currentSteps = m.steps.slice();
  currentMacroId = id;
  currentContext = m.context || null;
  currentSmart = !!m.smart;
  registerStopHotkey(true); // Esc i dalje prekida
  beginPlayback();
}

// Registruje globalnu prečicu za svaki makro koji je ima. Radi i u pozadini/tray-u.
let macroHotkeyMap = {};
function registerMacroHotkeys() {
  macroHotkeyMap = {};
  const reserved = new Set(Object.values(settings.hotkeys || {}));
  for (const m of storage.list()) {
    if (!m.hotkey) continue;
    if (reserved.has(m.hotkey)) continue;   // ne gazi snimanje/puštanje/stop
    if (macroHotkeyMap[m.hotkey]) continue;  // prvi makro koji uzme prečicu
    try {
      const ok = globalShortcut.register(m.hotkey, () => playMacroById(m.id));
      if (ok) macroHotkeyMap[m.hotkey] = m.id;
    } catch (_) { /* ignore */ }
  }
}

// ---------------------------------------------------------------- util
function summarize(steps) {
  // vrati kompaktan pregled za UI (bez ogromnog niza mousemove-ova)
  const counts = { keydown: 0, keyup: 0, mousedown: 0, mouseup: 0, mousemove: 0, wheel: 0, wait: 0 };
  const preview = [];
  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i];
    counts[s.type] = (counts[s.type] || 0) + 1;
    // "i" je stvarni indeks u nizu — editor po njemu briše/mijenja korak
    if (s.type !== 'mousemove' && preview.length < 400) preview.push({ ...s, i });
  }
  return { counts, preview };
}

/**
 * Pronalazi tačan tab u pretraživaču.
 * Prvo provjeri jesmo li već na njemu; ako nismo, koristi ugrađenu pretragu
 * tabova (Ctrl+Shift+A) i otkuca zapamćeni naslov. Ako ni to ne uspije,
 * otvara zapamćenu adresu u novom tabu.
 *
 * Napomena: pretraga tabova postoji samo u pretraživačima na Chromium osnovi
 * (Chrome, Edge, Brave...). U Firefoxu ta prečica otvara dodatke, pa se tamo
 * ide odmah na adresu.
 */
async function focusBrowserTab(ctx, onStatus = () => {}) {
  const hint = context.cleanTabTitle(ctx.title);
  if (!hint) return true;

  const same = (a, b) => a && b && (a === b || a.includes(b) || b.includes(a));

  try {
    const cur = context.cleanTabTitle(await context.getActiveTitle());
    if (same(cur, hint)) return true;   // već smo na pravom tabu
  } catch (_) { /* ignore */ }

  const chromium = /^(chrome|msedge|brave|vivaldi|chromium)$/i.test(ctx.name || '');
  if (chromium && player.available) {
    onStatus('Tražim tab…');
    const ok = await player.pressCombo(['LeftControl', 'LeftShift', 'A']);
    if (ok) {
      await new Promise((r) => setTimeout(r, 500));
      await player.typeText(hint.slice(0, 40));
      await new Promise((r) => setTimeout(r, 700));
      await player.pressCombo(['Enter']);
      await new Promise((r) => setTimeout(r, 800));
      try {
        const after = context.cleanTabTitle(await context.getActiveTitle());
        if (same(after, hint)) return true;
      } catch (_) { /* ignore */ }
    }
  }

  if (ctx.url) {
    onStatus('Otvaram adresu…');
    await context.openUrl(ctx.url);
    await new Promise((r) => setTimeout(r, 2500));
    return true;
  }
  return false;
}

/** Pravi zapis konteksta iz podataka o prozoru. */
function makeCtx(w) {
  return {
    name: w.name,
    path: w.path,
    title: w.title,
    desktop: context.isDesktopContext({ name: w.name, title: w.title }),
  };
}

/** Ponovo računa vremensku osu (t) iz pauza (dt) nakon izmjene koraka. */
function recomputeTimeline() {
  let t = 0;
  for (const s of currentSteps) {
    t += (s.dt || 0);
    s.t = t;
  }
}

/** Jedinstveni odgovor za sve izmjene u editoru. */
function stepsPayload() {
  recomputeTimeline();
  return {
    ok: true,
    count: currentSteps.length,
    durationMs: currentSteps.length ? currentSteps[currentSteps.length - 1].t : 0,
    steps: summarize(currentSteps),
  };
}

// ---------------------------------------------------------------- events -> renderer
function wireEngineEvents() {
  recorder.on('step', (step) => {
    if (step.type !== 'mousemove') send('recorder:step', step);

  });
  recorder.on('error', (err) => send('engine:error', { where: 'recorder', message: String(err && err.message || err) }));

  player.on('progress', (p) => {
    const now = Date.now();
    if (now - lastProgressSent > 50 || p.index === p.total) {
      lastProgressSent = now;
      send('player:progress', p);
    }
  });
  player.on('loop', (l) => send('player:loop', l));
  player.on('error', (err) => send('engine:error', { where: 'player', message: String(err && err.message || err) }));
  player.on('done', ({ reason }) => {
    registerStopHotkey(false);
    setState('idle');
    send('player:done', { reason });
  });
}

// ---------------------------------------------------------------- IPC
function registerIpc() {
  ipcMain.handle('app:init', () => ({
    settings,
    macros: storage.list(),
    native: {
      recorder: recorder.available,
      player: player.available,
      recorderError: recorder.loadError ? String(recorder.loadError.message) : null,
      playerError: player.loadError ? String(player.loadError.message) : null,
      missingKeys: player.missingKeys || [],
    },
    version: app.getVersion(),
    state,
    currentSteps: currentSteps.length,
  }));

  ipcMain.handle('recorder:start', () => { startRecording(); return { ok: state === 'recording' }; });
  ipcMain.handle('recorder:stop', () => { stopRecording(); return { ok: true }; });

  ipcMain.handle('player:play', () => { startPlayback(); return { ok: true }; });
  ipcMain.handle('player:stop', () => { stopPlayback(); return { ok: true }; });

  ipcMain.handle('macro:list', () => storage.list());

  ipcMain.handle('macro:loadForPlay', (_e, id) => {
    const m = storage.get(id);
    if (!m) return { ok: false };
    currentSteps = m.steps.slice();
    currentContext = m.context || null;
    currentSmart = !!m.smart;
    currentFollow = !!m.follow;
    currentMacroId = id;
    refreshTrayMenu();
    return { ok: true, macro: { id: m.id, name: m.name, stepCount: m.steps.length, durationMs: m.durationMs }, preview: summarize(currentSteps) };
  });

  ipcMain.handle('macro:save', (_e, { name }) => {
    if (!currentSteps.length) return { ok: false, error: 'Nema snimljenih koraka.' };
    const m = storage.save({ id: currentMacroId, name, steps: currentSteps, context: currentContext, smart: currentSmart, follow: currentFollow });
    currentMacroId = m.id;
    return { ok: true, macro: m, macros: storage.list() };
  });

  ipcMain.handle('macro:rename', (_e, { id, name }) => {
    storage.rename(id, name);
    return { ok: true, macros: storage.list() };
  });

  ipcMain.handle('macro:delete', (_e, id) => {
    storage.delete(id);
    if (currentMacroId === id) { currentMacroId = null; }
    registerGlobalHotkeys();
    updateIgnoredKeycodes();
    return { ok: true, macros: storage.list() };
  });

  ipcMain.handle('macro:setHotkey', (_e, { id, hotkey }) => {
    const hk = hotkey || null;
    if (hk) {
      const reserved = new Set(Object.values(settings.hotkeys || {}));
      if (reserved.has(hk)) return { ok: false, error: 'Prečica je rezervisana (snimanje / puštanje / stop).' };
      const clash = storage.list().find((mm) => mm.id !== id && mm.hotkey === hk);
      if (clash) return { ok: false, error: `Prečicu već koristi „${clash.name}".` };
    }
    storage.setHotkey(id, hk);
    registerGlobalHotkeys();
    updateIgnoredKeycodes();
    const registered = hk ? globalShortcut.isRegistered(hk) : true;
    return { ok: true, macros: storage.list(), registered };
  });

  ipcMain.handle('macro:export', async (_e, id) => {
    const m = storage.get(id);
    if (!m) return { ok: false };
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Izvezi makro',
      defaultPath: `${m.name.replace(/[^\w\-]+/g, '_')}.acmigo.json`,
      filters: [{ name: 'Acmigo makro', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { ok: false };
    storage.exportToFile(id, filePath);
    return { ok: true };
  });

  ipcMain.handle('macro:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Uvezi makro',
      filters: [{ name: 'Acmigo makro', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths.length) return { ok: false };
    try {
      const m = storage.importFromFile(filePaths[0]);
      registerGlobalHotkeys();
      updateIgnoredKeycodes();
      return { ok: true, macro: m, macros: storage.list() };
    } catch (err) {
      return { ok: false, error: String(err.message) };
    }
  });

  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', (_e, patch) => {
    settings = storage.setSettings(patch);
    registerGlobalHotkeys();
    updateIgnoredKeycodes();
    return settings;
  });

  // Uključi/isključi kontekstno svjesnu reprodukciju za makro.
  ipcMain.handle('macro:setSmart', (_e, { id, smart }) => {
    const m = storage.setSmart(id, !!smart);
    if (!m) return { ok: false, error: 'Makro ne postoji.' };
    if (currentMacroId === id) currentSmart = !!smart;
    return { ok: true, macros: storage.list() };
  });

  // Ručno osvježi zapamćenu ciljnu aplikaciju za makro (uzmi trenutno aktivni prozor).
  ipcMain.handle('macro:grabContext', async (_e, id) => {
    if (!context.supported()) return { ok: false, error: 'Podržano samo na Windowsu.' };
    try {
      const w = await context.getActiveWindow();
      if (!w || !w.name) return { ok: false, error: 'Ne mogu prepoznati aktivni prozor.' };
      if (/acmigo|electron/i.test(w.name)) return { ok: false, error: 'Prebaci se na ciljnu aplikaciju pa pokušaj ponovo.' };
      const ctx = {
        name: w.name, path: w.path, title: w.title,
        desktop: context.isDesktopContext({ name: w.name, title: w.title }),
      };
      if (id) storage.setContext(id, ctx);
      if (!id || currentMacroId === id) currentContext = ctx;
      return { ok: true, context: ctx, macros: storage.list() };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  // Pametna reprodukcija za TRENUTNI snimak (prije nego što je sačuvan).
  ipcMain.handle('smart:set', (_e, on) => {
    currentSmart = !!on;
    if (currentMacroId) storage.setSmart(currentMacroId, currentSmart);
    return { ok: true, smart: currentSmart, context: currentContext, macros: storage.list() };
  });
  // Ručno postavi desktop kao ciljni kontekst (bez pogađanja).
  ipcMain.handle('context:setDesktop', (_e, id) => {
    const ctx = { name: 'explorer', path: '', title: 'Program Manager', desktop: true };
    currentContext = ctx;
    const targetId = id || currentMacroId;
    if (targetId) storage.setContext(targetId, ctx);
    return { ok: true, context: ctx, macros: storage.list() };
  });

  // Proba: uradi samo pripremu (fokus/otvaranje) bez puštanja koraka.
  ipcMain.handle('context:test', async () => {
    if (!context.supported()) return { ok: false, error: 'Podržano samo na Windowsu.' };
    if (!currentContext) return { ok: false, error: 'Nema zapamćene aplikacije za ovaj makro.' };

    // Proba mora da uradi ISTO što i pravo puštanje: aplikacija, pa tab,
    // pa prilagođavanje prozoru. Inače bi javljala uspjeh, a puštanje bi
    // se ponašalo drugačije.
    const status = (m) => send('player:prepare', { message: m });
    const lines = [];
    try {
      const r = await context.ensureTarget(currentContext, status);
      lines.push(r.ok ? ('✓ ' + r.message) : ('✕ ' + r.message));
      if (!r.ok) return { ok: false, message: lines.join(' | '), details: lines };

      // 2) tab u pretraživaču
      if (context.isBrowser(currentContext)) {
        const hint = context.cleanTabTitle(currentContext.title);
        if (!hint) {
          lines.push('• tab: nema zapamćenog naslova');
        } else {
          await new Promise((res) => setTimeout(res, 300));
          const okTab = await focusBrowserTab(currentContext, status);
          const now = context.cleanTabTitle(await context.getActiveTitle().catch(() => ''));
          lines.push(okTab ? `✓ tab: ${now || hint}` : `✕ tab „${hint}" nije nađen`);
        }
      }

      // 3) prilagođavanje prozoru
      if (currentFollow) {
        if (currentContext.desktop) {
          lines.push('• prati prozor: ne važi za desktop');
        } else if (!currentContext.rect) {
          lines.push('✕ prati prozor: nema zapamćene veličine (snimi ponovo)');
        } else {
          const cur = await context.getWindowRect(currentContext.name, currentContext.title);
          if (!cur) lines.push('✕ prati prozor: ne mogu očitati prozor');
          else {
            const same = cur.w === currentContext.rect.w && cur.h === currentContext.rect.h
              && cur.x === currentContext.rect.x && cur.y === currentContext.rect.y;
            lines.push(same
              ? '✓ prati prozor: prozor je isti kao pri snimanju'
              : `✓ prati prozor: prilagođavam ${currentContext.rect.w}×${currentContext.rect.h} → ${cur.w}×${cur.h}`);
          }
        }
      }

      const failed = lines.some((l) => l.startsWith('✕'));
      return { ok: !failed, message: lines.join(' | '), details: lines, context: currentContext };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('follow:set', (_e, on) => {
    currentFollow = !!on;
    if (currentMacroId) storage.setFollow(currentMacroId, currentFollow);
    return { ok: true, follow: currentFollow, hasRect: !!(currentContext && currentContext.rect), macros: storage.list() };
  });

  ipcMain.handle('smart:get', () => ({ ok: true, smart: currentSmart, context: currentContext }));

  // ---------------- editor koraka ----------------
  // Sve izmjene rade nad currentSteps; snimanje na disk ide preko "Sačuvaj makro".

  ipcMain.handle('steps:get', () => stepsPayload());

  ipcMain.handle('steps:delete', (_e, index) => {
    if (state !== 'idle') return { ok: false, error: 'Zaustavi reprodukciju prije izmjene.' };
    if (index < 0 || index >= currentSteps.length) return { ok: false, error: 'Korak ne postoji.' };
    const removed = currentSteps[index];
    // pauzu obrisanog koraka prebaci na sljedeći, da se ritam ne pomjeri
    if (currentSteps[index + 1]) {
      currentSteps[index + 1].dt = (currentSteps[index + 1].dt || 0) + (removed.dt || 0);
    }
    currentSteps.splice(index, 1);
    return stepsPayload();
  });

  ipcMain.handle('steps:setDelay', (_e, { index, dt }) => {
    if (state !== 'idle') return { ok: false, error: 'Zaustavi reprodukciju prije izmjene.' };
    if (index < 0 || index >= currentSteps.length) return { ok: false, error: 'Korak ne postoji.' };
    const v = Math.max(0, Math.round(Number(dt) || 0));
    currentSteps[index].dt = v;
    return stepsPayload();
  });

  ipcMain.handle('steps:insertWait', (_e, { index, dt }) => {
    if (state !== 'idle') return { ok: false, error: 'Zaustavi reprodukciju prije izmjene.' };
    const at = Math.max(0, Math.min(index, currentSteps.length));
    const v = Math.max(0, Math.round(Number(dt) || 1000));
    currentSteps.splice(at, 0, { type: 'wait', dt: v, t: 0 });
    return stepsPayload();
  });

  // Uklanja sve pomjeraje miša — makro tada samo "skače" na mjesta klikova.
  ipcMain.handle('steps:clearMoves', () => {
    if (state !== 'idle') return { ok: false, error: 'Zaustavi reprodukciju prije izmjene.' };
    const kept = [];
    let carry = 0;
    for (const s of currentSteps) {
      if (s.type === 'mousemove') { carry += (s.dt || 0); continue; }
      kept.push(carry ? { ...s, dt: (s.dt || 0) + carry } : s);
      carry = 0;
    }
    currentSteps = kept;
    return stepsPayload();
  });

  ipcMain.on('window:minimize', () => {
    if (!win) return;
    // Ako je uključeno "sakrij u tray pri minimiziranju" — idi u tray, inače običan minimize.
    if (settings.minimizeToTray) win.hide(); else win.minimize();
  });
  ipcMain.on('window:maximize', () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
  });
  ipcMain.on('window:close', () => cleanupAndExit());
  ipcMain.on('app:quit', () => cleanupAndExit());
}

// ---------------------------------------------------------------- lifecycle
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    storage = new Storage(app.getPath('userData'));
    settings = storage.getSettings();
    recorder = new Recorder();
    player = new Player();

    wireEngineEvents();
    registerIpc();
    createWindow();
    buildTray();
    registerGlobalHotkeys();
    updateIgnoredKeycodes();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') cleanupAndExit(); });
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
