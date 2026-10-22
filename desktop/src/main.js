// SerieX desktop shell: starts the SerieX Books and SerieX Payroll servers that ship inside the
// app, shows a "Starting SerieX…" window until both answer, then opens the app used last.
// Both apps run in the same window (their own app switcher, or the Go menu), from 127.0.0.1.
'use strict';
const { app, BrowserWindow, dialog, shell, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const settings = require('./settings');
const logger = require('./log');
const menu = require('./menu');
const splash = require('./splash');
const { ServerManager, SERVERS } = require('./servers');

const { log } = logger;
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const APP_ID = 'com.seriex.desktop';
const START_TIMEOUT_MS = 30000;
const ZOOM_MIN = -3;
const ZOOM_MAX = 3;
// About box: the same copyright as the installers (scripts/build.mjs) and the license of package.json.
const COPYRIGHT = '© 2026 SerieX contributors';
const LICENSE_TEXT = 'Free software under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)';

// ---- data folder: <app data>/SerieX (SERIEX_DATA_DIR overrides it, e.g. for tests) ----
// On macOS it is made 0700 (only this user), and tightened to 0700 when it is more open.
// Everything this process and the servers it starts create (company files, backups, logs,
// saved exports) is private to the user signed in to the computer: 0600 files and 0700
// folders, whatever mode a program asks for (the servers inherit this setting). Windows has
// no such permission bits.
if (!IS_WIN) process.umask(0o077);
app.setName('SerieX');
const dataDir = process.env.SERIEX_DATA_DIR ? path.resolve(process.env.SERIEX_DATA_DIR) : path.join(app.getPath('appData'), 'SerieX');
const logsDir = path.join(dataDir, 'logs');
const dataDirOldMode = settings.privateDir(dataDir);
app.setPath('userData', dataDir);
app.setPath('sessionData', path.join(dataDir, 'Session')); // the browser's own files (local storage, caches)
app.setAppLogsPath(logsDir);
if (IS_WIN) app.setAppUserModelId(APP_ID);

const state = {
  servers: null,
  ready: false,
  quitRequested: false,
  serversStopped: false,
  exitDialog: {},
};

function resourcesPaths() {
  if (app.isPackaged) {
    return { binDir: path.join(process.resourcesPath, 'servers'), webDir: process.resourcesPath };
  }
  const goos = IS_WIN ? 'windows' : IS_MAC ? 'darwin' : 'linux';
  const goarch = process.arch === 'x64' ? 'amd64' : process.arch;
  const build = path.join(__dirname, '..', 'build');
  return { binDir: path.join(build, 'servers', `${goos}-${goarch}`), webDir: build };
}

// ---- addresses ----

function appUrl(key) {
  return state.servers.url(key);
}

/** 'books' / 'payroll' when url is one of the two local apps, else null. */
function appForUrl(url) {
  if (!state.servers) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' || (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost')) return null;
  for (const key of Object.keys(SERVERS)) if (Number(u.port) === state.servers.ports[key]) return key;
  return null;
}

function isWebUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function openExternal(url) {
  log(`opening in the system browser: ${url}`);
  shell.openExternal(url).catch((e) => log('could not open the browser', e));
}

// ---- page helpers ----

/** Runs a script in the page, giving up after `ms` (a page busy with a print dialog does not answer). */
function pageEval(win, js, ms = 1500, fallback = null) {
  if (!win || win.isDestroyed()) return Promise.resolve(fallback);
  return Promise.race([
    win.webContents.executeJavaScript(js, false).catch(() => fallback),
    new Promise((r) => setTimeout(() => r(fallback), ms)),
  ]);
}

/** True when a window inside the page shows the "unsaved changes" mark. */
async function hasUnsavedWork(win) {
  return (await pageEval(win, `!!document.querySelector('.sx-win-dirty, .sx-wtab-dirty, .sx-wtab-isdirty')`, 1500, false)) === true;
}

/** Id of the company open in the page (the app keeps it in local storage), or null when none is open. */
async function openCompanyId(win) {
  const key = appForUrl(win.webContents.getURL());
  if (!key) return null;
  const storageKey = key === 'books' ? 'sx.lastCompany' : 'sxp.lastCompany';
  const js = `(() => { try { return document.title.includes(' - SerieX') ? localStorage.getItem(${JSON.stringify(storageKey)}) : null; } catch { return null; } })()`;
  const id = await pageEval(win, js);
  return typeof id === 'string' && id ? id : null;
}

async function confirmLeave(win, action) {
  if (!(await hasUnsavedWork(win))) return true;
  const r = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: [action, 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'Some windows have unsaved changes.',
    detail: 'If you continue, those changes are lost. Choose Cancel to go back and save them.',
  });
  return r.response === 0;
}

// ---- windows ----

function mainWindows() {
  return BrowserWindow.getAllWindows().filter((w) => w.sxMain && !w.isDestroyed());
}

function visibleOnSomeDisplay(b) {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 10 && b.y < a.y + a.height - 80;
  });
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  const b = win.getNormalBounds();
  settings.set('window', { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() });
}

function applyZoom(win) {
  const level = Number(settings.get('zoom', 0)) || 0;
  win.webContents.setZoomLevel(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level)));
}

function zoom(win, dir) {
  if (!win || win.isDestroyed()) return;
  const cur = win.webContents.getZoomLevel();
  const next = dir === 0 ? 0 : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cur + dir * 0.5));
  settings.set('zoom', next);
  for (const w of mainWindows()) w.webContents.setZoomLevel(next);
}

async function reload(win) {
  if (await confirmLeave(win, 'Reload')) win.webContents.reload();
}

function createMainWindow(url) {
  const saved = settings.get('window', null);
  const others = mainWindows();
  const opts = {
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'SerieX',
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
    },
  };
  let maximize = false;
  if (others.length) {
    const b = (BrowserWindow.getFocusedWindow() || others[others.length - 1]).getBounds();
    Object.assign(opts, { x: b.x + 30, y: b.y + 30, width: b.width, height: b.height });
  } else if (saved && saved.width >= 600 && saved.height >= 400) {
    opts.width = saved.width;
    opts.height = saved.height;
    if (Number.isFinite(saved.x) && Number.isFinite(saved.y) && visibleOnSomeDisplay(saved)) Object.assign(opts, { x: saved.x, y: saved.y });
    maximize = !!saved.maximized;
  }
  const win = new BrowserWindow(opts);
  win.sxMain = true;
  wireWindow(win);
  let shown = false;
  const reveal = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    if (maximize) win.maximize();
    win.show();
    splash.close();
  };
  win.once('ready-to-show', reveal);
  setTimeout(reveal, 8000);
  log(`opening a window at ${url}`);
  win.loadURL(url).catch((e) => log(`could not load ${url}`, e));
  return win;
}

function wireWindow(win) {
  const wc = win.webContents;

  // window.open / target=_blank: a local app address gets a new SerieX window, a web address the browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (appForUrl(url)) createMainWindow(url);
    else if (isWebUrl(url)) openExternal(url);
    else log(`blocked a new window for ${url}`);
    return { action: 'deny' };
  });

  // Moving between SerieX Books and SerieX Payroll stays in this window; anything else is refused.
  const guard = (e, url) => {
    if (appForUrl(url)) return;
    e.preventDefault();
    if (isWebUrl(url)) openExternal(url);
    else log(`blocked navigation to ${url}`);
  };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
  wc.on('will-attach-webview', (e) => e.preventDefault());

  wc.on('did-navigate', (_e, url) => {
    const key = appForUrl(url);
    if (key) settings.set('lastApp', key);
  });
  wc.on('did-finish-load', () => applyZoom(win));
  wc.on('before-input-event', (e, input) => {
    if (menu.handleShortcut(menuCtx, win, input)) e.preventDefault();
  });
  wc.on('context-menu', (_e, params) => menu.contextMenu(menuCtx, win, params));
  wc.on('render-process-gone', async (_e, details) => {
    log(`page stopped (${details.reason}, exit code ${details.exitCode})`);
    if (details.reason === 'clean-exit' || win.isDestroyed()) return;
    const r = await dialog.showMessageBox(win, {
      type: 'error',
      buttons: ['Reload', 'Close Window'],
      defaultId: 0,
      message: 'This SerieX window stopped working.',
      detail: 'Reload it to continue. Changes that were not saved are lost.',
    });
    if (win.isDestroyed()) return;
    if (r.response === 0) wc.reload();
    else win.destroy();
  });
  // The print and save dialogs open as sheets on macOS; noted in the log for support.
  win.on('sheet-begin', () => log('dialog opened (sheet)'));
  win.on('sheet-end', () => log('dialog closed (sheet)'));

  let saveTimer = null;
  const saveSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowState(win), 800);
  };
  win.on('resize', saveSoon);
  win.on('move', saveSoon);

  // Closing asks first when a window inside the page has unsaved changes.
  win.on('close', (e) => {
    if (win.sxAllowClose) {
      clearTimeout(saveTimer);
      saveWindowState(win);
      return;
    }
    e.preventDefault();
    if (win.sxClosing) return;
    win.sxClosing = true;
    confirmLeave(win, state.quitRequested ? 'Quit Anyway' : 'Close Anyway').then((ok) => {
      win.sxClosing = false;
      if (win.isDestroyed()) return;
      if (!ok) {
        state.quitRequested = false;
        return;
      }
      win.sxAllowClose = true;
      if (state.quitRequested) app.quit();
      else win.close();
    });
  });
}

/** Go menu / Ctrl+1 / Ctrl+2: show that app in the focused window, on the same company when known. */
async function goTo(key) {
  if (!state.ready) return;
  const win = BrowserWindow.getFocusedWindow() || mainWindows()[0];
  if (!win || !win.sxMain) {
    createMainWindow(appUrl(key) + '/');
    return;
  }
  if (appForUrl(win.webContents.getURL()) === key) {
    win.focus();
    return;
  }
  const company = await openCompanyId(win);
  if (!(await confirmLeave(win, `Open ${SERVERS[key].name}`))) return;
  const target = appUrl(key) + (company ? `/?company=${encodeURIComponent(company)}` : '/');
  log(`switching to ${target}`);
  win.loadURL(target).catch((e) => log(`could not load ${target}`, e));
}

/** Go > Connect an AI Assistant: SerieX Books opens its "AI assistants" dialog (?open=aiAssistants), on the open company. */
async function connectAssistant() {
  if (!state.ready) return;
  const win = BrowserWindow.getFocusedWindow() || mainWindows()[0];
  const company = win && win.sxMain ? await openCompanyId(win) : null;
  const params = new URLSearchParams();
  if (company) params.set('company', company);
  params.set('open', 'aiAssistants');
  const target = `${appUrl('books')}/?${params}`;
  if (!win || !win.sxMain) {
    createMainWindow(target);
    return;
  }
  if (!(await confirmLeave(win, 'Open SerieX Books'))) return;
  log(`opening ${target}`);
  win.loadURL(target).catch((e) => log(`could not load ${target}`, e));
}

function openDataFolder() {
  shell.openPath(dataDir).then((err) => err && log('could not open the data folder', err));
}

function showLogs() {
  shell.openPath(logsDir).then((err) => err && log('could not open the logs folder', err));
}

// ---- license files ----

/**
 * LICENSE (the GNU AGPL text) and THIRD_PARTY_NOTICES.txt: scripts/build.mjs puts both in the
 * app's resources folder; when running from the source folder, the repository's LICENSE and
 * the notices of the last build (build/THIRD_PARTY_NOTICES.txt, made by scripts/notices.mjs).
 */
function legalFile(name) {
  if (app.isPackaged) return path.join(process.resourcesPath, name);
  return name === 'LICENSE' ? path.join(__dirname, '..', '..', 'LICENSE') : path.join(__dirname, '..', 'build', name);
}

const LEGAL_FILES = { license: 'LICENSE', notices: 'THIRD_PARTY_NOTICES.txt' };

/** Help > License / Help > Third-Party Notices: opens the file with the system's text viewer. */
function openLegal(which) {
  const file = legalFile(LEGAL_FILES[which]);
  if (!fs.existsSync(file)) {
    log(`cannot open ${file}: the file is missing`);
    dialog.showMessageBox(BrowserWindow.getFocusedWindow() || undefined, {
      type: 'error',
      title: 'SerieX',
      message: `The file ${path.basename(file)} is missing.`,
      detail: `It should be in:\n${path.dirname(file)}\n\nThe license and the third-party notices are also at https://github.com/CapitalFee/SerieX`,
      buttons: ['OK'],
    });
    return;
  }
  log(`opening ${file}`);
  shell.openPath(file).then((err) => {
    if (!err) return;
    log(`could not open ${file}: ${err}; showing it in its folder instead`);
    shell.showItemInFolder(file);
  });
}

function about() {
  if (IS_MAC) {
    app.showAboutPanel();
    return;
  }
  dialog.showMessageBox(BrowserWindow.getFocusedWindow() || undefined, {
    type: 'info',
    title: 'About SerieX',
    message: `SerieX ${app.getVersion()}`,
    detail:
      `SerieX Books and SerieX Payroll\n${LICENSE_TEXT}\n${COPYRIGHT}\n\n` +
      `To read the license and the third-party notices, right-click an empty spot of the page and choose License or Third-Party Notices. ` +
      `They are in:\n${path.dirname(legalFile(LEGAL_FILES.notices))}\n\nCompany files and logs are kept in:\n${dataDir}`,
    buttons: ['OK'],
  });
}

const menuCtx = {
  goTo,
  connectAssistant,
  zoom,
  reload,
  openDataFolder,
  showLogs,
  openLicense: () => openLegal('license'),
  openNotices: () => openLegal('notices'),
  about,
  devTools: !app.isPackaged,
};

// ---- session: permissions and downloads ----

// Downloads whose Save dialog is still open. Quitting closes that dialog as if Save had been
// chosen (macOS ends the sheet with an "OK"-like answer), which would quietly write the file to
// the suggested folder; these downloads are cancelled when the app quits instead.
const downloadsAwaitingPlace = new Set();

function cancelDownloadsAwaitingPlace() {
  for (const item of downloadsAwaitingPlace) {
    if (item.getSavePath() || item.getState() !== 'progressing') continue;
    log(`download cancelled: ${item.getFilename()} (SerieX quit before a place to save it was chosen)`);
    item.cancel();
  }
  downloadsAwaitingPlace.clear();
}

function setupSession() {
  const ses = session.defaultSession;
  const allowed = new Set(['clipboard-sanitized-write', 'fullscreen']);
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const ok = allowed.has(permission) && !!appForUrl(details.requestingUrl || wc.getURL());
    if (!ok) log(`refused permission "${permission}"`);
    cb(ok);
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => allowed.has(permission) && !!appForUrl(origin));
  ses.setSpellCheckerEnabled(false);

  // Downloads (exports, backups, files the apps produce) always ask where to save them.
  ses.on('will-download', (_e, item) => {
    const dir = settings.get('downloadDir', '') || app.getPath('downloads');
    item.setSaveDialogOptions({
      title: 'Save',
      defaultPath: path.join(fs.existsSync(dir) ? dir : app.getPath('downloads'), item.getFilename()),
    });
    log(`download started: ${item.getFilename()} (${item.getTotalBytes()} bytes); asking where to save it`);
    downloadsAwaitingPlace.add(item);
    item.on('updated', () => {
      if (item.getSavePath()) downloadsAwaitingPlace.delete(item);
    });
    item.once('done', (_ev, st) => {
      downloadsAwaitingPlace.delete(item);
      const where = item.getSavePath();
      log(`download ${st}: ${where || item.getFilename()}`);
      if (st === 'completed' && where) settings.set('downloadDir', path.dirname(where));
    });
  });
}

// ---- servers ----

async function startupFailed(err) {
  log('start failed', err);
  splash.hide();
  for (;;) {
    const r = await dialog.showMessageBox({
      type: 'error',
      buttons: ['Try Again', 'Show Logs', 'Quit'],
      defaultId: 0,
      cancelId: 2,
      title: 'SerieX',
      message: 'SerieX could not start.',
      detail: `${err.message}\n\nThe logs are in:\n${logsDir}`,
    });
    if (r.response === 1) {
      showLogs();
      continue;
    }
    if (r.response === 0) return true;
    return false;
  }
}

async function startServers() {
  const sm = state.servers;
  await sm.stopLeftovers(); // servers.json still lists what a crashed run left behind
  await sm.stopAll(); // "Try Again": stop what this run started
  await sm.choosePorts();
  sm.startAll();
  await sm.waitHealthy(START_TIMEOUT_MS, (key) => splash.status(`${SERVERS[key].name} is ready`));
}

async function onUnexpectedExit(key, code, signal) {
  if (!state.ready || state.quitRequested || state.exitDialog[key]) return;
  state.exitDialog[key] = true;
  const name = SERVERS[key].name;
  try {
    for (;;) {
      const parent = BrowserWindow.getFocusedWindow() || mainWindows()[0];
      const opts = {
        type: 'error',
        buttons: ['Restart', 'Show Logs', 'Quit'],
        defaultId: 0,
        cancelId: 0,
        title: 'SerieX',
        message: `${name} stopped unexpectedly.`,
        detail: `Exit code ${code ?? '-'}${signal ? `, signal ${signal}` : ''}.\n\nRestart it to keep working. The log is:\n${state.servers.logFile(key)}`,
      };
      const r = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
      if (state.quitRequested) return;
      if (r.response === 1) {
        shell.showItemInFolder(state.servers.logFile(key));
        continue;
      }
      if (r.response === 2) {
        app.quit();
        return;
      }
      state.servers.start(key);
      try {
        await state.servers.waitHealthyOne(key, START_TIMEOUT_MS);
        log(`${name} restarted`);
        return;
      } catch (e) {
        log(`${name} did not restart`, e);
        code = state.servers.procs[key]?.exitCode;
        signal = state.servers.procs[key]?.signalCode;
      }
    }
  } finally {
    state.exitDialog[key] = false;
  }
}

async function boot() {
  settings.load(dataDir);
  logger.init(logsDir);
  log(`SerieX ${app.getVersion()} starting (${process.platform} ${process.arch}, packaged: ${app.isPackaged}, data: ${dataDir})`);
  if (dataDirOldMode) log(`the data folder was open to other users (mode ${dataDirOldMode.toString(8)}); it is now 700`);
  for (const name of Object.values(LEGAL_FILES)) {
    const f = legalFile(name);
    log(`${name}: ${f}${fs.existsSync(f) ? '' : ' (missing)'}`);
  }
  app.setAboutPanelOptions({
    applicationName: 'SerieX',
    applicationVersion: app.getVersion(),
    version: '',
    credits: `SerieX Books and SerieX Payroll\n${LICENSE_TEXT}\nThe license and the third-party notices: Help > License and Help > Third-Party Notices.`,
    copyright: COPYRIGHT,
  });
  menu.install(menuCtx);
  setupSession();
  splash.show();

  const { binDir, webDir } = resourcesPaths();
  state.servers = new ServerManager({ dataDir, logsDir, binDir, webDir });
  state.servers.on('unexpected-exit', (key, code, signal) => {
    onUnexpectedExit(key, code, signal).catch((e) => log('restart dialog failed', e));
  });

  for (;;) {
    try {
      await startServers();
      break;
    } catch (e) {
      if (state.quitRequested) return;
      if (!(await startupFailed(e))) {
        app.quit();
        return;
      }
      splash.show();
    }
  }
  state.ready = true;
  const last = settings.get('lastApp', 'books') === 'payroll' ? 'payroll' : 'books';
  splash.status(`Opening ${SERVERS[last].name}`);
  createMainWindow(appUrl(last) + '/');
}

// ---- app lifecycle ----

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // while quitting, a new window would open on servers that are stopping
    if (state.quitRequested) return log('SerieX was started again while quitting; ignored');
    log('SerieX was started again; showing the window that is already open');
    const win = mainWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } else if (state.ready) {
      createMainWindow(appUrl(settings.get('lastApp', 'books') === 'payroll' ? 'payroll' : 'books') + '/');
    }
  });

  app.on('activate', () => {
    if (state.ready && !state.quitRequested && !mainWindows().length) createMainWindow(appUrl(settings.get('lastApp', 'books') === 'payroll' ? 'payroll' : 'books') + '/');
  });

  app.on('window-all-closed', () => {
    // macOS keeps the app (and its servers) running until Quit; Windows quits with the last window.
    if (!IS_MAC || !state.ready) app.quit();
  });

  app.on('before-quit', () => {
    if (!state.quitRequested) log('quitting');
    state.quitRequested = true;
    cancelDownloadsAwaitingPlace(); // before the windows close, which would end an open Save dialog
    session.defaultSession?.flushStorageData();
  });

  app.on('will-quit', (e) => {
    if (state.serversStopped || !state.servers) return;
    e.preventDefault();
    log('stopping the servers');
    state.servers
      .stopAll()
      .catch((err) => log('stopping the servers failed', err))
      .finally(() => {
        state.serversStopped = true;
        log('servers stopped; quitting');
        app.quit();
      });
  });

  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => {
      log(`received ${sig}; quitting`);
      app.quit();
    });
  }
  process.on('uncaughtException', (e) => log('uncaught error', e));
  process.on('unhandledRejection', (e) => log('unhandled rejection', e));

  app.whenReady().then(boot).catch((e) => {
    log('boot failed', e);
    dialog.showErrorBox('SerieX could not start', String(e && e.stack ? e.stack : e));
    app.quit();
  });
}
