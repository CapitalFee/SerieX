// Renders the SerieX app icon from assets/*.svg with Electron's own Chromium (no other tools).
// Run by scripts/build.mjs as: electron scripts/render-icons.cjs <output folder>
// Writes icon.png (1024 x 1024, macOS; electron-builder turns it into icon.icns),
// icon.ico (Windows: 16-64 px as bitmaps, 128 and 256 px as PNG) and
// icons/<n>x<n>.png (Ubuntu, 16 to 512 px).
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const outDir = path.resolve(process.argv[process.argv.length - 1]);
const assets = path.join(__dirname, '..', 'assets');
// build.mjs passes a throw-away browser profile folder and deletes it afterwards.
const profile = process.env.SERIEX_ICON_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'seriex-icon-'));
app.setPath('userData', profile);
app.dock?.hide();

function svgDataUrl(svg) {
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

/** The macOS art without its outer margin, so the tile fills the Windows icon. */
function croppedForWindows(svg) {
  return svg.replace(/width="1024" height="1024" viewBox="0 0 1024 1024"/, 'width="864" height="864" viewBox="80 80 864 864"');
}

async function render(win, svg, size) {
  const js = `(async () => {
    const img = new Image();
    img.src = ${JSON.stringify(svgDataUrl(svg))};
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = ${size};
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, ${size}, ${size});
    const rgba = Array.from(g.getImageData(0, 0, ${size}, ${size}).data);
    return { png: c.toDataURL('image/png').split(',')[1], rgba };
  })()`;
  const r = await win.webContents.executeJavaScript(js);
  return { size, png: Buffer.from(r.png, 'base64'), rgba: Uint8Array.from(r.rgba) };
}

/** A 32-bit bitmap icon entry (BITMAPINFOHEADER + bottom-up BGRA rows + AND mask). */
function dibEntry({ size, rgba }) {
  const maskRow = Math.ceil(size / 32) * 4;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(size * size * 4 + maskRow * size, 20);
  const pixels = Buffer.alloc(size * size * 4);
  const mask = Buffer.alloc(maskRow * size);
  for (let y = 0; y < size; y++) {
    const dst = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4;
      const d = (dst * size + x) * 4;
      pixels[d] = rgba[s + 2];
      pixels[d + 1] = rgba[s + 1];
      pixels[d + 2] = rgba[s];
      pixels[d + 3] = rgba[s + 3];
      if (rgba[s + 3] === 0) mask[dst * maskRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([header, pixels, mask]);
}

function writeIco(file, images) {
  const head = Buffer.alloc(6 + images.length * 16);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  const bodies = images.map((im) => (im.size >= 128 ? im.png : dibEntry(im)));
  let offset = head.length;
  images.forEach((im, i) => {
    const o = 6 + i * 16;
    head.writeUInt8(im.size >= 256 ? 0 : im.size, o);
    head.writeUInt8(im.size >= 256 ? 0 : im.size, o + 1);
    head.writeUInt8(0, o + 2);
    head.writeUInt8(0, o + 3);
    head.writeUInt16LE(1, o + 4);
    head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(bodies[i].length, o + 8);
    head.writeUInt32LE(offset, o + 12);
    offset += bodies[i].length;
  });
  fs.writeFileSync(file, Buffer.concat([head, ...bodies]));
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const big = fs.readFileSync(path.join(assets, 'icon.svg'), 'utf8');
    const small = fs.readFileSync(path.join(assets, 'icon-small.svg'), 'utf8');
    const win = new BrowserWindow({ show: false, width: 300, height: 300, webPreferences: { sandbox: true, contextIsolation: true } });
    await win.loadURL('data:text/html;charset=utf-8,<!doctype html><title>icon</title>');
    const mac = await render(win, big, 1024);
    fs.writeFileSync(path.join(outDir, 'icon.png'), mac.png);
    const winArt = croppedForWindows(big);
    const ico = [];
    for (const s of [16, 24, 32]) ico.push(await render(win, small, s));
    for (const s of [48, 64, 128, 256]) ico.push(await render(win, winArt, s));
    writeIco(path.join(outDir, 'icon.ico'), ico);
    fs.writeFileSync(path.join(outDir, 'icon-256.png'), ico[ico.length - 1].png);
    // Ubuntu: one PNG per size, because its icon theme stops at 512 px and ignores a single 1024 px
    // picture. 48 px and up use the macOS art: its margin matches how Ubuntu draws app icons.
    const linuxDir = path.join(outDir, 'icons');
    fs.rmSync(linuxDir, { recursive: true, force: true });
    fs.mkdirSync(linuxDir, { recursive: true });
    for (const s of [16, 24, 32]) fs.writeFileSync(path.join(linuxDir, `${s}x${s}.png`), (await render(win, small, s)).png);
    for (const s of [48, 64, 128, 256, 512]) fs.writeFileSync(path.join(linuxDir, `${s}x${s}.png`), (await render(win, big, s)).png);
    win.destroy();
    console.log(`icons written to ${outDir}`);
  } catch (e) {
    console.error(e);
    code = 1;
  }
  app.exit(code);
});
