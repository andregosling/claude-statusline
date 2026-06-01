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

  const statsColor = h?.manual_ingest_ok ? C.ctxOk : C.ctxWarn;
  const stats = helpAnchor(`${statsColor}${gStats}stats${RESET}`, 'stats');

  let otelColor;
  if (h == null) otelColor = C.ctxWarn;
  else otelColor = h.otel_ingest_ok ? C.ctxOk : C.gitGone;
  const otel = helpAnchor(`${otelColor}${gOtel}otel${RESET}`, 'otel');

  const label = helpAnchor(`${C.label}twt metrics${RESET}`, 'twt-metrics');
  return `${SEP}${label}${C.label}:${RESET} ${stats}${C.rule} · ${RESET}${otel}`;
}

// Gera o help.html completo (standalone, zero deps, estética Linear): sidebar de
// seções à esquerda + conteúdo (transcrito do HELP.md) à direita, navegável por
// #hash. Cada segmento da status line linka pra sua seção via helpAnchor().
// Idempotente: só reescreve se o conteúdo mudou. Bump HELP_VERSION ao editar.
const HELP_VERSION = 3;
function writeHelpHtml() {
  // Seções: { id (âncora), nav (label da sidebar), html (conteúdo) }.
  const sections = [
    { id: 'overview', nav: 'Visão geral', html: `
      <h2>O que é a status line</h2>
      <p>Uma barra de duas linhas no rodapé do Claude Code: a de cima é <b>contexto</b> (onde você está), a de baixo é <b>métricas</b> (o que está consumindo). <b>Cada item é clicável</b> — Cmd/Ctrl+clique abre esta página já na seção dele.</p>
      <div class="tree"><span class="g3">╭─</span>  ~/code/projeto · ⎇ main +3 ~2 · 󰚩 Opus · high
<span class="g3">╰─</span>  $0.42 ·  219k ctx · last +187 ·  18m · ███████░░░ 73%  +156/-23 · ● 5h · twt metrics: stats · otel</div>` },
    { id: 'path', nav: 'Diretório', html: `
      <h2><span class="mono">~/code/projeto</span> — diretório</h2>
      <p>Diretório de trabalho atual. Caminho profundo encurta pra <span class="mono">~/…/projeto/src</span> (só os 2 últimos segmentos).</p>` },
    { id: 'git', nav: 'Git', html: `
      <h2><span class="mono">⎇ main +3 ~2</span> — estado do git</h2>
      <ul>
        <li><b>main</b> — branch atual (ou hash curto se HEAD detached)</li>
        <li><b>↑N / ↓N</b> — commits ahead / behind do upstream</li>
        <li><b>+N</b> — arquivos novos / staged · <b>~N</b> modificados · <b>−N</b> deletados</li>
      </ul>
      <p><b>Cor:</b> <span class="dot g"></span>verde = limpo · <span class="dot y"></span>âmbar = dirty.</p>` },
    { id: 'model', nav: 'Modelo', html: `
      <h2><span class="mono">󰚩 Opus 4.7</span> — modelo</h2>
      <p>Modelo do Claude ativo na sessão (display name compacto).</p>` },
    { id: 'effort', nav: 'Effort', html: `
      <h2><span class="mono">high / med / low</span> — effort level</h2>
      <p>Effort configurado (campo <span class="mono">effortLevel</span> no settings.json). Só aparece se setado.</p>
      <h3 class="mt"><span class="mono">wt:feature-x</span> — worktree</h3>
      <p>Indicador de worktree. Só aparece dentro de um worktree do Claude Code.</p>` },
    { id: 'cost', nav: 'Custo', html: `
      <h2><span class="mono"> $0.42</span> — custo</h2>
      <p>Custo total em USD da sessão (campo <span class="mono">cost.total_cost_usd</span> do Claude Code).</p>` },
    { id: 'ctx', nav: 'Contexto / last', html: `
      <h2><span class="mono"> 219.4k ctx · last +187</span></h2>
      <p>O Claude Code <b>não fornece contadores acumulados</b> de tokens — os campos são snapshots do turno atual. O statusline mostra o que dá pra mostrar de forma honesta:</p>
      <ul>
        <li><b>219.4k ctx</b> — tamanho do contexto <b>agora</b>: system prompt + tools + CLAUDE.md + todo o histórico. É o número que importa ("quão cheio está"). Até um "oi" mostra ~8k: esse overhead é o custo fixo da sessão.</li>
        <li><b>last +187</b> — output <b>só do último turno</b>. Muda a cada resposta. Labelado "last" de propósito — não é total de sessão (que o CC não expõe).</li>
      </ul>` },
    { id: 'time', nav: 'Tempo', html: `
      <h2><span class="mono"> 18m03s</span> — tempo</h2>
      <p>Wall-clock da sessão: quanto passou desde que você abriu o Claude Code.</p>` },
    { id: 'ctxbar', nav: 'Barra de contexto', html: `
      <h2><span class="mono"> ███████░░░ 73%</span> — context window</h2>
      <p>Quanto do contexto da sessão já está cheio. Passando de 100%, o Claude faz compaction.</p>
      <p><b>Cor:</b> <span class="dot g"></span>verde &lt;50% · <span class="dot y"></span>âmbar 50–79% · <span class="dot r"></span>vermelho ≥80% (vai compactar).</p>` },
    { id: 'lines', nav: 'Linhas', html: `
      <h2><span class="mono">+156/-23</span> — linhas</h2>
      <p>Linhas de código adicionadas / removidas na sessão. Só aparece quando você editou algo.</p>` },
    { id: 'rl5h', nav: 'Rate limit 5h', html: `
      <h2><span class="mono">● 5h · resets in 2h14m</span> — a bolinha</h2>
      <p>Rate limit de 5 horas do seu plano. A bolinha e o pace são <b>duas métricas independentes</b>:</p>
      <ul>
        <li><b>Bolinha ●</b> — reflete <b>só o % bruto de uso</b>, ignorando o tempo: <span class="dot g"></span>verde &lt;50% · <span class="dot y"></span>âmbar 50–79% · <span class="dot r"></span>vermelho ≥80%.</li>
        <li><b>resets in Xh YYm</b> — tempo até a janela de 5h zerar.</li>
      </ul>
      <p>Usou só 5% do limite? Bolinha <b>verde</b>, mesmo com pace alto. Uso baixo = bolinha verde, ponto.</p>` },
    { id: 'pace', nav: 'Pace', html: `
      <h2><span class="mono">🏃 fast 1.5×</span> — o pace</h2>
      <p>O segmento mais importante: <b>"estou gastando rápido demais?"</b>. Tem cor própria, separada da bolinha.</p>
      <p class="mono dim">pace = uso_atual ÷ tempo_decorrido (ambos como fração da janela de 5h)</p>
      <table>
        <tr><td><b>1.0×</b></td><td>ritmo perfeito — bate 100% exatamente no reset</td></tr>
        <tr><td><b>&lt; 1.0×</b></td><td>tem folga (0.5× = metade do ritmo)</td></tr>
        <tr><td><b>&gt; 1.0×</b></td><td>acelerado — bate o teto antes do reset</td></tr>
      </table>
      <table class="mt">
        <tr><td><span class="dot g"></span>🐢 chill</td><td>&lt; 0.7× — folga, gasta à vontade</td></tr>
        <tr><td><span class="dot g"></span>🚶 ok</td><td>0.7–1.1× — no ritmo</td></tr>
        <tr><td><span class="dot y"></span>🏃 fast</td><td>1.1–1.5× — segura um pouco</td></tr>
        <tr><td><span class="dot r"></span>🔥 hot</td><td>&gt; 1.5× — vai bater o teto cedo</td></tr>
      </table>
      <h3 class="mt">sufixo <span class="mono">warming</span></h3>
      <p>Nos primeiros ~30min da janela, o pace aparece com <b>warming</b> apagado: o número é real mas ainda oscila (dividir por tempo quase-zero amplifica tudo). Depois estabiliza e o warming some.</p>` },
    { id: 'twt-metrics', nav: 'twt metrics', html: `
      <h2><span class="mono">twt metrics: stats · otel</span></h2>
      <p>Dois sinais de saúde da ingestão — dizem se o seu uso do Claude está chegando ao servidor de métricas. Cada um vigia um caminho diferente. <b>Cor:</b> <span class="dot g"></span>verde = chegando · <span class="dot y"></span>âmbar = desconhecido · <span class="dot r"></span>vermelho = não chega.</p>` },
    { id: 'stats', nav: '— stats', sub: true, html: `
      <h2><span class="chip stats">stats</span> heartbeat do statusline</h2>
      <p>O ingest clássico: a cada ~60s a status line manda um resumo da sessão — <b>custo, rate-limit (5h/7d), uso de contexto, linhas, repo</b>. É a fonte que o OpenTelemetry <i>não enxerga</i>.</p>
      <ul>
        <li><span class="dot g"></span><b>Verde</b> — último heartbeat aceito pelo servidor.</li>
        <li><span class="dot y"></span><b>Amarelo</b> — sem resposta recente (acabou de abrir / servidor não respondeu).</li>
      </ul>` },
    { id: 'otel', nav: '— otel', sub: true, html: `
      <h2><span class="chip otel">otel</span> OpenTelemetry do Claude Code</h2>
      <p>Telemetria <b>profunda</b> do próprio Claude Code: <b>tools, MCP e skills</b> usadas, <b>tokens e custo por turno</b>, commits, PRs e <b>erros</b>. O statusline configura tudo sozinho; o servidor confirma se recebe.</p>
      <ul>
        <li><span class="dot g"></span><b>Verde</b> — servidor recebeu eventos OTel na última hora.</li>
        <li><span class="dot y"></span><b>Amarelo</b> — estado desconhecido (sem heartbeat recente pra perguntar).</li>
        <li><span class="dot r"></span><b>Vermelho</b> — servidor <b>não</b> recebe OTel. Causa comum: <b>reinicie o Claude Code</b> (a config de OTel só ativa no restart). Persistindo, fale com o time.</li>
      </ul>` },
    { id: 'update', nav: 'Update', html: `
      <h2><span class="mono">⬆ vX.Y.Z available</span> — update</h2>
      <p>Tem versão nova publicada que ainda não baixou. Pra instalar agora:</p>
      <p class="mono dim">claude-statusline update</p>
      <p>O badge some na próxima atualização (~5s). Esconder: <span class="mono">CLAUDE_STATUSLINE_NO_UPDATE_BADGE=1</span>.</p>` },
  ];

  const nav = sections.map((s) =>
    `<a href="#${s.id}" class="navlink${s.sub ? ' sub' : ''}" data-sec="${s.id}">${s.nav}</a>`,
  ).join('\n');
  const body = sections.map((s) =>
    `<section id="${s.id}">${s.html}</section>`,
  ).join('\n');

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
  html { -webkit-font-smoothing:antialiased; scroll-behavior:smooth; }
  body { background:var(--bg); color:var(--txt); font-family:var(--sans); line-height:1.6;
    display:grid; grid-template-columns:248px 1fr; min-height:100vh; }
  /* sidebar */
  aside { position:sticky; top:0; align-self:start; height:100vh; overflow-y:auto;
    border-right:1px solid var(--line); padding:28px 18px; background:var(--panel); }
  .brand { font-family:var(--mono); font-size:12px; letter-spacing:.14em; text-transform:uppercase;
    color:var(--txt-3); margin-bottom:6px; display:flex; align-items:center; gap:8px; }
  .brand .led { width:6px; height:6px; border-radius:50%; background:var(--accent); box-shadow:0 0 10px var(--accent); }
  .brand-title { font-size:16px; font-weight:600; color:var(--txt); margin-bottom:22px; letter-spacing:-.01em; }
  nav { display:flex; flex-direction:column; gap:1px; }
  .navlink { color:var(--txt-2); text-decoration:none; font-size:13.5px; padding:7px 12px; border-radius:8px;
    transition:background .15s,color .15s; border-left:2px solid transparent; }
  .navlink:hover { background:var(--line-2); color:var(--txt); }
  .navlink.sub { padding-left:26px; font-size:13px; color:var(--txt-3); }
  .navlink.active { background:color-mix(in srgb,var(--accent) 14%,transparent); color:#fff; border-left-color:var(--accent); }
  /* conteúdo */
  main { padding:56px 56px 120px; max-width:760px; }
  section { scroll-margin-top:32px; padding:26px 0; border-bottom:1px solid var(--line-2); animation:rise .5s ease both; }
  section:first-child { padding-top:0; }
  section:last-child { border-bottom:none; }
  h2 { font-size:21px; font-weight:600; letter-spacing:-.02em; margin-bottom:12px; }
  h3 { font-size:15px; font-weight:600; color:var(--txt); }
  h3.mt, table.mt, .mt { margin-top:18px; }
  p { color:var(--txt-2); font-size:15px; margin-bottom:12px; }
  p b, li b, td b { color:var(--txt); font-weight:600; }
  p i { color:var(--txt); font-style:normal; border-bottom:1px dashed var(--txt-3); }
  ul { list-style:none; display:flex; flex-direction:column; gap:9px; margin:4px 0 12px; }
  li { color:var(--txt-2); font-size:14.5px; padding-left:2px; }
  table { border-collapse:collapse; width:100%; }
  td { padding:7px 12px 7px 0; font-size:14px; color:var(--txt-2); border-bottom:1px solid var(--line-2); vertical-align:top; }
  td:first-child { white-space:nowrap; color:var(--txt); font-weight:500; width:1%; padding-right:18px; }
  .mono { font-family:var(--mono); background:var(--panel-2); border:1px solid var(--line);
    padding:1px 7px; border-radius:6px; font-size:.92em; color:var(--txt); }
  p.mono { display:inline-block; }
  .dim { color:var(--txt-3); }
  .dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:7px; vertical-align:middle;
    box-shadow:0 0 8px currentColor; }
  .dot.g { background:var(--green); color:var(--green); } .dot.y { background:var(--amber); color:var(--amber); }
  .dot.r { background:var(--red); color:var(--red); }
  .chip { font-family:var(--mono); font-size:13px; font-weight:600; padding:3px 10px; border-radius:7px;
    margin-right:6px; border:1px solid var(--ca); background:color-mix(in srgb,var(--ca) 13%,transparent); }
  .chip.stats { --ca:var(--accent); } .chip.otel { --ca:var(--green); }
  .tree { font-family:var(--mono); font-size:12.5px; line-height:1.9; color:var(--txt-2); background:var(--panel);
    border:1px solid var(--line); border-radius:10px; padding:16px 18px; margin:14px 0; white-space:pre-wrap; }
  .tree .g3 { color:var(--txt-3); }
  @keyframes rise { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
  @media (max-width:720px) { body { grid-template-columns:1fr; } aside { position:static; height:auto; border-right:none; border-bottom:1px solid var(--line); }
    nav { flex-flow:row wrap; } main { padding:32px 22px 80px; } }
</style>
</head>
<body>
  <aside>
    <div class="brand"><span class="led"></span>claude-statusline</div>
    <div class="brand-title">Guia da status line</div>
    <nav>${nav}</nav>
  </aside>
  <main>${body}</main>
  <script>
    // Realça o link da seção visível na sidebar (scroll-spy simples).
    const links = [...document.querySelectorAll('.navlink')];
    const map = new Map(links.map(l => [l.dataset.sec, l]));
    const obs = new IntersectionObserver((es) => {
      es.forEach(e => { if (e.isIntersecting) {
        links.forEach(l => l.classList.remove('active'));
        map.get(e.target.id)?.classList.add('active');
      }});
    }, { rootMargin: '-20% 0px -70% 0px' });
    document.querySelectorAll('section').forEach(s => obs.observe(s));
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
async function backgroundHeartbeat(payloadFile) {
  try {
    const raw = fs.readFileSync(payloadFile, 'utf8');
    try { fs.unlinkSync(payloadFile); } catch {}
    const { token, payload } = JSON.parse(raw);
    if (!token) return;
    const res = await httpPostJson(`${TELEMETRY_API_URL}/telemetry/heartbeat`, payload, {
      Authorization: `Bearer ${token}`,
    });
    if (res.status === 401) {
      deleteToken();
      telemetryLog(`heartbeat 401 — token deleted, will re-auth on next render`);
      return;
    }
    if (res.status >= 400) {
      telemetryLog(`heartbeat error status=${res.status} body=${res.raw}`);
      return;
    }
    try { fs.writeFileSync(LAST_HEARTBEAT, String(Date.now())); } catch {}
    // Persiste a saúde dos dois pipelines pro renderer desenhar os indicadores.
    try {
      const b = res.body && typeof res.body === 'object' ? res.body : {};
      fs.writeFileSync(INGEST_HEALTH_CACHE, JSON.stringify({
        at: Date.now(),
        manual_ingest_ok: b.manual_ingest_ok === true,
        otel_ingest_ok: b.otel_ingest_ok === true,
        otel_last_seen_at: b.otel_last_seen_at ?? null,
      }), { mode: 0o600 });
    } catch {}
  } catch (e) {
    telemetryLog(`heartbeat exception: ${e.message}`);
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
