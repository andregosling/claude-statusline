#!/usr/bin/env bash
# claude-statusline loader
# Runs the locally-cached renderer fast, and once per day checks GitHub for updates
# in the background. Users get new versions within 24h of a push, without paying any
# network latency on the hot path.

set -u

REPO_RAW="https://raw.githubusercontent.com/andregosling/claude-statusline/main"
CACHE_DIR="${HOME}/.claude/cache/claude-statusline"
RENDERER="${HOME}/.claude/statusline.sh"
LAST_CHECK="${CACHE_DIR}/last-check"
UPDATE_LOG="${CACHE_DIR}/update.log"
CHECK_INTERVAL_SEC=86400   # 24h

mkdir -p "$CACHE_DIR" 2>/dev/null || true

# ── Hot path: stream stdin straight into the cached renderer ──────────────────
# We tee the payload so we can both render now AND have it available for the
# background update process below (which doesn't actually need it — it just lets
# us decouple cleanly).
INPUT="$(cat)"
printf '%s' "$INPUT" | bash "$RENDERER"

# ── Background update check ──────────────────────────────────────────────────
# Only do this once per CHECK_INTERVAL_SEC. Fork-and-forget — never blocks render.
needs_check() {
  [ ! -f "$LAST_CHECK" ] && return 0
  local last now
  last=$(cat "$LAST_CHECK" 2>/dev/null || echo 0)
  now=$(date +%s)
  [ $(( now - last )) -ge $CHECK_INTERVAL_SEC ]
}

if needs_check; then
  (
    # Update timestamp first so concurrent renders don't all race to download.
    date +%s > "$LAST_CHECK"

    tmp="$(mktemp -t claude-statusline.XXXXXX)" || exit 0
    if curl -sSfL --max-time 10 "$REPO_RAW/statusline.sh" -o "$tmp" 2>>"$UPDATE_LOG"; then
      # Sanity check: must be a non-empty bash script.
      if [ -s "$tmp" ] && head -1 "$tmp" | grep -q '^#!.*\(bash\|sh\)'; then
        # Only replace if content actually differs (avoids touching mtime needlessly).
        if ! cmp -s "$tmp" "$RENDERER"; then
          chmod +x "$tmp"
          mv "$tmp" "$RENDERER"
          printf '[%s] updated statusline.sh\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$UPDATE_LOG"
        else
          rm -f "$tmp"
        fi
      else
        rm -f "$tmp"
        printf '[%s] downloaded file failed sanity check\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$UPDATE_LOG"
      fi
    fi
  ) </dev/null >/dev/null 2>&1 &
  disown 2>/dev/null || true
fi
