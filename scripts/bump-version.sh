#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# bump-version.sh  —  единственный правильный способ обновить версию AirChat
#
# Использование:
#   ./scripts/bump-version.sh 4.32.0 165
#
# Обновляет ВСЕ 4 места синхронно:
#   1. worktree/package.json
#   2. worktree/app.json          (version + android.versionCode)
#   3. airchat-v430/app.json      (Expo CLI читает отсюда)
#   4. android/app/build.gradle   (versionCode + versionName для APK)
#
# НЕ ТРОГАТЬ вручную — использовать только этот скрипт.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

NEW_VER="${1:?Укажи версию: ./scripts/bump-version.sh 4.32.0 165}"
NEW_CODE="${2:?Укажи versionCode: ./scripts/bump-version.sh 4.32.0 165}"

WORKTREE="$(cd "$(dirname "$0")/.." && pwd)"
MAIN_DIR="~/airchat-v430"
GRADLE="$MAIN_DIR/android/app/build.gradle"

echo "→ Обновляю версию: $NEW_VER (versionCode $NEW_CODE)"

# 1. worktree/package.json
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$NEW_VER\"/" "$WORKTREE/package.json"

# 2. worktree/app.json
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$NEW_VER\"/" "$WORKTREE/app.json"
sed -i '' "s/\"versionCode\": [0-9]*/\"versionCode\": $NEW_CODE/" "$WORKTREE/app.json"

# 3. main app.json (Expo CLI)
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$NEW_VER\"/" "$MAIN_DIR/app.json"
sed -i '' "s/\"versionCode\": [0-9]*/\"versionCode\": $NEW_CODE/" "$MAIN_DIR/app.json"

# 4. build.gradle
sed -i '' "s/versionCode [0-9]*/versionCode $NEW_CODE/" "$GRADLE"
sed -i '' "s/versionName \"[^\"]*\"/versionName \"$NEW_VER\"/" "$GRADLE"

echo "✓ package.json:  $(grep '"version"' "$WORKTREE/package.json" | head -1 | xargs)"
echo "✓ app.json:      $(grep '"version"' "$WORKTREE/app.json" | head -1 | xargs)"
echo "✓ build.gradle:  $(grep 'versionName\|versionCode' "$GRADLE" | tr '\n' ' ' | xargs)"
echo ""
echo "Следующий шаг — пересборка с --rerun-tasks:"
echo "  cd $MAIN_DIR/android && ./gradlew assembleDebug -Pairchat.bundleInDebug=true -Pairchat.worktreeRoot=$WORKTREE --rerun-tasks"
