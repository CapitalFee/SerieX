// "Starting SerieX…" window shown until both servers answer.
'use strict';
const { BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

let win = null;

function page() {
  let icon = '';
  try {
    icon = fs.readFileSync(path.join(__dirname, '..', 'assets', 'icon.svg'), 'utf8');
  } catch {
    /* the text alone is enough */
  }
  const iconUrl = icon ? 'data:image/svg+xml;base64,' + Buffer.from(icon).toString('base64') : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>SerieX</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; user-select: none; cursor: default; }
  body { font: 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; color: #1f2937;
         background: linear-gradient(160deg, #ffffff 0%, #eef3fd 100%); display: flex; flex-direction: column;
         align-items: center; justify-content: center; -webkit-app-region: drag; box-sizing: border-box; border: 1px solid #d7deeb; }
  img { width: 96px; height: 96px; margin-bottom: 14px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 6px; letter-spacing: 0.2px; }
  #status { color: #6b7280; min-height: 18px; }
  .bar { width: 220px; height: 4px; border-radius: 2px; background: #dbe4f7; overflow: hidden; margin-top: 18px; }
  .bar::after { content: ''; display: block; width: 40%; height: 100%; border-radius: 2px; background: #2563eb;
                animation: slide 1.2s ease-in-out infinite; }
  @keyframes slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(250%); } }
</style></head><body>
${iconUrl ? `<img alt="" src="${iconUrl}">` : ''}
<h1>Starting SerieX…</h1>
<div id="status">Starting SerieX Books and SerieX Payroll</div>
<div class="bar"></div>
</body></html>`;
}

function show() {
  if (win) {
    win.show();
    return;
  }
  win = new BrowserWindow({
    width: 420,
    height: 300,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    show: false,
    center: true,
    title: 'SerieX',
    backgroundColor: '#ffffff',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.once('ready-to-show', () => win && win.show());
  win.on('closed', () => (win = null));
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page()));
}

function status(text) {
  if (!win) return;
  win.webContents.executeJavaScript(`document.getElementById('status').textContent = ${JSON.stringify(text)}`).catch(() => {});
}

/** Hides the window but keeps it, so the app does not count as having no windows (an error box is up). */
function hide() {
  if (win) win.hide();
}

function close() {
  if (win) win.destroy();
  win = null;
}

function isOpen() {
  return !!win;
}

module.exports = { show, status, hide, close, isOpen };
