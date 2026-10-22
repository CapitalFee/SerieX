// Starts and stops the two bundled servers (SerieX Books and SerieX Payroll) on 127.0.0.1.
// Ports: 47180 and 47190 by default. When one is taken, a free one is picked and kept in
// settings.json, so the app address (and what the web pages keep in local storage) stays the same.
// The process ids are kept in servers.json, so servers left behind by a crash are stopped at the next start.
// Windows cannot send SIGTERM, so there each server gets a secret at start and is asked to stop with it
// (POST /api/shutdown), which lets SerieX Books back up on quit as it does on a Mac.
'use strict';
const { EventEmitter } = require('node:events');
const { spawn, execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const settings = require('./settings');
const { log, rotate } = require('./log');

const IS_WIN = process.platform === 'win32';

// stopEnv: the variable that hands the server its stop secret (Windows).
// stopWait: how long a server that accepted the stop request gets before it is forced (SerieX Books backs up first).
const SERVERS = {
  books: { name: 'SerieX Books', exe: 'seriex-books', port: 47180, web: 'books-web', data: 'books', stopEnv: 'SXB_SHUTDOWN_TOKEN', stopWait: 10000 },
  payroll: { name: 'SerieX Payroll', exe: 'seriex-payroll', port: 47190, web: 'payroll-web', data: 'payroll', stopEnv: 'SXP_SHUTDOWN_TOKEN', stopWait: 5000 },
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function exeName(key) {
  return SERVERS[key].exe + (IS_WIN ? '.exe' : '');
}

/** True when nothing listens on 127.0.0.1:port. */
function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.unref();
    s.once('error', () => resolve(false));
    s.listen({ port, host: '127.0.0.1', exclusive: true }, () => s.close(() => resolve(true)));
  });
}

/** A port the system says is free. */
function anyFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.once('error', reject);
    s.listen({ port: 0, host: '127.0.0.1' }, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 10000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** True when process `pid` is running the server program `key` (so an unrelated process is never stopped). */
async function isOurServer(pid, key) {
  if (!pid || !isAlive(pid)) return false;
  const name = exeName(key).toLowerCase();
  if (IS_WIN) {
    const out = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    return out.toLowerCase().includes(`"${name}"`);
  }
  const out = (await run('ps', ['-p', String(pid), '-o', 'comm='])).trim();
  return path.basename(out).toLowerCase() === name;
}

async function killTree(pid, force) {
  if (IS_WIN) {
    await run('taskkill', ['/PID', String(pid), '/T', '/F']);
    return;
  }
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    /* already gone */
  }
}

/** GET <url>/api/health answers {"ok": true}. */
function healthy(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1500 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(res.statusCode === 200 && JSON.parse(body).ok === true);
        } catch {
          resolve(false);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

/** POST <url>/api/shutdown with the server's secret; true when it answered 202 (it is stopping). */
function askToStop(port, token) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/shutdown', method: 'POST', timeout: 1500, headers: { 'X-SerieX-Shutdown-Token': token, 'Content-Length': 0 } },
      (res) => {
        res.resume();
        resolve(res.statusCode === 202);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

class ServerManager extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.dataDir  SerieX data folder (books/ and payroll/ company files, logs/)
   * @param {string} o.logsDir
   * @param {string} o.binDir   folder with seriex-books[.exe], seriex-payroll[.exe] and, when bundled, seriex-mcp[.exe]
   * @param {string} o.webDir   folder with books-web/ and payroll-web/
   */
  constructor({ dataDir, logsDir, binDir, webDir }) {
    super();
    this.dataDir = dataDir;
    this.logsDir = logsDir;
    this.binDir = binDir;
    this.webDir = webDir;
    this.pidFile = path.join(dataDir, 'servers.json');
    this.ports = {};
    this.procs = {};
  }

  url(key) {
    return `http://127.0.0.1:${this.ports[key]}`;
  }

  logFile(key) {
    return path.join(this.logsDir, `${SERVERS[key].data}.log`);
  }

  readPids() {
    try {
      return JSON.parse(fs.readFileSync(this.pidFile, 'utf8')) || {};
    } catch {
      return {};
    }
  }

  writePids() {
    const out = {};
    for (const key of Object.keys(this.procs)) if (this.running(key)) out[key] = { pid: this.procs[key].pid, port: this.ports[key] };
    try {
      if (Object.keys(out).length) settings.writePrivateFile(this.pidFile, JSON.stringify(out, null, 2));
      else fs.rmSync(this.pidFile, { force: true });
    } catch (e) {
      log('could not write servers.json', e);
    }
  }

  /** Stops servers that an earlier run left behind (the app was killed or crashed). */
  async stopLeftovers() {
    const old = this.readPids();
    for (const key of Object.keys(SERVERS)) {
      const pid = old[key]?.pid;
      if (Object.values(this.procs).some((p) => p.pid === pid)) continue; // started by this run
      if (!(await isOurServer(pid, key))) continue;
      log(`stopping ${SERVERS[key].name} left running by an earlier session (pid ${pid})`);
      await killTree(pid, true);
      for (let i = 0; i < 30 && isAlive(pid); i++) await delay(100);
    }
    try {
      fs.rmSync(this.pidFile, { force: true });
    } catch {
      /* ignore */
    }
  }

  /** Picks the two ports: the remembered ones (default 47180 / 47190), else free ones, which are remembered. */
  async choosePorts() {
    const saved = settings.get('ports', {}) || {};
    const chosen = {};
    for (const key of Object.keys(SERVERS)) {
      const taken = new Set(Object.values(chosen));
      const preferred = Number.isInteger(saved[key]) && saved[key] > 0 && saved[key] < 65536 ? saved[key] : SERVERS[key].port;
      const candidates = [preferred];
      for (let i = 1; i <= 9; i++) candidates.push(SERVERS[key].port + i);
      let port = 0;
      for (const c of candidates) {
        if (!taken.has(c) && (await isPortFree(c))) {
          port = c;
          break;
        }
      }
      if (!port) {
        do port = await anyFreePort();
        while (taken.has(port));
      }
      if (port !== preferred) log(`${SERVERS[key].name}: port ${preferred} is in use, using ${port}`);
      chosen[key] = port;
    }
    this.ports = chosen;
    settings.set('ports', chosen);
    return chosen;
  }

  start(key) {
    const s = SERVERS[key];
    const exe = path.join(this.binDir, exeName(key));
    const data = path.join(this.dataDir, s.data);
    settings.privateDir(data); // books/ or payroll/: 0700 on macOS
    settings.privateDir(this.logsDir);
    const args = ['-host', '127.0.0.1', '-port', String(this.ports[key]), '-data', data, '-web', path.join(this.webDir, s.web)];
    if (key === 'books') {
      args.push('-payroll', this.url('payroll'));
      // the AI assistant helper, when this app carries it (see scripts/build.mjs)
      const helper = path.join(this.binDir, 'seriex-mcp' + (IS_WIN ? '.exe' : ''));
      if (fs.existsSync(helper)) args.push('-mcp-helper', helper);
    }
    else args.push('-books', this.url('books'));
    const logFile = this.logFile(key);
    settings.tighten(logFile);
    rotate(logFile);
    fs.appendFileSync(logFile, `\n==== ${new Date().toISOString()} starting ${s.name}: ${exe} ${args.join(' ')}\n`, { mode: settings.FILE_MODE });
    const fd = fs.openSync(logFile, 'a', settings.FILE_MODE);
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('ELECTRON_') || k === 'NODE_OPTIONS') delete env[k];
    const stopToken = IS_WIN ? crypto.randomBytes(32).toString('hex') : '';
    if (stopToken) env[s.stopEnv] = stopToken;
    let proc;
    try {
      proc = spawn(exe, args, { cwd: data, env, stdio: ['ignore', fd, fd], windowsHide: true });
    } finally {
      fs.closeSync(fd);
    }
    proc.stopping = false;
    proc.stopToken = stopToken;
    this.procs[key] = proc;
    log(`${s.name} started (pid ${proc.pid}) on ${this.url(key)}`);
    const ended = (code, signal) => {
      if (proc.ended) return;
      proc.ended = true;
      log(`${s.name} exited (code ${code}, signal ${signal})${proc.stopping ? '' : ' unexpectedly'}`);
      if (this.procs[key] === proc) this.writePids();
      if (!proc.stopping) this.emit('unexpected-exit', key, code, signal);
    };
    proc.on('error', (e) => {
      log(`${s.name} could not start`, e);
      try {
        fs.appendFileSync(logFile, `could not start ${exe}: ${e.message}\n`);
      } catch {
        /* ignore */
      }
      if (!proc.pid) ended(null, null);
    });
    proc.on('exit', ended);
    this.writePids();
    return proc;
  }

  startAll() {
    for (const key of Object.keys(SERVERS)) this.start(key);
  }

  running(key) {
    const p = this.procs[key];
    return !!p && !p.ended && !!p.pid && p.exitCode === null && p.signalCode === null;
  }

  /** Waits until both servers answer /api/health. Rejects after `timeoutMs` or when one exits. */
  async waitHealthy(timeoutMs, onProgress) {
    const end = Date.now() + timeoutMs;
    const ok = {};
    while (Date.now() < end) {
      for (const key of Object.keys(SERVERS)) {
        if (ok[key]) continue;
        if (!this.running(key)) throw new Error(`${SERVERS[key].name} stopped while starting.`);
        if (await healthy(this.ports[key])) {
          ok[key] = true;
          log(`${SERVERS[key].name} is ready`);
          onProgress?.(key);
        }
      }
      if (Object.keys(SERVERS).every((k) => ok[k])) return;
      await delay(200);
    }
    const missing = Object.keys(SERVERS).filter((k) => !ok[k]).map((k) => SERVERS[k].name);
    throw new Error(`${missing.join(' and ')} did not answer within ${Math.round(timeoutMs / 1000)} seconds.`);
  }

  /** Waits until one server answers /api/health (after a restart). */
  async waitHealthyOne(key, timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (!this.running(key)) throw new Error(`${SERVERS[key].name} stopped while starting.`);
      if (await healthy(this.ports[key])) return;
      await delay(200);
    }
    throw new Error(`${SERVERS[key].name} did not answer within ${Math.round(timeoutMs / 1000)} seconds.`);
  }

  /**
   * Stops one server: SIGTERM (Windows: the stop request), then a forced kill of the process tree
   * after stopWait; on Windows, when the request fails, the forced kill right away. A second call
   * while the first is still waiting gets the same stop, so it cannot cut a backup short.
   */
  stop(key) {
    const p = this.procs[key];
    if (!p || !this.running(key)) return Promise.resolve();
    if (!p.stopPromise) p.stopPromise = this.stopProcess(key, p);
    return p.stopPromise;
  }

  async stopProcess(key, p) {
    p.stopping = true;
    const exited = new Promise((r) => p.once('exit', r));
    const wait = SERVERS[key].stopWait;
    if (!(p.stopToken && (await askToStop(this.ports[key], p.stopToken)))) await killTree(p.pid, false);
    const done = await Promise.race([exited.then(() => true), delay(wait).then(() => false)]);
    if (!done) {
      log(`${SERVERS[key].name} did not stop in ${wait / 1000} seconds; forcing it`);
      await killTree(p.pid, true);
      await Promise.race([exited, delay(3000)]);
    }
  }

  async stopAll() {
    if (!Object.keys(this.procs).length) return; // nothing started yet: keep servers.json for stopLeftovers()
    await Promise.all(Object.keys(SERVERS).map((k) => this.stop(k)));
    this.writePids();
  }
}

module.exports = { ServerManager, SERVERS };
