'use strict';

/**
 * Kontekst prozora — "gdje" se makro izvršava.
 *
 * Namjerno NE koristi nikakav nativni modul: sve ide preko PowerShella koji
 * već postoji na svakom Windowsu. Tako build na GitHubu ostaje nepromijenjen
 * (nema novih C++ zavisnosti koje bi mogle da puknu).
 */

const { execFile } = require('child_process');

const PS = 'powershell.exe';
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

const WIN_API = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class AcmigoWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@ -ErrorAction SilentlyContinue
`;

/** Pokreće PowerShell skriptu i vraća njen ispis. */
function runPS(script, timeout = 15000) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      return reject(new Error('Kontekstna reprodukcija je podržana samo na Windowsu.'));
    }
    execFile(PS, [...PS_ARGS, script], { timeout, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message).trim()));
        resolve(String(stdout || '').trim());
      });
  });
}

/**
 * Vraća podatke o trenutno aktivnom prozoru:
 * { pid, name, path, title } — npr. name "Premiere", path "C:\...\Adobe Premiere Pro.exe".
 */
async function getActiveWindow() {
  const script = `${WIN_API}
$h = [AcmigoWin]::GetForegroundWindow()
$p = 0
[void][AcmigoWin]::GetWindowThreadProcessId($h, [ref]$p)
$sb = New-Object System.Text.StringBuilder 512
[void][AcmigoWin]::GetWindowText($h, $sb, 512)
$proc = Get-Process -Id $p -ErrorAction SilentlyContinue
[pscustomobject]@{
  pid   = $p
  name  = if ($proc) { $proc.ProcessName } else { "" }
  path  = if ($proc) { $proc.Path } else { "" }
  title = $sb.ToString()
} | ConvertTo-Json -Compress
`;
  const out = await runPS(script);
  try {
    const o = JSON.parse(out);
    if (!o || !o.name) return null;
    return { pid: o.pid, name: o.name, path: o.path || '', title: o.title || '' };
  } catch (_) {
    return null;
  }
}

/**
 * Dovodi prozor procesa u prvi plan (i vraća ga ako je minimiziran).
 * Vraća true ako je uspjelo.
 *
 * Windows namjerno otežava "krađu" fokusa, pa se koriste dva puta:
 * prvo AppActivate (COM), pa P/Invoke SetForegroundWindow kao rezerva.
 */
async function focusProcess(processName, titleHint = '') {
  const hint = (titleHint || '').replace(/'/g, "''");
  const name = (processName || '').replace(/'/g, "''");
  const script = `${WIN_API}
$candidates = Get-Process -Name '${name}' -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 }
if (-not $candidates) { "NOPROC"; exit }

# ako imamo naslov iz snimanja, probaj da nađeš baš taj prozor
$target = $null
if ('${hint}' -ne '') {
  $target = $candidates | Where-Object { $_.MainWindowTitle -eq '${hint}' } | Select-Object -First 1
}
if (-not $target) { $target = $candidates | Select-Object -First 1 }

$h = $target.MainWindowHandle
if ([AcmigoWin]::IsIconic($h)) { [void][AcmigoWin]::ShowWindow($h, 9) }  # 9 = SW_RESTORE

$ok = $false
try {
  $shell = New-Object -ComObject WScript.Shell
  $ok = $shell.AppActivate($target.Id)
} catch { }
if (-not $ok) { $ok = [AcmigoWin]::SetForegroundWindow($h) }
Start-Sleep -Milliseconds 250
if ($ok) { "OK" } else { "FAIL" }
`;
  const out = await runPS(script);
  return out.includes('OK');
}

/** Da li proces uopšte radi (ima prozor)? */
async function isRunning(processName) {
  const name = (processName || '').replace(/'/g, "''");
  const out = await runPS(
    `if (Get-Process -Name '${name}' -ErrorAction SilentlyContinue) { "YES" } else { "NO" }`,
    8000,
  );
  return out.includes('YES');
}

/** Pokreće program sa zapamćene putanje. */
async function launch(exePath) {
  const p = (exePath || '').replace(/'/g, "''");
  await runPS(`Start-Process -FilePath '${p}'`, 15000);
}

/** Otvara adresu u podrazumijevanom pretraživaču (novi tab). */
async function openUrl(url) {
  const u = (url || '').replace(/'/g, "''");
  await runPS(`Start-Process '${u}'`, 15000);
}

/** Čeka da se pojavi prozor procesa (npr. dok se Premiere učitava). */
async function waitForWindow(processName, timeoutMs = 60000, pollMs = 1000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if (await isRunning(processName)) {
        const ok = await focusProcess(processName);
        if (ok) return true;
      }
    } catch (_) { /* ignore */ }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

/**
 * Vraća položaj i veličinu prozora ciljne aplikacije: { x, y, w, h }.
 * Koristi se da bi makro radio i kad je prozor pomjeren ili druge veličine.
 */
async function getWindowRect(processName, titleHint = '') {
  const name = (processName || '').replace(/'/g, "''");
  const hint = (titleHint || '').replace(/'/g, "''");
  const script = `${WIN_API}
$cands = Get-Process -Name '${name}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
if (-not $cands) { "NONE"; exit }
$t = $null
if ('${hint}' -ne '') { $t = $cands | Where-Object { $_.MainWindowTitle -eq '${hint}' } | Select-Object -First 1 }
if (-not $t) { $t = $cands | Select-Object -First 1 }
$r = New-Object AcmigoWin+RECT
if ([AcmigoWin]::GetWindowRect($t.MainWindowHandle, [ref]$r)) {
  [pscustomobject]@{ x = $r.Left; y = $r.Top; w = ($r.Right - $r.Left); h = ($r.Bottom - $r.Top) } | ConvertTo-Json -Compress
} else { "NONE" }
`;
  const out = await runPS(script);
  if (!out || out.includes('NONE')) return null;
  try {
    const o = JSON.parse(out);
    if (!o || !o.w || !o.h) return null;
    return { x: o.x, y: o.y, w: o.w, h: o.h };
  } catch (_) { return null; }
}

/** Da li je ciljna aplikacija pretraživač (Chrome, Edge, Firefox...)? */
function isBrowser(ctx) {
  const n = String((ctx && ctx.name) || '').toLowerCase();
  return /^(chrome|msedge|firefox|brave|opera|vivaldi|chromium)$/.test(n);
}

/** Naslov prozora bez sufiksa pretraživača — ostaje čist naslov taba. */
function cleanTabTitle(title) {
  return String(title || '')
    .replace(/\s+[-—]\s+(Google Chrome|Microsoft.?\s?Edge|Mozilla Firefox|Brave|Opera|Vivaldi|Chromium)\s*$/i, '')
    .replace(/^\(\d+\)\s*/, '')   // skini "(3)" iz naslova tipa "(3) Poruke - ..."
    .trim();
}

/** Naslov trenutno aktivnog prozora (za provjeru da li smo na pravom tabu). */
async function getActiveTitle() {
  const w = await getActiveWindow();
  return w ? w.title : '';
}

/**
 * Prikazuje desktop (minimizira sve prozore) — isto što i Win+D.
 * Potrebno kad je makro snimljen na desktopu: tamo nema "prozora" koji bi
 * se fokusirao, nego svi ostali moraju da se sklone.
 */
async function showDesktop() {
  await runPS(`(New-Object -ComObject Shell.Application).MinimizeAll()`, 10000);
  await new Promise((r) => setTimeout(r, 600));
  return true;
}

/**
 * Da li zapamćeni kontekst predstavlja desktop?
 * Windows desktop je proces "explorer" sa prozorom "Program Manager" (ili bez naslova).
 */
function isDesktopContext(ctx) {
  if (!ctx) return false;
  if (ctx.desktop) return true;
  const n = String(ctx.name || '').toLowerCase();
  const t = String(ctx.title || '').toLowerCase();
  return n === 'explorer' && (t === '' || t.includes('program manager') || t.includes('desktop'));
}

/**
 * Glavna funkcija: pobrini se da ciljna aplikacija bude otvorena i u fokusu.
 * ctx = { name, path, title, url, useUrl }
 * Vraća { ok, message }.
 */
async function ensureTarget(ctx, onStatus = () => {}) {
  if (!ctx || !ctx.name) return { ok: false, message: 'Makro nema zapamćenu ciljnu aplikaciju.' };

  // 0) Desktop — skloni sve prozore da se vidi radna površina
  if (isDesktopContext(ctx)) {
    onStatus('Prikazujem desktop…');
    try {
      await showDesktop();
      return { ok: true, message: 'Desktop je prikazan.' };
    } catch (err) {
      return { ok: false, message: 'Ne mogu prikazati desktop: ' + String(err.message || err) };
    }
  }

  // 1) Ako je stranica u pretraživaču i tražено je otvaranje po adresi
  if (ctx.useUrl && ctx.url) {
    onStatus('Otvaram adresu…');
    await openUrl(ctx.url);
    await new Promise((r) => setTimeout(r, 2500));
    try { await focusProcess(ctx.name, ctx.title); } catch (_) { /* ignore */ }
    return { ok: true, message: 'Adresa otvorena.' };
  }

  // 2) Aplikacija već radi → samo je dovedi u prvi plan
  onStatus(`Tražim ${ctx.name}…`);
  try {
    if (await isRunning(ctx.name)) {
      const ok = await focusProcess(ctx.name, ctx.title);
      if (ok) return { ok: true, message: `${ctx.name} je u prvom planu.` };
    }
  } catch (err) {
    return { ok: false, message: String(err.message || err) };
  }

  // 3) Ne radi → pokreni je i sačekaj da se prozor pojavi
  if (!ctx.path) return { ok: false, message: `${ctx.name} nije pokrenut, a putanja nije zapamćena.` };
  onStatus(`Pokrećem ${ctx.name}…`);
  try {
    await launch(ctx.path);
  } catch (err) {
    return { ok: false, message: 'Ne mogu pokrenuti: ' + String(err.message || err) };
  }
  onStatus(`Čekam da se ${ctx.name} učita…`);
  const appeared = await waitForWindow(ctx.name);
  return appeared
    ? { ok: true, message: `${ctx.name} je spreman.` }
    : { ok: false, message: `${ctx.name} se nije otvorio na vrijeme.` };
}

module.exports = {
  getActiveWindow,
  getWindowRect,
  isBrowser,
  cleanTabTitle,
  getActiveTitle,
  showDesktop,
  isDesktopContext,
  focusProcess,
  isRunning,
  launch,
  openUrl,
  waitForWindow,
  ensureTarget,
  supported: () => process.platform === 'win32',
};
