#!/usr/bin/env bash
#
# which-build.sh — single source of truth for "which worktree is the live app".
#
# Why this exists: this machine has many git worktrees of AirChat at different
# versions (4.30 side-branches, jest-stub sandboxes, the real 4.32.x project).
# Picking the wrong one and rebuilding it onto the phone silently DOWNGRADES the
# app. The only reliable ground truth is the app already installed on the device:
# its versionCode must match exactly one worktree's android/app/build.gradle.
#
# Usage:
#   scripts/which-build.sh            # print the canonical project dir, exit 0
#   scripts/which-build.sh --verbose  # also print the full worktree/version map
#
# Exit codes: 0 = exactly one match (path printed to stdout)
#             2 = no device / no match / ambiguous (diagnostic to stderr)
#
# Gate a build with it, e.g.:
#   DIR=$(scripts/which-build.sh) || { echo "ABORT: ambiguous build target"; exit 1; }
#   ( cd "$DIR" && npm run android:build:standalone-debug )
#
set -euo pipefail

PKG="${AIRCHAT_PKG:-tech.dobropalm.airchat}"
ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"
VERBOSE=0
[ "${1:-}" = "--verbose" ] && VERBOSE=1

command -v "$ADB" >/dev/null 2>&1 || { echo "ERROR: adb not found at $ADB (set \$ADB)" >&2; exit 2; }

# 1) Ground truth: what is installed on the connected device?
state=$("$ADB" get-state 2>/dev/null || true)
[ "$state" = "device" ] || { echo "ERROR: no Android device in 'device' state (adb get-state='$state')" >&2; exit 2; }

dev_vc=$("$ADB" shell dumpsys package "$PKG" 2>/dev/null | grep -m1 -oE 'versionCode=[0-9]+' | cut -d= -f2 || true)
dev_vn=$("$ADB" shell dumpsys package "$PKG" 2>/dev/null | grep -m1 -oE 'versionName=[^ ]+' | cut -d= -f2 || true)
[ -n "$dev_vc" ] || { echo "ERROR: package $PKG is not installed on the device" >&2; exit 2; }

# 2) Scan every git worktree's build.gradle and collect version-code matches.
matches=()
map=""
while read -r wt; do
  [ -n "$wt" ] || continue
  bg="$wt/android/app/build.gradle"
  [ -f "$bg" ] || continue
  vc=$(grep -E '^[[:space:]]*versionCode ' "$bg" | head -1 | tr -dc '0-9' || true)
  vn=$(grep -E '^[[:space:]]*versionName ' "$bg" | head -1 | sed 's/.*versionName *"//; s/".*//' || true)
  map+="  vc=${vc:-?} vn=${vn:-?}  <-  $wt"$'\n'
  [ "$vc" = "$dev_vc" ] && matches+=("$wt")
done < <(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}')

if [ "$VERBOSE" = 1 ]; then
  echo "DEVICE: versionCode=$dev_vc versionName=$dev_vn  pkg=$PKG" >&2
  printf '%s' "$map" >&2
fi

# 3) Verdict.
if [ "${#matches[@]}" -eq 1 ]; then
  echo "${matches[0]}"
  exit 0
elif [ "${#matches[@]}" -eq 0 ]; then
  echo "ERROR: no worktree's build.gradle matches device versionCode=$dev_vc." >&2
  echo "       The live build came from a tree not listed here, or build.gradle was bumped after install." >&2
  printf '%s' "$map" >&2
  exit 2
else
  echo "ERROR: ambiguous — ${#matches[@]} worktrees share versionCode=$dev_vc:" >&2
  printf '   %s\n' "${matches[@]}" >&2
  echo "       Bump one of them or disambiguate before building." >&2
  exit 2
fi
