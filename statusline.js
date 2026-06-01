#!/usr/bin/env node
// Two-line dashboard status line for Claude Code.
// Works on macOS, Linux, and Windows with zero external dependencies (only Node, which Claude Code already ships).
// VERSION: 2.7.0
// REPO: https://github.com/andregosling/claude-statusline

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');

// ── Config ────────────────────────────────────────────────────────────────────
const VERSION = '2.7.0';
const REPO_RAW = 'https://raw.githubusercontent.com/andregosling/claude-statusline/main';
const CACHE_DIR = path.join(os.homedir(), '.claude', 'cache', 'claude-statusline');
const LAST_CHECK = path.join(CACHE_DIR, 'last-check');
const LAST_SESSION = path.join(CACHE_DIR, 'last-session');
const REMOTE_VERSION_CACHE = path.join(CACHE_DIR, 'remote-version');
const UPDATE_LOG = path.join(CACHE_DIR, 'update.log');
const LAST_HEARTBEAT = path.join(CACHE_DIR, 'last-heartbeat');
const LAST_HB_MODEL = path.join(CACHE_DIR, 'last-heartbeat-model');
const PENDING_AUTH = path.join(CACHE_DIR, 'pending-auth.json');
const AUTH_LOG = path.join(CACHE_DIR, 'auth.log');
const TELEMETRY_LOG = path.join(CACHE_DIR, 'telemetry.log');
// Saúde dos dois pipelines (vem da resposta do POST /telemetry/heartbeat).
// O bg-heartbeat escreve; o render lê (defasagem de ~1 ciclo, igual LAST_HEARTBEAT).
const INGEST_HEALTH_CACHE = path.join(CACHE_DIR, 'ingest-health.json');
const HELP_HTML = path.join(CACHE_DIR, 'statusline-help.html');
// Diagnóstico ao vivo injetado no help (window.DIAG). Reescrito a cada render
// (leve); o HTML carrega via <script src> local — file:// permite tag script.
const HELP_DATA_JS = path.join(CACHE_DIR, 'statusline-help-data.js');
// Throttle do enforce de OTel — settings.json muda raramente, não reescrever a cada render.
const OTEL_ENFORCE_THROTTLE_MS = 6 * 60 * 60 * 1000; // 6h
const OTEL_ENFORCE_CACHE = path.join(CACHE_DIR, 'otel-enforce');
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const SELF_PATH = __filename;

// ── Telemetry config ──────────────────────────────────────────────────────────
const TELEMETRY_API_URL = process.env.CLAUDE_METRICS_API_URL || 'http://localhost:3005';
const TELEMETRY_DISABLED = process.env.CLAUDE_METRICS_DISABLED === 'true' || process.env.CLAUDE_METRICS_DISABLED === '1';
const TELEMETRY_TOKEN_PATH = process.env.CLAUDE_METRICS_TOKEN_PATH
  ? process.env.CLAUDE_METRICS_TOKEN_PATH.replace(/^~/, os.homedir())
  : path.join(os.homedir(), '.config', 'claude-statusline', 'token');
const HEARTBEAT_INTERVAL_MS = Number(process.env.CLAUDE_METRICS_HEARTBEAT_INTERVAL_MS) || 60_000;
const CLIENT_ID = 'claude-statusline';

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const ESC = '\x1b';
const RESET  = `${ESC}[0m`;
const DIM    = `${ESC}[2m`;
const BOLD   = `${ESC}[1m`;
const ITALIC = `${ESC}[3m`;
const rgb = (r, g, b) => `${ESC}[38;2;${r};${g};${b}m`;

const C = {
  path:     rgb(125, 207, 255),
  git:      rgb(195, 232, 141),
  gitDirty: rgb(255, 203, 107),
  gitGone:  rgb(240, 113, 120),
  model:    rgb(199, 146, 234),
  cost:     rgb(255, 203, 107),
  tokens:   rgb(130, 170, 255),
  time:     rgb(255, 255, 255),
  ctxOk:    rgb(195, 232, 141),
  ctxWarn:  rgb(255, 203, 107),
  ctxHot:   rgb(240, 113, 120),
  rule:     rgb(90, 100, 120),
  label:    rgb(160, 170, 190),
};

// ── Glyphs (Nerd Font). Set CLAUDE_STATUSLINE_PLAIN=1 to use ASCII fallbacks. ─
const PLAIN = process.env.CLAUDE_STATUSLINE_PLAIN === '1';
const G = PLAIN ? {
  folder: '', branch: 'git:', add: '+', mod: '~', del: '-',
  ahead: '↑', behind: '↓', model: '◆', cost: '$', token: 'T',
  clock: 't:', ctx: 'ctx', rate: '*', tl: '╭─', mid: '│ ', bl: '╰─',
} : {
  folder: '',     //
  branch: '',     //
  add: '+', mod: '~', del: '−',
  ahead: '',      //
  behind: '',     //
  model: '\u{F06A9}',   // 󰚩
  cost: '',       //
  token: '',      //
  clock: '',      //
  ctx: '',        //
  rate: '',       //
  tl: '╭─', mid: '│ ', bl: '╰─',
};

// ── Responsividade: reflow por largura do terminal ─────────────────────────────
// O Claude Code (>= 2.1.153) seta COLUMNS/LINES antes de rodar o statusline
// (tput/stdout.columns NÃO funcionam — o output é capturado, não é um TTY).
// Versões antigas não setam → COLUMNS vem vazio → fallback: sem reflow (2 linhas fixas).
function termWidth() {
  const c = Number(process.env.COLUMNS);
  return Number.isFinite(c) && c > 0 ? c : null;
}

// Largura VISÍVEL de uma string: remove sequências ANSI (cor SGR + OSC 8 links)
// e conta glyphs largos como 2 colunas. Inclui CJK, emoji E os ícones Nerd Font
// (Private Use Area: E000–F8FF e F0000+), que a maioria dos terminais com Nerd
// Font renderiza como DOUBLE-WIDTH — contá-los como 1 fazia a linha estourar e o
// Claude Code truncar com "…". (Modo PLAIN usa ASCII de largura 1 e nem chega aqui.)
// eslint-disable-next-line no-control-regex
const ANSI_SGR = /\x1b\[[0-9;]*m/g;
// eslint-disable-next-line no-control-regex
const ANSI_OSC8 = /\x1b\]8;;[^\x07]*\x07/g;
function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||  // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) ||  // CJK
    (cp >= 0xac00 && cp <= 0xd7a3) ||  // Hangul
    (cp >= 0xe000 && cp <= 0xf8ff) ||  // PUA (Nerd Font básico: powerline, fa, etc.)
    (cp >= 0xf900 && cp <= 0xfaff) ||  // CJK Compat
    (cp >= 0xff00 && cp <= 0xff60) ||  // Fullwidth
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji
    (cp >= 0xf0000 && cp <= 0xffffd)   // PUA-A (Nerd Font: material design icons 󰀀+)
  );
}
function visibleWidth(s) {
  const plain = s.replace(ANSI_OSC8, '').replace(ANSI_SGR, '');
  let w = 0;
  for (const ch of plain) w += isWide(ch.codePointAt(0)) ? 2 : 1;
  return w;
}

// Reflow: quebra uma linha montada (com ANSI) em N sublinhas que cabem em `width`,
// usando ` · ` (SEP visível) como ponto natural de quebra. Continuações ganham
// recuo de 2 espaços. Sem width → devolve a linha intacta (1 elemento).
function reflowLine(line, width, indent = '  ') {
  if (!width) return [line];
  const parts = line.split(' · ');
  if (parts.length === 1) return [line];
  const out = [];
  let cur = '';
  let curW = 0;
  for (const seg of parts) {
    const segW = visibleWidth(seg);
    const wWithSep = cur === '' ? segW : curW + 3 + segW; // " · " = 3 cols
    if (cur !== '' && wWithSep > width) {
      out.push(cur);
      cur = indent + seg;
      curW = visibleWidth(indent) + segW;
    } else {
      cur = cur === '' ? seg : cur + ' · ' + seg;
      curW = wWithSep;
    }
  }
  if (cur !== '') out.push(cur);
  return out;
}

// ── Safe getters ──────────────────────────────────────────────────────────────
function pick(obj, p, dflt) {
  const parts = p.split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur == null) return dflt;
    cur = cur[part];
  }
  return cur == null ? dflt : cur;
}

// ── Pretty path ───────────────────────────────────────────────────────────────
function prettyPath(p) {
  if (!p) return '?';
  // Normalize separators for cross-platform display
  const norm = p.replace(/\\/g, '/');
  const home = os.homedir().replace(/\\/g, '/');
  let rel = norm;
  let prefix = '';
  if (norm === home) return '~';
  if (norm.startsWith(home + '/')) {
    rel = norm.slice(home.length + 1);
    prefix = '~/';
  }
  const segs = rel.split('/').filter(Boolean);
  if (segs.length <= 2) return prefix + segs.join('/');
  return prefix + '…/' + segs.slice(-2).join('/');
}

// ── Git segment ───────────────────────────────────────────────────────────────
function gitSegment(cwd) {
  try {
    const inside = execSync('git rev-parse --is-inside-work-tree', {
      cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 1000,
    }).trim();
    if (inside !== 'true') return '';
  } catch { return ''; }

  let branch = '';
  try {
    branch = execSync('git symbolic-ref --quiet --short HEAD', {
      cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 1000,
    }).trim();
  } catch {
    try {
      branch = execSync('git rev-parse --short HEAD', {
        cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 1000,
      }).trim();
    } catch { return ''; }
  }
  if (!branch) return '';

  let status = '';
  try {
    status = execSync('git status --porcelain=v1 -b', {
      cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 1500,
    });
  } catch {}

  const lines = status.split('\n');
  const header = lines[0] || '';
  const body = lines.slice(1).filter(Boolean);

  const aheadM = header.match(/ahead (\d+)/);
  const behindM = header.match(/behind (\d+)/);
  const ahead = aheadM ? aheadM[1] : null;
  const behind = behindM ? behindM[1] : null;

  let add = 0, mod = 0, del = 0;
  for (const l of body) {
    if (/^(\?\?|A.| A)/.test(l)) add++;
    else if (/^(M.|.M| M|R.|.R)/.test(l)) mod++;
    else if (/^(D.|.D| D)/.test(l)) del++;
  }
  const dirty = add + mod + del > 0;
  const color = dirty ? C.gitDirty : C.git;

  let out = `${color}${G.branch} ${branch}`;
  if (ahead)  out += ` ${G.ahead}${ahead}`;
  if (behind) out += ` ${G.behind}${behind}`;
  if (add) out += ` ${G.add}${add}`;
  if (mod) out += ` ${G.mod}${mod}`;
  if (del) out += ` ${G.del}${del}`;
  return out + RESET;
}

// Parseia "git@host:owner/repo.git" ou "https://host/owner/repo.git" e retorna
// { owner, repo, host } onde host é o nome curto (github, gitlab, bitbucket,
// ou primeiro segmento do domínio pra hosts custom). Pra GitLab com subgrupo
// (group/sub/repo) pega só group/repo — mantém legível na statusline.
function parseGitRemote(url) {
  if (!url) return null;
  // SSH:   git@host:path/repo.git    ou    ssh://git@host/path/repo.git
  // HTTPS: https://host[:port]/path/repo.git
  const m = url.match(/^(?:git@([^:]+):|ssh:\/\/[^@]*@([^/]+)\/|https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/)(.+?)(?:\.git)?\/?$/);
  if (!m) return null;
  const host = (m[1] || m[2] || m[3] || '').toLowerCase();
  const fullPath = m[4];
  const segs = fullPath.split('/').filter(Boolean);
  if (segs.length < 2) return null;
  const owner = segs[0];
  const repo = segs[segs.length - 1];

  let shortHost;
  if (host === 'github.com') shortHost = 'github';
  else if (host.includes('gitlab')) shortHost = 'gitlab';
  else if (host.includes('bitbucket')) shortHost = 'bitbucket';
  else shortHost = host.split('.')[0] || host;

  return { owner, repo, host: shortHost };
}

// ── Git info for telemetry payload ───────────────────────────────────────────
// remote.origin.url cacheia por cwd (não muda durante a sessão); branch sempre
// re-lê (dev pode fazer checkout). Backend recebe cru e canonicaliza.
const _gitRemoteCache = new Map();
function readGitInfo(cwd) {
  if (!cwd) return {};
  const info = {};

  if (!_gitRemoteCache.has(cwd)) {
    let url = null;
    try {
      url = execSync('git config --get remote.origin.url', {
        cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 1000,
      }).trim() || null;
    } catch {}
    _gitRemoteCache.set(cwd, url);
  }
  const url = _gitRemoteCache.get(cwd);
  if (url) info.git_remote_url = url;

  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 1000,
    }).trim();
    if (branch && branch !== 'HEAD') info.git_branch = branch;
  } catch {}

  return info;
}

// ── Formatters ────────────────────────────────────────────────────────────────
function fmtCost(c) {
  const n = Number(c) || 0;
  return `$${n.toFixed(2)}`;
}
function fmtTokens(t) {
  const n = Number(t) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
function fmtDuration(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s/60)}m${String(s%60).padStart(2,'0')}s`;
  return `${Math.floor(s/3600)}h${String(Math.floor((s%3600)/60)).padStart(2,'0')}m`;
}
function ctxColor(pct) {
  const n = Math.floor(Number(pct) || 0);
  if (n >= 80) return C.ctxHot;
  if (n >= 50) return C.ctxWarn;
  return C.ctxOk;
}
function ctxBar(pct) {
  const n = Math.max(0, Math.min(100, Math.floor(Number(pct) || 0)));
  const filled = Math.floor(n / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

// ── Model display ─────────────────────────────────────────────────────────────
function modelDisplay(id, display) {
  if (!id) return display || '?';
  const i = id.toLowerCase();
  if (i.includes('opus') && i.includes('4-7')) return 'Opus 4.7';
  if (i.includes('opus') && i.includes('4-6')) return 'Opus 4.6';
  if (i.includes('sonnet') && i.includes('4-6')) return 'Sonnet 4.6';
  if (i.includes('haiku') && i.includes('4-5')) return 'Haiku 4.5';
  return display || id;
}

// ── Auto-update (fork-and-forget) ─────────────────────────────────────────────
// Triggers a background check when EITHER:
//   - the session_id is new (Claude Code restarted / fresh session opened), or
//   - more than 24h passed since the last check (covers marathon sessions).
// Within the same session it never re-checks more than once per 24h, so no flood.
function maybeScheduleUpdate(sessionId) {
  // Auto-update DESARMADO por padrão nesta branch (feat/otel-indicators-responsive).
  // O `main` no GitHub está em v2.6.1 — versão ANTIGA que ignora o kill-switch e
  // rebaixaria o arquivo, clobberando estas mudanças (já aconteceu uma vez). Só
  // religa com CLAUDE_STATUSLINE_NO_UPDATE=0 explícito. Ao mergear pro main com uma
  // versão que respeite o kill-switch, voltar à condição `=== '1'` normal.
  if (process.env.CLAUDE_STATUSLINE_NO_UPDATE !== '0') return;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });

    let lastSession = '';
    try { lastSession = fs.readFileSync(LAST_SESSION, 'utf8').trim(); } catch {}
    const newSession = sessionId && sessionId !== lastSession;

    let last = 0;
    try { last = Number(fs.readFileSync(LAST_CHECK, 'utf8')) || 0; } catch {}
    const stale = Date.now() - last >= CHECK_INTERVAL_MS;

    // Remember this session so we don't re-trigger on every render within it.
    if (sessionId) {
      try { fs.writeFileSync(LAST_SESSION, sessionId); } catch {}
    }

    if (!newSession && !stale) return;
    fs.writeFileSync(LAST_CHECK, String(Date.now()));

    // Detach a background child that downloads + replaces self.
    const child = spawn(process.execPath, [SELF_PATH, '--bg-update'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch {}
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? require('https') : require('http');
    const req = lib.get(url, { timeout: 10000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(fetchText(res.headers.location)); return;
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => buf += d);
      res.on('end', () => resolve(buf));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

async function backgroundUpdate() {
  try {
    const remote = await fetchText(`${REPO_RAW}/statusline.js`);
    if (!remote || !remote.startsWith('#!')) return;
    const remoteVerMatch = remote.match(/^\/\/ VERSION:\s*([\w.\-]+)/m);
    const remoteVer = remoteVerMatch ? remoteVerMatch[1] : null;
    if (!remoteVer) return;

    // Always cache the last-known remote version, even when no update is needed.
    // The renderer reads this synchronously on the hot path to decide whether to
    // show the "update available" badge — keeps the render itself zero-network.
    try { fs.writeFileSync(REMOTE_VERSION_CACHE, remoteVer); } catch {}

    if (remoteVer === VERSION) return;

    let current = '';
    try { current = fs.readFileSync(SELF_PATH, 'utf8'); } catch {}
    if (current === remote) return;

    const tmp = SELF_PATH + '.new';
    fs.writeFileSync(tmp, remote, { mode: 0o755 });
    fs.renameSync(tmp, SELF_PATH);
    try { fs.chmodSync(SELF_PATH, 0o755); } catch {}
    fs.appendFileSync(UPDATE_LOG,
      `[${new Date().toISOString()}] updated to ${remoteVer}\n`);
  } catch (e) {
    try {
      fs.appendFileSync(UPDATE_LOG,
        `[${new Date().toISOString()}] update failed: ${e.message}\n`);
    } catch {}
  }
}

// ── "Update available" badge ──────────────────────────────────────────────────
// Reads the remote-version cache (written by the background update check, max 24h old).
// If the cached remote version differs from VERSION, show a clickable amber badge.
// Zero network cost on the hot path — just a tiny file read.
// Suppress with CLAUDE_STATUSLINE_NO_UPDATE_BADGE=1.
function updateBadge() {
  if (process.env.CLAUDE_STATUSLINE_NO_UPDATE_BADGE === '1') return '';
  let remoteVer;
  try { remoteVer = fs.readFileSync(REMOTE_VERSION_CACHE, 'utf8').trim(); }
  catch { return ''; }
  if (!remoteVer || remoteVer === VERSION) return '';

  const SEP = `${C.rule} · ${RESET}`;
  const url = `https://github.com/andregosling/claude-statusline/blob/main/HELP.md#update`;
  const BEL = '\x07';
  const open  = `${ESC}]8;;${url}${BEL}`;
  const close = `${ESC}]8;;${BEL}`;
  // Amber + bold to catch the eye, but not blinking (real blink is hostile UX).
  return `${SEP}${C.cost}${BOLD}${open}⬆ v${remoteVer} available${close}${RESET}`;
}

// ── Clickable (?) help link via OSC 8 ─────────────────────────────────────────
// Most modern terminals (iTerm2, WezTerm, Kitty, Windows Terminal, Ghostty, recent
// VTE-based) honor OSC 8 hyperlinks: Cmd/Ctrl+click opens the URL. Older terminals
// just see the visible text "(?)" with the escape codes filtered out gracefully.
// Disable explicitly with CLAUDE_STATUSLINE_NO_HELP=1.
// Envolve QUALQUER segmento da status line num link OSC 8 que abre o help.html
// já na seção `anchor`. Cada item da status line vira clicável → docs contextual.
// Gera o HTML on-demand (idempotente). NO_HELP=1 devolve o conteúdo sem link.
function helpAnchor(content, anchor) {
  if (process.env.CLAUDE_STATUSLINE_NO_HELP === '1') return content;
  try { writeHelpHtml(); } catch {}
  try { writeHelpData(); } catch {} // diagnóstico fresco a cada render
  const BEL = '\x07';
  const url = `file://${HELP_HTML}${anchor ? '#' + anchor : ''}`;
  return `${ESC}]8;;${url}${BEL}${content}${ESC}]8;;${BEL}`;
}

// (?) geral no fim da status line → abre o help no topo (overview).
function helpLink() {
  if (process.env.CLAUDE_STATUSLINE_NO_HELP === '1') return '';
  const SEP = `${C.rule} · ${RESET}`;
  return `${SEP}${C.label}${helpAnchor('(?)', '')}${RESET}`;
}

// Bloco "twt metrics" com dois indicadores de saúde de ingestão, cada um
// clicável pra sua sub-seção do help:
//   stats = pipeline do statusline/heartbeat (custo, rate-limit, contexto)
//   otel  = pipeline OpenTelemetry (Claude Code → /v1/*: tools, tokens/turno, erros)
// Cores: verde = chegando · amarelo = sem dado/desconhecido · vermelho = não chega.
function ingestHealthBadge() {
  if (TELEMETRY_DISABLED) return '';
  if (process.env.CLAUDE_STATUSLINE_NO_INGEST_BADGE === '1') return '';
  if (!loadToken()) return ''; // sem pareamento, o auth banner já cobre

  let h = null;
  try { h = JSON.parse(fs.readFileSync(INGEST_HEALTH_CACHE, 'utf8')); } catch {}

  const SEP = `${C.rule} · ${RESET}`;
  const gStats = PLAIN ? '' : '\u{F0954} '; // 󰥔 pulso
  const gOtel = PLAIN ? '' : '\u{F02A4} ';  // 󰊤 antena/broadcast

  // stats: verde = heartbeat aceito · vermelho = última tentativa FALHOU (last_error)
  // · amarelo = nunca tentou (sem cache ainda).
  let statsColor;
  if (h == null) statsColor = C.ctxWarn;
  else if (h.manual_ingest_ok) statsColor = C.ctxOk;
  else statsColor = C.gitGone; // falhou (backend off, 401, etc)
  const stats = `${statsColor}${gStats}stats${RESET}`;

  // otel: verde = backend recebeu OTel recente · amarelo = desconhecido (sem cache
  // OU heartbeat falhou, então não dá pra saber) · vermelho = heartbeat OK mas OTel não chega.
  let otelColor;
  if (h == null || !h.manual_ingest_ok) otelColor = C.ctxWarn; // sem info confiável
  else otelColor = h.otel_ingest_ok ? C.ctxOk : C.gitGone;
  const otel = `${otelColor}${gOtel}otel${RESET}`;

  // Sem link nos indicadores (texto puro). A ajuda fica no (?) geral no fim da linha.
  return `${SEP}${C.label}twt metrics:${RESET} ${stats}${C.rule} · ${RESET}${otel}`;
}

// Coleta o estado ao vivo dos dois pipelines + saúde/config + últimos eventos,
// lendo os caches locais. Vira window.DIAG no help (painel de diagnóstico).
function collectDiagnostics() {
  const now = Date.now();
  let health = null;
  try { health = JSON.parse(fs.readFileSync(INGEST_HEALTH_CACHE, 'utf8')); } catch {}

  let lastHb = null;
  try { lastHb = Number(fs.readFileSync(LAST_HEARTBEAT, 'utf8')) || null; } catch {}

  // Últimas ~12 linhas do log de telemetria (eventos/erros recentes).
  let events = [];
  try {
    const lines = fs.readFileSync(TELEMETRY_LOG, 'utf8').trim().split('\n');
    events = lines.slice(-12).map((l) => {
      const m = l.match(/^\[([^\]]+)\]\s*(.*)$/);
      return m ? { ts: m[1], msg: m[2] } : { ts: '', msg: l };
    }).reverse();
  } catch {}

  // settings.json do CC tem o OTel configurado?
  let otelConfigured = false;
  try {
    const s = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
    otelConfigured = !!(s && s.env && s.env.CLAUDE_CODE_ENABLE_TELEMETRY === '1' &&
      s.env.OTEL_EXPORTER_OTLP_ENDPOINT);
  } catch {}

  // Estado derivado de cada pipeline: { color, title, why }.
  let stats, otel;
  if (!health) {
    stats = { color: 'y', title: 'desconhecido', why: 'Nenhum heartbeat enviado ainda nesta sessão (acabou de abrir, ou aguardando o primeiro envio ~60s).' };
    otel = { color: 'y', title: 'desconhecido', why: 'Sem heartbeat recente, não dá pra perguntar ao servidor se o OTel está chegando.' };
  } else if (!health.manual_ingest_ok) {
    stats = { color: 'r', title: 'falhando', why: `O heartbeat não está sendo aceito pelo servidor.${health.last_error ? ' Último erro: ' + health.last_error + '.' : ''} Endpoint: ${health.endpoint || TELEMETRY_API_URL}.` };
    otel = { color: 'y', title: 'desconhecido', why: 'Como o heartbeat está falhando, não dá pra confirmar o estado do OTel.' };
  } else {
    stats = { color: 'g', title: 'recebendo', why: 'O servidor está aceitando seus heartbeats normalmente.' };
    if (health.otel_ingest_ok) {
      otel = { color: 'g', title: 'recebendo', why: `O servidor recebeu eventos OTel seus recentemente${health.otel_last_seen_at ? ' (último: ' + health.otel_last_seen_at + ')' : ''}.` };
    } else {
      otel = { color: 'r', title: 'não chega', why: `O servidor recebe seu heartbeat, mas NÃO está recebendo OTel do Claude Code.${otelConfigured ? ' A config existe — provável que falte REINICIAR o Claude Code (OTel só ativa no restart).' : ' O OTel ainda não foi configurado no settings.json — o statusline configura no próximo render.'}` };
    }
  }

  return {
    capturedAt: now,
    endpoint: (health && health.endpoint) || TELEMETRY_API_URL,
    lastHeartbeatAt: lastHb,
    tokenPresent: !!loadToken(),
    otelConfigured,
    cliVersion: VERSION,
    stats, otel,
    events,
  };
}

// Escreve o help-data.js (window.DIAG = {...}) — leve, reescrito a cada render.
function writeHelpData() {
  try {
    const data = collectDiagnostics();
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(HELP_DATA_JS, `window.DIAG = ${JSON.stringify(data)};`);
  } catch {}
}

// Gera o help.html completo (standalone, zero deps): painel de diagnóstico ao vivo
// no topo (lê window.DIAG do help-data.js) + cards com glow neon explicando cada
// segmento. Cada card tem id pra âncora (#stats etc).
// Idempotente: só reescreve se o conteúdo mudou. Bump HELP_VERSION ao editar.
const HELP_VERSION = 6;
function writeHelpHtml() {
  const html = `<!doctype html>
<html lang="pt-br" data-v="${HELP_VERSION}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>claude-statusline · ajuda</title>
<style>
  :root { color-scheme: dark;
    --bg:#08090c; --panel:#0e1014; --panel-2:#14161c; --line:rgba(255,255,255,.07);
    --line-2:rgba(255,255,255,.04); --txt:#f7f8f8; --txt-2:#9b9fa8; --txt-3:#6a6e78;
    --accent:#7c84f2; --green:#4cc38a; --amber:#f2c94c; --red:#f56565;
    --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,monospace;
    --sans:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",sans-serif; }
  * { box-sizing:border-box; margin:0; padding:0; }
  html { -webkit-font-smoothing:antialiased; scroll-behavior:smooth; text-rendering:optimizeLegibility; }
  body { background:var(--bg); color:var(--txt); font-family:var(--sans); line-height:1.55;
    min-height:100vh; padding:72px 24px 96px; position:relative; overflow-x:hidden; }
  body::before { content:""; position:fixed; inset:0; pointer-events:none; z-index:0;
    background:radial-gradient(680px 340px at 50% -8%, rgba(124,132,242,.16), transparent 70%),
      radial-gradient(900px 500px at 85% 8%, rgba(76,195,138,.05), transparent 60%); }
  .wrap { max-width:740px; margin:0 auto; position:relative; z-index:1; }
  .eyebrow { font-family:var(--mono); font-size:11.5px; letter-spacing:.18em; text-transform:uppercase;
    color:var(--txt-3); margin-bottom:16px; display:flex; align-items:center; gap:9px; animation:rise .6s cubic-bezier(.2,.7,.2,1) both; }
  .eyebrow .led { width:6px; height:6px; border-radius:50%; background:var(--accent); box-shadow:0 0 10px var(--accent); }
  h1 { font-size:32px; font-weight:600; letter-spacing:-.025em; line-height:1.1; margin-bottom:12px;
    animation:rise .6s cubic-bezier(.2,.7,.2,1) .05s both; }
  h1 .grad { background:linear-gradient(95deg,#fff,#9ea4f5); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; }
  .lead { font-size:16px; color:var(--txt-2); max-width:60ch; animation:rise .6s cubic-bezier(.2,.7,.2,1) .1s both; }
  /* mock */
  .mock { margin:30px 0 14px; border-radius:12px; overflow:hidden; border:1px solid var(--line); background:var(--panel);
    box-shadow:0 24px 60px -28px rgba(0,0,0,.8), inset 0 1px 0 rgba(255,255,255,.03); animation:rise .7s cubic-bezier(.2,.7,.2,1) .15s both; }
  .mock-bar { display:flex; align-items:center; gap:7px; padding:11px 14px; background:var(--panel-2); border-bottom:1px solid var(--line-2); }
  .tl { width:11px; height:11px; border-radius:50%; } .tl.r{background:#ff5f57} .tl.y{background:#febc2e} .tl.g{background:#28c840}
  .mock-bar .ttl { margin-left:8px; font-family:var(--mono); font-size:11.5px; color:var(--txt-3); }
  .mock-body { padding:16px 20px; font-family:var(--mono); font-size:12.5px; line-height:2; white-space:pre-wrap; color:var(--txt-2); }
  .mock-body .g3 { color:var(--txt-3); } .mock-body .ok { color:var(--green); } .mock-body .bad { color:var(--red); }
  .section-label { font-family:var(--mono); font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:var(--txt-3);
    margin:40px 0 14px; padding-left:2px; }
  /* cards */
  .card { border:1px solid var(--line); border-radius:14px; background:var(--panel); padding:22px 24px 18px;
    margin-bottom:14px; position:relative; transition:border-color .25s, transform .25s; animation:rise .5s cubic-bezier(.2,.7,.2,1) both; }
  .card:hover { border-color:rgba(255,255,255,.13); transform:translateY(-1px); }
  .card::before { content:""; position:absolute; left:24px; right:24px; top:0; height:1px;
    background:linear-gradient(90deg,transparent,var(--ca,var(--accent)),transparent); opacity:.45; }
  .card.stats { --ca:var(--accent); } .card.otel { --ca:var(--green); }
  .card-head { display:flex; align-items:center; gap:11px; margin-bottom:9px; flex-wrap:wrap; }
  .chip { font-family:var(--mono); font-size:12px; font-weight:600; padding:3px 10px; border-radius:7px; color:var(--txt);
    border:1px solid var(--ca,var(--accent)); background:color-mix(in srgb,var(--ca,var(--accent)) 12%,transparent); }
  .card-head h2 { font-size:17px; font-weight:600; letter-spacing:-.01em; }
  .card p { color:var(--txt-2); font-size:14.5px; margin-bottom:12px; } .card p:last-child { margin-bottom:0; }
  .card p b { color:var(--txt); font-weight:600; } .card p i { color:var(--txt); font-style:normal; border-bottom:1px dashed var(--txt-3); }
  .states { display:flex; flex-direction:column; gap:1px; }
  .state { display:grid; grid-template-columns:15px 70px 1fr; align-items:start; gap:13px; padding:9px 10px; border-radius:9px; transition:background .2s; }
  .state:hover { background:var(--line-2); }
  .state .dot { width:10px; height:10px; border-radius:50%; margin-top:5px; background:var(--c);
    box-shadow:0 0 0 3px color-mix(in srgb,var(--c) 18%,transparent), 0 0 14px var(--c); }
  .state .nm { font-weight:600; font-size:13.5px; color:var(--ct); } .state .ds { color:var(--txt-2); font-size:13.5px; } .state .ds b { color:var(--txt); }
  .g{--c:var(--green);--ct:#6fdca6} .y{--c:var(--amber);--ct:#f4d06a} .rd{--c:var(--red);--ct:#f88}
  .mono { font-family:var(--mono); background:var(--panel-2); border:1px solid var(--line); padding:1px 6px; border-radius:5px; font-size:.9em; color:var(--txt); }
  .tbl { width:100%; border-collapse:collapse; margin-top:4px; } .tbl td { padding:6px 12px 6px 0; font-size:13.5px; color:var(--txt-2); border-bottom:1px solid var(--line-2); vertical-align:top; }
  .tbl td:first-child { white-space:nowrap; color:var(--txt); font-weight:500; width:1%; }
  .foot { margin-top:36px; padding-top:20px; border-top:1px solid var(--line-2); color:var(--txt-3); font-size:12.5px; text-align:center; animation:rise .6s ease .4s both; }
  .foot code { font-family:var(--mono); background:var(--panel-2); border:1px solid var(--line); padding:2px 7px; border-radius:6px; color:var(--txt-2); font-size:11.5px; }
  section { scroll-margin-top:24px; }
  @keyframes rise { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:none} }
  /* painel de diagnóstico */
  .diag-age { font-family:var(--mono); font-size:10.5px; color:var(--txt-3); text-transform:none; letter-spacing:0; margin-left:8px; }
  .diag-panel { border:1px solid var(--line); border-radius:14px; background:var(--panel); padding:20px 22px;
    display:flex; flex-direction:column; gap:14px; box-shadow:0 20px 50px -30px rgba(0,0,0,.7); }
  .diag-row { display:grid; grid-template-columns:14px 1fr; gap:13px; align-items:start; }
  .diag-dot { width:11px; height:11px; border-radius:50%; margin-top:5px; background:var(--dc,var(--txt-3));
    box-shadow:0 0 0 3px color-mix(in srgb,var(--dc,var(--txt-3)) 18%,transparent), 0 0 14px var(--dc,var(--txt-3)); }
  .diag-dot.g{--dc:var(--green)} .diag-dot.y{--dc:var(--amber)} .diag-dot.r{--dc:var(--red)}
  .diag-name { font-weight:600; font-size:15px; }
  .diag-state { font-family:var(--mono); font-size:11px; padding:2px 8px; border-radius:6px; margin-left:6px; vertical-align:middle;
    background:color-mix(in srgb,var(--sc,var(--txt-3)) 16%,transparent); color:var(--sc,var(--txt-2)); }
  .diag-state.g{--sc:var(--green)} .diag-state.y{--sc:var(--amber)} .diag-state.r{--sc:var(--red)}
  .diag-why { color:var(--txt-2); font-size:13.5px; margin-top:3px; line-height:1.5; }
  .diag-why b { color:var(--txt); }
  .diag-meta { display:flex; flex-wrap:wrap; gap:8px 18px; padding-top:13px; border-top:1px solid var(--line-2);
    font-family:var(--mono); font-size:11.5px; color:var(--txt-3); }
  .diag-meta b { color:var(--txt-2); font-weight:500; }
  .diag-events { border-top:1px solid var(--line-2); padding-top:13px; display:flex; flex-direction:column; gap:5px; }
  .diag-events .ev { font-family:var(--mono); font-size:11px; color:var(--txt-3); display:flex; gap:10px; }
  .diag-events .ev .t { color:var(--txt-3); opacity:.7; white-space:nowrap; }
  .diag-events .ev .m { color:var(--txt-2); } .diag-events .ev.err .m { color:#f88; }
  .diag-empty { color:var(--txt-3); font-size:13px; font-style:italic; }
  @media (max-width:560px){ body{padding:44px 16px} h1{font-size:26px} .state{grid-template-columns:15px 1fr} .state .nm,.state .ds{grid-column:2} }
</style>
</head>
<body><div class="wrap">
  <div class="eyebrow"><span class="led"></span>claude-statusline · guia</div>
  <h1><span class="grad">O que cada coisa significa</span></h1>
  <p class="lead">Duas linhas no rodapé do Claude Code: a de cima é <b>contexto</b> (onde você está), a de baixo é <b>métricas</b> (o que está consumindo).</p>

  <div class="mock">
    <div class="mock-bar"><span class="tl r"></span><span class="tl y"></span><span class="tl g"></span><span class="ttl">claude — statusline</span></div>
    <div class="mock-body"><span class="g3">╭─</span>  ~/code/projeto · ⎇ main +3 ~2 · 󰚩 Opus · high
<span class="g3">╰─</span>  $0.42 ·  219k ctx · last +187 ·  18m · ███████░░░ 73%  +156/-23 · ● 5h · resets in 2h · 🏃 fast 1.4× · twt metrics: <span class="ok">stats</span> · <span class="bad">otel</span> <span class="g3">(?)</span></div>
  </div>

  <!-- Painel de diagnóstico ao vivo (preenchido via window.DIAG do help-data.js) -->
  <section id="diagnostico"><div class="section-label" style="margin-top:34px">Diagnóstico agora <span id="diag-age" class="diag-age"></span></div>
    <div id="diag-panel" class="diag-panel">
      <div class="diag-row"><span class="dot diag-dot" id="diag-stats-dot"></span>
        <div><div class="diag-name">stats <span id="diag-stats-state" class="diag-state"></span></div>
        <div class="diag-why" id="diag-stats-why">—</div></div></div>
      <div class="diag-row"><span class="dot diag-dot" id="diag-otel-dot"></span>
        <div><div class="diag-name">otel <span id="diag-otel-state" class="diag-state"></span></div>
        <div class="diag-why" id="diag-otel-why">—</div></div></div>
      <div class="diag-meta" id="diag-meta"></div>
      <div class="diag-events" id="diag-events"></div>
    </div>
  </section>

  <div class="section-label">Linha 1 — contexto</div>
  <section id="path"><div class="card"><div class="card-head"><span class="chip">~/…</span><h2>Diretório</h2></div>
    <p>Diretório de trabalho atual (ou <span class="mono">owner/repo · host</span> se for um repo git com remote). Caminho profundo encurta pra <span class="mono">~/…/projeto/src</span>.</p></div></section>
  <section id="git"><div class="card"><div class="card-head"><span class="chip">⎇</span><h2>Git</h2></div>
    <p><b>main</b> = branch · <b>↑N/↓N</b> = ahead/behind · <b>+N</b> novos · <b>~N</b> modificados · <b>−N</b> deletados.</p>
    <div class="states"><div class="state g"><span class="dot"></span><span class="nm">Verde</span><span class="ds">limpo, sem mudanças</span></div>
    <div class="state y"><span class="dot"></span><span class="nm">Âmbar</span><span class="ds">dirty (tem mudanças)</span></div></div></div></section>
  <section id="model"><div class="card"><div class="card-head"><span class="chip">󰚩</span><h2>Modelo &amp; effort</h2></div>
    <p><span class="mono">󰚩 Opus 4.7</span> — modelo ativo. <span class="mono">high/med/low</span> — effort (campo <span class="mono">effortLevel</span>, só aparece se setado). <span class="mono">wt:nome</span> — worktree, se estiver em um.</p></div></section>

  <div class="section-label">Linha 2 — métricas</div>
  <section id="cost"><div class="card"><div class="card-head"><span class="chip"> $</span><h2>Custo</h2></div>
    <p>Custo total em USD da sessão (<span class="mono">cost.total_cost_usd</span>).</p></div></section>
  <section id="ctx"><div class="card"><div class="card-head"><span class="chip"> ctx</span><h2>Contexto · last</h2></div>
    <p>O Claude Code <b>não dá contadores acumulados</b> de tokens — só snapshots do turno. Então:</p>
    <p><b>219k ctx</b> = tamanho do contexto <b>agora</b> (system prompt + tools + CLAUDE.md + histórico). Até um "oi" mostra ~8k: é o overhead fixo. &nbsp;<b>last +187</b> = output <i>só do último turno</i>, não um total de sessão.</p></div></section>
  <section id="time"><div class="card"><div class="card-head"><span class="chip"></span><h2>Tempo</h2></div>
    <p>Wall-clock da sessão — desde que você abriu o Claude Code.</p></div></section>
  <section id="ctxbar"><div class="card"><div class="card-head"><span class="chip"></span><h2>Barra de contexto</h2></div>
    <p>Quanto do contexto já está cheio. Passando de 100%, o Claude compacta.</p>
    <div class="states"><div class="state g"><span class="dot"></span><span class="nm">&lt; 50%</span><span class="ds">bem livre</span></div>
    <div class="state y"><span class="dot"></span><span class="nm">50–79%</span><span class="ds">preparando compaction</span></div>
    <div class="state rd"><span class="dot"></span><span class="nm">≥ 80%</span><span class="ds">vai compactar em breve</span></div></div></div></section>
  <section id="lines"><div class="card"><div class="card-head"><span class="chip">+/−</span><h2>Linhas</h2></div>
    <p>Linhas adicionadas / removidas na sessão. Só aparece quando você editou algo.</p></div></section>
  <section id="rl5h"><div class="card"><div class="card-head"><span class="chip">●</span><h2>Rate limit 5h · a bolinha</h2></div>
    <p>A bolinha reflete <b>só o % bruto de uso</b> do limite de 5h, <b>ignorando o tempo</b>. Usou 5%? Verde, mesmo com pace alto. <span class="mono">resets in Xh</span> = tempo até zerar.</p>
    <div class="states"><div class="state g"><span class="dot"></span><span class="nm">&lt; 50%</span><span class="ds">tranquilo</span></div>
    <div class="state y"><span class="dot"></span><span class="nm">50–79%</span><span class="ds">atenção</span></div>
    <div class="state rd"><span class="dot"></span><span class="nm">≥ 80%</span><span class="ds">perto do teto</span></div></div></div></section>
  <section id="pace"><div class="card"><div class="card-head"><span class="chip">🏃</span><h2>Pace — "estou gastando rápido demais?"</h2></div>
    <p>Multiplicador <b>independente da bolinha</b>: <span class="mono">uso ÷ tempo_decorrido</span> (frações da janela de 5h). <b>1.0×</b> = bate 100% exatamente no reset · <b>&lt;1</b> folga · <b>&gt;1</b> bate o teto antes.</p>
    <div class="states"><div class="state g"><span class="dot"></span><span class="nm">🐢 chill</span><span class="ds">&lt; 0.7× — gasta à vontade</span></div>
    <div class="state g"><span class="dot"></span><span class="nm">🚶 ok</span><span class="ds">0.7–1.1× — no ritmo</span></div>
    <div class="state y"><span class="dot"></span><span class="nm">🏃 fast</span><span class="ds">1.1–1.5× — segura um pouco</span></div>
    <div class="state rd"><span class="dot"></span><span class="nm">🔥 hot</span><span class="ds">&gt; 1.5× — vai bater o teto cedo</span></div></div>
    <p style="margin-top:14px"><b>warming</b>: nos primeiros ~30min o número é real mas oscila (denominador minúsculo). Some sozinho depois.</p></div></section>

  <div class="section-label">twt metrics — ingestão</div>
  <section id="twt-metrics"><div class="card"><div class="card-head"><span class="chip">twt</span><h2>Seus dados estão chegando?</h2></div>
    <p>Dois sinais que dizem se o seu uso do Claude está chegando ao servidor de métricas. Cada um vigia um caminho diferente. <b>Cor:</b> <span class="dot g" style="display:inline-block;box-shadow:0 0 8px var(--green)"></span> verde = chegando · <span class="dot y" style="display:inline-block;box-shadow:0 0 8px var(--amber)"></span> âmbar = desconhecido · <span class="dot rd" style="display:inline-block;box-shadow:0 0 8px var(--red)"></span> vermelho = não chega.</p></div></section>
  <section id="stats"><div class="card stats"><div class="card-head"><span class="chip">stats</span><h2>Heartbeat do statusline</h2></div>
    <p>O ingest clássico: a cada ~60s manda um resumo da sessão — <b>custo, rate-limit, contexto, linhas, repo</b>. É a fonte que o OpenTelemetry <i>não enxerga</i>.</p>
    <div class="states"><div class="state g"><span class="dot"></span><span class="nm">Verde</span><span class="ds">último heartbeat <b>aceito</b> pelo servidor</span></div>
    <div class="state y"><span class="dot"></span><span class="nm">Âmbar</span><span class="ds">sem resposta recente ainda</span></div></div></div></section>
  <section id="otel"><div class="card otel"><div class="card-head"><span class="chip">otel</span><h2>OpenTelemetry do Claude Code</h2></div>
    <p>Telemetria <b>profunda</b> do próprio Claude Code: <b>tools, MCP e skills</b> usadas, <b>tokens e custo por turno</b>, commits, PRs e <b>erros</b>. O statusline configura sozinho; o servidor confirma se recebe.</p>
    <div class="states"><div class="state g"><span class="dot"></span><span class="nm">Verde</span><span class="ds">servidor recebeu OTel na última hora</span></div>
    <div class="state y"><span class="dot"></span><span class="nm">Âmbar</span><span class="ds">desconhecido (sem heartbeat recente)</span></div>
    <div class="state rd"><span class="dot"></span><span class="nm">Vermelho</span><span class="ds">não chega. Causa comum: <b>reinicie o Claude Code</b> (OTel só ativa no restart). Persistindo, fale com o time.</span></div></div></div></section>

  <div class="section-label">Atualização</div>
  <section id="update"><div class="card"><div class="card-head"><span class="chip">⬆</span><h2>Update disponível</h2></div>
    <p>Tem versão nova. Pra instalar: <span class="mono">claude-statusline update</span>. Esconder o badge: <span class="mono">CLAUDE_STATUSLINE_NO_UPDATE_BADGE=1</span>.</p></div></section>

  <p class="foot">claude-statusline · twt metrics &nbsp;·&nbsp; esconder os indicadores: <code>CLAUDE_STATUSLINE_NO_INGEST_BADGE=1</code></p>
</div>
<script src="${path.basename(HELP_DATA_JS)}"></script>
<script>
  // Preenche o painel de diagnóstico com window.DIAG (do help-data.js, gerado a
  // cada render do statusline). É um SNAPSHOT — recarregue (Cmd+R) pra atualizar.
  (function () {
    var d = window.DIAG;
    var panel = document.getElementById('diag-panel');
    if (!d) { if (panel) panel.innerHTML = '<div class="diag-empty">Sem dados de diagnóstico ainda — abra após o primeiro heartbeat.</div>'; return; }
    function set(id, txt) { var e = document.getElementById(id); if (e) e.textContent = txt; }
    function cls(id, base, c) { var e = document.getElementById(id); if (e) e.className = base + ' ' + c; }
    // idade do snapshot
    var ageMs = Date.now() - (d.capturedAt || Date.now());
    var ageS = Math.round(ageMs / 1000);
    var ageStr = ageS < 60 ? ('há ' + ageS + 's') : ('há ' + Math.round(ageS / 60) + 'min');
    set('diag-age', '· capturado ' + ageStr + ' · recarregue (Cmd+R) pra atualizar');
    // pipelines
    var L = { g: 'OK', y: 'desconhecido', r: 'problema' };
    cls('diag-stats-dot', 'dot diag-dot', d.stats.color);
    set('diag-stats-state', d.stats.title); cls('diag-stats-state', 'diag-state', d.stats.color);
    set('diag-stats-why', d.stats.why);
    cls('diag-otel-dot', 'dot diag-dot', d.otel.color);
    set('diag-otel-state', d.otel.title); cls('diag-otel-state', 'diag-state', d.otel.color);
    set('diag-otel-why', d.otel.why);
    // meta (saúde/config)
    var hb = d.lastHeartbeatAt ? ('há ' + Math.round((Date.now() - d.lastHeartbeatAt) / 1000) + 's') : 'nunca';
    var meta = document.getElementById('diag-meta');
    if (meta) meta.innerHTML =
      '<span>endpoint: <b>' + esc(d.endpoint) + '</b></span>' +
      '<span>último heartbeat: <b>' + hb + '</b></span>' +
      '<span>token: <b>' + (d.tokenPresent ? 'presente' : 'ausente') + '</b></span>' +
      '<span>OTel configurado: <b>' + (d.otelConfigured ? 'sim' : 'não') + '</b></span>' +
      '<span>CC statusline: <b>v' + esc(d.cliVersion) + '</b></span>';
    // eventos recentes
    var ev = document.getElementById('diag-events');
    if (ev) {
      if (!d.events || !d.events.length) { ev.innerHTML = '<div class="diag-empty">Sem eventos recentes no log.</div>'; }
      else ev.innerHTML = d.events.map(function (e) {
        var isErr = /erro|error|exception|fail|refused|ECONN|timeout|401/i.test(e.msg);
        var t = (e.ts || '').replace('T', ' ').replace(/\\..*$/, '').slice(11);
        return '<div class="ev' + (isErr ? ' err' : '') + '"><span class="t">' + esc(t) + '</span><span class="m">' + esc(e.msg) + '</span></div>';
      }).join('');
    }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  })();
</script>
<script>
  // Scroll pra seção do #hash — funciona no load E quando a página JÁ está aberta
  // numa aba e o terminal reabre com outro #hash (o browser não re-scrolla sozinho).
  // Também dá um flash visual no card alvo pra deixar claro onde você chegou.
  function gotoHash() {
    var id = (location.hash || '').slice(1);
    if (!id) return;
    var el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    var card = el.querySelector('.card') || el;
    card.style.transition = 'box-shadow .4s, border-color .4s';
    card.style.boxShadow = '0 0 0 1px var(--accent), 0 0 30px -4px var(--accent)';
    card.style.borderColor = 'var(--accent)';
    setTimeout(function () { card.style.boxShadow = ''; card.style.borderColor = ''; }, 1400);
  }
  window.addEventListener('hashchange', gotoHash);
  // No load: espera o layout assentar antes de rolar (file:// + render assíncrono).
  if (location.hash) { window.addEventListener('load', function(){ setTimeout(gotoHash, 60); }); }
</script>
</body></html>`;

  try { if (fs.readFileSync(HELP_HTML, 'utf8') === html) return; } catch {}
  fs.mkdirSync(path.dirname(HELP_HTML), { recursive: true });
  fs.writeFileSync(HELP_HTML, html);
}


// ── Telemetry: token I/O ──────────────────────────────────────────────────────
function loadToken() {
  try { return fs.readFileSync(TELEMETRY_TOKEN_PATH, 'utf8').trim() || null; }
  catch { return null; }
}
function saveToken(token) {
  fs.mkdirSync(path.dirname(TELEMETRY_TOKEN_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(TELEMETRY_TOKEN_PATH, token, { mode: 0o600 });
}
function deleteToken() {
  try { fs.unlinkSync(TELEMETRY_TOKEN_PATH); } catch {}
}
function telemetryLog(line) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.appendFileSync(TELEMETRY_LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
}

// ── Telemetry: HTTP POST (zero deps) ──────────────────────────────────────────
function httpPostJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    const payload = Buffer.from(JSON.stringify(body));
    const req = lib.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        ...headers,
      },
      timeout: 10000,
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => buf += d);
      res.on('end', () => {
        let parsed = null;
        try { parsed = buf ? JSON.parse(buf) : null; } catch {}
        resolve({ status: res.statusCode, body: parsed, raw: buf });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(payload);
    req.end();
  });
}

// ── Telemetry: pending-auth state ─────────────────────────────────────────────
// The statusline is re-invoked from scratch on each render, so the device flow's
// (device_code, expires_at, interval) must live on disk. We render the banner
// reading this file; a background process owns the polling.
function loadPendingAuth() {
  try {
    const raw = fs.readFileSync(PENDING_AUTH, 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || !obj.device_code || !obj.expires_at) return null;
    if (Date.now() > obj.expires_at) { try { fs.unlinkSync(PENDING_AUTH); } catch {} return null; }
    return obj;
  } catch { return null; }
}
function savePendingAuth(obj) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(PENDING_AUTH, JSON.stringify(obj));
  } catch {}
}
function clearPendingAuth() {
  try { fs.unlinkSync(PENDING_AUTH); } catch {}
}

// ── Telemetry: device flow (RFC 8628) ─────────────────────────────────────────
async function backgroundAuthInit() {
  try {
    let pending = loadPendingAuth();
    if (!pending) {
      const res = await httpPostJson(`${TELEMETRY_API_URL}/oauth/device/authorize`, {
        client_id: CLIENT_ID,
        scope: 'telemetry:write',
      });
      if (res.status !== 200 || !res.body || !res.body.device_code) {
        telemetryLog(`auth/authorize failed: status=${res.status} body=${res.raw}`);
        return;
      }
      const init = res.body;
      pending = {
        device_code: init.device_code,
        user_code: init.user_code,
        verification_uri: init.verification_uri,
        verification_uri_complete: init.verification_uri_complete,
        interval_ms: (init.interval || 5) * 1000,
        expires_at: Date.now() + (init.expires_in || 600) * 1000,
      };
      savePendingAuth(pending);
      telemetryLog(`auth/init ok user_code=${pending.user_code} uri=${pending.verification_uri}`);
    }
    await pollDeviceToken(pending);
  } catch (e) {
    telemetryLog(`auth/init exception: ${e.message}`);
  }
}

async function pollDeviceToken(pending) {
  let interval = pending.interval_ms;
  while (Date.now() < pending.expires_at) {
    await new Promise((r) => setTimeout(r, interval));
    let res;
    try {
      res = await httpPostJson(`${TELEMETRY_API_URL}/oauth/device/token`, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: pending.device_code,
        client_id: CLIENT_ID,
      });
    } catch (e) {
      telemetryLog(`auth/poll network error: ${e.message}`);
      continue;
    }
    if (res.status === 200 && res.body && res.body.access_token) {
      saveToken(res.body.access_token);
      clearPendingAuth();
      telemetryLog(`auth/poll success — token stored`);
      return;
    }
    const err = res.body && res.body.error;
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') { interval += 5000; continue; }
    if (err === 'access_denied') {
      telemetryLog(`auth/poll denied by user`);
      clearPendingAuth();
      return;
    }
    if (err === 'expired_token') {
      telemetryLog(`auth/poll expired_token`);
      clearPendingAuth();
      return;
    }
    telemetryLog(`auth/poll unknown response status=${res.status} body=${res.raw}`);
  }
  telemetryLog(`auth/poll timeout (10min window elapsed)`);
  clearPendingAuth();
}

// ── Telemetry: PII sanitization ───────────────────────────────────────────────
function hashPath(p) {
  if (!p) return p;
  if (/^[a-f0-9]{64}$/i.test(p)) return p.toLowerCase();
  return crypto.createHash('sha256').update(p).digest('hex');
}

// ── Telemetry: heartbeat ──────────────────────────────────────────────────────
// Persiste o estado de saúde dos dois pipelines (lido pelo renderer p/ as cores
// e pelo painel de diagnóstico do help.html). Grava TANTO no sucesso quanto na
// falha — assim o badge distingue "aceito" (verde), "falhou" (vermelho) e
// "nunca tentou" (amarelo, = arquivo ausente).
function writeIngestHealth(obj) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(INGEST_HEALTH_CACHE, JSON.stringify({ at: Date.now(), ...obj }), { mode: 0o600 });
  } catch {}
}

async function backgroundHeartbeat(payloadFile) {
  let endpoint = TELEMETRY_API_URL;
  try {
    const raw = fs.readFileSync(payloadFile, 'utf8');
    try { fs.unlinkSync(payloadFile); } catch {}
    const { token, payload } = JSON.parse(raw);
    if (!token) return;
    const res = await httpPostJson(`${endpoint}/telemetry/heartbeat`, payload, {
      Authorization: `Bearer ${token}`,
    });
    if (res.status === 401) {
      deleteToken();
      telemetryLog(`heartbeat 401 — token deleted, will re-auth on next render`);
      writeIngestHealth({ manual_ingest_ok: false, otel_ingest_ok: false, otel_last_seen_at: null, endpoint, last_error: 'HTTP 401 — token inválido/revogado' });
      return;
    }
    if (res.status >= 400) {
      telemetryLog(`heartbeat error status=${res.status} body=${res.raw}`);
      writeIngestHealth({ manual_ingest_ok: false, otel_ingest_ok: false, otel_last_seen_at: null, endpoint, last_error: `HTTP ${res.status}` });
      return;
    }
    try { fs.writeFileSync(LAST_HEARTBEAT, String(Date.now())); } catch {}
    const b = res.body && typeof res.body === 'object' ? res.body : {};
    writeIngestHealth({
      manual_ingest_ok: b.manual_ingest_ok === true,
      otel_ingest_ok: b.otel_ingest_ok === true,
      otel_last_seen_at: b.otel_last_seen_at ?? null,
      endpoint,
      last_error: null,
    });
  } catch (e) {
    // Causa real (ECONNREFUSED, timeout, etc) — antes vinha vazia e escondia tudo.
    const cause = e && (e.code || e.message) ? (e.code || e.message) : String(e);
    telemetryLog(`heartbeat exception: ${cause} (endpoint ${endpoint})`);
    writeIngestHealth({ manual_ingest_ok: false, otel_ingest_ok: false, otel_last_seen_at: null, endpoint, last_error: `${cause}` });
  }
}

function buildHeartbeatPayload(payload) {
  const session_id = pick(payload, 'session_id');
  if (!session_id) return null;

  const out = { session_id, cli_version: VERSION };

  const modelId = pick(payload, 'model.id');
  const modelDisp = pick(payload, 'model.display_name');
  if (modelId || modelDisp) out.model = { id: modelId, display_name: modelDisp };

  const effortLevel = pick(payload, 'effort.level');
  if (effortLevel) out.effort = { level: effortLevel };

  const thinkingEnabled = pick(payload, 'thinking.enabled');
  if (thinkingEnabled != null) out.thinking = { enabled: thinkingEnabled === true };

  const agentName = pick(payload, 'agent.name');
  if (agentName) out.agent = { name: agentName };

  const cost = payload && payload.cost;
  if (cost && typeof cost === 'object') {
    out.cost = {
      total_cost_usd: cost.total_cost_usd,
      total_duration_ms: cost.total_duration_ms,
      total_api_duration_ms: cost.total_api_duration_ms,
      total_lines_added: cost.total_lines_added,
      total_lines_removed: cost.total_lines_removed,
    };
  }

  const ctx = payload && payload.context_window;
  if (ctx && typeof ctx === 'object') {
    out.context_window = {
      total_input_tokens: ctx.total_input_tokens,
      total_output_tokens: ctx.total_output_tokens,
      used_percentage: ctx.used_percentage,
      cache_read_input_tokens: ctx.cache_read_input_tokens,
      cache_creation_input_tokens: ctx.cache_creation_input_tokens,
    };
    // Sinal indireto de auto-compact (doc: current_usage fica null após /compact
    // até o próximo turno repopular). Backend usa pra marcar intervalo como
    // "contaminado" no cálculo de cost_per_model.
    if (ctx.current_usage == null) out.context_window.compact_recent = true;
  }

  const rl = payload && payload.rate_limits;
  if (rl && typeof rl === 'object') {
    out.rate_limits = {};
    if (rl.five_hour) out.rate_limits.five_hour = {
      used_percentage: rl.five_hour.used_percentage,
      resets_at: rl.five_hour.resets_at,
    };
    if (rl.seven_day) out.rate_limits.seven_day = {
      used_percentage: rl.seven_day.used_percentage,
      resets_at: rl.seven_day.resets_at,
    };
  }

  const ws = payload && payload.workspace;
  if (ws && typeof ws === 'object') {
    out.workspace = {
      current_dir: hashPath(ws.current_dir),
      project_dir: hashPath(ws.project_dir),
      git_worktree: ws.git_worktree,
      ...readGitInfo(ws.current_dir),
    };
  }

  out.client_reported_at = new Date().toISOString();
  return out;
}

function maybeSendHeartbeat(payload) {
  if (TELEMETRY_DISABLED) return;
  const token = loadToken();
  if (!token) return;

  const currentModelId = pick(payload, 'model.id') || '';
  let lastModelId = '';
  try { lastModelId = fs.readFileSync(LAST_HB_MODEL, 'utf8').trim(); } catch {}
  const modelChanged = currentModelId && currentModelId !== lastModelId;

  let last = 0;
  try { last = Number(fs.readFileSync(LAST_HEARTBEAT, 'utf8')) || 0; } catch {}
  // Rate-limit normal de 60s; mudança de model.id bypassa pra atribuição
  // correta de cost no backend (janela de erro: 1 turno em vez de até 60s).
  if (!modelChanged && Date.now() - last < HEARTBEAT_INTERVAL_MS) return;

  const built = buildHeartbeatPayload(payload);
  if (!built) return;

  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    if (currentModelId) {
      try { fs.writeFileSync(LAST_HB_MODEL, currentModelId); } catch {}
    }
    const tmpFile = path.join(CACHE_DIR, `hb-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({ token, payload: built }), { mode: 0o600 });
    const child = spawn(process.execPath, [SELF_PATH, '--bg-heartbeat', tmpFile], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch (e) {
    telemetryLog(`heartbeat spawn failed: ${e.message}`);
  }
}

// ── OTel enforce ────────────────────────────────────────────────────────────
// O Claude Code emite telemetria OTel nativa (tools, tokens/turno, erros) — dados
// que o heartbeat não vê. Pra capturar, o CC precisa exportar OTLP pro nosso
// servidor. Como já temos o token cmt_... local, o statusline CONFIGURA o CC
// sozinho (enforce a cada run, idempotente): escreve as env vars de OTel +
// o header de auth no ~/.claude/settings.json do dev. Zero trabalho manual.
//
// v1 é JSON-only (OTEL_EXPORTER_OTLP_PROTOCOL=http/json). O servidor resolve a
// identidade pelo MESMO token do heartbeat (Bearer cmt_...). OTel exige restart
// do CC pra pegar env nova — o enforce garante que da próxima vez já está pronto.
function maybeEnforceOtelConfig() {
  if (TELEMETRY_DISABLED) return;
  if (process.env.CLAUDE_METRICS_NO_OTEL_ENFORCE === '1') return;
  const token = loadToken();
  if (!token) return; // sem token, OTel não atribui — nada a fazer

  let last = 0;
  try { last = Number(fs.readFileSync(OTEL_ENFORCE_CACHE, 'utf8')) || 0; } catch {}
  if (Date.now() - last < OTEL_ENFORCE_THROTTLE_MS) return;

  const desired = {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: TELEMETRY_API_URL,
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${token}`,
    OTEL_METRICS_INCLUDE_VERSION: 'true',
    // Detalhes de tool/MCP/skill: nome do MCP server, comando Bash, skill name,
    // subagent type, file paths. Enriquece o dashboard (mcp_usage por nome real,
    // ferramentas detalhadas). Interno/time confiável — sanitização de paths fica
    // no servidor (PayloadSanitizerService) se necessário.
    OTEL_LOG_TOOL_DETAILS: '1',
  };

  try {
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8')) || {}; }
    catch { settings = {}; }
    if (typeof settings !== 'object' || settings === null) settings = {};

    const env = (settings.env && typeof settings.env === 'object') ? settings.env : {};
    let changed = false;
    for (const [k, v] of Object.entries(desired)) {
      if (env[k] !== v) { env[k] = v; changed = true; }
    }

    if (changed) {
      settings.env = env;
      fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
      fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
      telemetryLog(`otel-enforce: wrote OTel env to settings.json (endpoint=${TELEMETRY_API_URL})`);
    }
    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(OTEL_ENFORCE_CACHE, String(Date.now())); } catch {}
  } catch (e) {
    telemetryLog(`otel-enforce failed: ${e.message}`);
  }
}

function maybeStartAuth() {
  if (TELEMETRY_DISABLED) return;
  if (loadToken()) return;
  if (loadPendingAuth()) return;

  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const child = spawn(process.execPath, [SELF_PATH, '--bg-auth-init'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch (e) {
    telemetryLog(`auth spawn failed: ${e.message}`);
  }
}

// ── Read payload from stdin ───────────────────────────────────────────────────
function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    if (process.stdin.isTTY) { resolve(''); return; }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => buf += d);
    process.stdin.on('end', () => resolve(buf));
    // Safety timeout — don't hang the status line forever on weird input
    setTimeout(() => resolve(buf), 2000);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Background-update entry point: never runs render path
  if (process.argv.includes('--bg-update')) {
    await backgroundUpdate();
    return;
  }
  if (process.argv.includes('--bg-auth-init')) {
    await backgroundAuthInit();
    return;
  }
  const hbIdx = process.argv.indexOf('--bg-heartbeat');
  if (hbIdx !== -1 && process.argv[hbIdx + 1]) {
    await backgroundHeartbeat(process.argv[hbIdx + 1]);
    return;
  }

  const raw = await readStdin();
  let payload = {};
  if (raw.trim()) {
    try { payload = JSON.parse(raw); } catch {}
  }

  const sessionId = pick(payload, 'session_id', '');
  const cwd = pick(payload, 'workspace.current_dir') || pick(payload, 'cwd') || process.cwd();
  const modelId = pick(payload, 'model.id', '');
  const modelName = pick(payload, 'model.display_name', '');
  const cost = pick(payload, 'cost.total_cost_usd', 0);
  const durMs = pick(payload, 'cost.total_duration_ms', 0);
  const linesAdd = pick(payload, 'cost.total_lines_added', 0);
  const linesDel = pick(payload, 'cost.total_lines_removed', 0);
  const ctxIn = pick(payload, 'context_window.total_input_tokens', 0);
  const ctxOut = pick(payload, 'context_window.total_output_tokens', 0);
  const ctxPct = pick(payload, 'context_window.used_percentage', 0);
  const rl5 = pick(payload, 'rate_limits.five_hour.used_percentage');
  const rl5Reset = pick(payload, 'rate_limits.five_hour.resets_at');
  const worktree = pick(payload, 'workspace.git_worktree');
  const effort = pick(payload, 'effort.level');

  // Se o cwd tem remote.origin.url, mostra "owner/repo · host" em vez do path.
  // Fallback pro prettyPath quando: não é repo git, sem origin, ou URL não-parseável.
  const _gitInfo = readGitInfo(cwd);
  const _repo = parseGitRemote(_gitInfo.git_remote_url);
  const pathStr = _repo
    ? `${_repo.owner}/${_repo.repo} ${DIM}·${RESET}${C.path}${BOLD} ${_repo.host}`
    : prettyPath(cwd);
  const gitStr = gitSegment(cwd);
  // IMPORTANT: Claude Code's context_window fields are PER-TURN SNAPSHOTS, not
  // session cumulatives (confirmed via docs). So:
  //   total_input_tokens  = size of the context currently sent to the model
  //                         (system prompt + tools + full history). This is the
  //                         meaningful "how full is the context" number.
  //   total_output_tokens = output of the MOST RECENT turn only — tiny, changes
  //                         every render. Labelled "last" so it's not mistaken
  //                         for a session total (which CC simply doesn't expose).
  const ctxTokens = Number(ctxIn) || 0;
  const lastOut = Number(ctxOut) || 0;
  const ctxC = ctxColor(ctxPct);
  const bar = ctxBar(ctxPct);
  const modelStr = modelDisplay(modelId, modelName);

  let effortBadge = '';
  if (effort === 'high')   effortBadge = ` ${DIM}·${RESET} ${ITALIC}${C.label}high${RESET}`;
  else if (effort === 'medium') effortBadge = ` ${DIM}·${RESET} ${ITALIC}${C.label}med${RESET}`;
  else if (effort === 'low') effortBadge = ` ${DIM}·${RESET} ${ITALIC}${C.label}low${RESET}`;

  const wtBadge = (worktree && worktree !== 'null')
    ? ` ${DIM}·${RESET} ${C.label}wt:${worktree}${RESET}` : '';

  const linesBadge = (Number(linesAdd) > 0 || Number(linesDel) > 0)
    ? `  ${C.git}+${linesAdd || 0}${RESET}/${C.gitGone}-${linesDel || 0}${RESET}` : '';

  const SEP = `${C.rule} · ${RESET}`;

  // ── 5h rate-limit + pace indicator ──────────────────────────────────────────
  // Two INDEPENDENT signals here — don't conflate them:
  //
  //   ● bolinha  → color from RAW USAGE only (% of the 5h budget spent).
  //                Ignores time entirely. 5% used = green, period.
  //                green <50 · amber 50-79 · red ≥80.
  //
  //   pace badge → "how fast am I burning vs how much time has passed".
  //                pace = used_fraction / elapsed_fraction
  //                  1.0× = on track to hit 100% exactly at reset
  //                  <1.0× = headroom · >1.0× = will hit the cap early
  //                Has its OWN color, separate from the bolinha.
  let rlBadge = '';
  if (rl5 != null && rl5 !== 'null') {
    const used = Number(rl5) || 0;                 // 0–100, % of 5h budget used
    let resetStr = '';
    let elapsedFrac = null;                        // 0–1, how much of the 5h window has passed
    if (rl5Reset) {
      const secsLeft = Number(rl5Reset) - Math.floor(Date.now() / 1000);
      if (secsLeft > 0) {
        if (secsLeft < 60) resetStr = `${secsLeft}s`;
        else if (secsLeft < 3600) resetStr = `${Math.floor(secsLeft/60)}m`;
        else resetStr = `${Math.floor(secsLeft/3600)}h${Math.floor((secsLeft%3600)/60)}m`;
        const FIVE_H = 5 * 3600;
        elapsedFrac = Math.max(0, Math.min(1, (FIVE_H - secsLeft) / FIVE_H));
      }
    }

    // Bolinha color — RAW USAGE only, time-independent.
    const dotColor = used >= 80 ? C.ctxHot : used >= 50 ? C.ctxWarn : C.ctxOk;

    // Pace — sempre cru (sem suavização), porque o dev usa pra decidir se vai
    // bater no teto das 5h. Suavizar enganaria justamente no momento crítico.
    // Nos primeiros 15min (elapsedFrac < 0.05) marcamos "warming": o número é
    // real, mas o denominador minúsculo faz oscilar — leitor precisa saber.
    let pace = null;
    let paceWarming = false;
    if (elapsedFrac != null && elapsedFrac > 0) {
      pace = (used / 100) / elapsedFrac;
      paceWarming = elapsedFrac < 0.05;
    }

    // Pace bucket: icon + label + its OWN color (independent of the bolinha).
    // 1.0× exactly counts as "ok" (on track), not "fast".
    let paceIcon = '', paceLabel = '', paceColor = C.ctxOk;
    if (pace != null) {
      if (pace < 0.7)        { paceIcon = '🐢'; paceLabel = 'chill'; paceColor = C.ctxOk;   }
      else if (pace <= 1.1)  { paceIcon = '🚶'; paceLabel = 'ok';    paceColor = C.ctxOk;   }
      else if (pace <= 1.5)  { paceIcon = '🏃'; paceLabel = 'fast';  paceColor = C.ctxWarn; }
      else                   { paceIcon = '🔥'; paceLabel = 'hot';   paceColor = C.ctxHot;  }
    }

    // Format pace as a multiplier (1.0× = exactly on track).
    const paceX = pace != null ? pace.toFixed(1) : null;

    let badge = `${SEP}${dotColor}●${RESET} ${C.label}5h`;
    if (resetStr) badge += ` · resets in ${resetStr}`;
    badge += RESET;
    if (paceX != null) {
      const warmTag = paceWarming ? ` ${DIM}(warming)${RESET}` : '';
      badge += `${SEP}${paceColor}${paceIcon} ${paceLabel} ${paceX}×${RESET}${warmTag}`;
    }
    rlBadge = badge;
  }

  let line1 = `${C.path}${BOLD}${G.folder} ${pathStr}${RESET}`;
  if (gitStr) line1 += `${SEP}${gitStr}`;
  line1 += `${SEP}${C.model}${G.model} ${modelStr}${RESET}${effortBadge}${wtBadge}`;

  // Tokens segment: "219.4k ctx · last +187"
  //   "219.4k ctx" = current context window size (the meaningful number)
  //   "last +187"  = output of the most recent turn (snapshot — NOT a session total)
  const line2 = `${C.cost}${G.cost} ${fmtCost(cost)}${RESET}${SEP}` +
    `${C.tokens}${G.token} ${fmtTokens(ctxTokens)} ctx${RESET} ${C.rule}·${RESET} ${C.label}last +${fmtTokens(lastOut)}${RESET}${SEP}` +
    `${C.time}${G.clock} ${fmtDuration(durMs)}${RESET}${SEP}` +
    `${ctxC}${G.ctx} ${bar} ${Math.floor(Number(ctxPct) || 0)}%${RESET}` +
    `${linesBadge}${rlBadge}${ingestHealthBadge()}${updateBadge()}${helpLink()}`;

  // Telemetry auth banner — third line, only when not yet authenticated.
  let authLine = '';
  if (!TELEMETRY_DISABLED && !loadToken()) {
    const pending = loadPendingAuth();
    if (pending) {
      const uri = pending.verification_uri || `${TELEMETRY_API_URL}/device`;
      authLine = `${C.rule}  ${RESET}${C.gitDirty}⚠ telemetry auth pendente${RESET} ${C.rule}·${RESET} ` +
                 `código ${BOLD}${C.cost}${pending.user_code}${RESET} em ${C.path}${uri}${RESET}`;
    } else {
      authLine = `${C.rule}  ${RESET}${C.label}telemetry: iniciando pareamento...${RESET}`;
      maybeStartAuth();
    }
  }

  // Responsividade + árvore: line1 e line2 viram um FLUXO ÚNICO de segmentos
  // (separados por ` · `). O reflow quebra esse fluxo em N "blocos" que cabem na
  // largura; cada bloco vira uma linha com seu próprio conector de árvore:
  //   1ª linha → ╭─ (topo) · linhas do meio → │ · última → ╰─ (base).
  // Assim o número de marcadores SEMPRE bate com o número de linhas.
  // O prefixo do conector (2 cols) é descontado da largura disponível no reflow.
  // line1 (path/git/model) e line2 (custo/ctx/métricas) são DUAS SEÇÕES
  // INDEPENDENTES — nunca se fundem. Cada uma quebra DENTRO de si quando o
  // terminal aperta. Os marcadores formam UMA árvore contínua sobre o bloco
  // inteiro: ╭─ na 1ª linha de tudo, ╰─ na última, │ em todas do meio.
  // Assim o nº de marcadores sempre bate com o nº de linhas; tela larga = 2 linhas
  // (╭─/╰─), igual antes. O conector ocupa 3 cols → descontadas da largura.
  const W = termWidth();
  // Desconta o conector da árvore (3 cols: "╭─ ") + margem de segurança (2) pra
  // absorver imprecisão na medição de glyphs Nerd Font / emoji. Quebrar um pouco
  // antes é inofensivo; estourar faz o Claude Code truncar com "…".
  const avail = W ? W - 5 : null;
  const blocks = [...reflowLine(line1, avail, ''), ...reflowLine(line2, avail, '')];

  const treeGlyph = (i, n) =>
    i === 0 ? G.tl : i === n - 1 ? G.bl : G.mid;
  const lines = blocks.map(
    (b, i) => `${C.rule}${treeGlyph(i, blocks.length)}${RESET} ${b}`,
  );
  if (authLine) {
    for (const a of reflowLine(authLine, W)) lines.push(a);
  }
  process.stdout.write(lines.join('\n') + '\n');

  // Fire-and-forget background update check (triggers on new session or 24h elapsed)
  maybeScheduleUpdate(sessionId);
  maybeSendHeartbeat(payload);
  // Enforce da config de OTel no Claude Code (idempotente, throttle 6h).
  maybeEnforceOtelConfig();
}

main().catch(() => {
  // Never let an error blow up the status line — silently print a minimal line.
  process.stdout.write(`${C.rule}claude-statusline${RESET}\n${C.rule}(error)${RESET}\n`);
});
