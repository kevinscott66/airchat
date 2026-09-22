#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# build-release.sh — воспроизводимая релизная сборка AirChat (AC-05, AC-07).
#
#   bash scripts/build-release.sh                # web + android
#   bash scripts/build-release.sh web            # только веб → dist/
#   bash scripts/build-release.sh android        # APK по ABI → android/app/build/outputs/apk/release/
#   bash scripts/build-release.sh ios            # iOS .xcarchive → build/ios/ (нужен Xcode и Team ID)
#
# Перед сборкой: чистое дерево git (или ALLOW_DIRTY=1), typecheck, lint и тесты
# (SKIP_CHECKS=1 — пропустить, только осознанно). В конце пишет
# release/manifest.json: версия, commit SHA, хеши и размеры артефактов — то,
# с чем потом сверяется выложенное (health серверов тоже отдаёт commit).
#
# Android release подписывается ключом из ~/.airchat-release/keystore.properties
# (см. post-prebuild-android-patches.sh, п.8). Без него сборка остановится:
# APK с отладочной подписью выкладывать нельзя.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PLATFORMS=("$@")
[[ ${#PLATFORMS[@]} -eq 0 ]] && PLATFORMS=(web android)
for p in "${PLATFORMS[@]}"; do
  case "$p" in web|android|ios) ;; *) echo "Неизвестная платформа: $p (web|android|ios)" >&2; exit 2 ;; esac
done

if [[ -n "$(git status --porcelain)" && "${ALLOW_DIRTY:-0}" != "1" ]]; then
  echo "Дерево git грязное — релиз должен соответствовать коммиту. ALLOW_DIRTY=1, чтобы собрать всё равно." >&2
  git status --short >&2
  exit 1
fi

VER="$(node -p "require('./app.config.base.json').expo.version")"
PKG_VER="$(node -p "require('./package.json').version")"
if [[ "$VER" != "$PKG_VER" ]]; then
  echo "Версии разошлись: app.config.base.json=$VER, package.json=$PKG_VER. Используй scripts/bump-version.sh." >&2
  exit 1
fi
SHA="$(git rev-parse HEAD)"
echo "→ AirChat $VER @ ${SHA:0:12}: ${PLATFORMS[*]}"

if [[ "${SKIP_CHECKS:-0}" != "1" ]]; then
  node scripts/check-package-scripts.js
  npm run typecheck
  npm run lint
  npx jest --runInBand --silent
fi

ARTIFACTS=()

build_web() {
  echo "→ web: expo export → dist/"
  rm -rf dist
  npx expo export --platform web --output-dir dist
  node scripts/web-bundle-budget.js dist
  # Опубликованный сайт сам говорит, что он такое: сверка без угадывания по хешам.
  printf '{"app":"airchat","version":"%s","commit":"%s","builtAt":"%s"}\n' "$VER" "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > dist/release.json
  ARTIFACTS+=(dist/release.json)
  ARTIFACTS+=(dist/index.html)
  while IFS= read -r f; do ARTIFACTS+=("$f"); done < <(find dist -name '*.js' -path '*_expo/static/js/*' | sort)
}

build_android() {
  local props="$HOME/.airchat-release/keystore.properties"
  if [[ ! -f "$props" ]]; then
    echo "Нет $props — релизный APK получил бы отладочную подпись. Остановлено." >&2
    exit 1
  fi
  echo "→ android: assembleRelease (ABI split)"
  bash scripts/android-gradle.sh :app:assembleRelease -Pairchat.abiSplits=true -Pexpo.useLegacyPackaging=true
  local out=android/app/build/outputs/apk/release
  for f in "$out"/app-arm64-v8a-release.apk "$out"/app-armeabi-v7a-release.apk; do
    [[ -f "$f" ]] || { echo "Нет артефакта $f" >&2; exit 1; }
    ARTIFACTS+=("$f")
  done
  local built
  built="$(node -p "require('./$out/output-metadata.json').elements[0].versionName")"
  [[ "$built" == "$VER" ]] || { echo "APK собран как $built, а не $VER" >&2; exit 1; }
}

build_ios() {
  command -v xcodebuild >/dev/null || { echo "Нужен Xcode (xcodebuild)." >&2; exit 1; }
  echo "→ ios: prebuild + xcodebuild archive"
  [[ -d ios ]] || npx expo prebuild --platform ios
  (cd ios && pod install)
  local ws scheme
  ws="$(ls -d ios/*.xcworkspace | head -1)"
  scheme="$(basename "$ws" .xcworkspace)"
  mkdir -p build/ios
  xcodebuild -workspace "$ws" -scheme "$scheme" -configuration Release \
    -destination 'generic/platform=iOS' -archivePath "build/ios/AirChat-$VER.xcarchive" \
    -allowProvisioningUpdates archive
  ARTIFACTS+=("build/ios/AirChat-$VER.xcarchive/Info.plist")
}

for p in "${PLATFORMS[@]}"; do "build_$p"; done

mkdir -p release
node - "$VER" "$SHA" "${PLATFORMS[*]}" "${ARTIFACTS[@]}" <<'NODE'
const fs = require('fs');
const crypto = require('crypto');
const [version, commit, platforms, ...files] = process.argv.slice(2);
const manifestPath = 'release/manifest.json';
let previous = {};
try { previous = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}
const artifacts = { ...(previous.commit === commit ? previous.artifacts : {}) };
for (const file of files) {
  const buf = fs.readFileSync(file);
  artifacts[file] = { bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}
const manifest = {
  app: 'airchat',
  version,
  commit,
  builtAt: new Date().toISOString(),
  platforms: [...new Set([...(previous.commit === commit ? previous.platforms || [] : []), ...platforms.split(' ')])],
  artifacts,
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`✓ ${manifestPath}: ${Object.keys(artifacts).length} артефактов, ${version} @ ${commit.slice(0, 12)}`);
NODE
