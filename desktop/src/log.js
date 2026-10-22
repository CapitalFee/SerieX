// Log of the desktop shell itself (logs/main.log). The two servers write their own logs.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { privateDir, tighten, FILE_MODE } = require('./settings');

const MAX_BYTES = 5 * 1024 * 1024;
let file = '';

/** Keeps one older copy (<name>.1.log) once a log grows past 5 MB. */
function rotate(logFile) {
  try {
    if (fs.statSync(logFile).size > MAX_BYTES) fs.renameSync(logFile, logFile.replace(/\.log$/, '.1.log'));
  } catch {
    /* no log yet */
  }
}

/** Creates logs/ as 0700 and tightens the logs already in it (to 0600). */
function init(dir) {
  privateDir(dir);
  try {
    for (const f of fs.readdirSync(dir)) tighten(path.join(dir, f));
  } catch {
    /* ignore */
  }
  file = path.join(dir, 'main.log');
  rotate(file);
}

function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.map((p) => (p instanceof Error ? p.stack || p.message : typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
  if (!require('electron').app.isPackaged) process.stdout.write(line);
  if (!file) return;
  try {
    fs.appendFileSync(file, line, { mode: FILE_MODE });
  } catch {
    /* logging must never break the app */
  }
}

module.exports = { init, log, rotate };
