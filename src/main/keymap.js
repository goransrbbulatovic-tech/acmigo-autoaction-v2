'use strict';

/**
 * Mapiranje između uiohook-napi (snimanje) i @nut-tree-fork/nut-js (reprodukcija).
 *
 * Radi se defanzivno: za svaki par [uiohookName, nutName] rezolvujemo obje strane
 * dinamički. Ako neka verzija biblioteke nema određeni taster, taj par se preskače
 * uz upozorenje umjesto da cijela aplikacija pukne. Tako je alat otporan na razlike
 * između verzija biblioteka.
 */

// Parovi: [ime u uiohook UiohookKey, ime u nut-js Key]
const NAME_PAIRS = [
  // Kontrolni / navigacioni
  ['Backspace', 'Backspace'],
  ['Tab', 'Tab'],
  ['Enter', 'Return'],
  ['CapsLock', 'CapsLock'],
  ['Escape', 'Escape'],
  ['Space', 'Space'],
  ['PageUp', 'PageUp'],
  ['PageDown', 'PageDown'],
  ['End', 'End'],
  ['Home', 'Home'],
  ['ArrowLeft', 'Left'],
  ['ArrowUp', 'Up'],
  ['ArrowRight', 'Right'],
  ['ArrowDown', 'Down'],
  ['Insert', 'Insert'],
  ['Delete', 'Delete'],

  // Modifikatori
  ['Ctrl', 'LeftControl'],
  ['CtrlRight', 'RightControl'],
  ['Alt', 'LeftAlt'],
  ['AltRight', 'RightAlt'],
  ['Shift', 'LeftShift'],
  ['ShiftRight', 'RightShift'],
  ['Meta', 'LeftSuper'],
  ['MetaRight', 'RightSuper'],

  // Interpunkcija (US layout imena u uiohook)
  ['Semicolon', 'Semicolon'],
  ['Equal', 'Equal'],
  ['Comma', 'Comma'],
  ['Minus', 'Minus'],
  ['Period', 'Period'],
  ['Slash', 'Slash'],
  ['Backquote', 'Grave'],
  ['BracketLeft', 'LeftBracket'],
  ['Backslash', 'Backslash'],
  ['BracketRight', 'RightBracket'],
  ['Quote', 'Quote'],

  // Funkcijski tasteri F1–F24
  ...Array.from({ length: 24 }, (_, i) => [`F${i + 1}`, `F${i + 1}`]),

  // Sistemski
  ['PrintScreen', 'Print'],
  ['ScrollLock', 'ScrollLock'],
  ['Pause', 'Pause'],
  ['NumLock', 'NumLock'],

  // Numpad
  ['Numpad0', 'NumPad0'],
  ['Numpad1', 'NumPad1'],
  ['Numpad2', 'NumPad2'],
  ['Numpad3', 'NumPad3'],
  ['Numpad4', 'NumPad4'],
  ['Numpad5', 'NumPad5'],
  ['Numpad6', 'NumPad6'],
  ['Numpad7', 'NumPad7'],
  ['Numpad8', 'NumPad8'],
  ['Numpad9', 'NumPad9'],
  ['NumpadMultiply', 'Multiply'],
  ['NumpadAdd', 'Add'],
  ['NumpadSubtract', 'Subtract'],
  ['NumpadDecimal', 'Decimal'],
  ['NumpadDivide', 'Divide'],
];

// Slova A–Z (isto ime u obje biblioteke)
for (let c = 65; c <= 90; c++) {
  const ch = String.fromCharCode(c);
  NAME_PAIRS.push([ch, ch]);
}

// Cifre iz gornjeg reda: uiohook '0'..'9'  ->  nut-js Num0..Num9
for (let d = 0; d <= 9; d++) {
  NAME_PAIRS.push([String(d), `Num${d}`]);
}

/**
 * Gradi Map: uiohook keycode (broj) -> nut-js Key vrijednost.
 * @param {object} UiohookKey  Objekat imena->keycode iz uiohook-napi
 * @param {object} Key         Enum iz nut-js
 * @returns {{map: Map<number, any>, missing: string[]}}
 */
function buildKeyMap(UiohookKey, Key) {
  const map = new Map();
  const missing = [];

  for (const [uName, nName] of NAME_PAIRS) {
    const code = UiohookKey ? UiohookKey[uName] : undefined;
    const nutKey = Key ? Key[nName] : undefined;
    if (code === undefined || nutKey === undefined) {
      missing.push(`${uName}->${nName}`);
      continue;
    }
    map.set(code, nutKey);
  }

  return { map, missing };
}

/**
 * Mapira uiohook broj dugmeta miša na nut-js Button.
 * uiohook: 1=lijevo, 2=desno, 3=srednje (4/5 = bočni).
 */
function buildButtonMap(Button) {
  const m = new Map();
  if (!Button) return m;
  if (Button.LEFT !== undefined) m.set(1, Button.LEFT);
  if (Button.RIGHT !== undefined) m.set(2, Button.RIGHT);
  if (Button.MIDDLE !== undefined) m.set(3, Button.MIDDLE);
  return m;
}

module.exports = { buildKeyMap, buildButtonMap };
