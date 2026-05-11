#!/usr/bin/env bash
# claude-statusline installer (macOS / Linux)
# Usage: curl -fsSL https://raw.githubusercontent.com/andregosling/claude-statusline/main/install.sh | bash

set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/andregosling/claude-statusline/main"
CLAUDE_DIR="${HOME}/.claude"
SETTINGS="${CLAUDE_DIR}/settings.json"
RENDERER="${CLAUDE_DIR}/statusline.js"
BIN_DIR="${HOME}/.local/bin"
CLI="${BIN_DIR}/claude-statusline"

c_ok="\033[32m"; c_warn="\033[33m"; c_err="\033[31m"; c_dim="\033[2m"; c_reset="\033[0m"
ok()   { printf "${c_ok}✓${c_reset} %s\n" "$*"; }
warn() { printf "${c_warn}!${c_reset} %s\n" "$*"; }
err()  { printf "${c_err}✗${c_reset} %s\n" "$*" >&2; }
info() { printf "${c_dim}→${c_reset} %s\n" "$*"; }

command -v curl >/dev/null 2>&1 || { err "curl is required"; exit 1; }
command -v node >/dev/null 2>&1 || { err "node is required (Claude Code already ships with Node — make sure it's on PATH)"; exit 1; }
[ -d "$CLAUDE_DIR" ] || { err "$CLAUDE_DIR does not exist. Install Claude Code first."; exit 1; }

NODE_BIN="$(command -v node)"

info "downloading statusline.js"
curl -fsSL "$REPO_RAW/statusline.js" -o "$RENDERER"
chmod +x "$RENDERER"
ok "installed $RENDERER"

info "installing claude-statusline CLI"
mkdir -p "$BIN_DIR"
curl -fsSL "$REPO_RAW/bin/claude-statusline.js" -o "$CLI"
chmod +x "$CLI"
ok "installed $CLI"

# Patch settings.json with `node <renderer>` command (absolute paths everywhere — no ~).
if [ -f "$SETTINGS" ]; then
  cp "$SETTINGS" "${SETTINGS}.bak.$(date +%s)"
  info "backed up existing settings.json"
else
  echo '{}' > "$SETTINGS"
fi

# Use Node itself to safely edit JSON (no jq dep)
node - "$SETTINGS" "$NODE_BIN" "$RENDERER" <<'NODE'
const fs = require('fs');
const [_, __, settingsPath, nodeBin, renderer] = process.argv;
let s = {};
try { s = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
s.statusLine = {
  type: 'command',
  command: `"${nodeBin}" "${renderer}"`,
  padding: 1,
  refreshInterval: 5,
};
fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n');
NODE
ok "patched $SETTINGS"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    warn "$BIN_DIR is not on your PATH"
    info "add this to your shell rc:"
    info '    export PATH="$HOME/.local/bin:$PATH"'
    info "or run with full path: $CLI"
    ;;
esac

if /bin/ls "$HOME/Library/Fonts/" /Library/Fonts/ /usr/share/fonts /usr/local/share/fonts 2>/dev/null | grep -qi "nerd"; then
  ok "Nerd Font detected"
else
  warn "no Nerd Font detected — icons will render as boxes (□)"
  info "macOS:  brew install --cask font-jetbrains-mono-nerd-font"
  info "Linux:  https://www.nerdfonts.com/font-downloads"
  info "Or set CLAUDE_STATUSLINE_PLAIN=1 to use ASCII fallbacks."
fi

echo
ok "done. reload Claude Code (or wait ~5s) to see the new status line."
info "updates check automatically every 24h. Force now: claude-statusline update"
