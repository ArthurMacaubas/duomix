/*
 * DuoMix: processo principal do app de computador (Electron).
 *
 * - Serve o site compilado (dist/) num endereço próprio e seguro, app://duomix,
 *   para microfone, AudioWorklet (isolador de voz) e WebAssembly funcionarem como no Chrome.
 * - Libera o microfone, a escolha de saída de áudio e a tela sempre ligada só para o próprio app.
 * - Não deixa o áudio "dormir" com a janela minimizada (importante no Modo Auditório).
 * - Abre uma janela só: abrir o atalho de novo traz a janela que já está aberta.
 */
const { app, BrowserWindow, Menu, net, protocol, session, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SCHEME = 'app';
const HOST = 'duomix';
const ORIGIN = `${SCHEME}://${HOST}`;
const DIST = path.join(__dirname, '..', 'dist');
const SELFTEST = process.env.DUOMIX_SELFTEST === '1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// Permissões que o app pede ao navegador interno. Só são dadas para o próprio app.
const ALLOWED_PERMISSIONS = new Set(['media', 'speaker-selection', 'screen-wake-lock', 'audioCapture']);

// O teste automático usa uma pasta de dados própria, para não mexer nas configurações reais do app.
// Começa sempre de uma pasta limpa, para um teste não herdar o modo salvo por outro.
if (SELFTEST) {
  const dir = path.join(app.getPath('temp'), 'duomix-selftest');
  require('node:fs').rmSync(dir, { recursive: true, force: true });
  app.setPath('userData', dir);
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

// Uma instância só: duas mesas brigariam pelo mesmo receptor.
if (!SELFTEST && !app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;

function serveDist() {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) return new Response('Not found', { status: 404 });
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(DIST, rel));
    // Nunca servir nada fora da pasta dist/.
    if (!file.startsWith(DIST + path.sep)) return new Response('Forbidden', { status: 403 });
    try {
      const res = await net.fetch(pathToFileURL(file).toString());
      if (!res.ok) return new Response('Not found', { status: 404 });
      const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
      return new Response(res.body, { status: 200, headers: { 'content-type': type } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

// Compara protocolo e host diretamente: para esquemas próprios como app://, o Node calcula
// URL.origin como "null", então não dá para comparar a origem inteira.
function isOwnOrigin(urlOrOrigin) {
  try {
    const u = new URL(urlOrOrigin);
    return u.protocol === `${SCHEME}:` && u.host === HOST;
  } catch {
    return false;
  }
}

function setupPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = details?.requestingUrl || wc.getURL();
    const ok = isOwnOrigin(origin) && ALLOWED_PERMISSIONS.has(permission);
    if (SELFTEST) console.log(`DUOMIX_PERM request ${permission} ${origin} -> ${ok}`);
    callback(ok);
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    const ok = isOwnOrigin(requestingOrigin) && ALLOWED_PERMISSIONS.has(permission);
    if (SELFTEST) console.log(`DUOMIX_PERM check ${permission} ${requestingOrigin} -> ${ok}`);
    return ok;
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 380,
    minHeight: 600,
    show: false,
    backgroundColor: '#0d1016',
    title: 'DuoMix',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A mesa precisa continuar processando com a janela minimizada.
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  // Links externos (ex.: github.com) abrem no navegador, não dentro do app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isOwnOrigin(url)) event.preventDefault();
  });

  win.once('ready-to-show', () => {
    if (!SELFTEST) win.show();
  });
  win.loadURL(`${ORIGIN}/index.html`);

  if (SELFTEST) runSelfTest(win);
}

/** Teste automático: abre a mesa escondida, confere microfone, saída e isolador, e imprime o resultado. */
function runSelfTest(w) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  w.webContents.once('did-finish-load', async () => {
    const js = (code) => w.webContents.executeJavaScript(code, true);
    const result = { loaded: true };
    try {
      // DUOMIX_SELFTEST_DUAL=1: testa o modo de dois receptores com os dois primeiros aparelhos reais.
      const dual = process.env.DUOMIX_SELFTEST_DUAL === '1';
      // Espera a mesa terminar de abrir (e salvar o próprio estado) antes de mudar os ajustes.
      await wait(1500);
      await js(`(async () => {
        localStorage.setItem('dm:onboarded', '1');
        localStorage.setItem('dm:mode', JSON.stringify('single'));
        if (${dual}) {
          await navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => s.getTracks().forEach((t) => t.stop()));
          const ids = (await navigator.mediaDevices.enumerateDevices())
            .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
            .map((d) => d.deviceId);
          localStorage.setItem('dm:mode', JSON.stringify('dual'));
          localStorage.setItem('dm:dualDevices', JSON.stringify([ids[0] || '', ids[1] || '']));
        }
        location.reload();
        return true;
      })()`);
      await wait(4000);
      result.title = await js('document.title');
      result.desktop = await js('Boolean(window.duomix && window.duomix.desktop)');
      result.status = await js(`document.querySelector('.status')?.textContent`);
      result.sources = await js(`[...document.querySelectorAll('.strip__source')].map((e) => e.textContent)`);
      result.sinkSupported = await js(`typeof AudioContext.prototype.setSinkId === 'function'`);
      result.inputs = await js(
        `navigator.mediaDevices.enumerateDevices().then(l => l.filter(d => d.kind === 'audioinput').map(d => d.label))`,
      );
      result.outputs = await js(
        `navigator.mediaDevices.enumerateDevices().then(l => l.filter(d => d.kind === 'audiooutput').map(d => d.label))`,
      );
      await js(`document.querySelector('.iso-btn')?.click(); true`);
      let iso = '';
      for (let i = 0; i < 40 && !/Só a voz|Não consegui/.test(iso); i++) {
        await wait(250);
        iso = await js(`document.querySelector('.strip__iso')?.textContent || ''`);
      }
      result.isolator = iso;
      await js(`document.querySelector('.iso-btn')?.click(); true`);
      result.wakeLock = await js(
        `navigator.wakeLock.request('screen').then(l => { l.release(); return 'ok'; }).catch(e => e.name)`,
      );
    } catch (err) {
      result.error = String(err);
    }
    console.log('DUOMIX_SELFTEST ' + JSON.stringify(result));
    app.exit(0);
  });
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  serveDist();
  setupPermissions();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
