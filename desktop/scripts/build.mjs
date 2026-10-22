// Builds the SerieX desktop installers into desktop/dist/.
//
//   node scripts/build.mjs mac          macOS DMGs and ZIPs (Apple Silicon and Intel)
//   node scripts/build.mjs win          Windows installer (x64)
//   node scripts/build.mjs linux        Ubuntu packages (.deb, x64 and arm64)
//   node scripts/build.mjs all          all three
//
// Installer names do not change between versions (release/install.sh and install.ps1 download
// them by name): SerieX-mac-arm64.dmg / .zip, SerieX-mac-x64.dmg / .zip, SerieX-Setup-x64.exe,
// SerieX-linux-amd64.deb, SerieX-linux-arm64.deb.
//
// Options: --mac-arch arm64|x64 (one macOS build only), --linux-arch x64|arm64 (one Ubuntu
// package only), --skip-web, --skip-servers, --skip-icon, --skip-mcpb
//
// Steps: (a) build both web clients with Vite into build/books-web and build/payroll-web,
// (b) cross-compile both Go servers (and the seriex-mcp helper) into build/servers/<os>-<arch>/
// with GOTOOLCHAIN=auto, so the toolchain line of each go.mod picks the Go version, and check
// that version in each binary, (c) write the license files: build/LICENSE (the root LICENSE) and
// build/THIRD_PARTY_NOTICES.txt (scripts/notices.mjs), (d) render the app icon, (e) package with
// electron-builder; both license files go into the app's resources folder on every system (the
// Ubuntu package puts the servers, web pages and license files in /opt/SerieX/resources),
// (f) "all" on a Mac only: the SerieX extension packages for Claude Desktop (mcp/packaging/build.sh)
// into dist/mcp/: seriex-<version>-darwin-universal.mcpb, seriex-<version>-windows-amd64.mcpb (both
// published with the release) and server.json (for mcp-publisher, not published), (g) "all" only:
// the SerieX skill for AI assistants (skills/seriex) as dist/seriex.skill, published with the release.
// Nothing is written inside the server or web folders.
// `npm run publish` (scripts/publish.mjs) then publishes the installers as a GitHub release.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { writeNotices } from './notices.mjs';

const require = createRequire(import.meta.url);
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(desktop, '..');
const buildDir = path.join(desktop, 'build');
const IS_WIN_HOST = process.platform === 'win32';
const appVersion = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')).version;
// The seriex-mcp helper (AI assistants that run on this computer connect through it) lives in its
// own Go module mcp/. It is bundled only when it exists and SerieX Books accepts -mcp-helper.
const mcpDir = path.join(root, 'mcp');

const argv = process.argv.slice(2);
const what = argv.find((a) => !a.startsWith('--')) || 'all';
const flag = (name) => argv.includes(`--${name}`);
const option = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (!['mac', 'win', 'linux', 'all'].includes(what)) {
  console.error('usage: node scripts/build.mjs mac|win|linux|all [--mac-arch arm64|x64] [--linux-arch x64|arm64] [--skip-web] [--skip-servers] [--skip-icon] [--skip-mcpb]');
  process.exit(2);
}
const wantMac = what === 'mac' || what === 'all';
const wantWin = what === 'win' || what === 'all';
const wantLinux = what === 'linux' || what === 'all';
const macArchs = (option('mac-arch') || 'arm64,x64').split(',').map((s) => s.trim()).filter(Boolean);
for (const a of macArchs) if (!['arm64', 'x64'].includes(a)) throw new Error(`unknown macOS arch ${a}`);
const linuxArchs = (option('linux-arch') || 'x64,arm64').split(',').map((s) => s.trim()).filter(Boolean);
for (const a of linuxArchs) if (!['arm64', 'x64'].includes(a)) throw new Error(`unknown Linux arch ${a}`);

const GOARCH = { arm64: 'arm64', x64: 'amd64' };
// Go's names for this computer, for the checks that run the servers here.
const HOST_OS = { darwin: 'darwin', win32: 'windows', linux: 'linux' }[process.platform];
const HOST_ARCH = GOARCH[process.arch] || process.arch;
// The Maintainer field of the Ubuntu packages (required by the .deb format). It is public: anyone
// can read it in every package, with "dpkg -s seriex" or "apt show seriex".
const LINUX_MAINTAINER = 'SerieX <37116247+kryonsx@users.noreply.github.com>';
const LICENSE_FILE = path.join(root, 'LICENSE');
const NOTICES_FILE = path.join(buildDir, 'THIRD_PARTY_NOTICES.txt');

function step(title) {
  console.log(`\n=== ${title}`);
}

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}${opts.cwd ? `   (in ${path.relative(root, opts.cwd) || '.'})` : ''}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: IS_WIN_HOST, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} failed (exit ${r.status ?? r.signal})`);
}

function mustExist(file, hint) {
  if (!fs.existsSync(file)) throw new Error(`${file} is missing. ${hint || ''}`.trim());
}

// ---- license ----

/** The SerieX license (root LICENSE, GNU AGPL-3.0) ships in every installer: stop early when it is missing. */
function checkLicense() {
  if (!fs.existsSync(LICENSE_FILE)) {
    throw new Error(`${LICENSE_FILE} is missing. The installers must carry the SerieX license: put the GNU AGPL-3.0 text in LICENSE at the root of the repository.`);
  }
  if (!/GNU AFFERO GENERAL PUBLIC LICENSE/.test(fs.readFileSync(LICENSE_FILE, 'utf8'))) {
    throw new Error(`${LICENSE_FILE} does not hold the GNU Affero General Public License text.`);
  }
}

// ---- (a) web clients ----
function buildWeb() {
  const apps = [
    ['books-web', path.join(root, 'web')],
    ['payroll-web', path.join(root, 'payroll', 'web')],
  ];
  for (const [name, dir] of apps) {
    step(`web client ${name}`);
    mustExist(path.join(dir, 'node_modules', 'vite'), `Run "npm install" in ${dir} first.`);
    const out = path.join(buildDir, name);
    run('npx', ['vite', 'build', '--outDir', out, '--emptyOutDir'], { cwd: dir });
    mustExist(path.join(out, 'index.html'));
  }
}

// ---- (b) servers ----

/** Go builds use GOTOOLCHAIN=auto: when a go.mod names a newer toolchain than the installed Go, Go fetches and uses it. */
function goEnv(goos, goarch) {
  return { ...process.env, GOTOOLCHAIN: 'auto', CGO_ENABLED: '0', GOOS: goos, GOARCH: goarch };
}

/** "go1.26.10" / "1.25" / "go1.27rc1" -> comparable numbers (a release candidate sorts before its release). */
function parseGoVersion(v) {
  const m = /^(?:go)?(\d+)\.(\d+)(?:\.(\d+))?(?:(rc|beta)(\d+))?/.exec(String(v).trim());
  if (!m) return null;
  const pre = m[4] === 'beta' ? Number(m[5]) : m[4] === 'rc' ? 100 + Number(m[5]) : Infinity;
  return [Number(m[1]), Number(m[2]), Number(m[3] || 0), pre];
}

function olderGo(a, b) {
  const x = parseGoVersion(a);
  const y = parseGoVersion(b);
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

/** The Go version a module asks for: its toolchain line, else its go line. */
function goModWants(dir) {
  const mod = fs.readFileSync(path.join(dir, 'go.mod'), 'utf8');
  const toolchain = /^toolchain\s+(go\S+)/m.exec(mod)?.[1];
  if (toolchain) return { version: toolchain, from: 'toolchain line' };
  const goLine = /^go\s+(\S+)/m.exec(mod)?.[1];
  if (!goLine) throw new Error(`${path.join(dir, 'go.mod')} has no go line`);
  return { version: `go${goLine}`, from: 'go line (no toolchain line)' };
}

/** Prints the Go version a binary was built with (go version -m) and fails when it is older than its go.mod asks for. */
function checkGoVersion(bin, dir, label) {
  const r = spawnSync('go', ['version', '-m', bin], { cwd: desktop, encoding: 'utf8', env: { ...process.env, GOTOOLCHAIN: 'auto' } });
  if (r.status !== 0) throw new Error(`go version -m ${bin} failed: ${r.stderr}`);
  const built = /:\s+(go\S+)/.exec(r.stdout.split('\n')[0])?.[1];
  if (!built || !parseGoVersion(built)) throw new Error(`could not read the Go version of ${bin}:\n${r.stdout}`);
  const want = goModWants(dir);
  console.log(`${label}: built with ${built} (go.mod ${want.from}: ${want.version})`);
  if (olderGo(built, want.version)) {
    throw new Error(`${label} was built with ${built}, older than the ${want.version} of the ${want.from} in ${path.join(dir, 'go.mod')}. Check GOTOOLCHAIN (it must allow "auto") and the network access to download Go ${want.version}.`);
  }
}

function serverTargets() {
  const t = [];
  if (wantMac) for (const a of macArchs) t.push({ goos: 'darwin', goarch: GOARCH[a] });
  if (wantWin) t.push({ goos: 'windows', goarch: 'amd64' });
  if (wantLinux) for (const a of linuxArchs) t.push({ goos: 'linux', goarch: GOARCH[a] });
  return t;
}

function buildServers() {
  const programs = [
    ['seriex-books', path.join(root, 'server')],
    ['seriex-payroll', path.join(root, 'payroll', 'server')],
  ];
  for (const { goos, goarch } of serverTargets()) {
    step(`servers for ${goos}/${goarch}`);
    const outDir = path.join(buildDir, 'servers', `${goos}-${goarch}`);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    for (const [name, dir] of programs) {
      const out = path.join(outDir, name + (goos === 'windows' ? '.exe' : ''));
      run('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', out, '.'], { cwd: dir, shell: false, env: goEnv(goos, goarch) });
      mustExist(out);
      checkGoVersion(out, dir, `${name} ${goos}/${goarch}`);
    }
  }
  // The desktop app passes -payroll to SerieX Books and -books to SerieX Payroll: check both
  // flags exist, using the build that runs on this computer. When this computer is not one of the
  // targets (for example "build.mjs linux" or "win" on a Mac), a throw-away build for this
  // computer is made in build/servers/.check-<os>-<arch> and removed after the checks.
  const throwaway = !serverTargets().some((t) => t.goos === HOST_OS && t.goarch === HOST_ARCH);
  const hostDir = path.join(buildDir, 'servers', `${throwaway ? '.check-' : ''}${HOST_OS}-${HOST_ARCH}`);
  const ext = IS_WIN_HOST ? '.exe' : '';
  try {
    if (throwaway) {
      step(`servers for this computer (${HOST_OS}/${HOST_ARCH}), only to check their options`);
      fs.rmSync(hostDir, { recursive: true, force: true });
      fs.mkdirSync(hostDir, { recursive: true });
      for (const [name, dir] of programs) {
        const out = path.join(hostDir, name + ext);
        run('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', out, '.'], { cwd: dir, shell: false, env: goEnv(HOST_OS, HOST_ARCH) });
        mustExist(out);
      }
    }
    for (const [name, needed] of [
      ['seriex-books', '-payroll'],
      ['seriex-payroll', '-books'],
    ]) {
      const bin = path.join(hostDir, name + ext);
      mustExist(bin);
      const r = spawnSync(bin, ['-h'], { encoding: 'utf8' });
      const help = `${r.stdout || ''}${r.stderr || ''}`;
      if (!help.includes(`${needed} `) && !help.includes(`${needed}\n`)) throw new Error(`${name} does not accept the ${needed} option`);
      console.log(`${name} accepts ${needed}`);
    }
    buildMcpHelper(hostDir, ext, throwaway);
  } finally {
    if (throwaway) fs.rmSync(hostDir, { recursive: true, force: true });
  }
}

/**
 * Builds seriex-mcp next to the servers of every target, when mcp/ exists and Books accepts
 * -mcp-helper. With throwaway set, hostDir is the check folder of buildServers(), and seriex-mcp
 * is also built there for this computer, for the --version check.
 */
function buildMcpHelper(hostDir, ext, throwaway) {
  if (!fs.existsSync(path.join(mcpDir, 'cmd', 'seriex-mcp'))) {
    console.log('seriex-mcp: mcp/cmd/seriex-mcp not found, the helper is not bundled');
    return;
  }
  const books = path.join(hostDir, 'seriex-books' + ext);
  const r = spawnSync(books, ['-h'], { encoding: 'utf8' });
  const help = `${r.stdout || ''}${r.stderr || ''}`;
  if (!help.includes('-mcp-helper')) {
    console.log('seriex-mcp: SerieX Books does not accept -mcp-helper yet, the helper is not bundled');
    return;
  }
  for (const { goos, goarch } of serverTargets()) {
    const out = path.join(buildDir, 'servers', `${goos}-${goarch}`, 'seriex-mcp' + (goos === 'windows' ? '.exe' : ''));
    run('go', ['build', '-trimpath', '-ldflags', `-s -w -X main.version=${appVersion}`, '-o', out, './cmd/seriex-mcp'], {
      cwd: mcpDir,
      shell: false,
      env: goEnv(goos, goarch),
    });
    mustExist(out);
    checkGoVersion(out, mcpDir, `seriex-mcp ${goos}/${goarch}`);
  }
  const helper = path.join(hostDir, 'seriex-mcp' + ext);
  if (throwaway) {
    run('go', ['build', '-trimpath', '-ldflags', `-s -w -X main.version=${appVersion}`, '-o', helper, './cmd/seriex-mcp'], {
      cwd: mcpDir,
      shell: false,
      env: goEnv(HOST_OS, HOST_ARCH),
    });
    mustExist(helper);
  }
  const v = spawnSync(helper, ['--version'], { encoding: 'utf8' });
  if (!`${v.stdout || ''}${v.stderr || ''}`.includes(appVersion)) throw new Error(`seriex-mcp --version does not say ${appVersion}`);
  console.log(`seriex-mcp ${appVersion} bundled`);
}

// ---- (c) license files ----

/** build/LICENSE and build/THIRD_PARTY_NOTICES.txt, for the Go modules of the systems being built. */
function buildLicenseFiles() {
  step('license and third-party notices');
  fs.mkdirSync(buildDir, { recursive: true });
  fs.copyFileSync(LICENSE_FILE, path.join(buildDir, 'LICENSE'));
  // seriex-mcp is listed when this build carries it (buildMcpHelper put it next to the servers)
  const targets = serverTargets();
  const mcp = targets.some(({ goos, goarch }) => fs.existsSync(path.join(buildDir, 'servers', `${goos}-${goarch}`, 'seriex-mcp' + (goos === 'windows' ? '.exe' : ''))));
  const r = writeNotices({ out: NOTICES_FILE, targets, mcp, appVersion });
  for (const w of r.warnings) console.warn(`note: ${w}`);
  console.log(`${path.relative(desktop, r.file)}: ${r.goModules} Go modules, ${r.webPackages} JavaScript packages, Go ${r.goVersions.join(' and ')}`);
  console.log(`build/LICENSE: copied from ${path.relative(desktop, LICENSE_FILE)}`);
}

// ---- (d) icon ----
function buildIcon() {
  step('app icon');
  const electron = require('electron'); // path of the Electron binary
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'seriex-icon-'));
  try {
    const env = { ...process.env, SERIEX_ICON_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    const r = spawnSync(electron, [path.join(desktop, 'scripts', 'render-icons.cjs'), buildDir], { stdio: 'inherit', env });
    if (r.status !== 0) throw new Error('rendering the icon failed');
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
  mustExist(path.join(buildDir, 'icon.png'));
  mustExist(path.join(buildDir, 'icon.ico'));
  mustExist(path.join(buildDir, 'icons', '512x512.png'));
}

// ---- (e) electron-builder ----

/**
 * The files next to app.asar (resources/ on Windows, SerieX.app/Contents/Resources on macOS,
 * /opt/SerieX/resources on Ubuntu): the servers, the web pages, LICENSE and
 * THIRD_PARTY_NOTICES.txt (Help > License and Help > Third-Party Notices open these two).
 */
function resources(serverDir) {
  for (const d of [serverDir, 'build/books-web', 'build/payroll-web', 'build/LICENSE', 'build/THIRD_PARTY_NOTICES.txt']) {
    mustExist(path.join(desktop, d), 'Build it first (drop the --skip option).');
  }
  return [
    { from: serverDir, to: 'servers' },
    { from: 'build/books-web', to: 'books-web' },
    { from: 'build/payroll-web', to: 'payroll-web' },
    { from: 'build/LICENSE', to: 'LICENSE' },
    { from: 'build/THIRD_PARTY_NOTICES.txt', to: 'THIRD_PARTY_NOTICES.txt' },
  ];
}

/**
 * Electron's own notices. The Windows installer puts LICENSE.electron.txt and
 * LICENSES.chromium.html next to SerieX.exe by itself; the macOS app gets them in its resources.
 */
function electronNotices() {
  const dist = path.join(desktop, 'node_modules', 'electron', 'dist');
  mustExist(path.join(dist, 'LICENSE'), 'Run "npm install" in desktop/ first.');
  mustExist(path.join(dist, 'LICENSES.chromium.html'), 'Run "npm install" in desktop/ first.');
  return [
    { from: 'node_modules/electron/dist/LICENSE', to: 'LICENSE.electron.txt' },
    { from: 'node_modules/electron/dist/LICENSES.chromium.html', to: 'LICENSES.chromium.html' },
  ];
}

/**
 * Locks the Electron binary down; on macOS also gives the whole app an ad-hoc signature (there is
 * no certificate); on Ubuntu makes sure the servers can be run.
 */
async function afterPack(context) {
  const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
  const mac = context.electronPlatformName === 'darwin';
  const linux = context.electronPlatformName === 'linux';
  const exe = mac
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
    : linux
      ? path.join(context.appOutDir, context.packager.executableName) // .../linux-unpacked/seriex
      : path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  await flipFuses(exe, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: mac,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    ...(mac ? { [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true } : {}),
  });
  console.log(`fuses set on ${exe}`);
  if (linux) {
    const servers = path.join(context.appOutDir, 'resources', 'servers');
    for (const f of fs.readdirSync(servers)) fs.chmodSync(path.join(servers, f), 0o755);
    return;
  }
  if (!mac) return;
  const servers = path.join(exe, 'Contents', 'Resources', 'servers');
  for (const f of fs.readdirSync(servers)) {
    fs.chmodSync(path.join(servers, f), 0o755);
    run('codesign', ['--force', '--sign', '-', '--timestamp=none', path.join(servers, f)], { shell: false });
  }
  run('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', exe], { shell: false });
  run('codesign', ['--verify', '--deep', '--strict', exe], { shell: false });
}

function baseConfig() {
  return {
    appId: 'com.seriex.desktop',
    productName: 'SerieX',
    copyright: '© 2026 SerieX contributors',
    directories: { output: 'dist', buildResources: 'build' },
    files: ['src/**/*', 'assets/icon.svg', 'package.json'],
    asar: true,
    npmRebuild: false,
    publish: null,
    afterPack,
  };
}

/** Removes installers an earlier build left in dist/ (also the older names with the version in them). */
function removeOldInstallers(test) {
  const dist = path.join(desktop, 'dist');
  if (!fs.existsSync(dist)) return;
  for (const f of fs.readdirSync(dist)) {
    if (/^SerieX-.*\.(dmg|zip|exe|deb|blockmap)$/i.test(f) && test(f)) fs.rmSync(path.join(dist, f), { force: true });
  }
}

async function packageMac(builder, arch) {
  step(`macOS DMG and ZIP (${arch})`);
  removeOldInstallers((f) => f.includes(`-mac-${arch}`));
  const { Platform, Arch } = builder;
  await builder.build({
    targets: Platform.MAC.createTarget(['dmg', 'zip'], Arch[arch]),
    config: {
      ...baseConfig(),
      mac: {
        icon: 'build/icon.png',
        category: 'public.app-category.finance',
        identity: null,
        hardenedRuntime: false,
        gatekeeperAssess: false,
        extraResources: [...resources(`build/servers/darwin-${GOARCH[arch]}`), ...electronNotices()],
        artifactName: 'SerieX-mac-${arch}.${ext}',
      },
      dmg: { title: 'SerieX ${version}', sign: false, writeUpdateInfo: false },
    },
  });
}

async function packageWin(builder) {
  step('Windows installer (x64)');
  removeOldInstallers((f) => /^SerieX-Setup-/i.test(f));
  const { Platform, Arch } = builder;
  await builder.build({
    targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
    config: {
      ...baseConfig(),
      // NSIS 3.12 toolset: its makensis runs natively on Apple Silicon (the older default bundle is Intel-only)
      toolsets: { nsis: '1.2.1' },
      win: {
        icon: 'build/icon.ico',
        signAndEditExecutable: true,
        extraResources: resources('build/servers/windows-amd64'),
        artifactName: 'SerieX-Setup-${arch}.${ext}',
      },
      // No license page: the AGPL does not ask users to accept anything to install or use SerieX,
      // and the NSIS license page makes them click "I Agree". The license is in resources\LICENSE.
      // (electron-builder adds that page by itself when build/ holds license.txt or eula.txt.)
      nsis: {
        oneClick: false,
        perMachine: false,
        allowElevation: true,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: 'always',
        createStartMenuShortcut: true,
        shortcutName: 'SerieX',
        uninstallDisplayName: 'SerieX',
        installerIcon: 'build/icon.ico',
        uninstallerIcon: 'build/icon.ico',
        deleteAppDataOnUninstall: false,
        differentialPackage: false,
        runAfterFinish: true,
      },
    },
  });
}

/**
 * Ubuntu: one .deb per processor, installed into /opt/SerieX (program seriex, menu entry
 * seriex.desktop). Its install step adds the AppArmor rule (Ubuntu's security rules) that lets
 * Chromium's sandbox run on Ubuntu 24.04 and later. These are Linux settings only, so the Mac and
 * Windows builds do not change: desktopName and homepage go into this package's package.json only.
 */
async function packageLinux(builder, arch) {
  const debArch = GOARCH[arch];
  step(`Ubuntu package (${debArch})`);
  if (spawnSync('xz', ['--version'], { stdio: 'ignore' }).error) {
    throw new Error('xz is missing: the Ubuntu packages are compressed with it. On a Mac, install it with "brew install xz".');
  }
  removeOldInstallers((f) => f.startsWith(`SerieX-linux-${debArch}.`));
  mustExist(path.join(buildDir, 'icons', '256x256.png'), 'Render the icons first (drop --skip-icon).');
  const { Platform, Arch } = builder;
  await builder.build({
    targets: Platform.LINUX.createTarget(['deb'], Arch[arch]),
    config: {
      ...baseConfig(),
      extraMetadata: { desktopName: 'seriex.desktop', homepage: 'https://github.com/CapitalFee/SerieX' },
      linux: {
        executableName: 'seriex', // not at the top level: that would rename SerieX.exe
        syncDesktopName: true,
        icon: 'build/icons',
        category: 'Office;Finance',
        synopsis: 'Free bookkeeping and payroll',
        description: 'SerieX Books and SerieX Payroll as a desktop application',
        maintainer: LINUX_MAINTAINER,
        vendor: 'SerieX',
        // Electron's own license files land next to the program by themselves, as on Windows.
        extraResources: [...resources(`build/servers/linux-${debArch}`), { from: 'build/icons/256x256.png', to: 'icon.png' }],
        artifactName: 'SerieX-linux-${arch}.${ext}', // ${arch} is amd64 or arm64 for a .deb
      },
      deb: {
        packageName: 'seriex',
        packageCategory: 'office',
        // libasound2t64 first: a plain libasound2 makes apt pick liboss4-salsa-asound2 on 24.04, which crashes SerieX.
        depends: ['libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils', 'libatspi2.0-0', 'libuuid1', 'libsecret-1-0', 'libasound2t64 | libasound2', 'libgbm1'],
        recommends: [], // the default libappindicator3-1 does not exist on 24.04, and SerieX does not use it
      },
    },
  });
  mustExist(path.join(desktop, 'dist', `SerieX-linux-${debArch}.deb`), 'electron-builder did not write it.');
}

// ---- (f) extension packages for Claude Desktop ----

/** Builds the .mcpb packages and server.json into dist/mcp/ with mcp/packaging/build.sh (needs a Mac: lipo). */
function buildMcpb() {
  const script = path.join(mcpDir, 'packaging', 'build.sh');
  if (!fs.existsSync(script)) {
    console.log('mcp/packaging/build.sh not found: the extension packages are not built');
    return;
  }
  if (process.platform !== 'darwin') {
    console.log('the extension packages are built on a Mac only (they need lipo): not built');
    return;
  }
  step(`extension packages for Claude Desktop (${appVersion})`);
  const out = path.join(desktop, 'dist', 'mcp');
  fs.rmSync(out, { recursive: true, force: true }); // no package of another version is left next to these
  run('bash', [script, appVersion, out], { env: { ...process.env, GOTOOLCHAIN: 'auto' } });
  for (const f of [`seriex-${appVersion}-darwin-universal.mcpb`, `seriex-${appVersion}-windows-amd64.mcpb`, 'server.json']) {
    mustExist(path.join(out, f), 'mcp/packaging/build.sh did not write it.');
  }
}

// ---- (g) the SerieX skill for AI assistants ----

/**
 * Packs skills/seriex into dist/seriex.skill: a ZIP whose root is the folder seriex/, the file the
 * Claude apps upload under Customize > Skills (Claude Code and Codex use the unzipped folder).
 * Python caches and .DS_Store files are left out, as the skill packager of Claude does.
 */
function buildSkill() {
  const skills = path.join(root, 'skills');
  mustExist(path.join(skills, 'seriex', 'SKILL.md'));
  if (spawnSync('zip', ['-v'], { stdio: 'ignore' }).error) {
    console.log('zip not found: dist/seriex.skill is not built');
    return;
  }
  step('SerieX skill for AI assistants');
  const out = path.join(desktop, 'dist', 'seriex.skill');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.rmSync(out, { force: true }); // zip adds to an existing file instead of replacing it
  run('zip', ['-q', '-r', '-X', '-D', '-9', out, 'seriex', '-x', '*/__pycache__/*', '*.pyc', '*/.DS_Store'], { cwd: skills, shell: false });
  mustExist(out);
}

const started = Date.now();
checkLicense();
if (!flag('skip-web')) buildWeb();
if (!flag('skip-servers')) buildServers();
buildLicenseFiles();
if (!flag('skip-icon')) buildIcon();
const builder = require('electron-builder');
if (wantMac) for (const a of macArchs) await packageMac(builder, a);
if (wantWin) await packageWin(builder);
if (wantLinux) for (const a of linuxArchs) await packageLinux(builder, a);
if (what === 'all' && !flag('skip-mcpb')) buildMcpb();
if (what === 'all') buildSkill();

step('installers');
const dist = path.join(desktop, 'dist');
const mcpbDir = path.join(dist, 'mcp');
const outputs = [
  ...fs.readdirSync(dist).filter((f) => /\.(dmg|zip|exe|deb|skill)$/i.test(f)).map((f) => path.join(dist, f)),
  ...(fs.existsSync(mcpbDir) ? fs.readdirSync(mcpbDir).filter((f) => f.endsWith('.mcpb')).map((f) => path.join(mcpbDir, f)) : []),
];
for (const f of outputs.sort()) {
  const mb = (fs.statSync(f).size / 1024 / 1024).toFixed(1);
  console.log(`${path.relative(dist, f)}  ${mb} MB`);
}
console.log(`done in ${Math.round((Date.now() - started) / 1000)} s`);
