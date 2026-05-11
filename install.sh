#!/usr/bin/env bash
# claude-statusline installer
# Usage: curl -fsSL https://raw.githubusercontent.com/andregosling/claude-statusline/main/install.sh | bash

set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/andregosling/claude-statusline/main"
CLAUDE_DIR="${HOME}/.claude"
SETTINGS="${CLAUDE_DIR}/settings.json"
RENDERER="${CLAUDE_DIR}/statusline.sh"
LOADER="${CLAUDE_DIR}/statusline-loader.sh"

c_ok="\033[32m"; c_warn="\033[33m"; c_err="\033[31m"; c_dim="\033[2m"; c_reset="\033[0m"
ok()   { printf "${c_ok}✓${c_reset} %s\n" "$*"; }
warn() { printf "${c_warn}!${c_reset} %s\n" "$*"; }
err()  { printf "${c_err}✗${c_reset} %s\n" "$*" >&2; }
info() { printf "${c_dim}→${c_reset} %s\n" "$*"; }

# ── Pre-flight ───────────────────────────────────────────────────────────────
command -v curl >/dev/null 2>&1 || { err "curl is required"; exit 1; }
command -v jq   >/dev/null 2>&1 || { err "jq is required (brew install jq)";   exit 1; }
command -v git  >/dev/null 2>&1 || warn "git not found — git segment will stay empty"

[ -d "$CLAUDE_DIR" ] || { err "$CLAUDE_DIR does not exist. Install Claude Code first."; exit 1; }

# ── Download renderer + loader ───────────────────────────────────────────────
info "downloading statusline.sh"
curl -fsSL "$REPO_RAW/statusline.sh" -o "$RENDERER"
chmod +x "$RENDERER"
ok "installed $RENDERER"

info "downloading statusline-loader.sh"
curl -fsSL "$REPO_RAW/statusline-loader.sh" -o "$LOADER"
chmod +x "$LOADER"
ok "installed $LOADER"

# ── Patch settings.json ──────────────────────────────────────────────────────
# Add (or replace) the statusLine key, preserving everything else.
if [ -f "$SETTINGS" ]; then
  cp "$SETTINGS" "${SETTINGS}.bak.$(date +%s)"
  info "backed up existing settings.json"
else
  echo '{}' > "$SETTINGS"
fi

tmp="$(mktemp)"
jq --arg cmd "$LOADER" '
  .statusLine = {
    "type": "command",
    "command": $cmd,
    "padding": 1,
    "refreshInterval": 5
  }
' "$SETTINGS" > "$tmp"
mv "$tmp" "$SETTINGS"
ok "patched $SETTINGS"

# ── Font check (best-effort) ─────────────────────────────────────────────────
if /bin/ls "$HOME/Library/Fonts/" /Library/Fonts/ 2>/dev/null | grep -qi "nerd"; then
  ok "Nerd Font detected"
else
  warn "no Nerd Font detected — icons will render as boxes (□)"
  info "macOS:   brew install --cask font-jetbrains-mono-nerd-font"
  info "Linux:   https://www.nerdfonts.com/font-downloads"
  info "After installing, set your terminal font to 'JetBrainsMono Nerd Font'."
fi

echo
ok "done. reload Claude Code (or wait ~5s) to see the new status line."
info "updates are checked automatically every 24h from the GitHub repo."
