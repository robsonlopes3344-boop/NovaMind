const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, desktopCapturer, screen } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { spawn } = require('child_process');
const nativeFs = require('node:fs');
const { createConversationStore } = require('./conversation-store');
const { inspectPowerShellCommand, buildSafeShellEnvironment, redactSensitiveText } = require('./agent-safety');
const { compareWorkspaceSnapshots } = require('./activity-tracker');
const crypto = require('node:crypto');
const net = require('node:net');
const dns = require('node:dns/promises');

let win;
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
let permissionMode = 'workspace';
let approvedRoots = [];
let hermesProcess = null;
let hermesStartupPromise = null;
const activeRequests = new Map();
const activeShells = new Map();
const workspaceSnapshots = new Map();

function hermesHome() {
  const localDefault = path.join(process.env.LOCALAPPDATA || app.getPath('home'), 'hermes');
  const candidates = [process.env.HERMES_HOME, 'E:\\Hermes\\Data', localDefault].filter(Boolean);
  return candidates.find(p => { try { return require('fs').existsSync(path.join(p, '.env')); } catch { return false; } }) || process.env.HERMES_HOME || localDefault;
}
function readHermesEnv() {
  try {
    const file = path.join(hermesHome(), '.env');
    const text = require('fs').readFileSync(file, 'utf8');
    const out = {};
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
    return out;
  } catch { return {}; }
}
function hermesApiKey() { return readHermesEnv().API_SERVER_KEY || ''; }
function hermesBaseUrl(base) { return String(base || 'http://127.0.0.1:8642/v1').replace(/\/+$/, '').replace(/\/v1$/i, '') + '/v1'; }
async function ensureHermesGateway() {
  if (hermesStartupPromise) return hermesStartupPromise;
  hermesStartupPromise = (async () => {
    const base = 'http://127.0.0.1:8642';
    try { const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1200) }); if (r.ok) return true; } catch {}
    const script = app.isPackaged
      ? path.join(process.resourcesPath, 'scripts', 'start-hermes-api.ps1')
      : path.join(__dirname, '..', 'scripts', 'start-hermes-api.ps1');
    if (!require('fs').existsSync(script)) return false;
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script], { detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, HERMES_HOME: hermesHome() } });
    child.unref(); hermesProcess = child;
    for (let i = 0; i < 60; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      try { const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(900) }); if (r.ok) return true; } catch {}
    }
    throw new Error('O gateway Hermes não iniciou em 60 segundos. Confira se o Hermes está instalado, se a porta 8642 está livre e se o arquivo .env contém API_SERVER_ENABLED=true, API_SERVER_HOST=127.0.0.1 e API_SERVER_PORT=8642.');
  })().finally(() => { hermesStartupPromise = null; });
  return hermesStartupPromise;
}

function registerIpc(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    const frame = event.senderFrame;
    const trusted = win && event.sender === win.webContents && frame === event.sender.mainFrame &&
      typeof frame?.url === 'string' && frame.url.startsWith('file://');
    if (!trusted) throw new Error('Origem IPC não autorizada.');
    return handler(event, ...args);
  });
}

async function writeAuditEvent(event) {
  try {
    const auditDir = path.join(app.getPath('userData'), 'audit');
    await fs.mkdir(auditDir, { recursive: true });
    await fs.appendFile(path.join(auditDir, 'actions.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
  } catch (error) {
    console.error('Falha ao registrar auditoria local:', error.message);
  }
}

function redactCommandPreview(command) {
  return redactSensitiveText(String(command))
    .replace(/(-?(?:password|passwd|token|api[_-]?key|secret)\s*(?:[:=]\s*|\s+))[^\s;]+/gi, '$1[oculto]')
    .slice(0, 600);
}

function terminateProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true, stdio: 'ignore'
    });
    killer.on('error', () => { try { child.kill(); } catch {} });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); }
    catch { try { child.kill('SIGTERM'); } catch {} }
  }
}

function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (family === 6) {
    const value = address.toLowerCase();
    return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') ||
      value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb') ||
      value.startsWith('::ffff:127.') || value.startsWith('::ffff:10.') || value.startsWith('::ffff:192.168.');
  }
  return true;
}

async function assertPublicWebUrl(input) {
  const url = input instanceof URL ? input : new URL(String(input));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Somente URLs HTTP/HTTPS públicas sem credenciais são permitidas.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Endereço local não permitido na leitura web.');
  }
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('Endereço IP privado não permitido na leitura web.');
  } else {
    const addresses = await dns.lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) {
      throw new Error('O domínio resolve para endereço local/privado e foi bloqueado.');
    }
  }
  return url;
}

async function readTextLimited(response, maxBytes) {
  if (!response.body?.getReader) return (await response.text()).slice(0, maxBytes);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < maxBytes) {
    const { value, done } = await reader.read();
    if (done) break;
    const remaining = maxBytes - total;
    const part = value.byteLength > remaining ? value.subarray(0, remaining) : value;
    chunks.push(Buffer.from(part));
    total += part.byteLength;
    if (part.byteLength < value.byteLength) break;
  }
  try { await reader.cancel(); } catch {}
  return Buffer.concat(chunks).toString('utf8');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1480, height: 940, minWidth: 1080, minHeight: 700,
    backgroundColor: '#080b14',
    title: 'NovaMind',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!String(url).startsWith('file://')) event.preventDefault();
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('closed',()=>{desktopEnabled=false;closeVisionOverlay();});
}
app.whenReady().then(() => {
  ensureHermesGateway().catch(error => console.error('[NovaMind] Hermes gateway indisponível na inicialização:', error.message));
  createWindow();
});
app.on('before-quit', () => {
  desktopEnabled=false; closeVisionOverlay();
  for (const child of activeShells.values()) terminateProcessTree(child);
  activeShells.clear();
  for (const controller of activeRequests.values()) controller.abort();
  activeRequests.clear();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

registerIpc('ollama:tags', async (_, base = 'http://127.0.0.1:11434') => {
  const r = await fetch(`${base.replace(/\/$/, '')}/api/tags`);
  if (!r.ok) throw new Error(`Ollama respondeu HTTP ${r.status}`);
  return r.json();
});
let desktopEnabled = false;
let lastDesktopCapture = 0;
let visionOverlay, visionTimer;
function closeVisionOverlay(){ clearInterval(visionTimer); if(visionOverlay && !visionOverlay.isDestroyed()) visionOverlay.destroy(); visionOverlay=null; }
function showVisionOverlay(){
  if(visionOverlay && !visionOverlay.isDestroyed()) return;
  const d=screen.getPrimaryDisplay();
  visionOverlay=new BrowserWindow({...d.bounds, frame:false, transparent:true, alwaysOnTop:true, skipTaskbar:true, focusable:false, resizable:false, hasShadow:false, webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
  visionOverlay.setIgnoreMouseEvents(true); visionOverlay.setContentProtection(true);
  visionOverlay.setAlwaysOnTop(true,'screen-saver');
  visionOverlay.loadFile(path.join(__dirname,'vision-overlay.html'));
  visionOverlay.showInactive();
  visionTimer=setInterval(()=>{if(!visionOverlay || visionOverlay.isDestroyed()) return; const pos=screen.getCursorScreenPoint(); visionOverlay.webContents.executeJavaScript(`document.documentElement.style.setProperty('--x','${pos.x-d.bounds.x}px');document.documentElement.style.setProperty('--y','${pos.y-d.bounds.y}px')`).catch(()=>{});},50);
}
registerIpc('desktop:enable', async (_, enabled) => {
  desktopEnabled = enabled === true; lastDesktopCapture = 0;
  if(desktopEnabled) showVisionOverlay(); else closeVisionOverlay();
  return desktopEnabled;
});
registerIpc('desktop:capture', async () => {
  if (!desktopEnabled) throw new Error('Compartilhamento desligado.');
  const d = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({types:['screen'], thumbnailSize:{width:Math.min(1600, Math.round(d.size.width*d.scaleFactor)),height:Math.min(1600, Math.round(d.size.height*d.scaleFactor))}});
  const source = sources.find(s=>s.display_id===String(d.id)) || (sources.length===1 ? sources[0] : null);
  if (!source || source.thumbnail.isEmpty() || !desktopEnabled) throw new Error('Monitor indisponível.');
  lastDesktopCapture = Date.now();
  return 'data:image/jpeg;base64,'+source.thumbnail.toJPEG(80).toString('base64');
});
registerIpc('desktop:action', async (_, action) => {
  if (!desktopEnabled || !lastDesktopCapture || Date.now()-lastDesktopCapture>120000 || process.platform!=='win32') throw new Error('Controle visual indisponível; atualize a captura.');
  if (!['click','doubleclick','rightclick','move'].includes(action?.type) || !Number.isFinite(action.x) || !Number.isFinite(action.y) || action.x<0 || action.x>1 || action.y<0 || action.y>1) throw new Error('Ação visual inválida.');
  const d=screen.getPrimaryDisplay();
  const x=Math.round(action.x*(d.size.width*d.scaleFactor-1)), y=Math.round(action.y*(d.size.height*d.scaleFactor-1));
  const result=await dialog.showMessageBox(win,{type:'warning',buttons:['Cancelar','Executar'],defaultId:0,cancelId:0,message:`Autorizar ${action.type} no monitor principal?`,detail:`Posição: ${x}, ${y}. Confira se o alvo ainda está correto. Não autorize pagamentos, credenciais ou ações inesperadas.`});
  if(result.response!==1 || !desktopEnabled) return {ok:false};
  const flags=action.type==='rightclick'?[8,16]:action.type==='move'?[]:action.type==='doubleclick'?[2,4,2,4]:[2,4];
  const script=`$ErrorActionPreference='Stop'; Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class NovaMouse { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,System.UIntPtr e); }'; [NovaMouse]::SetProcessDPIAware() | Out-Null; if(-not [NovaMouse]::SetCursorPos(${x},${y})){throw 'Cursor indisponível'}; ${flags.map(f=>`[NovaMouse]::mouse_event(${f},0,0,0,[UIntPtr]::Zero)`).join('; ')} `;
  await new Promise((resolve,reject)=>{const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:'ignore'});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('Falha no controle do mouse.')));});
  await writeAuditEvent({action:'desktop',type:action.type,x,y,at:Date.now()});
  lastDesktopCapture=0;
  return {ok:true};
});
registerIpc('ollama:chat', async (_, payload) => {
  const { base, model, messages, options = {}, requestId } = payload;
  const controller = new AbortController();
  if (requestId) activeRequests.set(requestId, controller);
  try {
    const r = await fetch(`${base.replace(/\/$/, '')}/api/chat`, {
      method: 'POST', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]), headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false, options })
    });
    if (!r.ok) throw new Error(`Ollama respondeu HTTP ${r.status}: ${await r.text()}`);
    return await r.json();
  } catch (error) { if (controller.signal.aborted) throw new Error('Geração interrompida pelo usuário.'); throw error; }
  finally { if (requestId && activeRequests.get(requestId) === controller) activeRequests.delete(requestId); }
});
registerIpc('hermes:models', async (_, payload) => {
  const { base, apiKey } = payload;
  await ensureHermesGateway();
  const key = apiKey || hermesApiKey();
  const url = `${hermesBaseUrl(base)}/models`;
  const r = await fetch(url, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
  if (!r.ok) throw new Error(`Hermes respondeu HTTP ${r.status}: ${await r.text()}`);
  return r.json();
});
// Qwen3.5 aceita uma única mensagem system, antes do histórico.
function normalizeLocalSystemMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  const systemMessages = messages.filter(message => message?.role === 'system');
  if (systemMessages.length === 0 ||
      (systemMessages.length === 1 && messages[0] === systemMessages[0])) {
    return messages;
  }

  const systemText = systemMessages.map(message => {
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content) &&
        message.content.every(part => part?.type === 'text' && typeof part.text === 'string')) {
      return message.content.map(part => part.text).join('\n');
    }
    throw new Error('Mensagem de sistema não textual incompatível com o template do modelo local.');
  }).join('\n\n');

  return [
    { role: 'system', content: systemText },
    ...messages.filter(message => message?.role !== 'system')
  ];
}

// Assemble OpenAI-compatible SSE chunks without executing or interpreting partial output.
async function readLocalChatStream(response, onProgress) {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) return response.json();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '', dataLines = [], content = '', reasoning = '', finish = null, done = false, usage, model, id, chunks = 0;
  const processEvent = () => {
    if (!dataLines.length) return;
    const data = dataLines.join('\n'); dataLines = [];
    if (data === '[DONE]') { done = true; return; }
    const packet = JSON.parse(data);
    if (packet.error) throw new Error(`API respondeu com erro durante a geração: ${packet.error.message || 'erro desconhecido'}`);
    if (packet.usage) usage = packet.usage;
    model = packet.model || model; id = packet.id || id;
    const choice = packet.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
    if (typeof delta.content === 'string') content += delta.content;
    if (delta.content || delta.reasoning_content) {
      chunks++;
      onProgress?.({ delta: typeof delta.content === 'string' ? delta.content : '', chunks });
    }
    if (choice.finish_reason != null) finish = choice.finish_reason;
  };
  const processLine = line => {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line === '') processEvent();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  };
  const drain = () => {
    let next;
    while ((next = pending.indexOf('\n')) >= 0) {
      processLine(pending.slice(0, next)); pending = pending.slice(next + 1);
    }
  };
  try {
    while (!done) {
      const item = await reader.read();
      if (item.done) break;
      pending += decoder.decode(item.value, { stream: true }); drain();
    }
    pending += decoder.decode(); drain();
    if (pending) processLine(pending);
    processEvent();
    if (!done && finish === null) throw new Error('Conexão interrompida antes do fim da resposta local.');
    return { id, model, ...(usage ? {usage} : {}), choices: [{ index: 0, finish_reason: finish || 'stop', message: { role: 'assistant', content, ...(reasoning ? {reasoning_content: reasoning} : {}) } }] };
  } finally { try { await reader.cancel(); } catch {} }
}

registerIpc('provider:chat', async (event, payload) => {
  const { base, apiKey, model, messages, temperature = 0.4, provider = 'openai', requestId } = payload || {};
  const controller = new AbortController();
  if (requestId) activeRequests.set(requestId, controller);
  try {
    if (provider === 'hermes') await ensureHermesGateway();
    if (controller.signal.aborted) throw new Error('Geração interrompida pelo usuário.');
    const key = apiKey || (provider === 'hermes' ? hermesApiKey() : '');
    const root = provider === 'hermes' ? hermesBaseUrl(base) : String(base || '').replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(root)) throw new Error('Endereço da API inválido. Confira as configurações do provedor.');
    const url = `${root}/chat/completions`;
    // Limita a adaptação ao llama-server local do RANA (porta 11436).
    const isLocalRana = provider !== 'hermes' &&
      /^http:\/\/(?:127\.0\.0\.1|localhost):11436\/v1$/i.test(root);
    const outgoingMessages = isLocalRana ? normalizeLocalSystemMessages(messages) : messages;
    const stream = isLocalRana && payload?.localStream === true && typeof requestId === 'string';
    const localOptions = isLocalRana ? {
      ...(payload?.disableThinking === true ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      ...(payload?.shortReply === true ? { max_tokens: 96 } : {}),
      stream
    } : {};
    const r = await fetch(url, {
      method: 'POST', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(isLocalRana ? 1800000 : provider === 'hermes' ? 600000 : 180000)]),
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, messages: outgoingMessages, temperature, ...localOptions })
    });
    if (!r.ok) throw new Error(`API respondeu HTTP ${r.status}: ${(await r.text()).slice(0, 1500)}`);
    if (!stream) return await r.json();
    return await readLocalChatStream(r, progress => {
      if (controller.signal.aborted || activeRequests.get(requestId) !== controller || event.sender.isDestroyed()) return;
      event.sender.send('provider:progress', { requestId, chunks: progress.chunks,
        ...(payload?.previewText === true ? { delta: progress.delta } : {}) });
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Geração interrompida pelo usuário.');
    if (error.message?.startsWith('API respondeu')) throw error;
    const reason = error.name === 'TimeoutError'
      ? (provider === 'hermes' ? 'o Hermes demorou mais de 10 minutos para responder. Isso pode ser lentidão do modelo local, não necessariamente falha de conexão' : 'tempo limite excedido')
      : (error.cause?.message || error.message || 'falha de rede');
    const root = provider === 'hermes' ? hermesBaseUrl(base) : String(base || '').replace(/\/+$/, '');
    const advice = provider === 'hermes' ? 'Confira o gateway Hermes, a porta 8642 e a chave API_SERVER_KEY nas configurações do servidor.' : 'Confira o endpoint, o modelo e a janela do servidor local.';
    throw new Error(`Falha ao consultar ${root}: ${reason}. ${advice}`);
  } finally {
    if (requestId && activeRequests.get(requestId) === controller) activeRequests.delete(requestId);
  }
});
registerIpc('provider:cancel', async (_, requestId) => { const controller = activeRequests.get(requestId); if (controller) { controller.abort(); activeRequests.delete(requestId); return true; } return false; });

// Pesquisa web e leitura de páginas são executadas no processo principal do Electron.
registerIpc('web:search', async (_, query) => {
  const q = String(query || '').trim().slice(0, 400);
  if (!q) return [];
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 NovaMind/1.0' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Pesquisa web respondeu HTTP ${response.status}`);
  const html = await readTextLimited(response, 1_000_000);
  const results = [];
  const blocks = html.split(/<div class="result[^>]*>/i).slice(1);
  for (const block of blocks) {
    const link = block.match(/<a(?=[^>]*class="result__a")(?=[^>]*href="([^"]+)")[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/i);
    const clean = value => value.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
    let href = link[1].replace(/&amp;/g, '&');
    try { const parsed = new URL(href, 'https://duckduckgo.com'); if (parsed.hostname.includes('duckduckgo.com') && parsed.searchParams.has('uddg')) href = decodeURIComponent(parsed.searchParams.get('uddg')); } catch {}
    if (!/^https?:\/\//i.test(href)) continue;
    results.push({ title: clean(link[2]), url: href, snippet: snippet ? clean(snippet[1]) : '' });
    if (results.length >= 6) break;
  }
  return results;
});
registerIpc('web:fetch', async (_, target) => {
  let current = await assertPublicWebUrl(String(target));
  let response;
  for (let redirectCount = 0; redirectCount <= 5; redirectCount++) {
    response = await fetch(current, {
      headers: { 'User-Agent': 'Mozilla/5.0 NovaMind/1.0' },
      signal: AbortSignal.timeout(15000),
      redirect: 'manual'
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    if (!location || redirectCount === 5) throw new Error('Redirecionamento web inválido ou excessivo.');
    current = await assertPublicWebUrl(new URL(location, current));
  }
  if (!response?.ok) throw new Error(`A página respondeu HTTP ${response?.status || 'desconhecido'}`);
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html') && !type.includes('text/plain')) throw new Error('Este tipo de arquivo não pode ser convertido em texto pelo leitor web.');
  const html = await readTextLimited(response, 1_500_000);
  const text = html.replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<\/(p|div|h[1-6]|li|article|section|br|tr)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').trim();
  return { url: response.url || current.href, title: (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]+>/g, '').trim(), text: text.slice(0, 18000) };
});
registerIpc('settings:save', async (_, settings) => {
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
  const safe = { ...settings };
  const secrets = { apiKey: safe.apiKey || '', hermesKey: safe.hermesKey || '' };
  delete safe.apiKey; delete safe.hermesKey;
  if (safeStorage.isEncryptionAvailable()) {
    safe.secretsEncrypted = Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, v ? safeStorage.encryptString(v).toString('base64') : '']));
  } else {
    safe.secretsEncrypted = null;
    safe.secretsNeedReentry = Object.values(secrets).some(Boolean);
  }
  await fs.writeFile(settingsPath(), JSON.stringify(safe, null, 2), 'utf8');
  return { encrypted: !!safe.secretsEncrypted, needsReentry: !!safe.secretsNeedReentry };
});
registerIpc('settings:load', async () => {
  try {
    const safe = JSON.parse(await fs.readFile(settingsPath(), 'utf8'));
    const encrypted = safe.secretsEncrypted || {};
    safe.apiKey = encrypted.apiKey && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(encrypted.apiKey, 'base64')) : '';
    safe.hermesKey = encrypted.hermesKey && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(encrypted.hermesKey, 'base64')) : '';
    if (!safe.hermesKey) safe.hermesKey = hermesApiKey();
    if (['chat', 'workspace', 'advanced', 'unrestricted'].includes(safe.permissionMode)) permissionMode = safe.permissionMode;
    delete safe.secretsEncrypted;
    return safe;
  } catch { permissionMode = 'workspace'; return { hermesKey: hermesApiKey(), permissionMode }; }
});
registerIpc('permissions:set', async (_, mode) => {
  if (!['chat', 'workspace', 'advanced', 'unrestricted'].includes(mode)) throw new Error('Modo inválido');
  permissionMode = mode;
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
  let saved = {}; try { saved = JSON.parse(await fs.readFile(settingsPath(), 'utf8')); } catch {}
  saved.permissionMode = mode;
  await fs.writeFile(settingsPath(), JSON.stringify(saved, null, 2), 'utf8');
  return permissionMode;
});
const conversationStore = () => createConversationStore(path.join(app.getPath('userData'), 'conversations'));
registerIpc('conversations:list', async () => conversationStore().list());
registerIpc('conversations:get', async (_, id) => conversationStore().get(id));
registerIpc('conversations:save', async (_, conversation) => conversationStore().save(conversation));
registerIpc('conversations:delete', async (_, id) => conversationStore().remove(id));
registerIpc('conversations:flags', async (_, id, flags) => conversationStore().updateFlags(id, flags));
registerIpc('workspace:choose', async () => {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  const selected = await fs.realpath(result.filePaths[0]);
  if (!approvedRoots.includes(selected)) approvedRoots.push(selected);
  return selected;
});
async function ensureAllowed(target) {
  if (typeof target !== 'string' || !target.trim()) throw new Error('Caminho de arquivo inválido.');
  const resolved = path.resolve(target);
  if (permissionMode === 'unrestricted') return resolved;
  if (permissionMode === 'chat') throw new Error('Acesso a arquivos está desativado no modo Somente chat.');
  let canonicalTarget;
  try { canonicalTarget = await fs.realpath(resolved); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    canonicalTarget = path.join(await fs.realpath(path.dirname(resolved)), path.basename(resolved));
  }
  const canonicalRoots = await Promise.all(approvedRoots.map(root => fs.realpath(root).catch(() => null)));
  const ok = canonicalRoots.filter(Boolean).some(root => canonicalTarget === root || canonicalTarget.startsWith(root + path.sep));
  if (!ok) throw new Error('Pasta fora dos espaços de trabalho autorizados. Adicione a pasta em Configurações.');
  return resolved;
}
const CODE_EXTENSIONS = new Set([
  '.js','.jsx','.mjs','.cjs','.ts','.tsx','.vue','.svelte','.html','.htm','.css','.scss','.less',
  '.json','.jsonc','.md','.mdx','.txt','.yml','.yaml','.toml','.xml','.svg',
  '.py','.pyw','.ps1','.psm1','.bat','.cmd','.sh','.java','.kt','.go','.rs','.c','.h','.cc','.cpp','.hpp','.cs','.sql','.php','.rb','.swift','.dart'
]);
const IGNORED_SNAPSHOT_DIRS = new Set([
  'node_modules','.git','.svn','.hg','dist','release','build','.next','.nuxt','.output','.cache','.venv','venv','coverage','vendor','target','bin','obj'
]);

async function scanWorkspace(root) {
  const allowedRoot = await ensureAllowed(root);
  const rootStat = await fs.stat(allowedRoot);
  if (!rootStat.isDirectory()) throw new Error('O workspace selecionado não é uma pasta.');
  const files = new Map();
  let scanned = 0;
  let textBytes = 0;
  let truncated = false;
  const MAX_FILES = 3000;
  const MAX_TEXT_BYTES = 12 * 1024 * 1024;
  const MAX_TEXT_FILE = 384 * 1024;

  async function walk(folder, depth) {
    if (depth > 12 || scanned >= MAX_FILES) { truncated = true; return; }
    let entries;
    try { entries = await fs.readdir(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (scanned >= MAX_FILES) { truncated = true; return; }
      if (entry.isSymbolicLink()) continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_SNAPSHOT_DIRS.has(entry.name.toLowerCase())) await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      scanned++;
      try {
        const stat = await fs.stat(full);
        const ext = path.extname(entry.name).toLowerCase();
        const isCode = CODE_EXTENSIONS.has(ext);
        let content = null;
        if (isCode && stat.size <= MAX_TEXT_FILE && textBytes + stat.size <= MAX_TEXT_BYTES) {
          try { content = await fs.readFile(full, 'utf8'); textBytes += stat.size; }
          catch { content = null; }
        } else if (isCode) truncated = true;
        const relative = path.relative(allowedRoot, full).split(path.sep).join('/');
        files.set(relative, { size: stat.size, mtimeMs: stat.mtimeMs, isCode, content });
      } catch {}
    }
  }

  await walk(allowedRoot, 0);
  return { root: allowedRoot, files, scanned, truncated };
}

registerIpc('workspace:snapshot', async (_, root) => {
  if (typeof root !== 'string' || !root.trim()) return { tracked: false, reason: 'Nenhuma pasta de projeto selecionada.' };
  const snapshot = await scanWorkspace(root);
  const id = crypto.randomUUID();
  workspaceSnapshots.set(id, snapshot);
  while (workspaceSnapshots.size > 8) workspaceSnapshots.delete(workspaceSnapshots.keys().next().value);
  return { tracked: true, id, root: snapshot.root, scannedFiles: snapshot.scanned, truncated: snapshot.truncated };
});

registerIpc('workspace:compareSnapshot', async (_, id) => {
  const before = workspaceSnapshots.get(id);
  if (!before) throw new Error('A referência inicial do workspace expirou.');
  const after = await scanWorkspace(before.root);
  return compareWorkspaceSnapshots(before, after);
});
registerIpc('workspace:releaseSnapshot', async (_, id) => workspaceSnapshots.delete(id));

registerIpc('workspace:read', async (_, target) => {
  const p = await ensureAllowed(target);
  const st = await fs.stat(p);
  if (!st.isFile()) throw new Error('Selecione um arquivo.');
  if (st.size > 2 * 1024 * 1024) throw new Error('Arquivo maior que 2 MB; abra um arquivo menor.');
  return await fs.readFile(p, 'utf8');
});
registerIpc('workspace:write', async (_, target, content) => {
  if (!['advanced', 'unrestricted'].includes(permissionMode)) throw new Error('Gravação exige modo Avançado ou Irrestrito.');
  if (typeof content !== 'string' || content.length > 2 * 1024 * 1024) throw new Error('Conteúdo inválido ou maior que 2 MB.');
  const p = await ensureAllowed(target);
  await fs.writeFile(p, content, 'utf8');
  return true;
});
registerIpc('workspace:list', async (_, target) => {
  const p = await ensureAllowed(target);
  const entries = await fs.readdir(p, { withFileTypes: true });
  return entries.slice(0, 250).map(e => ({ name: e.name, directory: e.isDirectory(), path: path.join(p, e.name) }));
});
registerIpc('shell:run', async (_, payload) => {
  const command = typeof payload === 'string' ? payload : payload?.command;
  const requestId = typeof payload === 'object' && typeof payload?.requestId === 'string' ? payload.requestId : crypto.randomUUID();
  if (!['advanced', 'unrestricted'].includes(permissionMode)) throw new Error('Terminal exige modo Avançado ou Irrestrito.');
  if (typeof command !== 'string' || !command.trim() || command.length > 12000) throw new Error('Comando inválido ou muito longo.');
  if (activeShells.size > 0) throw new Error('Já existe um comando local em execução. Aguarde ou use Parar.');

  const risk = inspectPowerShellCommand(command);
  const commandHash = crypto.createHash('sha256').update(command).digest('hex').slice(0, 16);
  const preview = redactCommandPreview(command);
  if (risk.level === 'blocked') {
    await writeAuditEvent({ at: new Date().toISOString(), requestId, risk: risk.level, rule: risk.rule, commandHash, outcome: 'blocked' });
    return { code: 126, stdout: '', stderr: `Proteção NovaMind: execução bloqueada. ${risk.reason}`, blocked: true, risk };
  }
  if (risk.level === 'confirm') {
    const decision = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Proteção inteligente do NovaMind',
      message: 'Esta ação pode causar alterações difíceis de desfazer.',
      detail: `${risk.reason}\n\nComando proposto:\n${preview}\n\nO NovaMind só continuará se você autorizar esta ação específica.`,
      buttons: ['Cancelar', 'Executar mesmo assim'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (decision.response !== 1) {
      await writeAuditEvent({ at: new Date().toISOString(), requestId, risk: risk.level, rule: risk.rule, commandHash, outcome: 'user-cancelled' });
      return { code: 126, stdout: '', stderr: 'Ação cancelada pelo usuário na proteção inteligente. Não tente contornar esta recusa.', blocked: true, risk };
    }
  }

  let workspaceWatcher = null;
  let workspaceWatchEvents = 0;
  const requestedWorkspace = typeof payload?.workspaceRoot === 'string' && payload.workspaceRoot.trim() ? payload.workspaceRoot : null;
  let safeWorkspaceRoot = null;
  let workingDirectory = approvedRoots[0] || process.env.USERPROFILE || app.getPath('home');
  if (requestedWorkspace) {
    try {
      const candidate = await ensureAllowed(requestedWorkspace);
      const rootStat = await fs.stat(candidate);
      if (rootStat.isDirectory()) { safeWorkspaceRoot = candidate; workingDirectory = candidate; }
    } catch {}
  }
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
    cwd: workingDirectory,
    env: buildSafeShellEnvironment()
  });
  activeShells.set(requestId, child);
  if (safeWorkspaceRoot) {
    try {
      workspaceWatcher = nativeFs.watch(safeWorkspaceRoot, { recursive: true }, (eventType, filename) => {
        if (!filename || workspaceWatchEvents >= 120) return;
        workspaceWatchEvents++;
        const relativePath = String(filename).split(path.sep).join('/');
        if (relativePath.split('/').some(part => IGNORED_SNAPSHOT_DIRS.has(part.toLowerCase()))) return;
        try { win?.webContents.send('agent:filesystem-event', { requestId, eventType, relativePath, at: Date.now() }); } catch {}
      });
      workspaceWatcher.on('error', () => { try { workspaceWatcher?.close(); } catch {} workspaceWatcher = null; });
    } catch {}
  }
  const closeWorkspaceWatcher = () => { try { workspaceWatcher?.close(); } catch {} workspaceWatcher = null; };
  const MAX_OUTPUT = 256 * 1024;
  let out = '', err = '', outTruncated = false, errTruncated = false, timedOut = false;
  const appendBounded = (current, chunk, max) => {
    const next = current + chunk.toString();
    if (next.length <= max) return [next, false];
    return [next.slice(0, max), true];
  };

  return await new Promise((resolve, reject) => {
    const timeoutMs = permissionMode === 'unrestricted' ? 10 * 60 * 1000 : 60 * 1000;
    const timer = setTimeout(() => {
      timedOut = true;
      child.novaTerminatedReason = 'timeout';
      terminateProcessTree(child);
    }, timeoutMs);
    child.stdout.on('data', data => { const result = appendBounded(out, data, MAX_OUTPUT); out = result[0]; outTruncated ||= result[1]; });
    child.stderr.on('data', data => { const result = appendBounded(err, data, MAX_OUTPUT); err = result[0]; errTruncated ||= result[1]; });
    child.on('error', async error => {
      clearTimeout(timer);
      closeWorkspaceWatcher();
      activeShells.delete(requestId);
      await writeAuditEvent({ at: new Date().toISOString(), requestId, risk: risk.level, rule: risk.rule, commandHash, outcome: 'spawn-error', error: error.message });
      reject(error);
    });
    child.on('close', async code => {
      clearTimeout(timer);
      closeWorkspaceWatcher();
      activeShells.delete(requestId);
      const cancelled = child.novaTerminatedReason === 'cancelled';
      const finalCode = timedOut || cancelled ? 124 : (Number.isInteger(code) ? code : 1);
      const outcome = timedOut ? 'timeout' : (cancelled ? 'cancelled' : (finalCode === 0 ? 'success' : 'non-zero-exit'));
      await writeAuditEvent({ at: new Date().toISOString(), requestId, risk: risk.level, rule: risk.rule, commandHash, outcome, exitCode: finalCode, stdoutTruncated: outTruncated, stderrTruncated: errTruncated });
      resolve({
        code: finalCode,
        stdout: redactSensitiveText(out) + (outTruncated ? '\n[Saída truncada pelo limite de segurança.]' : ''),
        stderr: redactSensitiveText(err) + (errTruncated ? '\n[Saída truncada pelo limite de segurança.]' : '') + (timedOut ? '\nTempo limite atingido; a árvore de processos foi encerrada.' : (cancelled ? '\nExecução interrompida pelo usuário.' : '')),
        blocked: false,
        risk
      });
    });
  });
});
registerIpc('shell:cancel', async (_, requestId) => {
  const child = activeShells.get(requestId);
  if (!child) return false;
  child.novaTerminatedReason = 'cancelled';
  terminateProcessTree(child);
  return true;
});

registerIpc('app:openExternal', async (_, url) => {
  if (!/^https:\/\/[a-z0-9.-]+/i.test(url)) throw new Error('URL não permitida');
  await shell.openExternal(url);
  return true;
});