// Small settings file (settings.json in the SerieX data folder): server ports, the app used
// last, window size and position, zoom and the last download folder.
// Also the permissions of the data folder: on macOS (and Linux) its folders are made 0700 and the
// files the desktop app writes 0600, so only the person signed in to the computer can read the
// company files and logs; looser ones are tightened at start. Windows keeps its default (the
// folder is in the user's own profile there).
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const PRIVATE = process.platform !== 'win32';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

let file = '';
let data = {};

/**
 * Takes away the access of group and others from an existing file or folder (to 0700 / 0600).
 * Returns its old permission bits when it changed them, else 0.
 */
function tighten(p) {
  if (!PRIVATE) return 0;
  try {
    const st = fs.statSync(p);
    if ((st.mode & 0o077) === 0) return 0;
    fs.chmodSync(p, st.isDirectory() ? DIR_MODE : FILE_MODE);
    return st.mode & 0o777;
  } catch {
    return 0; /* missing, or owned by someone else */
  }
}

/** Creates a folder (and missing parents) as 0700, or tightens it when it exists. Returns what tighten() returns. */
function privateDir(dir) {
  fs.mkdirSync(dir, PRIVATE ? { recursive: true, mode: DIR_MODE } : { recursive: true });
  return tighten(dir);
}

/** Writes a file as 0600: to a temporary file first, then renamed over the old one. */
function writePrivateFile(target, text) {
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, PRIVATE ? { mode: FILE_MODE } : undefined);
  if (PRIVATE) fs.chmodSync(tmp, FILE_MODE); // a temporary file left by a crash keeps its old mode
  fs.renameSync(tmp, target);
}

function load(dir) {
  file = path.join(dir, 'settings.json');
  tighten(file);
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    data = {};
  }
  return data;
}

function get(key, fallback) {
  return data[key] === undefined ? fallback : data[key];
}

/** Sets a value and writes the file at once (write to a temporary file, then rename). */
function set(key, value) {
  if (JSON.stringify(data[key]) === JSON.stringify(value)) return;
  data[key] = value;
  save();
}

function save() {
  if (!file) return;
  try {
    writePrivateFile(file, JSON.stringify(data, null, 2));
  } catch {
    /* a read-only data folder must not stop the app */
  }
}

module.exports = { load, get, set, save, tighten, privateDir, writePrivateFile, FILE_MODE };
