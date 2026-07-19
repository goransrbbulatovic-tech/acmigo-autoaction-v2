'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** Sigurni most između UI-ja (renderer) i glavnog procesa. */
const api = {
  // inicijalni podaci
  init: () => ipcRenderer.invoke('app:init'),

  // snimanje
  startRecording: () => ipcRenderer.invoke('recorder:start'),
  stopRecording: () => ipcRenderer.invoke('recorder:stop'),

  // reprodukcija
  play: () => ipcRenderer.invoke('player:play'),
  stop: () => ipcRenderer.invoke('player:stop'),

  // makroi
  listMacros: () => ipcRenderer.invoke('macro:list'),
  loadForPlay: (id) => ipcRenderer.invoke('macro:loadForPlay', id),
  saveMacro: (name) => ipcRenderer.invoke('macro:save', { name }),
  renameMacro: (id, name) => ipcRenderer.invoke('macro:rename', { id, name }),
  deleteMacro: (id) => ipcRenderer.invoke('macro:delete', id),
  exportMacro: (id) => ipcRenderer.invoke('macro:export', id),
  importMacro: () => ipcRenderer.invoke('macro:import'),
  setMacroHotkey: (id, hotkey) => ipcRenderer.invoke('macro:setHotkey', { id, hotkey }),

  setMacroSmart: (id, smart) => ipcRenderer.invoke('macro:setSmart', { id, smart }),
  grabContext: (id) => ipcRenderer.invoke('macro:grabContext', id),

  setSmart: (on) => ipcRenderer.invoke('smart:set', on),
  getSmart: () => ipcRenderer.invoke('smart:get'),
  setFollow: (on) => ipcRenderer.invoke('follow:set', on),
  testContext: () => ipcRenderer.invoke('context:test'),
  setDesktopContext: (id) => ipcRenderer.invoke('context:setDesktop', id),

  // editor koraka
  getSteps: () => ipcRenderer.invoke('steps:get'),
  deleteStep: (index) => ipcRenderer.invoke('steps:delete', index),
  setStepDelay: (index, dt) => ipcRenderer.invoke('steps:setDelay', { index, dt }),
  insertWait: (index, dt) => ipcRenderer.invoke('steps:insertWait', { index, dt }),
  clearMoves: () => ipcRenderer.invoke('steps:clearMoves'),

  // podešavanja
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // kontrola prozora
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),
  quit: () => ipcRenderer.send('app:quit'),

  // događaji iz glavnog procesa
  on: (channel, cb) => {
    const allowed = [
      'state', 'recorder:step', 'recorder:stats', 'recorder:done', 'recorder:context',
      'player:prepare',
      'player:progress', 'player:loop', 'player:countdown', 'player:done',
      'engine:error',
    ];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_e, data) => cb(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld('acmigo', api);
