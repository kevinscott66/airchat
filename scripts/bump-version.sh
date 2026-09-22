#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# bump-version.sh — единственный правильный способ обновить версию AirChat.
#
#   bash scripts/bump-version.sh 4.32.721          # versionCode = последнее число
#   bash scripts/bump-version.sh 4.32.721 721      # явно
#
# Источник правды — app.config.base.json (version, android.versionCode,
# ios.buildNumber) и package.json/package-lock.json. Каталог android/ в git не
# лежит (его пишет `expo prebuild`), поэтому build.gradle правится, только если
# он есть: иначе релизный APK выходил с versionName старого prebuild (4.32.671
# при коде 4.32.720 — так было с APK от 9 сентября).
#
# До v4.32.721 скрипт писал в несуществующий `~/airchat-v430` (тильда в кавычках
# не раскрывается) и падал на первом же sed.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

NEW_VER="${1:?Укажи версию: bash scripts/bump-version.sh 4.32.721 [versionCode]}"
[[ "$NEW_VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Версия должна быть вида X.Y.Z: $NEW_VER" >&2; exit 2; }
NEW_CODE="${2:-${NEW_VER##*.}}"
[[ "$NEW_CODE" =~ ^[0-9]+$ ]] || { echo "versionCode должен быть числом: $NEW_CODE" >&2; exit 2; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "→ Версия $NEW_VER (versionCode/buildNumber $NEW_CODE)"

node - "$NEW_VER" "$NEW_CODE" <<'NODE'
const fs = require('fs');
const [ver, code] = process.argv.slice(2);
const write = (file, obj) => fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');

const cfg = JSON.parse(fs.readFileSync('app.config.base.json', 'utf8'));
cfg.expo.version = ver;
cfg.expo.android = { ...cfg.expo.android, versionCode: Number(code) };
cfg.expo.ios = { ...cfg.expo.ios, buildNumber: String(code) };
write('app.config.base.json', cfg);

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = ver;
write('package.json', pkg);

const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
lock.version = ver;
if (lock.packages && lock.packages['']) lock.packages[''].version = ver;
write('package-lock.json', lock);
NODE

GRADLE="$ROOT/android/app/build.gradle"
if [[ -f "$GRADLE" ]]; then
  sed -i.bak -E "s/versionCode [0-9]+/versionCode $NEW_CODE/; s/versionName \"[^\"]*\"/versionName \"$NEW_VER\"/" "$GRADLE"
  rm -f "$GRADLE.bak"
  echo "✓ build.gradle:  $(grep -E 'versionCode|versionName' "$GRADLE" | tr -s ' ' | tr '\n' ' ')"
else
  echo "• android/ нет (prebuild ещё не делали) — build.gradle получит версию при prebuild"
fi
echo "✓ package.json:  $(node -p "require('./package.json').version")"
echo "✓ app config:    $(node -p "const e=require('./app.config.base.json').expo; e.version+' / '+e.android.versionCode+' / '+e.ios.buildNumber")"
