// Publishes the installers in desktop/dist/ and the SerieX extension packages for Claude Desktop in
// desktop/dist/mcp/ as the GitHub release v<version> of the source repository CapitalFee/SerieX
// (version from desktop/package.json).
//
//   npm run publish -- --commit <sha>             publish (run "npm run build:all" first)
//   npm run publish -- --commit <sha> --dry-run   write SHA256SUMS and the release notes, change nothing on GitHub
//
// --commit is required: it names the commit the installers were built from, and the release tag
// v<version> is created on exactly that commit. It must be the HEAD of this working tree (with no
// changes to tracked files) and must already be on origin/main, and the installers must have been
// built after it was made.
//
// Steps: (a) check the commit, (b) check the installers (five for Mac and Windows, and the two
// Ubuntu packages SerieX-linux-amd64.deb and -arm64.deb: their version, processor and contents,
// read with the macOS tar), the two extension packages (seriex-<version>-darwin-universal.mcpb
// and -windows-amd64.mcpb, with dist/mcp/server.json naming their download addresses and
// SHA-256), the SerieX skill for AI assistants (dist/seriex.skill, which must hold exactly the
// skills/seriex folder of the commit) and the install scripts, (c)
// write dist/SHA256SUMS, (d) create the release and its tag on the commit (or, when the release
// already exists on the same commit, upload its files again) with the installers, the extension
// packages, the skill, SHA256SUMS and both install scripts as its files, and mark it as the latest
// release. Nothing is committed to any branch: the install scripts are published only as files of
// the release. server.json is not
// published here: after this release is out, mcp-publisher publishes it to the MCP Registry, which
// downloads the packages from this release to check their SHA-256.
// Needs git and the GitHub CLI (gh), signed in with write access to the repository.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'CapitalFee/SerieX';
const BRANCH = 'main';
const DOWNLOAD = `https://github.com/${REPO}/releases/latest/download`;
// the Ubuntu packages (scripts/build.mjs packageLinux; release/install.sh downloads them by name)
const LINUX_DEBS = ['SerieX-linux-amd64.deb', 'SerieX-linux-arm64.deb'];
const INSTALLERS = ['SerieX-mac-arm64.zip', 'SerieX-mac-x64.zip', 'SerieX-mac-arm64.dmg', 'SerieX-mac-x64.dmg', 'SerieX-Setup-x64.exe', ...LINUX_DEBS];
const SCRIPTS = ['install.sh', 'install.ps1'];

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(desktop, 'dist');
const mcpDist = path.join(dist, 'mcp');
const releaseDir = path.join(desktop, 'release');
const { version } = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
const tag = `v${version}`;
// built by "npm run build:all" on a Mac (mcp/packaging/build.sh)
const MCPB_MAC = `seriex-${version}-darwin-universal.mcpb`;
const MCPB_WIN = `seriex-${version}-windows-amd64.mcpb`;
const MCPB = [MCPB_MAC, MCPB_WIN];
// the SerieX skill for AI assistants: skills/seriex packed under seriex/ (no version in the name,
// so the README can link to releases/latest/download/seriex.skill)
const SKILL = 'seriex.skill';

function step(title) {
  console.log(`\n=== ${title}`);
}

function fail(message) {
  console.error(`\npublish stopped: ${message}`);
  process.exit(1);
}

/** Runs a command; returns { status, stdout, stderr }. */
function run(cmd, args, { input, quiet } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', input, stdio: [input === undefined ? 'inherit' : 'pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  if (r.error) fail(`${cmd} could not run: ${r.error.message}`);
  if (!quiet && r.stderr) process.stderr.write(r.stderr);
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** Runs gh and fails on an error (unless allowed). Uploads show their output as they go. */
function gh(args, { allowFail = false, live = false, input } = {}) {
  if (live) {
    const r = spawnSync('gh', args, { stdio: 'inherit' });
    if (r.status !== 0 && !allowFail) fail(`gh ${args.slice(0, 3).join(' ')} failed (exit ${r.status})`);
    return { status: r.status, stdout: '' };
  }
  const r = run('gh', args, { input, quiet: allowFail });
  if (r.status !== 0 && !allowFail) fail(`gh ${args.slice(0, 3).join(' ')} failed (exit ${r.status}) ${r.stderr.trim()}`);
  return r;
}

function ghJson(args, opts) {
  const r = gh(args, opts);
  if (r.status !== 0) return null;
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

function sha256(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(8 * 1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Runs git in this working tree; returns { status, out, lines, err } (out = trimmed stdout). */
function git(args) {
  const r = run('git', ['-C', desktop, ...args], { quiet: true });
  return { status: r.status, out: r.stdout.trim(), lines: r.stdout.split('\n').filter(Boolean), err: r.stderr.trim() };
}

/** The commit a tag of the repository points at on GitHub; '' when there is no such tag. */
function tagCommit(name) {
  const ref = ghJson(['api', `repos/${REPO}/git/ref/tags/${name}`], { allowFail: true });
  if (!ref || !ref.object) return '';
  if (ref.object.type === 'commit') return ref.object.sha;
  if (ref.object.type === 'tag') return ghJson(['api', `repos/${REPO}/git/tags/${ref.object.sha}`])?.object?.sha || '';
  return '';
}

// ---- Ubuntu packages ----

const DEB_PACKAGE = 'seriex'; // deb.packageName in scripts/build.mjs
const ELF_MACHINE = { amd64: 0x3e, arm64: 0xb7 }; // the processor field of a Linux program
const DEB_PROGRAMS = ['opt/SerieX/seriex', ...['seriex-books', 'seriex-payroll', 'seriex-mcp'].map((n) => `opt/SerieX/resources/servers/${n}`)];
const DEB_FILES = [
  ...DEB_PROGRAMS,
  'opt/SerieX/chrome-sandbox',
  'opt/SerieX/resources/app.asar',
  'opt/SerieX/resources/apparmor-profile',
  'opt/SerieX/resources/LICENSE',
  'opt/SerieX/resources/THIRD_PARTY_NOTICES.txt',
  'opt/SerieX/resources/icon.png',
  'opt/SerieX/resources/books-web/index.html',
  'opt/SerieX/resources/payroll-web/index.html',
  'usr/share/applications/seriex.desktop',
  'usr/share/icons/hicolor/512x512/apps/seriex.png',
];
const DESKTOP_ENTRY = ['Exec=/opt/SerieX/seriex %U', 'Icon=seriex', 'StartupWMClass=seriex'];

/** Lists a tar archive with the macOS tar (bsdtar, which also reads the .deb format): { names, long }. */
function tarList(file, label) {
  const r = run('/usr/bin/tar', ['-tvf', file], { quiet: true });
  const short = run('/usr/bin/tar', ['-tf', file], { quiet: true });
  if (r.status !== 0 || short.status !== 0) fail(`could not read ${label} with tar.`);
  return { names: short.stdout.split('\n').filter(Boolean), long: r.stdout.split('\n').filter(Boolean) };
}

/** Checks dist/<f> (SerieX-linux-<amd64|arm64>.deb), unpacking what it needs into a folder of tmp. */
function checkDeb(f, tmp) {
  if (process.platform !== 'darwin') fail('check the Ubuntu packages on a Mac: the check reads them with the macOS tar.');
  const file = path.join(dist, f);
  const arch = /^SerieX-linux-(amd64|arm64)\.deb$/.exec(f)[1];
  const head = Buffer.alloc(8);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, 8, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (head.toString('latin1') !== '!<arch>\n') fail(`dist/${f} is not a Debian package.`);
  const members = tarList(file, `dist/${f}`).names;
  const control = members.find((n) => /^control\.tar\.(gz|xz|zst)$/.test(n));
  const data = members.find((n) => /^data\.tar\.(gz|xz|zst)$/.test(n));
  if (!members.includes('debian-binary') || !control || !data) fail(`dist/${f} does not hold debian-binary, control.tar and data.tar.`);
  const dir = fs.mkdtempSync(path.join(tmp, `${arch}-`));
  if (run('/usr/bin/tar', ['-xf', file, '-C', dir, control, data], { quiet: true }).status !== 0) fail(`could not unpack dist/${f}.`);
  const plain = (n) => n.replace(/^\.\//, '');

  // the package fields (./control)
  const controlTar = path.join(dir, control);
  const controlName = tarList(controlTar, `${control} in dist/${f}`).names.find((n) => plain(n) === 'control');
  if (!controlName) fail(`${control} in dist/${f} has no control file.`);
  const fields = {};
  for (const line of run('/usr/bin/tar', ['-xOf', controlTar, controlName], { quiet: true }).stdout.split('\n')) {
    const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (m) fields[m[1]] = m[2].trim();
  }
  if (fields.Package !== DEB_PACKAGE) fail(`dist/${f} is the package ${fields.Package || '(none)'}, not ${DEB_PACKAGE}.`);
  if (fields.Version !== version) fail(`dist/${f} contains SerieX ${fields.Version || '(no version)'}, not ${version}. Run "npm run build:all" first.`);
  if (fields.Architecture !== arch) fail(`dist/${f} is for ${fields.Architecture || '(no processor)'}, not ${arch}.`);

  // the files it installs
  const dataTar = path.join(dir, data);
  const listing = tarList(dataTar, `${data} in dist/${f}`);
  const byPlain = new Map(listing.names.map((n) => [plain(n), n]));
  const missing = DEB_FILES.filter((n) => !byPlain.has(n));
  if (missing.length) fail(`dist/${f} does not install ${missing.map((n) => `/${n}`).join(', ')}.`);
  // every file must belong to root (user and group 0): Ubuntu installs them with the owner the package records
  const owners = run('/usr/bin/tar', ['--numeric-owner', '-tvf', dataTar], { quiet: true });
  if (owners.status !== 0) fail(`could not read the owners in ${data} of dist/${f}.`);
  const notRoot = owners.stdout.split('\n').filter(Boolean).filter((l) => {
    const p = l.trim().split(/\s+/);
    return p[2] !== '0' || p[3] !== '0';
  });
  if (notRoot.length) fail(`dist/${f} has ${notRoot.length} files not owned by root, for example: ${notRoot[0].trim()}`);
  for (const n of DEB_PROGRAMS) {
    const line = listing.long.find((l) => l.endsWith(` ${byPlain.get(n)}`));
    if (!line || !/^-..x..x..x/.test(line)) fail(`/${n} in dist/${f} cannot be run (its mode is not 755).`);
  }
  const out = path.join(dir, 'files');
  fs.mkdirSync(out);
  const wanted = [...DEB_PROGRAMS, 'usr/share/applications/seriex.desktop'].map((n) => byPlain.get(n));
  if (run('/usr/bin/tar', ['-xf', dataTar, '-C', out, ...wanted], { quiet: true }).status !== 0) fail(`could not unpack the programs of dist/${f}.`);
  for (const n of DEB_PROGRAMS) {
    const elf = Buffer.alloc(20);
    const pfd = fs.openSync(path.join(out, n), 'r');
    try {
      fs.readSync(pfd, elf, 0, 20, 0);
    } finally {
      fs.closeSync(pfd);
    }
    const isElf64 = elf[0] === 0x7f && elf.toString('latin1', 1, 4) === 'ELF' && elf[4] === 2;
    if (!isElf64 || elf.readUInt16LE(18) !== ELF_MACHINE[arch]) fail(`/${n} in dist/${f} is not a 64-bit Linux program for ${arch}.`);
  }
  const entry = fs.readFileSync(path.join(out, 'usr/share/applications/seriex.desktop'), 'utf8').split('\n').map((l) => l.trim());
  for (const want of DESKTOP_ENTRY) {
    if (!entry.includes(want)) fail(`the menu entry seriex.desktop in dist/${f} does not have ${want}.`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`${f}: ${DEB_PACKAGE} ${fields.Version} for ${arch}, ${DEB_FILES.length} files checked`);
}

// ---- arguments ----
function usage(message) {
  console.error(`publish stopped: ${message}\n`);
  console.error('Usage: npm run publish -- --commit <sha> [--dry-run]');
  console.error('  --commit <sha>   the commit the installers were built from (the release tag is created on it)');
  console.error('  --dry-run        write SHA256SUMS and the release notes, change nothing on GitHub');
  process.exit(1);
}
let dryRun = false;
let commitArg = '';
{
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--commit') {
      commitArg = args[++i] || '';
      if (!commitArg || commitArg.startsWith('-')) usage('--commit needs the commit the installers were built from.');
    } else if (a.startsWith('--commit=')) commitArg = a.slice('--commit='.length);
    else usage(`unknown option ${a}`);
  }
  if (!commitArg) usage('--commit <sha> is required: the commit the installers were built from.');
}

// ---- (a) check the commit ----
step(`commit ${commitArg}`);
const resolved = git(['rev-parse', '--verify', '--quiet', `${commitArg}^{commit}`]);
if (resolved.status !== 0 || !/^[0-9a-f]{40}$/.test(resolved.out)) fail(`${commitArg} is not a commit of this repository.`);
const commit = resolved.out;
const short = commit.slice(0, 12);
const head = git(['rev-parse', 'HEAD']).out;
if (head !== commit) {
  fail(`this working tree is at ${head.slice(0, 12)}, not at ${short}, so its installers were not built from ${short}. Build and publish from a working tree of that commit (git worktree add --detach <folder> ${short}).`);
}
const changed = git(['status', '--porcelain', '--untracked-files=no']);
if (changed.status !== 0) fail(`git status failed: ${changed.err}`);
if (changed.lines.length) {
  const { lines } = changed;
  const list = lines.slice(0, 10).join('\n') + (lines.length > 10 ? `\n... and ${lines.length - 10} more` : '');
  fail(`this working tree has changed files, so its installers may not match ${short}:\n${list}\nBuild and publish from a clean working tree of the commit.`);
}
const onMain = git(['merge-base', '--is-ancestor', commit, `refs/remotes/origin/${BRANCH}`]);
if (onMain.status === 1) fail(`${short} is not on origin/${BRANCH}. Push it to ${BRANCH} first (run "git fetch origin" if it is already there).`);
if (onMain.status !== 0) fail(`could not check whether ${short} is on origin/${BRANCH}: ${onMain.err}`);
console.log(`${commit} is HEAD of this working tree and on origin/${BRANCH}`);

// ---- (b) check the files ----
step(`SerieX ${version}: checking the files`);
for (const f of INSTALLERS) {
  if (!fs.existsSync(path.join(dist, f))) fail(`dist/${f} is missing. Run "npm run build:all" first.`);
}
for (const f of [...MCPB, 'server.json']) {
  if (!fs.existsSync(path.join(mcpDist, f))) fail(`dist/mcp/${f} is missing. Run "npm run build:all" on a Mac first.`);
}
for (const f of SCRIPTS) {
  if (!fs.existsSync(path.join(releaseDir, f))) fail(`release/${f} is missing.`);
}
// install.sh is shared by every Mac and Ubuntu user: it must parse, and it must know the Ubuntu packages.
{
  const script = path.join(releaseDir, 'install.sh');
  const parsed = run('bash', ['-n', script], { quiet: true }).status === 0;
  if (!parsed || !fs.readFileSync(script, 'utf8').includes('SerieX-linux-')) fail('release/install.sh cannot install the Ubuntu packages.');
}
// The app inside each ZIP must be this version (a ZIP left by an older build would not be).
for (const f of INSTALLERS.filter((n) => n.endsWith('.zip'))) {
  const plist = spawnSync('unzip', ['-p', path.join(dist, f), 'SerieX.app/Contents/Info.plist'], { maxBuffer: 16 * 1024 * 1024 });
  const m = plist.status === 0 && /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist.stdout.toString('utf8'));
  if (!m) fail(`could not read the app version inside dist/${f}`);
  if (m[1] !== version) fail(`dist/${f} contains SerieX ${m[1]}, not ${version}. Run "npm run build:all" first.`);
}
// Each Ubuntu package must be this version, for its processor, and hold SerieX, its servers, the
// AppArmor rule (without it SerieX does not open on Ubuntu 24.04), the license files, the icon and
// the menu entry.
const debTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seriex-deb-'));
process.on('exit', () => fs.rmSync(debTmp, { recursive: true, force: true })); // fail() exits at once
try {
  for (const f of LINUX_DEBS) checkDeb(f, debTmp);
} finally {
  fs.rmSync(debTmp, { recursive: true, force: true });
}
// Each extension package must be this version, and the Mac one must run on Apple silicon and Intel.
const mcpbTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seriex-mcpb-'));
process.on('exit', () => fs.rmSync(mcpbTmp, { recursive: true, force: true })); // fail() exits at once
try {
  for (const f of MCPB) {
    const manifest = spawnSync('unzip', ['-p', path.join(mcpDist, f), 'manifest.json'], { encoding: 'utf8' });
    let v = '';
    try {
      v = JSON.parse(manifest.stdout).version;
    } catch {
      fail(`could not read manifest.json inside dist/mcp/${f}`);
    }
    if (v !== version) fail(`dist/mcp/${f} says version ${v}, not ${version}. Run "npm run build:all" first.`);
  }
  const helper = path.join(mcpbTmp, 'seriex-mcp');
  const unz = spawnSync('unzip', ['-o', '-j', '-q', path.join(mcpDist, MCPB_MAC), 'server/seriex-mcp', '-d', mcpbTmp]);
  if (unz.status !== 0 || !fs.existsSync(helper)) fail(`could not take server/seriex-mcp out of dist/mcp/${MCPB_MAC}`);
  if (process.platform === 'darwin') {
    const archs = run('lipo', ['-archs', helper], { quiet: true }).stdout.trim().split(/\s+/);
    if (!archs.includes('arm64') || !archs.includes('x86_64')) fail(`server/seriex-mcp in dist/mcp/${MCPB_MAC} is for ${archs.join(' ') || 'nothing'}, not for both arm64 and x86_64.`);
    fs.chmodSync(helper, 0o755);
    const hv = run(helper, ['--version'], { quiet: true });
    if (!`${hv.stdout}${hv.stderr}`.includes(version)) fail(`server/seriex-mcp in dist/mcp/${MCPB_MAC} does not say version ${version}.`);
  }
} finally {
  fs.rmSync(mcpbTmp, { recursive: true, force: true });
}
// server.json (published to the MCP Registry after this release) must name these exact files.
{
  let server;
  try {
    server = JSON.parse(fs.readFileSync(path.join(mcpDist, 'server.json'), 'utf8'));
  } catch {
    fail('could not read dist/mcp/server.json');
  }
  const pkgs = server.packages || [];
  if (server.version !== version) fail(`dist/mcp/server.json says version ${server.version}, not ${version}.`);
  if (pkgs.length !== MCPB.length) fail(`dist/mcp/server.json lists ${pkgs.length} packages, not ${MCPB.length}.`);
  for (const f of MCPB) {
    const url = `https://github.com/${REPO}/releases/download/${tag}/${f}`;
    const p = pkgs.find((x) => x.identifier === url);
    if (!p) fail(`dist/mcp/server.json does not list ${url}`);
    if (p.fileSha256 !== sha256(path.join(mcpDist, f))) fail(`dist/mcp/server.json has another SHA-256 for ${f} than the file in dist/mcp/. Run "npm run build:all" again.`);
  }
}
// The skill must open and hold exactly the files of skills/seriex in this commit, under seriex/,
// with the front matter of SKILL.md intact (the Claude apps refuse a skill without it).
{
  const file = path.join(dist, SKILL);
  if (!fs.existsSync(file)) fail(`dist/${SKILL} is missing. Run "npm run build:all" first.`);
  if (run('unzip', ['-tqq', file], { quiet: true }).status !== 0) fail(`dist/${SKILL} does not open as a ZIP file.`);
  const inZip = run('unzip', ['-Z1', file], { quiet: true }).stdout.split('\n').filter((n) => n && !n.endsWith('/'));
  const want = git(['ls-files', '--full-name', '--', ':/skills/seriex']).lines.map((f) => f.replace(/^skills\//, ''));
  if (!want.includes('seriex/SKILL.md')) fail('git does not list skills/seriex/SKILL.md in this commit.');
  const extra = inZip.filter((n) => !want.includes(n));
  const missing = want.filter((n) => !inZip.includes(n));
  if (extra.length) fail(`dist/${SKILL} holds files that are not in skills/seriex of ${short}: ${extra.join(', ')}. Run "npm run build:all" again.`);
  if (missing.length) fail(`dist/${SKILL} misses ${missing.join(', ')}. Run "npm run build:all" again.`);
  const packed = (n) => spawnSync('unzip', ['-p', file, n], { maxBuffer: 64 * 1024 * 1024 }).stdout;
  for (const n of want) {
    if (!packed(n)?.equals(fs.readFileSync(path.join(desktop, '..', 'skills', n)))) fail(`${n} in dist/${SKILL} differs from skills/${n}. Run "npm run build:all" again.`);
  }
  const front = /^---\n([\s\S]*?)\n---\n/.exec(packed('seriex/SKILL.md').toString('utf8'))?.[1] || '';
  if (!/^name: seriex$/m.test(front) || !/^description: \S/m.test(front)) fail(`SKILL.md in dist/${SKILL} does not start with front matter naming the skill seriex and describing it.`);
  console.log(`${SKILL}: ${want.length} files of skills/seriex`);
}
// Everything must come from the same build: the DMGs and the Windows installer with the ZIPs, and
// the extension packages and the skill with them.
const built = [...INSTALLERS.map((f) => path.join(dist, f)), ...MCPB.map((f) => path.join(mcpDist, f)), path.join(dist, SKILL)];
const times = built.map((f) => fs.statSync(f).mtimeMs);
if (Math.max(...times) - Math.min(...times) > 3 * 60 * 60 * 1000) fail('the files in dist/ and dist/mcp/ were not built together. Run "npm run build:all" first.');
// Files older than the commit were built from an earlier commit (same version or not).
const commitTime = Number(git(['show', '-s', '--format=%ct', commit]).out) * 1000;
if (!commitTime) fail(`could not read the date of ${short}.`);
const oldest = times.indexOf(Math.min(...times));
if (times[oldest] < commitTime) {
  fail(`${path.relative(desktop, built[oldest])} was built ${new Date(times[oldest]).toISOString()}, before ${short} was made (${new Date(commitTime).toISOString()}), so it was not built from ${short}. Run "npm run build:all" first.`);
}
for (const f of built) console.log(`${path.basename(f)}  ${mb(fs.statSync(f).size)}`);

// ---- (c) SHA256SUMS ----
step('SHA256SUMS');
const sumsFile = path.join(dist, 'SHA256SUMS');
const sums = built.map((f) => `${sha256(f)}  ${path.basename(f)}\n`).join('');
fs.writeFileSync(sumsFile, sums);
process.stdout.write(sums);

const notes = `SerieX ${version}: SerieX Books and SerieX Payroll in one desktop app.

## Install or update

**Mac** (open Terminal and paste):

\`\`\`
curl -fsSL ${DOWNLOAD}/install.sh | bash
\`\`\`

**Windows** (open PowerShell and paste):

\`\`\`
irm ${DOWNLOAD}/install.ps1 | iex
\`\`\`

**Ubuntu 22.04 or later** (open Terminal with Ctrl+Alt+T and paste):

\`\`\`
wget -qO- ${DOWNLOAD}/install.sh | bash
\`\`\`

The command downloads SerieX, checks it against SHA256SUMS, installs it for you and opens it. Run the same command again to update. On a Mac and on Windows no administrator password is needed. On Ubuntu the command asks for your password once, because Ubuntu's app installer needs it.

## Or download the installer

- Mac with Apple silicon (M1 or later): **SerieX-mac-arm64.dmg**
- Mac with an Intel processor: **SerieX-mac-x64.dmg**
- Windows (64-bit): **SerieX-Setup-x64.exe**
- Ubuntu, 64-bit Intel or AMD (most PCs): **SerieX-linux-amd64.deb**
- Ubuntu on a 64-bit ARM processor: **SerieX-linux-arm64.deb**

These installers are not signed by Apple or Microsoft, so the first time you open SerieX your computer shows a warning. You only need to get past it once:

- **Mac:** open the DMG and drag SerieX to Applications. In Applications, right-click (or Control-click) SerieX, choose **Open**, then click **Open** again. If your Mac only offers **Done** or **Move to Trash**, click **Done**, open **System Settings > Privacy & Security**, and click **Open Anyway** next to SerieX.
- **Windows:** when the blue "Windows protected your PC" window appears, click **More info**, then **Run anyway**.

On Ubuntu there is no warning. Install the downloaded file in Terminal with \`sudo apt install ~/Downloads/SerieX-linux-amd64.deb\` (on an ARM computer, use the arm64 file). A note that the download is "performed unsandboxed" is normal.

The install commands above do not show this warning.

## Use SerieX with an AI assistant (optional)

In SerieX, click **AI Assistants** in the left sidebar, turn on sharing for the company file, and click **Set up Claude for me** or **Set up ChatGPT for me**. SerieX must be open while you use the assistant. On Ubuntu, use Claude Code or Codex; the AI Assistants window shows how.

For Claude Desktop on a Mac or on Windows you can install the SerieX extension instead of clicking **Set up Claude for me**: download **${MCPB_MAC}** (Mac) or **${MCPB_WIN}** (Windows) and open it with Claude Desktop. The company file must still be shared under **AI Assistants** in the left sidebar.

**${SKILL}** is the SerieX skill: instructions that teach an assistant how to work in SerieX. Upload it in Claude under **Customize > Skills**, or unzip it into \`~/.claude/skills\` (Claude Code) or \`~/.agents/skills\` (Codex). [How to use it](https://github.com/${REPO}/blob/${BRANCH}/docs/user-guide.md#use-the-seriex-skill)

## Your company files

- Mac: \`~/Library/Application Support/SerieX\`
- Windows: \`%APPDATA%\\SerieX\`
- Ubuntu: \`~/.config/SerieX\`

Updating or uninstalling SerieX keeps your company files. To remove the app:

- Mac: drag SerieX from Applications to the Trash, or run \`curl -fsSL ${DOWNLOAD}/install.sh | bash -s -- --uninstall\`
- Windows: Settings > Apps > Installed apps > SerieX > Uninstall
- Ubuntu: run \`wget -qO- ${DOWNLOAD}/install.sh | bash -s -- --uninstall\`, or \`sudo apt remove seriex\`

## Source code

SerieX is free software under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). Its source code is in this repository; this release was built from commit [${short}](https://github.com/${REPO}/tree/${commit}).
`;
// The notes go to GitHub through a temporary file, removed when the script ends.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seriex-publish-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
const notesFile = path.join(tmpDir, 'notes.md');
fs.writeFileSync(notesFile, notes);

const assets = [...built, sumsFile, ...SCRIPTS.map((f) => path.join(releaseDir, f))];

if (dryRun) {
  step('release notes');
  process.stdout.write(notes);
  step('dry run: nothing was changed on GitHub');
  console.log(`origin/${BRANCH} was checked in this working tree only; the real publish also checks ${BRANCH} on GitHub.`);
  console.log(`would create the tag ${tag} on ${commit} in ${REPO} and publish the release with:`);
  for (const a of assets) console.log(`  ${path.basename(a)}  ${mb(fs.statSync(a).size)}`);
  process.exit(0);
}

// ---- GitHub ----
step(`GitHub: ${REPO}`);
if (run('gh', ['auth', 'status'], { quiet: true }).status !== 0) fail('the GitHub CLI is not signed in. Run "gh auth login" first.');
const repo = ghJson(['api', `repos/${REPO}`]);
if (repo.private) fail(`${REPO} is private; the install commands need a public repository.`);
if (!repo.permissions?.push) fail(`your GitHub account cannot write to ${REPO}.`);

// The commit must be on main on GitHub too (origin/main above is this working tree's copy).
const cmp = gh(['api', `repos/${REPO}/compare/${commit}...${BRANCH}`, '--jq', '.status'], { allowFail: true });
if (cmp.status !== 0) fail(`GitHub does not have the commit ${short}. Push it to ${BRANCH} first.`);
const where = cmp.stdout.trim();
if (where !== 'ahead' && where !== 'identical') fail(`${short} is not on ${BRANCH} on GitHub (${where || 'unknown'}). Push it to ${BRANCH} first.`);
console.log(`${short} is on ${BRANCH} on GitHub`);

// ---- (d) the release ----
step(`release ${tag} on ${short}`);
const title = `SerieX ${version}`;
// A published version is never moved to another commit: its tag must be new or already on this commit.
const tagAt = tagCommit(tag);
if (tagAt && tagAt !== commit) {
  fail(`the tag ${tag} already exists on ${REPO} and points at ${tagAt.slice(0, 12)}, not ${short}. Raise the version in desktop/package.json, commit, build and publish again.`);
}
const existing = gh(['release', 'view', tag, '--repo', REPO, '--json', 'tagName'], { allowFail: true }).status === 0;
if (existing) {
  // --target: a draft release has no tag yet, and publishing it creates the tag on its target.
  gh(['release', 'edit', tag, '--repo', REPO, '--target', commit, '--title', title, '--notes-file', notesFile, '--draft=false', '--prerelease=false', '--latest']);
  console.log(`updating the files of ${tag}...`);
  gh(['release', 'upload', tag, '--repo', REPO, '--clobber', ...assets], { live: true });
} else {
  console.log(`creating ${tag} and uploading its files (about ${mb(assets.reduce((n, a) => n + fs.statSync(a).size, 0))})...`);
  gh(['release', 'create', tag, '--repo', REPO, '--target', commit, '--title', title, '--notes-file', notesFile, '--latest', ...assets], { live: true });
}

// ---- check what GitHub has ----
step('checking the release');
const rel = ghJson(['release', 'view', tag, '--repo', REPO, '--json', 'url,assets,isDraft,isPrerelease']);
const online = new Map(rel.assets.map((a) => [a.name, a.size]));
let ok = !rel.isDraft && !rel.isPrerelease;
for (const a of assets) {
  const name = path.basename(a);
  const size = fs.statSync(a).size;
  const good = online.get(name) === size;
  ok &&= good;
  console.log(`${good ? 'ok     ' : 'MISSING'} ${name}  ${mb(size)}`);
}
const latest = ghJson(['api', `repos/${REPO}/releases/latest`]);
if (latest?.tag_name !== tag) {
  ok = false;
  console.log(`the latest release is ${latest?.tag_name}, not ${tag}`);
}
const taggedAt = tagCommit(tag);
if (taggedAt !== commit) {
  ok = false;
  console.log(`the tag ${tag} points at ${taggedAt.slice(0, 12) || 'nothing'}, not ${short}`);
}
if (!ok) fail('the release on GitHub does not match the local files.');
console.log(`\nPublished ${rel.url} (tag ${tag} on ${short})`);
console.log(`The extension packages are on the release: dist/mcp/server.json can now be published with mcp-publisher.`);
console.log(`  Mac:     curl -fsSL ${DOWNLOAD}/install.sh | bash`);
console.log(`  Windows: irm ${DOWNLOAD}/install.ps1 | iex`);
console.log(`  Ubuntu:  wget -qO- ${DOWNLOAD}/install.sh | bash`);
