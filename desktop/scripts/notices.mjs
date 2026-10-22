// Writes build/THIRD_PARTY_NOTICES.txt: the licenses of the third-party code that the SerieX
// installers carry. It needs only Go and Node.js, which the build uses anyway.
//
//   node scripts/notices.mjs [--out <file>] [--no-mcp]
//
// scripts/build.mjs calls writeNotices() itself, for the systems it builds.
//
// (a) Go: the modules compiled into each program (go list -deps, for every target system), with
//     their LICENSE, COPYING, NOTICE and PATENTS files from the Go module cache, and the license of
//     the Go standard library of the Go version that builds the program (GOTOOLCHAIN=auto, so the
//     toolchain line of its go.mod decides, as in the build).
// (b) JavaScript: the packages the web pages are built from: every package in package-lock.json
//     that is not a development tool, with the license files from node_modules.
// Electron and Chromium come with their own notice files (see the header of the output).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(desktop, '..');

/** The Go programs in the installers. seriex-mcp is there only when scripts/build.mjs bundles it. */
export const GO_PROGRAMS = [
  { name: 'seriex-books', dir: path.join(root, 'server'), pkg: '.' },
  { name: 'seriex-payroll', dir: path.join(root, 'payroll', 'server'), pkg: '.' },
  { name: 'seriex-mcp', dir: path.join(root, 'mcp'), pkg: './cmd/seriex-mcp' },
];

/** The two web clients, built with Vite into the installers. */
export const WEB_APPS = [
  { name: 'SerieX Books', dir: path.join(root, 'web') },
  { name: 'SerieX Payroll', dir: path.join(root, 'payroll', 'web') },
];

export const DEFAULT_TARGETS = [
  { goos: 'darwin', goarch: 'arm64' },
  { goos: 'darwin', goarch: 'amd64' },
  { goos: 'windows', goarch: 'amd64' },
  { goos: 'linux', goarch: 'amd64' },
  { goos: 'linux', goarch: 'arm64' },
];

const RULE = '='.repeat(80);
const LINE = '-'.repeat(80);

// File names that hold license terms: LICENSE, LICENCE.md, COPYING, NOTICE, PATENTS,
// SQLITE-LICENSE, LICENSE-3RD-PARTY.md, ... (source files such as copyright_test.go are not).
const LICENSE_NAME = /(licen[cs]e|copying|notice|copyright|patents)/i;
const SOURCE_FILE = /\.(go|s|c|h|cc|js|mjs|cjs|ts|mts|cts|tsx|jsx|map|json|py|sh|ya?ml|toml|css)$/i;
// The main license file, used to name the license of a Go module.
const MAIN_LICENSE = /^(licen[cs]e|copying)(\.(md|txt))?$/i;

function goEnv(goos, goarch) {
  return { ...process.env, GOTOOLCHAIN: 'auto', CGO_ENABLED: '0', GOOS: goos, GOARCH: goarch };
}

function go(args, dir, env) {
  const r = spawnSync('go', args, { cwd: dir, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`go could not run: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`go ${args.join(' ')} failed in ${dir}:\n${r.stderr}`);
  return r.stdout;
}

/** The license files at the top of a folder, as [{ name, text }], sorted with the main license first. */
function licenseFiles(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && LICENSE_NAME.test(e.name) && !SOURCE_FILE.test(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
  names.sort((a, b) => (MAIN_LICENSE.test(b) ? 1 : 0) - (MAIN_LICENSE.test(a) ? 1 : 0) || a.localeCompare(b));
  return names.map((name) => ({ name, text: readText(path.join(dir, name)) }));
}

function readText(file) {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/** The common licenses, recognised from their text; '' when it is not one of them. */
function licenseFromText(text) {
  const t = text.replace(/\s+/g, ' ');
  if (/Apache License,? Version 2\.0/i.test(t) || /Apache License Version 2\.0/i.test(t)) return 'Apache-2.0';
  if (/Mozilla Public License,? (Version|v\.) ?2\.0/i.test(t)) return 'MPL-2.0';
  if (/Permission is hereby granted, free of charge/i.test(t)) return 'MIT';
  if (/Permission to use, copy, modify, and\/?or distribute this software for any purpose/i.test(t)) return 'ISC';
  if (/Redistribution and use in source and binary forms/i.test(t)) {
    return /(Neither the name|names of (its|the) contributors|name of the copyright holder)/i.test(t) ? 'BSD-3-Clause' : 'BSD-2-Clause';
  }
  if (/The author disclaims copyright to this source code/i.test(t)) return 'Public domain (SQLite blessing)';
  return '';
}

/** "## License" section of a package's README, for packages that ship no license file. */
function readmeLicenseSection(dir) {
  let readme = '';
  try {
    readme = fs.readdirSync(dir).find((f) => /^readme(\.(md|markdown|txt))?$/i.test(f)) || '';
  } catch {
    return null;
  }
  if (!readme) return null;
  const lines = readText(path.join(dir, readme)).split('\n');
  const start = lines.findIndex((l) => /^#{1,6}\s*licen[cs]es?\b/i.test(l));
  if (start < 0) return null;
  const level = /^#+/.exec(lines[start])[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#+)\s/.exec(lines[i]);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return { name: `${readme} (its License section)`, text: lines.slice(start, end).join('\n').trim() };
}

// ---- (a) Go ----

/**
 * The Go modules compiled into the programs, for every target system.
 * @returns {{ modules: Map<string, object>, stdlib: Map<string, object> }}
 */
function collectGo(programs, targets) {
  const modules = new Map(); // "path@version" -> { path, version, replace, dir, users:Set }
  const stdlib = new Map(); // Go version -> { version, goroot, users:Set }
  const tmpl =
    '{{with .Module}}{{if not .Main}}{{.Path}}\t{{.Version}}\t{{.Dir}}{{with .Replace}}\t{{.Path}}\t{{.Version}}\t{{.Dir}}{{end}}{{end}}{{end}}';
  for (const p of programs) {
    for (const { goos, goarch } of targets) {
      const env = goEnv(goos, goarch);
      const [goVersion, goroot] = go(['env', 'GOVERSION', 'GOROOT'], p.dir, env).trim().split('\n');
      if (!stdlib.has(goVersion)) stdlib.set(goVersion, { version: goVersion, goroot, users: new Set() });
      stdlib.get(goVersion).users.add(p.name);
      for (const line of go(['list', '-deps', '-f', tmpl, p.pkg], p.dir, env).split('\n')) {
        if (!line.trim()) continue;
        const [modPath, version, dir, rPath, rVersion, rDir] = line.split('\t');
        const replace = rPath ? { path: rPath, version: rVersion || '', dir: rDir } : null;
        const key = `${modPath}@${version}${replace ? ` => ${rPath}@${rVersion}` : ''}`;
        if (!modules.has(key)) modules.set(key, { path: modPath, version, replace, dir: replace?.dir || dir, users: new Set() });
        modules.get(key).users.add(p.name);
      }
    }
  }
  return { modules, stdlib };
}

// ---- (b) JavaScript ----

/** The packages of the production dependency tree of each web client (package-lock.json, not "dev"). */
function collectWeb(apps) {
  const packages = new Map(); // "name@version" -> { name, version, license, dir, repository, users:Set }
  for (const a of apps) {
    const lockFile = path.join(a.dir, 'package-lock.json');
    if (!fs.existsSync(lockFile)) throw new Error(`${lockFile} is missing: the third-party notices are made from it.`);
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if (!lock.packages) throw new Error(`${lockFile} is in an old format (lockfileVersion ${lock.lockfileVersion}); run "npm install" with npm 7 or later in ${a.dir}.`);
    for (const [where, info] of Object.entries(lock.packages)) {
      // "" is the app itself; "dev" and "devOptional" packages are the build tools (Vite, TypeScript, ...)
      if (!where || info.dev || info.devOptional || info.link) continue;
      const dir = path.join(a.dir, where);
      const pkgJson = path.join(dir, 'package.json');
      if (!fs.existsSync(pkgJson)) {
        if (info.optional) continue; // an optional package that is not installed is not in the build
        throw new Error(`${where} (from ${lockFile}) is not installed. Run "npm ci" in ${a.dir} first.`);
      }
      const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
      const name = pkg.name || info.name || where.slice(where.lastIndexOf('node_modules/') + 'node_modules/'.length);
      const version = pkg.version || info.version;
      if (info.version && pkg.version && info.version !== pkg.version) {
        console.warn(`notices: ${a.dir}/${where} is ${pkg.version} but package-lock.json says ${info.version}; listing the installed ${pkg.version}`);
      }
      const key = `${name}@${version}`;
      if (!packages.has(key)) {
        const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type || info.license || '';
        const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '';
        packages.set(key, { name, version, license, dir, repository: repo, homepage: pkg.homepage || '', users: new Set() });
      }
      packages.get(key).users.add(a.name);
    }
  }
  return packages;
}

// ---- output ----

function header({ appVersion }) {
  return [
    'SerieX third-party notices',
    RULE,
    '',
    `SerieX${appVersion ? ` ${appVersion}` : ''} (SerieX Books, SerieX Payroll and the SerieX desktop app) is free`,
    'software under the GNU Affero General Public License, version 3 or (at your option) any',
    'later version (AGPL-3.0-or-later). Its full text is in the LICENSE file next to this file.',
    'Source code: https://github.com/CapitalFee/SerieX',
    '',
    'SerieX includes the third-party software listed below. Each entry gives its name, its',
    'version, which part of SerieX uses it, its license and the license text that came with it.',
    '',
    'The desktop app is built on Electron, which includes Chromium, Node.js and other software.',
    'Their notices are in the app\'s own license files: LICENSE.electron.txt and',
    'LICENSES.chromium.html, next to SerieX.exe on Windows, in /opt/SerieX on Ubuntu, and in',
    'SerieX.app/Contents/Resources on macOS.',
    '',
  ];
}

function entry(lines, title, facts, files, missingNote) {
  lines.push(LINE, title, ...facts.filter(Boolean), '');
  if (!files.length) {
    lines.push(missingNote, '');
    return;
  }
  for (const f of files) lines.push(`--- ${f.name} ---`, '', f.text, '');
}

/**
 * Writes the notices file. Returns { file, goModules, webPackages, warnings }.
 * @param {object} o
 * @param {string} o.out          output file
 * @param {{goos:string, goarch:string}[]} [o.targets]  systems the Go programs are built for
 * @param {boolean} [o.mcp]       include seriex-mcp (default: when mcp/cmd/seriex-mcp exists)
 * @param {string} [o.appVersion]
 */
export function writeNotices({ out, targets = DEFAULT_TARGETS, mcp, appVersion } = {}) {
  const withMcp = mcp ?? fs.existsSync(path.join(root, 'mcp', 'cmd', 'seriex-mcp'));
  const programs = GO_PROGRAMS.filter((p) => p.name !== 'seriex-mcp' || withMcp);
  const warnings = [];
  const { modules, stdlib } = collectGo(programs, targets);
  const packages = collectWeb(WEB_APPS);

  const goList = [...modules.values()].sort((a, b) => a.path.localeCompare(b.path) || a.version.localeCompare(b.version));
  const webList = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  for (const m of goList) {
    m.files = licenseFiles(m.dir);
    const main = m.files.find((f) => MAIN_LICENSE.test(f.name)) || m.files[0];
    m.license = main ? licenseFromText(main.text) : '';
    if (!m.files.length) warnings.push(`Go module ${m.path} ${m.version} has no license file in ${m.dir}`);
  }
  for (const p of webList) {
    p.files = licenseFiles(p.dir);
    if (!p.files.length) {
      const section = readmeLicenseSection(p.dir);
      if (section) p.files = [section];
      warnings.push(`npm package ${p.name} ${p.version} has no license file${section ? ' (its README license section is used)' : ''}`);
    }
  }
  const stdList = [...stdlib.values()].sort((a, b) => a.version.localeCompare(b.version));
  for (const s of stdList) {
    // Some Go installs (Homebrew) keep LICENSE one folder above GOROOT.
    const pick = (dir) => licenseFiles(dir).filter((f) => /^(LICENSE|PATENTS)$/.test(f.name));
    s.files = pick(s.goroot);
    if (!s.files.some((f) => f.name === 'LICENSE')) s.files = [...pick(path.dirname(s.goroot)).filter((f) => f.name === 'LICENSE'), ...s.files];
  }
  for (const s of stdList) {
    // The Go license is the same for every Go version: borrow it when one install does not carry it.
    if (s.files.some((f) => f.name === 'LICENSE')) continue;
    const other = stdList.find((o) => o.files.some((f) => f.name === 'LICENSE'));
    if (other) s.files = [{ ...other.files.find((f) => f.name === 'LICENSE'), name: `LICENSE (from Go ${other.version.replace(/^go/, '')}; the same for every Go version)` }, ...s.files];
    else warnings.push(`the Go ${s.version} license file was not found in ${s.goroot}`);
  }

  const lines = header({ appVersion });
  lines.push('Contents', '');
  lines.push('PART 1. Go standard library (in the Go programs: seriex-books, seriex-payroll' + (withMcp ? ', seriex-mcp' : '') + ')');
  for (const s of stdList) lines.push(`     Go ${s.version.replace(/^go/, '')}  BSD-3-Clause  (${[...s.users].join(', ')})`);
  lines.push('', 'PART 2. Go modules');
  for (const m of goList) lines.push(`     ${m.path} ${m.version}${m.replace ? ` (replaced by ${m.replace.path} ${m.replace.version})` : ''}  ${m.license || 'see its text'}  (${[...m.users].join(', ')})`);
  lines.push('', 'PART 3. JavaScript packages (in the web pages of SerieX Books and SerieX Payroll)');
  for (const p of webList) lines.push(`     ${p.name} ${p.version}  ${p.license || 'see its text'}  (${[...p.users].join(', ')})`);
  lines.push('', '');

  lines.push(RULE, 'PART 1. Go standard library', RULE, '');
  for (const s of stdList) {
    entry(
      lines,
      `Go standard library and runtime, Go ${s.version.replace(/^go/, '')}`,
      [`Used by: ${[...s.users].join(', ')}`, 'License: BSD-3-Clause (the packages it includes from golang.org/x are under the same license)', 'Source: https://go.dev/'],
      s.files,
      `The license file was not found in ${s.goroot}. Go is distributed under the BSD-3-Clause license: https://go.dev/LICENSE`,
    );
  }
  lines.push(RULE, 'PART 2. Go modules', RULE, '');
  for (const m of goList) {
    entry(
      lines,
      `${m.path} ${m.version}`,
      [
        m.replace ? `Replaced by: ${m.replace.path} ${m.replace.version}`.trim() : '',
        `Used by: ${[...m.users].join(', ')}`,
        `License: ${m.license || 'see the text below'}`,
        `Source: https://pkg.go.dev/${m.path}@${m.version}`,
      ],
      m.files,
      'No license file was found in this module.',
    );
  }
  lines.push(RULE, 'PART 3. JavaScript packages', RULE, '');
  for (const p of webList) {
    entry(
      lines,
      `${p.name} ${p.version}`,
      [
        `Used by: ${[...p.users].join(', ')} web pages`,
        `License: ${p.license || 'see the text below'}`,
        `Source: https://www.npmjs.com/package/${p.name}/v/${p.version}`,
      ],
      p.files,
      `This package has no license file. Its package.json says its license is: ${p.license || '(not given)'}.`,
    );
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n');
  return { file: out, goModules: goList.length, webPackages: webList.length, goVersions: stdList.map((s) => s.version), warnings };
}

// ---- command line ----
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--out');
  const out = i >= 0 ? path.resolve(argv[i + 1]) : path.join(desktop, 'build', 'THIRD_PARTY_NOTICES.txt');
  const { version } = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
  const r = writeNotices({ out, mcp: argv.includes('--no-mcp') ? false : undefined, appVersion: version });
  for (const w of r.warnings) console.warn(`notices: ${w}`);
  console.log(`${r.file}: ${r.goModules} Go modules, ${r.webPackages} JavaScript packages, Go ${r.goVersions.join(' and ')}`);
}
