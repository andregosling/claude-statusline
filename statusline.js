#!/usr/bin/env node
// Two-line dashboard status line for Claude Code.
// Works on macOS, Linux, and Windows with zero external dependencies (only Node, which Claude Code already ships).
// VERSION: 2.2.0
// REPO: https://github.com/andregosling/claude-statusline

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');

// ── Config ────────────────────────────────────────────────────────────────────
const VERSION = '2.2.0';
const REPO_RAW = 'https://raw.githubusercontent.com/andregosling/claude-statusline/main';
const CACHE_DIR = path.join(os.homedir(), '.claude', 'cache', 'claude-statusline');
const LAST_CHECK = path.join(CACHE_DIR, 'last-check');
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
  folder: '',     //
  branch: '',     //
  add: '+', mod: '~', del: '−',
  ahead: '',      //
  behind: '',     //
  model: '\u{F06A9}',   // 󰚩
  cost: '',       //
  token: '',      //
  clock: '',      //
  ctx: '',        //
  rate: '',       //
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
function maybeScheduleUpdate() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    let last = 0;
    try { last = Number(fs.readFileSync(LAST_CHECK, 'utf8')) || 0; } catch {}
    if (Date.now() - last < CHECK_INTERVAL_MS) return;
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
    if (!remoteVer || remoteVer === VERSION) return;

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
  const tokTotal = (Number(ctxIn) || 0) + (Number(ctxOut) || 0);
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
  // "Pace" = how fast you're burning the 5h budget relative to clock time.
  //   pace = used_fraction / elapsed_fraction
  //   pace < 1.0  → using budget slower than time passing (room to spend)
  //   pace = 1.0  → exactly on track to hit 100% at reset
  //   pace > 1.0  → burning faster than time; you'll hit the cap early
  // The bolinha's color reflects PACE (not raw %), so green = you're chill,
  // even if you've already used 70% — as long as the window is mostly elapsed.
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

    // Pace metric — only meaningful once a little time has elapsed (avoid div-by-zero
    // spikes in the first seconds of a fresh window).
    let pace = null;
    if (elapsedFrac != null && elapsedFrac > 0.02) {
      pace = (used / 100) / elapsedFrac;
    }

    // Bucket: pick icon + label + color from pace.
    // Thresholds tuned so that "ok" covers the natural ±15% noise around even pacing.
    let icon = '', label = '', dotColor = C.ctxOk;
    if (pace == null) {
      // No timing data yet — fall back to raw used color, no pace badge.
      icon = '';
      label = '';
      dotColor = used >= 80 ? C.ctxHot : used >= 50 ? C.ctxWarn : C.ctxOk;
    } else if (pace < 0.7) {
      icon = '🐢'; label = 'chill';  dotColor = C.ctxOk;
    } else if (pace < 1.0) {
      icon = '🚶'; label = 'ok';     dotColor = C.ctxOk;
    } else if (pace < 1.3) {
      icon = '🏃'; label = 'fast';   dotColor = C.ctxWarn;
    } else {
      icon = '🔥'; label = 'hot';    dotColor = C.ctxHot;
    }

    // Format pace as a percentage (100% = exactly on track).
    const pacePct = pace != null ? Math.round(pace * 100) : null;

    let badge = `${SEP}${dotColor}●${RESET} ${C.label}5h`;
    if (resetStr) badge += ` · resets in ${resetStr}`;
    badge += RESET;
    if (pacePct != null) {
      badge += `${SEP}${dotColor}${icon} ${label} ${pacePct}%${RESET}`;
    }
    rlBadge = badge;
  }

  let line1 = `${C.rule}${G.tl}${RESET} ${C.path}${BOLD}${G.folder} ${pathStr}${RESET}`;
  if (gitStr) line1 += `${SEP}${gitStr}`;
  line1 += `${SEP}${C.model}${G.model} ${modelStr}${RESET}${effortBadge}${wtBadge}`;

  const line2 = `${C.rule}${G.bl}${RESET} ${C.cost}${G.cost} ${fmtCost(cost)}${RESET}${SEP}` +
    `${C.tokens}${G.token} ${fmtTokens(tokTotal)} tok${RESET}${SEP}` +
    `${C.time}${G.clock} ${fmtDuration(durMs)}${RESET}${SEP}` +
    `${ctxC}${G.ctx} ${bar} ${Math.floor(Number(ctxPct) || 0)}%${RESET}` +
    `${linesBadge}${rlBadge}${helpLink()}`;

  process.stdout.write(line1 + '\n' + line2 + '\n');

  // Fire-and-forget background update check
  maybeScheduleUpdate();
}

main().catch(() => {
  // Never let an error blow up the status line — silently print a minimal line.
  process.stdout.write(`${C.rule}claude-statusline${RESET}\n${C.rule}(error)${RESET}\n`);
});
