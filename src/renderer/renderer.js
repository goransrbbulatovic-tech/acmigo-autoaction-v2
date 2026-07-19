'use strict';

/* global acmigo */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const el = {
  body: document.body,
  stateBadge: $('#stateBadge'),
  deckState: $('#deckState'),
  deckSub: $('#deckSub'),
  statSteps: $('#statSteps'),
  statTime: $('#statTime'),
  statLoop: $('#statLoop'),
  btnRecord: $('#btnRecord'),
  btnPlay: $('#btnPlay'),
  btnStop: $('#btnStop'),
  btnSave: $('#btnSave'),
  stepsList: $('#stepsList'),
  stepsEmpty: $('#stepsEmpty'),
  stepsTitle: $('#stepsTitle'),
  libList: $('#libList'),
  libEmpty: $('#libEmpty'),
  libCount: $('#libCount'),
  progressWrap: $('#progressWrap'),
  progressFill: $('#progressFill'),
  progressText: $('#progressText'),
  countdown: $('#countdown'),
  countdownNum: $('#countdownNum'),
  toast: $('#toast'),
  nativeWarn: $('#nativeWarn'),
  nativeWarnDetail: $('#nativeWarnDetail'),
  saveModal: $('#saveModal'),
  macroName: $('#macroName'),
};

let hasSteps = false;
let currentState = 'idle';
let settings = null;
let liveCount = 0;
let toastTimer = null;

// ---------------------------------------------------------------- init
async function init() {
  const info = await acmigo.init();
  settings = info.settings;
  hasSteps = info.currentSteps > 0;

  applySettingsToUI();
  renderLibrary(info.macros);
  $('#aboutVer').textContent = 'v' + info.version;

  if (!info.native.recorder || !info.native.player) {
    el.nativeWarn.hidden = false;
    const det = [];
    if (info.native.recorderError) det.push('Recorder: ' + info.native.recorderError);
    if (info.native.playerError) det.push('Player: ' + info.native.playerError);
    el.nativeWarnDetail.textContent = det.join(' · ');
  }

  applyState(info.state || 'idle');
  updateHotkeyLabels();
}

// ---------------------------------------------------------------- state
function applyState(state, extra = {}) {
  currentState = state;
  el.body.dataset.state = state;

  const labels = {
    idle: 'Spreman',
    recording: 'Snimam',
    countdown: 'Odbrojavam',
    playing: 'Puštam',
  };
  el.stateBadge.textContent = labels[state] || state;

  const rec = state === 'recording';
  const busy = state === 'playing' || state === 'countdown' || state === 'preparing';

  // dugmad
  el.btnRecord.querySelector('.bb-lbl').textContent = rec ? 'Stop' : 'Snimaj';
  el.btnRecord.classList.toggle('active', rec);
  el.btnRecord.disabled = busy;
  el.btnPlay.disabled = rec || busy || !hasSteps;
  el.btnStop.disabled = !busy;
  el.btnSave.disabled = rec || busy || !hasSteps;

  // tekst palube
  if (rec) {
    el.deckState.textContent = 'Snimam…';
    el.deckSub.textContent = 'Radi šta treba — sve se bilježi. Stop: F6';
  } else if (state === 'playing') {
    el.deckState.textContent = 'Puštam…';
    el.deckSub.innerHTML = 'Prekid u sekundi — pritisni <kbd>Esc</kbd>';
  } else if (state === 'countdown') {
    el.deckState.textContent = 'Krećem za…';
  } else if (state === 'preparing') {
    el.deckState.textContent = 'Pripremam aplikaciju…';
    el.deckSub.textContent = 'Prebaci se na ciljni prozor';
  } else {
    el.deckState.textContent = hasSteps ? 'Makro spreman' : 'Spreman za snimanje';
    el.deckSub.innerHTML = hasSteps
      ? 'Pritisni Pusti ili prečicu <kbd>F7</kbd>'
      : 'Pritisni Snimaj ili prečicu <kbd>F6</kbd>';
  }

  if (!busy) { el.progressWrap.hidden = true; el.progressFill.style.width = '0%'; }
  if (state !== 'countdown') el.countdown.hidden = true;
}

// ---------------------------------------------------------------- helpers
function fmtTime(ms) {
  if (!ms) return '0.0s';
  if (ms < 1000) return (ms / 1000).toFixed(1) + 's';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

function toast(msg, ms = 2400) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
}

const BTN_NAMES = { 1: 'lijevi', 2: 'desni', 3: 'srednji' };

function stepView(s) {
  let cls = 'k'; let ico = '⌨'; let type = ''; let detail = '';
  switch (s.type) {
    case 'keydown': cls = 'k'; ico = '▼'; type = 'taster ▼'; detail = 'kod ' + s.keycode; break;
    case 'keyup':   cls = 'k'; ico = '▲'; type = 'taster ▲'; detail = 'kod ' + s.keycode; break;
    case 'mousedown': cls = 'm'; ico = '●'; type = 'klik ▼'; detail = `${BTN_NAMES[s.button] || s.button} · ${s.x},${s.y}`; break;
    case 'mouseup':   cls = 'm'; ico = '○'; type = 'klik ▲'; detail = `${BTN_NAMES[s.button] || s.button} · ${s.x},${s.y}`; break;
    case 'mousemove': cls = 'm'; ico = '↗'; type = 'pomjeraj'; detail = `${s.x},${s.y}`; break;
    case 'wheel':     cls = 'w'; ico = '⟳'; type = 'točkić'; detail = (s.rotation < 0 ? 'gore' : 'dolje'); break;
    case 'wait':      cls = 'p'; ico = '⏸'; type = 'čekanje'; detail = fmtTime(s.dt || 0); break;
    default: type = s.type;
  }
  return { cls, ico, type, detail, dt: s.dt || 0 };
}

function appendStepRow(s, animate = true) {
  const v = stepView(s);
  const row = document.createElement('div');
  row.className = 'step-row';
  if (!animate) row.style.animation = 'none';
  row.innerHTML =
    `<div class="step-ico ${v.cls}">${v.ico}</div>` +
    `<div class="step-type">${v.type}</div>` +
    `<div class="step-detail">${v.detail}</div>` +
    `<div class="step-dt">+${v.dt}ms</div>`;
  el.stepsList.appendChild(row);
  el.stepsEmpty.hidden = true;
}

let editMode = false;
let selectedMacroId = null;
let lastMacros = [];
let lastPreview = [];

function stepRowHtml(s, v) {
  const idx = (typeof s.i === 'number') ? s.i : -1;
  const edit = editMode && idx >= 0;
  return `<div class="step-ico ${v.cls}">${v.ico}</div>` +
    `<div class="step-type">${v.type}</div>` +
    `<div class="step-detail">${v.detail}</div>` +
    (edit
      ? `<div class="step-edit">` +
        `<input class="dt-input" type="number" min="0" step="10" value="${v.dt}" data-i="${idx}" title="Pauza prije ovog koraka (ms)" />` +
        `<span class="dt-unit">ms</span>` +
        `<button class="step-btn" data-act="wait" data-i="${idx}" title="Ubaci čekanje prije ovog koraka">＋⏸</button>` +
        `<button class="step-btn danger" data-act="del" data-i="${idx}" title="Obriši korak">✕</button>` +
        `</div>`
      : `<div class="step-dt">+${v.dt}ms</div>`);
}

function renderSteps(preview) {
  lastPreview = preview || [];
  el.stepsList.innerHTML = '';
  const tools = $('#stepsTools');
  if (tools) tools.hidden = !lastPreview.length;

  if (!lastPreview.length) {
    el.stepsEmpty.hidden = false;
    return;
  }
  el.stepsEmpty.hidden = true;

  const frag = document.createDocumentFragment();
  lastPreview.forEach((s) => {
    const v = stepView(s);
    const row = document.createElement('div');
    row.className = 'step-row' + (editMode ? ' editing' : '');
    row.style.animation = 'none';
    row.innerHTML = stepRowHtml(s, v);
    frag.appendChild(row);
  });
  el.stepsList.appendChild(frag);
}

// Primjenjuje odgovor editora: osvježi statistiku i listu.
function applyStepsResult(r) {
  if (!r || !r.ok) { if (r && r.error) toast(r.error); return; }
  hasSteps = r.count > 0;
  el.statSteps.textContent = r.count;
  el.statTime.textContent = fmtTime(r.durationMs);
  renderSteps(r.steps.preview);
  applyState(currentState);
}

function showCtx(ctx) {
  const n = $('#ctxName');
  if (!n) return;
  n.textContent = ctx && ctx.name ? ('→ ' + ctx.name) : '';
  n.title = ctx && ctx.title ? ctx.title : '';
}

function wireStepsEditor() {
  const smart = $('#smartMode');
  smart.addEventListener('change', async () => {
    const r = await acmigo.setSmart(smart.checked);
    if (r && r.ok) {
      showCtx(r.context);
      if (r.macros) renderLibrary(r.macros);
      if (smart.checked && !r.context) {
        toast('Nema zapamćene aplikacije — klikni „🎯 Zapamti aplikaciju".');
      } else {
        toast(smart.checked ? 'Pametna reprodukcija uključena' : 'Pametna reprodukcija isključena');
      }
    }
  });

  const chk = $('#editMode');
  chk.addEventListener('change', () => {
    editMode = chk.checked;
    renderSteps(lastPreview);
  });

  const follow = $('#followWin');
  follow.addEventListener('change', async () => {
    const r = await acmigo.setFollow(follow.checked);
    if (r && r.ok) {
      if (r.macros) renderLibrary(r.macros);
      if (follow.checked && !r.hasRect) {
        toast('Nema zapamćene veličine prozora — snimi makro ponovo da bi se zapamtila.');
      } else {
        toast(follow.checked ? 'Prilagođavanje prozoru uključeno' : 'Prilagođavanje prozoru isključeno');
      }
    }
  });

  $('#btnDesktopCtx').addEventListener('click', async () => {
    const r = await acmigo.setDesktopContext(selectedMacroId || null);
    if (r.ok) {
      showCtx(r.context);
      if (r.macros) renderLibrary(r.macros);
      toast('Cilj postavljen: desktop');
    }
  });

  $('#btnTestCtx').addEventListener('click', async () => {
    toast('Probam pripremu…');
    const r = await acmigo.testContext();
    const txt = r.message || r.error || (r.ok ? 'Uspjelo' : 'Nije uspjelo');
    toast(txt, 9000);
    el.deckState.textContent = r.ok ? 'Provjera prošla' : 'Provjera: ima problema';
  });

  $('#btnGrabCtx').addEventListener('click', () => {
    // Odbrojavanje sa prikazom — imaš vremena da nađeš pravi prozor ili tab.
    let left = 10;
    const tick = async () => {
      if (left > 0) {
        toast(`Prebaci se na ciljnu aplikaciju — hvatam za ${left}…`, 1100);
        left -= 1;
        setTimeout(tick, 1000);
        return;
      }
      const r = await acmigo.grabContext(selectedMacroId || null);
      if (r.ok) {
        toast('Zapamćeno: ' + r.context.name);
        if (r.macros) renderLibrary(r.macros);
      } else toast('Greška: ' + (r.error || ''));
    };
    tick();
  });

  $('#btnClearMoves').addEventListener('click', async () => {
    const r = await acmigo.clearMoves();
    applyStepsResult(r);
    if (r && r.ok) toast('Pomjeraji miša uklonjeni');
  });

  // izmjena pauze
  el.stepsList.addEventListener('change', async (e) => {
    const inp = e.target.closest('.dt-input');
    if (!inp) return;
    const r = await acmigo.setStepDelay(parseInt(inp.dataset.i, 10), inp.value);
    applyStepsResult(r);
  });

  // brisanje koraka i ubacivanje čekanja
  el.stepsList.addEventListener('click', async (e) => {
    const btn = e.target.closest('.step-btn');
    if (!btn) return;
    const i = parseInt(btn.dataset.i, 10);
    if (btn.dataset.act === 'del') {
      applyStepsResult(await acmigo.deleteStep(i));
    } else if (btn.dataset.act === 'wait') {
      // Electron ne podržava prompt() — ubaci 1s čekanja pa ga doštelaj u polju.
      const r = await acmigo.insertWait(i, 1000);
      applyStepsResult(r);
      if (r && r.ok) toast('Ubačeno čekanje 1000 ms — promijeni vrijednost u polju');
    }
  });
}

// ---------------------------------------------------------------- library
function renderLibrary(macros) {
  lastMacros = macros;
  el.libList.innerHTML = '';
  el.libCount.textContent = macros.length;
  el.libEmpty.hidden = macros.length > 0;

  macros.forEach((m) => {
    const item = document.createElement('div');
    item.className = 'lib-item';
    item.dataset.id = m.id;
    item.setAttribute('role', 'listitem');
    item.innerHTML =
      `<div class="lib-name">${escapeHtml(m.name)}${m.hotkey ? `<span class="lib-hk">${escapeHtml(m.hotkey)}</span>` : ''}</div>` +
      `<div class="lib-sub">${m.stepCount} koraka · ${fmtTime(m.durationMs)}</div>` +
      (m.context ? `<div class="lib-ctx">${m.smart ? '🎯' : '○'} ${escapeHtml(m.context.name)}</div>` : '') +
      `<div class="lib-actions">` +
      `<button class="mini" data-act="play">Pusti</button>` +
      `<button class="mini" data-act="hotkey">Prečica</button>` +
      `<button class="mini${m.smart ? ' on' : ''}" data-act="smart" title="Sam pronađi i otvori ciljnu aplikaciju prije puštanja">Pametno</button>` +
      `<button class="mini" data-act="export">Izvezi</button>` +
      `<button class="mini danger" data-act="delete">Obriši</button>` +
      `</div>`;

    item.addEventListener('click', (e) => {
      const act = e.target.getAttribute && e.target.getAttribute('data-act');
      if (act) { e.stopPropagation(); handleLibAction(act, m); return; }
      selectMacro(m.id, item);
    });
    el.libList.appendChild(item);
  });
}

async function selectMacro(id, item) {
  $$('.lib-item').forEach((n) => n.classList.remove('active'));
  if (item) item.classList.add('active');
  selectedMacroId = id;
  const sm = $('#smartMode');
  const m0 = (lastMacros || []).find((x) => x.id === id);
  if (sm && m0) { sm.checked = !!m0.smart; showCtx(m0.context); }
  const fw = $('#followWin');
  if (fw && m0) fw.checked = !!m0.follow;
  const res = await acmigo.loadForPlay(id);
  if (!res.ok) return;
  hasSteps = true;
  liveCount = res.macro.stepCount;
  el.statSteps.textContent = res.macro.stepCount;
  el.statTime.textContent = fmtTime(res.macro.durationMs);
  el.stepsTitle.textContent = 'Makro: ' + res.macro.name;
  renderSteps(res.preview.preview);
  applyState('idle');
  toast(`Učitan „${res.macro.name}"`);
}

async function handleLibAction(act, m) {
  if (act === 'play') {
    await acmigo.loadForPlay(m.id);
    hasSteps = true;
    await acmigo.play();
  } else if (act === 'hotkey') {
    openHotkeyModal(m);
  } else if (act === 'smart') {
    if (!m.context && !m.smart) {
      toast('Ovaj makro nema zapamćenu aplikaciju — prebaci se na nju pa klikni "Zapamti aplikaciju".');
    }
    const r = await acmigo.setMacroSmart(m.id, !m.smart);
    if (r.ok) {
      renderLibrary(r.macros);
      toast(!m.smart ? 'Pametna reprodukcija uključena' : 'Pametna reprodukcija isključena');
    } else toast('Greška: ' + (r.error || ''));
  } else if (act === 'export') {
    const r = await acmigo.exportMacro(m.id);
    if (r.ok) toast('Makro izvezen');
  } else if (act === 'delete') {
    const r = await acmigo.deleteMacro(m.id);
    renderLibrary(r.macros);
    toast('Makro obrisan');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ---------------------------------------------------------------- settings UI
function applySettingsToUI() {
  $('#setRepeat').value = settings.repeat;
  $('#setLoopForever').checked = settings.loopForever;
  $('#setSpeed').value = settings.speed;
  $('#speedVal').textContent = Number(settings.speed).toFixed(2) + '×';
  $('#setCountdown').value = settings.countdown;
  $('#cdVal').textContent = settings.countdown + 's';
  $('#setCaptureMove').checked = settings.captureMouseMove;
  const sm = settings.scrollStrength || 100;
  $('#setScroll').value = sm;
  $('#scrollVal').textContent = sm + '%';
  $('#setThrottle').value = settings.moveThrottleMs;
  $('#throttleVal').textContent = settings.moveThrottleMs + ' ms';
  $('#setTray').checked = settings.minimizeToTray;
  $('#setRepeat').disabled = settings.loopForever;
}

function updateHotkeyLabels() {
  const h = settings.hotkeys || {};
  const short = (k) => (k === 'Escape' ? 'Esc' : k);
  ['#hkRecord'].forEach((s) => { if ($(s)) $(s).textContent = short(h.toggleRecord); });
  if ($('#hkRec2')) $('#hkRec2').textContent = short(h.toggleRecord);
  if ($('#hkPlay2')) $('#hkPlay2').textContent = short(h.play);
  if ($('#hkStop2')) $('#hkStop2').textContent = short(h.stop);
}

async function saveSettings(patch) {
  settings = await acmigo.setSettings(patch);
}

function wireSettings() {
  $('#setRepeat').addEventListener('change', (e) => {
    const v = Math.max(1, parseInt(e.target.value, 10) || 1);
    e.target.value = v; saveSettings({ repeat: v });
  });
  $('#setLoopForever').addEventListener('change', (e) => {
    $('#setRepeat').disabled = e.target.checked;
    saveSettings({ loopForever: e.target.checked });
  });
  $('#setSpeed').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('#speedVal').textContent = v.toFixed(2) + '×';
    saveSettings({ speed: v });
  });
  $('#setCountdown').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    $('#cdVal').textContent = v + 's';
    saveSettings({ countdown: v });
  });
  $('#setScroll').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    $('#scrollVal').textContent = v + '%';
    saveSettings({ scrollStrength: v });
  });
  $('#setCaptureMove').addEventListener('change', (e) => saveSettings({ captureMouseMove: e.target.checked }));
  $('#setThrottle').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    $('#throttleVal').textContent = v + ' ms';
    saveSettings({ moveThrottleMs: v });
  });
  $('#setTray').addEventListener('change', (e) => saveSettings({ minimizeToTray: e.target.checked }));
}

// ---------------------------------------------------------------- controls
function wireControls() {
  // window
  $('#winMin').addEventListener('click', () => acmigo.minimize());
  $('#winMax').addEventListener('click', () => acmigo.maximize());
  $('#winClose').addEventListener('click', () => acmigo.closeWindow());

  // tabs
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.remove('active'));
    $$('.panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $(`.panel[data-panel="${tab.dataset.tab}"]`).classList.add('active');
  }));

  // record toggle
  el.btnRecord.addEventListener('click', () => {
    if (currentState === 'recording') acmigo.stopRecording();
    else if (currentState === 'idle') {
      liveCount = 0;
      el.stepsList.innerHTML = '';
      el.stepsEmpty.hidden = false;
      el.stepsTitle.textContent = 'Snimljeni koraci';
      acmigo.startRecording();
    }
  });

  el.btnPlay.addEventListener('click', () => acmigo.play());
  el.btnStop.addEventListener('click', () => acmigo.stop());

  // import
  $('#btnImport').addEventListener('click', async () => {
    const r = await acmigo.importMacro();
    if (r.ok) { renderLibrary(r.macros); toast(`Uvezen „${r.macro.name}"`); }
    else if (r.error) toast('Greška: ' + r.error);
  });

  // save modal
  el.btnSave.addEventListener('click', () => openSaveModal());
  $('#saveCancel').addEventListener('click', () => { el.saveModal.hidden = true; });
  $('#saveConfirm').addEventListener('click', () => confirmSave());
  el.macroName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmSave();
    if (e.key === 'Escape') el.saveModal.hidden = true;
  });
  el.saveModal.addEventListener('click', (e) => { if (e.target === el.saveModal) el.saveModal.hidden = true; });
}

function openSaveModal() {
  el.macroName.value = 'Makro ' + new Date().toLocaleString('sr-RS', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
  el.saveModal.hidden = false;
  setTimeout(() => { el.macroName.focus(); el.macroName.select(); }, 30);
}

// ---------------------------------------------------------------- hotkey modal
let hkTargetId = null;
let hkValue = null;

function openHotkeyModal(m) {
  hkTargetId = m.id;
  hkValue = m.hotkey || null;
  $('#hkForName').textContent = `„${m.name}"`;
  $('#hkCapture').textContent = hkValue || 'Klikni ovdje pa pritisni tipku…';
  $('#hotkeyModal').hidden = false;
  setTimeout(() => $('#hkCapture').focus(), 30);
}

// Pretvara pritisak tipke u Electron „accelerator" (npr. "F2", "CommandOrControl+Shift+K").
function eventToAccelerator(e) {
  if (['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(e.key)) return null; // sam modifikator nije dovoljan
  const parts = [];
  if (e.ctrlKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Super');

  let key = e.key;
  if (/^F\d{1,2}$/.test(key)) { /* F1..F24 ostaje */ }
  else if (key === ' ' || key === 'Spacebar') key = 'Space';
  else if (key === 'Escape' || key === 'Esc') return null; // rezervisano za STOP
  else if (key === 'Enter') key = 'Return';
  else if (key === 'ArrowUp') key = 'Up';
  else if (key === 'ArrowDown') key = 'Down';
  else if (key === 'ArrowLeft') key = 'Left';
  else if (key === 'ArrowRight') key = 'Right';
  else if (key.length === 1) key = key.toUpperCase();
  // ostalo (Tab, Delete, Home, End, PageUp...) prolazi kako jeste
  parts.push(key);
  return parts.join('+');
}

function wireHotkeyModal() {
  const cap = $('#hkCapture');
  cap.addEventListener('keydown', (e) => {
    e.preventDefault();
    const acc = eventToAccelerator(e);
    if (acc) { hkValue = acc; cap.textContent = acc; }
  });
  $('#hkClear').addEventListener('click', () => { hkValue = null; cap.textContent = 'Bez prečice'; });
  $('#hkCancel').addEventListener('click', () => { $('#hotkeyModal').hidden = true; });
  $('#hkSave').addEventListener('click', async () => {
    const r = await acmigo.setMacroHotkey(hkTargetId, hkValue);
    $('#hotkeyModal').hidden = true;
    if (r.ok) {
      renderLibrary(r.macros);
      if (hkValue && r.registered === false) toast('Prečica sačuvana, ali je sistem nije prihvatio (možda je zauzeta).');
      else toast(hkValue ? `Prečica ${hkValue} postavljena` : 'Prečica uklonjena');
    } else {
      toast('Greška: ' + (r.error || 'nije postavljeno'));
    }
  });
  $('#hotkeyModal').addEventListener('click', (e) => { if (e.target.id === 'hotkeyModal') $('#hotkeyModal').hidden = true; });
}

async function confirmSave() {
  const name = el.macroName.value.trim() || 'Novi makro';
  const r = await acmigo.saveMacro(name);
  el.saveModal.hidden = true;
  if (r.ok) { renderLibrary(r.macros); toast(`Sačuvan „${name}"`); }
  else toast('Greška: ' + (r.error || 'nije sačuvano'));
}

// ---------------------------------------------------------------- engine events
function wireEngineEvents() {
  acmigo.on('state', (d) => applyState(d.state, d));

  acmigo.on('recorder:step', (s) => {
    liveCount += 1;
    // živi prikaz: zadrži DOM lakim (max ~200 redova)
    appendStepRow(s, true);
    while (el.stepsList.children.length > 200) el.stepsList.removeChild(el.stepsList.firstChild);
    el.stepsList.scrollTop = el.stepsList.scrollHeight;
  });

  acmigo.on('recorder:stats', (d) => {
    el.statSteps.textContent = d.count;
    el.statTime.textContent = fmtTime(d.durationMs);
  });

  acmigo.on('recorder:done', (d) => {
    hasSteps = d.count > 0;
    el.statSteps.textContent = d.count;
    el.statTime.textContent = fmtTime(d.durationMs);
    el.stepsTitle.textContent = 'Snimljeni koraci';
    renderSteps(d.steps.preview);
    applyState('idle');
    if (d.count > 0) toast(`Snimljeno ${d.count} koraka`);
  });

  acmigo.on('recorder:context', (ctx) => showCtx(ctx));

  acmigo.on('player:prepare', (d) => {
    el.deckState.textContent = d.message || 'Pripremam…';
  });

  acmigo.on('player:countdown', (d) => {
    el.countdown.hidden = false;
    el.countdownNum.textContent = d.value;
    el.countdownNum.style.animation = 'none';
    // restart animacije
    void el.countdownNum.offsetWidth;
    el.countdownNum.style.animation = '';
  });

  acmigo.on('player:progress', (p) => {
    el.progressWrap.hidden = false;
    const pct = Math.round((p.index / p.total) * 100);
    el.progressFill.style.width = pct + '%';
    const loopTxt = p.loops === Infinity || p.loops === null
      ? `petlja ${p.loop}/∞`
      : `petlja ${p.loop}/${p.loops}`;
    el.progressText.textContent = `korak ${p.index}/${p.total} · ${loopTxt}`;
    el.statSteps.textContent = `${p.index}/${p.total}`;
  });

  acmigo.on('player:loop', (l) => {
    el.statLoop.textContent = (l.loops === Infinity || l.loops === null) ? `${l.loop}/∞` : `${l.loop}/${l.loops}`;
  });

  acmigo.on('player:done', (d) => {
    el.statLoop.textContent = '—';
    // vrati brojač na ukupan broj koraka (da ne ostane "230/875")
    acmigo.getSteps().then((r) => {
      if (r && r.ok) {
        el.statSteps.textContent = r.count;
        el.statTime.textContent = fmtTime(r.durationMs);
      }
    }).catch(() => { /* ignore */ });
    applyState('idle');
    if (d.reason === 'stopped') toast('Reprodukcija zaustavljena');
    else if (d.reason === 'finished') toast('Reprodukcija završena');
    else if (d.reason === 'error') toast('Greška pri reprodukciji');
  });

  acmigo.on('engine:error', (d) => toast('Greška (' + d.where + '): ' + d.message));
}

// ---------------------------------------------------------------- go
init();
wireControls();
wireSettings();
wireHotkeyModal();
wireStepsEditor();
wireEngineEvents();
