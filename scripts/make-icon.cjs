/*
 * Gera build/icon.png (512x512) a partir de public/logo.svg, usando o próprio Electron.
 * Uso: npx electron scripts/make-icon.cjs
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SIZE = 512;
const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'public', 'logo.svg'), 'utf8');
const html = `<!doctype html><html><body style="margin:0;background:transparent">
<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${SIZE}" height="${SIZE}" style="display:block">
</body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    transparent: true,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await new Promise((r) => setTimeout(r, 500));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  const out = path.join(root, 'build', 'icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, image.resize({ width: SIZE, height: SIZE }).toPNG());
  console.log(`icon ok: ${out} (${image.getSize().width}x${image.getSize().height})`);
  app.exit(0);
});
