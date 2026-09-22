#!/usr/bin/env bash
# Запуск gradle-задачи в android/, которого в git нет (его пишет prebuild).
#
#   bash scripts/android-gradle.sh :app:assembleDebug -Pairchat.bundleInDebug=true
#
# Если android/ ещё не сгенерирован — делает `expo prebuild --platform android`
# и накатывает локальные правки (scripts/post-prebuild-android-patches.sh):
# без них standalone debug висит на сплэше, а release подписан отладочным
# ключом. Версия в build.gradle сверяется с app.config.base.json — иначе APK
# выходит с номером старого prebuild.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f android/gradlew ]]; then
  echo "→ android/ нет — expo prebuild --platform android"
  npx expo prebuild --platform android --no-install
  bash scripts/post-prebuild-android-patches.sh
fi

VER="$(node -p "require('./app.config.base.json').expo.version")"
CODE="$(node -p "require('./app.config.base.json').expo.android.versionCode")"
GRADLE=android/app/build.gradle
if ! grep -q "versionCode $CODE\b" "$GRADLE" || ! grep -q "versionName \"$VER\"" "$GRADLE"; then
  echo "→ build.gradle отстал от app.config.base.json — ставлю $VER ($CODE)"
  sed -i.bak -E "s/versionCode [0-9]+/versionCode $CODE/; s/versionName \"[^\"]*\"/versionName \"$VER\"/" "$GRADLE"
  rm -f "$GRADLE.bak"
fi

cd android
exec ./gradlew "$@"
