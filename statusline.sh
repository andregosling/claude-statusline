#!/usr/bin/env bash
# Two-line dashboard status line for Claude Code.
# Reads a JSON payload from stdin and renders a dense, colorful summary.
# Requires: jq, a Nerd Font installed in the terminal (JetBrainsMono Nerd Font recommended).

set -u

# ── Colors (truecolor; falls back gracefully on 256-color terminals) ──────────
ESC=$'\033'
RESET="${ESC}[0m"
DIM="${ESC}[2m"
BOLD="${ESC}[1m"
ITALIC="${ESC}[3m"

# Palette — tuned for both light + dark backgrounds
C_PATH="${ESC}[38;2;125;207;255m"     # cyan-blue
C_GIT="${ESC}[38;2;195;232;141m"      # green
C_GIT_DIRTY="${ESC}[38;2;255;203;107m" # amber
C_GIT_GONE="${ESC}[38;2;240;113;120m"  # red
C_MODEL="${ESC}[38;2;199;146;234m"    # purple
C_COST="${ESC}[38;2;255;203;107m"     # amber
C_TOKENS="${ESC}[38;2;130;170;255m"   # blue
C_TIME="${ESC}[38;2;255;255;255m"     # white
C_CTX_OK="${ESC}[38;2;195;232;141m"   # green
C_CTX_WARN="${ESC}[38;2;255;203;107m" # amber
C_CTX_HOT="${ESC}[38;2;240;113;120m"  # red
C_RULE="${ESC}[38;2;90;100;120m"      # muted gray-blue
C_LABEL="${ESC}[38;2;160;170;190m"    # muted

# ── Glyphs (Nerd Font) ───────────────────────────────────────────────────────
G_FOLDER=""    # nf-cod-folder
G_BRANCH=""    # nf-dev-git_branch
G_ADD="+"
G_MOD="~"
G_DEL="−"
G_AHEAD=""     # nf-oct-arrow_up
G_BEHIND=""    # nf-oct-arrow_down
G_MODEL="󰚩"     # nf-md-robot
G_COST=""      # nf-fa-dollar
G_TOKEN=""     # nf-md-database (using a generic glyph)
G_CLOCK=""     # nf-md-timer
G_CTX=""       # nf-md-gauge
G_RATE=""      # nf-cod-flame
G_TL="╭─"
G_BL="╰─"

# ── Read payload ─────────────────────────────────────────────────────────────
PAYLOAD="$(cat)"

j() { printf '%s' "$PAYLOAD" | jq -r "$1 // empty" 2>/dev/null; }

CWD="$(j '.workspace.current_dir // .cwd')"
MODEL_NAME="$(j '.model.display_name // .model.id')"
MODEL_ID="$(j '.model.id')"
COST_USD="$(j '.cost.total_cost_usd')"
DUR_MS="$(j '.cost.total_duration_ms')"
LINES_ADD="$(j '.cost.total_lines_added')"
LINES_DEL="$(j '.cost.total_lines_removed')"
CTX_IN="$(j '.context_window.total_input_tokens')"
CTX_OUT="$(j '.context_window.total_output_tokens')"
CTX_SIZE="$(j '.context_window.context_window_size')"
CTX_PCT="$(j '.context_window.used_percentage')"
RL_5H="$(j '.rate_limits.five_hour.used_percentage')"
RL_5H_RESET="$(j '.rate_limits.five_hour.resets_at')"
WORKTREE="$(j '.workspace.git_worktree')"
OUTPUT_STYLE="$(j '.output_style.name')"
EFFORT="$(j '.effort.level')"

# ── Pretty path: ~ for home, last 3 segments otherwise ───────────────────────
pretty_path() {
  local p="$1"
  [ -z "$p" ] && { printf '?'; return; }
  case "$p" in
    "$HOME") printf '~';;
    "$HOME"/*)
      local rest="${p#$HOME/}"
      local segs; IFS='/' read -r -a segs <<< "$rest"
      local n=${#segs[@]}
      if [ "$n" -le 2 ]; then
        printf '~/%s' "$rest"
      else
        printf '~/…/%s/%s' "${segs[$((n-2))]}" "${segs[$((n-1))]}"
      fi
      ;;
    *)
      local segs; IFS='/' read -r -a segs <<< "$p"
      local n=${#segs[@]}
      if [ "$n" -le 3 ]; then printf '%s' "$p"
      else printf '/…/%s/%s' "${segs[$((n-2))]}" "${segs[$((n-1))]}"
      fi
      ;;
  esac
}

# ── Git info (branch, ahead/behind, +~−) ─────────────────────────────────────
git_segment() {
  command -v git >/dev/null 2>&1 || return 0
  ( cd "$CWD" 2>/dev/null && git rev-parse --is-inside-work-tree >/dev/null 2>&1 ) || return 0

  local branch ahead behind add mod del status_lines
  branch="$(cd "$CWD" && git symbolic-ref --quiet --short HEAD 2>/dev/null \
            || git -C "$CWD" rev-parse --short HEAD 2>/dev/null)"
  [ -z "$branch" ] && return 0

  status_lines="$(cd "$CWD" && git status --porcelain=v1 -b 2>/dev/null)"
  ahead="$(printf '%s\n' "$status_lines" | head -1 | grep -oE 'ahead [0-9]+' | awk '{print $2}')"
  behind="$(printf '%s\n' "$status_lines" | head -1 | grep -oE 'behind [0-9]+' | awk '{print $2}')"

  # Count modifications excluding the header line
  local body; body="$(printf '%s\n' "$status_lines" | tail -n +2)"
  add="$(printf '%s\n' "$body" | grep -cE '^(\?\?|A.|.A| A)' || true)"
  mod="$(printf '%s\n' "$body" | grep -cE '^(M.|.M| M|R.|.R)' || true)"
  del="$(printf '%s\n' "$body" | grep -cE '^(D.|.D| D)' || true)"

  local dirty=0
  [ "${add:-0}" -gt 0 ] && dirty=1
  [ "${mod:-0}" -gt 0 ] && dirty=1
  [ "${del:-0}" -gt 0 ] && dirty=1

  local color="$C_GIT"
  [ "$dirty" -eq 1 ] && color="$C_GIT_DIRTY"

  printf '%s%s %s' "$color" "$G_BRANCH" "$branch"
  [ -n "${ahead:-}" ] && printf ' %s%s' "$G_AHEAD" "$ahead"
  [ -n "${behind:-}" ] && printf ' %s%s' "$G_BEHIND" "$behind"
  [ "${add:-0}" -gt 0 ] && printf ' %s%s' "$G_ADD" "$add"
  [ "${mod:-0}" -gt 0 ] && printf ' %s%s' "$G_MOD" "$mod"
  [ "${del:-0}" -gt 0 ] && printf ' %s%s' "$G_DEL" "$del"
  printf '%s' "$RESET"
}

# ── Format helpers ───────────────────────────────────────────────────────────
fmt_cost() {
  local c="${1:-0}"
  [ -z "$c" ] || [ "$c" = "null" ] && c=0
  LC_ALL=C awk -v c="$c" 'BEGIN{ printf "$%.2f", c }'
}

fmt_tokens() {
  local t="${1:-0}"
  [ -z "$t" ] || [ "$t" = "null" ] && t=0
  LC_ALL=C awk -v t="$t" 'BEGIN{
    if (t >= 1000000) printf "%.1fM", t/1000000;
    else if (t >= 1000) printf "%.1fk", t/1000;
    else printf "%d", t;
  }'
}

fmt_duration() {
  local ms="${1:-0}"
  [ -z "$ms" ] && ms=0
  local s=$((ms/1000))
  if   [ "$s" -lt 60 ];    then printf '%ds' "$s"
  elif [ "$s" -lt 3600 ];  then printf '%dm%02ds' "$((s/60))" "$((s%60))"
  else printf '%dh%02dm' "$((s/3600))" "$(((s%3600)/60))"
  fi
}

ctx_color_for() {
  local pct="${1:-0}"
  pct="${pct%.*}"
  [ -z "$pct" ] && pct=0
  if   [ "$pct" -ge 80 ]; then printf '%s' "$C_CTX_HOT"
  elif [ "$pct" -ge 50 ]; then printf '%s' "$C_CTX_WARN"
  else printf '%s' "$C_CTX_OK"
  fi
}

# 10-cell unicode progress bar
ctx_bar() {
  local pct="${1:-0}"; pct="${pct%.*}"; [ -z "$pct" ] && pct=0
  [ "$pct" -lt 0 ]   && pct=0
  [ "$pct" -gt 100 ] && pct=100
  local filled=$(( pct / 10 ))
  local empty=$(( 10 - filled ))
  local bar=""
  while [ "$filled" -gt 0 ]; do bar="${bar}█"; filled=$((filled-1)); done
  while [ "$empty"  -gt 0 ]; do bar="${bar}░"; empty=$((empty-1));  done
  printf '%s' "$bar"
}

# ── Compute pieces ───────────────────────────────────────────────────────────
PATH_STR="$(pretty_path "$CWD")"
GIT_STR="$(git_segment)"
CTX_TOTAL=$(( ${CTX_IN:-0} + ${CTX_OUT:-0} ))
CTX_COLOR="$(ctx_color_for "${CTX_PCT:-0}")"
CTX_BAR="$(ctx_bar "${CTX_PCT:-0}")"

# Compact model display
MODEL_DISPLAY="${MODEL_NAME:-?}"
case "$MODEL_ID" in
  *opus*4-7*)   MODEL_DISPLAY="Opus 4.7" ;;
  *opus*4-6*)   MODEL_DISPLAY="Opus 4.6" ;;
  *sonnet*4-6*) MODEL_DISPLAY="Sonnet 4.6" ;;
  *haiku*4-5*)  MODEL_DISPLAY="Haiku 4.5" ;;
esac

EFFORT_BADGE=""
case "$EFFORT" in
  high)   EFFORT_BADGE=" ${DIM}·${RESET} ${ITALIC}${C_LABEL}high${RESET}" ;;
  medium) EFFORT_BADGE=" ${DIM}·${RESET} ${ITALIC}${C_LABEL}med${RESET}"  ;;
  low)    EFFORT_BADGE=" ${DIM}·${RESET} ${ITALIC}${C_LABEL}low${RESET}"  ;;
esac

WT_BADGE=""
if [ -n "$WORKTREE" ] && [ "$WORKTREE" != "null" ]; then
  WT_BADGE=" ${DIM}·${RESET} ${C_LABEL}wt:${WORKTREE}${RESET}"
fi

# Lines-changed badge (only when work has happened)
LINES_BADGE=""
if [ -n "$LINES_ADD" ] && [ "$LINES_ADD" != "0" ] && [ "$LINES_ADD" != "null" ]; then
  LINES_BADGE="  ${C_GIT}+${LINES_ADD}${RESET}/${C_GIT_GONE}-${LINES_DEL:-0}${RESET}"
fi

SEP="${C_RULE} · ${RESET}"

# Rate-limit badge: traffic-light dot for 5h usage + time until reset.
# No percentage shown by design — color carries the signal, countdown gives context.
RL_BADGE=""
if [ -n "$RL_5H" ] && [ "$RL_5H" != "null" ]; then
  rl5_int="${RL_5H%.*}"; rl5_int="${rl5_int:-0}"
  if   [ "$rl5_int" -ge 80 ]; then rl_color="$C_CTX_HOT"
  elif [ "$rl5_int" -ge 50 ]; then rl_color="$C_CTX_WARN"
  else                              rl_color="$C_CTX_OK"
  fi

  rl_reset_str=""
  if [ -n "$RL_5H_RESET" ] && [ "$RL_5H_RESET" != "null" ]; then
    now=$(date +%s)
    secs_left=$(( RL_5H_RESET - now ))
    if [ "$secs_left" -gt 0 ]; then
      if   [ "$secs_left" -lt 60 ];   then rl_reset_str="${secs_left}s"
      elif [ "$secs_left" -lt 3600 ]; then rl_reset_str="$((secs_left/60))m"
      else                                 rl_reset_str="$((secs_left/3600))h$(( (secs_left%3600)/60 ))m"
      fi
    fi
  fi

  if [ -n "$rl_reset_str" ]; then
    RL_BADGE="${SEP}${rl_color}●${RESET} ${C_LABEL}5h · resets in ${rl_reset_str}${RESET}"
  else
    RL_BADGE="${SEP}${rl_color}●${RESET} ${C_LABEL}5h${RESET}"
  fi
fi

# ── Render ───────────────────────────────────────────────────────────────────
LINE1="${C_RULE}${G_TL}${RESET} ${C_PATH}${BOLD}${G_FOLDER} ${PATH_STR}${RESET}"
[ -n "$GIT_STR" ] && LINE1="${LINE1}${SEP}${GIT_STR}"
LINE1="${LINE1}${SEP}${C_MODEL}${G_MODEL} ${MODEL_DISPLAY}${RESET}${EFFORT_BADGE}${WT_BADGE}"

LINE2="${C_RULE}${G_BL}${RESET} ${C_COST}${G_COST} $(fmt_cost "$COST_USD")${RESET}${SEP}${C_TOKENS}${G_TOKEN} $(fmt_tokens "$CTX_TOTAL") tok${RESET}${SEP}${C_TIME}${G_CLOCK} $(fmt_duration "$DUR_MS")${RESET}${SEP}${CTX_COLOR}${G_CTX} ${CTX_BAR} ${CTX_PCT:-0}%${RESET}${LINES_BADGE}${RL_BADGE}"

printf '%b\n' "$LINE1"
printf '%b\n' "$LINE2"
