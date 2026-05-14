#!/usr/bin/env node
// Two-line dashboard status line for Claude Code.
// Works on macOS, Linux, and Windows with zero external dependencies (only Node, which Claude Code already ships).
// VERSION: 2.6.0
// REPO: https://github.com/andregosling/claude-statusline

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');

// ── Config ────────────────────────────────────────────────────────────────────
const VERSION = '2.6.0';
const REPO_RAW = 'https://raw.githubusercontent.com/andregosling/claude-statusline/main';
const CACHE_DIR = path.join(os.homedir(), '.claude', 'cache', 'claude-statusline');
const LAST_CHECK = path.join(CACHE_DIR, 'last-check');
const LAST_SESSION = path.join(CACHE_DIR, 'last-session');
const REMOTE_VERSION_CACHE = path.join(CACHE_DIR, 'remote-version');
const UPDATE_LOG = path.join(CACHE_DIR, 'update.log');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const SELF_PATH = __filename;

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
  clock: 't:', ctx: 'ctx', rate: '*', tl: '╭─', bl: '╰─',
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
  tl: '╭─', bl: '╰─',
};

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
function helpLink() {
  if (process.env.CLAUDE_STATUSLINE_NO_HELP === '1') return '';
  const url = `https://github.com/andregosling/claude-statusline/blob/main/HELP.md`;
  const BEL = '\x07';
  // OSC 8 ; ; URL BEL  TEXT  OSC 8 ; ; BEL
  const open  = `${ESC}]8;;${url}${BEL}`;
  const close = `${ESC}]8;;${BEL}`;
  const SEP = `${C.rule} · ${RESET}`;
  return `${SEP}${C.label}${open}(?)${close}${RESET}`;
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

  const pathStr = prettyPath(cwd);
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

    // Pace — only meaningful once enough of the window has elapsed. In the first
    // ~10% (~30min) the ratio is pure noise (tiny denominator), so we hide it.
    let pace = null;
    if (elapsedFrac != null && elapsedFrac >= 0.10) {
      pace = (used / 100) / elapsedFrac;
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
      badge += `${SEP}${paceColor}${paceIcon} ${paceLabel} ${paceX}×${RESET}`;
    }
    rlBadge = badge;
  }

  let line1 = `${C.rule}${G.tl}${RESET} ${C.path}${BOLD}${G.folder} ${pathStr}${RESET}`;
  if (gitStr) line1 += `${SEP}${gitStr}`;
  line1 += `${SEP}${C.model}${G.model} ${modelStr}${RESET}${effortBadge}${wtBadge}`;

  // Tokens segment: "219.4k ctx · last +187"
  //   "219.4k ctx" = current context window size (the meaningful number)
  //   "last +187"  = output of the most recent turn (snapshot — NOT a session total)
  const line2 = `${C.rule}${G.bl}${RESET} ${C.cost}${G.cost} ${fmtCost(cost)}${RESET}${SEP}` +
    `${C.tokens}${G.token} ${fmtTokens(ctxTokens)} ctx${RESET} ${C.rule}·${RESET} ${C.label}last +${fmtTokens(lastOut)}${RESET}${SEP}` +
    `${C.time}${G.clock} ${fmtDuration(durMs)}${RESET}${SEP}` +
    `${ctxC}${G.ctx} ${bar} ${Math.floor(Number(ctxPct) || 0)}%${RESET}` +
    `${linesBadge}${rlBadge}${updateBadge()}${helpLink()}`;

  process.stdout.write(line1 + '\n' + line2 + '\n');

  // Fire-and-forget background update check (triggers on new session or 24h elapsed)
  maybeScheduleUpdate(sessionId);
}

main().catch(() => {
  // Never let an error blow up the status line — silently print a minimal line.
  process.stdout.write(`${C.rule}claude-statusline${RESET}\n${C.rule}(error)${RESET}\n`);
});
