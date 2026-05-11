#!/usr/bin/env node
// claude-statusline CLI — works on macOS, Linux, Windows.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const REPO_RAW = 'https://raw.githubusercontent.com/andregosling/claude-statusline/main';
const REPO_URL = 'https://github.com/andregosling/claude-statusline';
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const RENDERER = path.join(CLAUDE_DIR, 'statusline.js');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const CACHE_DIR = path.join(CLAUDE_DIR, 'cache', 'claude-statusline');
const LAST_CHECK = path.join(CACHE_DIR, 'last-check');
const UPDATE_LOG = path.join(CACHE_DIR, 'update.log');

const ESC = '\x1b';
const r = `${ESC}[0m`, b = `${ESC}[1m`, d = `${ESC}[2m`;
const g = `${ESC}[32m`, y = `${ESC}[33m`, R = `${ESC}[31m`;
const ok   = (m) => console.log(`${g}✓${r} ${m}`);
const warn = (m) => console.log(`${y}!${r} ${m}`);
const err  = (m) => console.error(`${R}✗${r} ${m}`);
const info = (m) => console.log(`${d}→${r} ${m}`);

function localVersion() {
  try {
    const src = fs.readFileSync(RENDERER, 'utf8');
    const m = src.match(/^\/\/ VERSION:\s*([\w.\-]+)/m);
    return m ? m[1] : 'unknown';
  } catch { return 'missing'; }
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
      res.on('data', (c) => buf += c);
      res.on('end', () => resolve(buf));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

async function remoteVersion() {
  try {
    const text = await fetchText(`${REPO_RAW}/statusline.js`);
    const m = text.match(/^\/\/ VERSION:\s*([\w.\-]+)/m);
    return m ? m[1] : null;
  } catch { return null; }
}

function usage() {
  console.log(`${b}claude-statusline${r} — manage your Claude Code status line\n`);
  console.log(`${b}USAGE${r}`);
  console.log(`  claude-statusline <command>\n`);
  console.log(`${b}COMMANDS${r}`);
  console.log(`  update      Force-download the latest statusline.js from GitHub now`);
  console.log(`  status      Show installed files, last update check, and current version`);
  console.log(`  version     Print the version of the local statusline.js`);
  console.log(`  uninstall   Remove statusline files and unpatch settings.json`);
  console.log(`  help        Show this message\n`);
  console.log(`${b}REPO${r}`);
  console.log(`  ${REPO_URL}`);
}

async function cmdUpdate() {
  if (!fs.existsSync(RENDERER)) {
    err(`renderer not found at ${RENDERER} — run the installer first`);
    process.exit(1);
  }
  info(`fetching latest statusline.js from ${REPO_URL}`);
  let remote;
  try { remote = await fetchText(`${REPO_RAW}/statusline.js`); }
  catch (e) { err(`download failed: ${e.message}`); process.exit(1); }

  if (!remote.startsWith('#!')) { err('downloaded file failed sanity check'); process.exit(1); }

  const current = fs.existsSync(RENDERER) ? fs.readFileSync(RENDERER, 'utf8') : '';
  if (current === remote) {
    ok(`already on the latest version (${localVersion()})`);
    return;
  }
  fs.writeFileSync(RENDERER, remote, { mode: 0o755 });
  try { fs.chmodSync(RENDERER, 0o755); } catch {}
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(LAST_CHECK, String(Date.now()));
  fs.appendFileSync(UPDATE_LOG, `[${new Date().toISOString()}] manual update via CLI\n`);
  ok(`updated to version ${localVersion()}`);
}

async function cmdStatus() {
  console.log(`${b}claude-statusline${r}\n`);
  console.log(`  renderer:  ${fs.existsSync(RENDERER) ? `${RENDERER} ${d}(v${localVersion()})${r}` : `${R}not installed${r}`}`);
  console.log(`  cli:       ${process.argv[1]}`);

  let settingsOk = false;
  if (fs.existsSync(SETTINGS)) {
    try {
      const s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
      if (s.statusLine) {
        settingsOk = true;
        console.log(`  settings:  configured ${d}(command: ${s.statusLine.command})${r}`);
      }
    } catch {}
  }
  if (!settingsOk) console.log(`  settings:  ${y}not configured in ${SETTINGS}${r}`);

  console.log('');
  if (fs.existsSync(LAST_CHECK)) {
    const ts = Number(fs.readFileSync(LAST_CHECK, 'utf8')) || 0;
    const ageS = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    let s;
    if (ageS < 60) s = `${ageS}s ago`;
    else if (ageS < 3600) s = `${Math.floor(ageS/60)}m ago`;
    else s = `${Math.floor(ageS/3600)}h${Math.floor((ageS%3600)/60).toString().padStart(2,'0')}m ago`;
    console.log(`  last update check:  ${s}`);
  } else {
    console.log(`  last update check:  ${d}never${r}`);
  }
  console.log(`  local version:      ${b}${localVersion()}${r}`);
  const rv = await remoteVersion();
  if (!rv) {
    console.log(`  latest on GitHub:   ${d}(network error)${r}`);
  } else {
    let line = `  latest on GitHub:   ${b}${rv}${r}`;
    if (rv !== localVersion() && localVersion() !== 'unknown') {
      line += `  ${y}← update available (run: claude-statusline update)${r}`;
    }
    console.log(line);
  }
}

async function cmdUninstall() {
  console.log(`${y}!${r} This will remove:`);
  console.log(`    ${RENDERER}`);
  console.log(`    ${CACHE_DIR}`);
  console.log(`    ${process.argv[1]}  ${d}(this CLI itself)${r}`);
  console.log(`  And remove the statusLine section from ${SETTINGS}`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise((res) => rl.question('\nContinue? [y/N] ', (a) => { rl.close(); res(a); }));
  if (!/^y(es)?$/i.test(ans.trim())) { info('cancelled'); return; }

  try { fs.rmSync(RENDERER, { force: true }); } catch {}
  try { fs.rmSync(CACHE_DIR, { recursive: true, force: true }); } catch {}
  ok('removed scripts and cache');

  if (fs.existsSync(SETTINGS)) {
    try {
      const s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
      fs.copyFileSync(SETTINGS, `${SETTINGS}.bak.${Date.now()}`);
      delete s.statusLine;
      fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n');
      ok(`unpatched ${SETTINGS} (backup saved)`);
    } catch (e) { warn(`could not patch settings.json: ${e.message}`); }
  }

  try { fs.rmSync(process.argv[1], { force: true }); ok(`removed CLI: ${process.argv[1]}`); } catch {}
  console.log('\nReload Claude Code to fully clear the status line.');
}

const cmd = (process.argv[2] || 'help').toLowerCase();
(async () => {
  switch (cmd) {
    case 'update': await cmdUpdate(); break;
    case 'status': await cmdStatus(); break;
    case 'version': case '-v': case '--version': console.log(localVersion()); break;
    case 'uninstall': await cmdUninstall(); break;
    case 'help': case '-h': case '--help': usage(); break;
    default: err(`unknown command: ${cmd}`); console.log(); usage(); process.exit(2);
  }
})().catch((e) => { err(e.message); process.exit(1); });
