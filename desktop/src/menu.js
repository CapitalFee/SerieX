// Native menus, keyboard shortcuts and the right-click menu.
// macOS: the usual menu bar (SerieX, Edit, View, Go, Window, Help); the Edit menu is what makes
// Cmd+C / Cmd+V / Cmd+Z work in text fields there.
// Windows: no native menu bar, because both apps draw their own menu bar inside the page and use
// Alt, F10, Ctrl+R, Ctrl+W and other Ctrl keys themselves. The SerieX commands are reached with
// the shortcuts below and with a right-click on an empty spot of the page.
'use strict';
const { Menu, BrowserWindow } = require('electron');

const IS_MAC = process.platform === 'darwin';

/**
 * @param {object} ctx
 * @param {(key: 'books'|'payroll') => void} ctx.goTo
 * @param {() => void} ctx.connectAssistant  open SerieX Books' AI assistants dialog on the open company
 * @param {(win: BrowserWindow, dir: 1|-1|0) => void} ctx.zoom
 * @param {(win: BrowserWindow) => void} ctx.reload  reload, asking first when a window has unsaved changes
 * @param {() => void} ctx.openDataFolder
 * @param {() => void} ctx.showLogs
 * @param {() => void} ctx.openLicense  open LICENSE (the GNU AGPL text) from the app's resources
 * @param {() => void} ctx.openNotices  open THIRD_PARTY_NOTICES.txt from the app's resources
 * @param {() => void} ctx.about
 * @param {boolean} ctx.devTools
 */
function install(ctx) {
  if (!IS_MAC) {
    Menu.setApplicationMenu(null);
    return;
  }
  const focused = () => BrowserWindow.getFocusedWindow();
  const view = [
    { label: 'Reload', accelerator: 'Cmd+R', click: () => focused() && ctx.reload(focused()) },
    ...(ctx.devTools ? [{ role: 'forceReload' }, { role: 'toggleDevTools' }] : []),
    { type: 'separator' },
    { label: 'Actual Size', accelerator: 'Cmd+0', click: () => focused() && ctx.zoom(focused(), 0) },
    { label: 'Zoom In', accelerator: 'Cmd+=', click: () => focused() && ctx.zoom(focused(), 1) },
    { label: 'Zoom Out', accelerator: 'Cmd+-', click: () => focused() && ctx.zoom(focused(), -1) },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ];
  const template = [
    {
      label: 'SerieX',
      submenu: [
        { label: 'About SerieX', click: ctx.about },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: 'Hide SerieX' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit SerieX' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    { label: 'View', submenu: view },
    {
      label: 'Go',
      submenu: [
        { label: 'SerieX Books', accelerator: 'Cmd+1', click: () => ctx.goTo('books') },
        { label: 'SerieX Payroll', accelerator: 'Cmd+2', click: () => ctx.goTo('payroll') },
        { type: 'separator' },
        { label: 'Connect an AI Assistant...', click: () => ctx.connectAssistant() },
      ],
    },
    {
      label: 'Window',
      role: 'window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'close', label: 'Close Window' }, { type: 'separator' }, { role: 'front' }],
    },
    {
      role: 'help',
      submenu: [
        { label: 'Open Data Folder', click: ctx.openDataFolder },
        { label: 'Show Logs', click: ctx.showLogs },
        { type: 'separator' },
        { label: 'License', click: ctx.openLicense },
        { label: 'Third-Party Notices', click: ctx.openNotices },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Windows shortcuts (there is no native menu there). Returns true when the key was used.
 * Ctrl+1 / Ctrl+2 switch app, Ctrl+= / Ctrl+- / Ctrl+0 zoom, F11 full screen, F5 reload,
 * Ctrl+Shift+I developer tools (development builds only).
 */
function handleShortcut(ctx, win, input) {
  if (IS_MAC || input.type !== 'keyDown') return false;
  const ctrl = input.control && !input.alt && !input.meta;
  const plain = !input.control && !input.alt && !input.meta && !input.shift;
  const code = input.code;
  if (ctrl && !input.shift && code === 'Digit1') return ctx.goTo('books'), true;
  if (ctrl && !input.shift && code === 'Digit2') return ctx.goTo('payroll'), true;
  if (ctrl && (code === 'Equal' || code === 'NumpadAdd')) return ctx.zoom(win, 1), true;
  if (ctrl && !input.shift && (code === 'Minus' || code === 'NumpadSubtract')) return ctx.zoom(win, -1), true;
  if (ctrl && !input.shift && (code === 'Digit0' || code === 'Numpad0')) return ctx.zoom(win, 0), true;
  if (plain && input.key === 'F11') return win.setFullScreen(!win.isFullScreen()), true;
  if (plain && input.key === 'F5') return ctx.reload(win), true;
  if (ctx.devTools && ctrl && input.shift && code === 'KeyI') return win.webContents.toggleDevTools(), true;
  return false;
}

/** Right-click menu for places where the page shows none of its own. */
function contextMenu(ctx, win, params) {
  const items = [];
  const f = params.editFlags || {};
  if (params.isEditable) {
    items.push(
      { label: 'Undo', role: 'undo', enabled: f.canUndo },
      { label: 'Redo', role: 'redo', enabled: f.canRedo },
      { type: 'separator' },
      { label: 'Cut', role: 'cut', enabled: f.canCut },
      { label: 'Copy', role: 'copy', enabled: f.canCopy },
      { label: 'Paste', role: 'paste', enabled: f.canPaste },
      { type: 'separator' },
      { label: 'Select All', role: 'selectAll', enabled: f.canSelectAll },
    );
  } else if (params.selectionText && params.selectionText.trim()) {
    items.push({ label: 'Copy', role: 'copy' }, { label: 'Select All', role: 'selectAll' });
  } else {
    const ctl = IS_MAC ? 'Cmd' : 'Ctrl';
    items.push(
      { label: 'SerieX Books', accelerator: `${ctl}+1`, registerAccelerator: false, click: () => ctx.goTo('books') },
      { label: 'SerieX Payroll', accelerator: `${ctl}+2`, registerAccelerator: false, click: () => ctx.goTo('payroll') },
      { label: 'Connect an AI Assistant...', click: () => ctx.connectAssistant() },
      { type: 'separator' },
      { label: 'Reload', accelerator: IS_MAC ? 'Cmd+R' : 'F5', registerAccelerator: false, click: () => ctx.reload(win) },
      {
        label: 'Zoom',
        submenu: [
          { label: 'Actual Size', accelerator: `${ctl}+0`, registerAccelerator: false, click: () => ctx.zoom(win, 0) },
          { label: 'Zoom In', accelerator: `${ctl}+=`, registerAccelerator: false, click: () => ctx.zoom(win, 1) },
          { label: 'Zoom Out', accelerator: `${ctl}+-`, registerAccelerator: false, click: () => ctx.zoom(win, -1) },
        ],
      },
      {
        label: IS_MAC ? 'Toggle Full Screen' : 'Full Screen',
        accelerator: IS_MAC ? 'Ctrl+Cmd+F' : 'F11',
        registerAccelerator: false,
        click: () => win.setFullScreen(!win.isFullScreen()),
      },
      { type: 'separator' },
      { label: 'Open Data Folder', click: ctx.openDataFolder },
      { label: 'Show Logs', click: ctx.showLogs },
      ...(IS_MAC
        ? []
        : [
            { type: 'separator' },
            { label: 'License', click: ctx.openLicense },
            { label: 'Third-Party Notices', click: ctx.openNotices },
            { label: 'About SerieX', click: ctx.about },
          ]),
    );
  }
  Menu.buildFromTemplate(items).popup({ window: win });
}

module.exports = { install, handleShortcut, contextMenu };
