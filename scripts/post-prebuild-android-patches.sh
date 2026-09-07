#!/usr/bin/env bash
# Re-apply local Android customizations that `expo prebuild` regenerates over.
#
# Run AFTER `npx expo prebuild --platform android`:
#   bash scripts/post-prebuild-android-patches.sh
#
# Patches applied:
#   1. android/app/build.gradle — restore the bundleInDebug toggle in react{}
#      block (gates debuggableVariants=[] so `assembleDebug -Pairchat.bundleInDebug=true`
#      packages the JS bundle into the APK; without it the standalone debug
#      build hangs on the native splash forever, waiting for Metro).
#   2. Re-resample assets/splash-icon.png into all 5 density buckets under
#      android/app/src/main/res/drawable-*/splashscreen_logo.png. The asset
#      copy expo does at prebuild time uses the source on disk, so this is
#      only needed when assets/splash-icon.png changed between prebuilds.
#   3. android/local.properties — ensure sdk.dir is set (prebuild does not
#      write this file).
#   4. assets/android/res/drawable/ic_notification.xml -> android/.../res/drawable/.
#      Small icon всех уведомлений. Каталог android/ в .gitignore, поэтому
#      исходник ресурса лежит в assets/. Без файла notifee оставляет small icon
#      пустым, и Android отклоняет КАЖДОЕ уведомление (v4.32.517), а отказ
#      выглядит как «push не работает». Отсутствие исходника — фатально.
#   5. android/build.gradle — источник com.facebook.react:react-android из
#      локального ~/.m2, если артефакт там лежит. Gradle рвёт TLS на этом
#      файле (144 МБ) с «Tag mismatch!», тогда как curl качает его целиком.
#      Репозиторий сужен через content{includeModule} — он не подменяет
#      ничего, кроме одного этого модуля.
#   6. android/gradle.properties — TLSv1.2 для JDK-клиента gradle. Та же
#      причина, что и в п.5, но проявляется на любом артефакте (groovy,
#      annotations и т.д.): «Insufficient buffer remaining for AEAD cipher
#      fragment». После правки нужен ./gradlew --stop, чтобы демон перечитал
#      системные свойства.
#   7. android/app/build.gradle — переключатель airchat.abiSplits: разбиение
#      релизного APK по ABI. Универсальный APK весит 123 МБ и не влезает в
#      лимит GitHub (100 МБ), поэтому сборка для сайта идёт с
#      -Pairchat.abiSplits=true -Pexpo.useLegacyPackaging=true.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GRADLE="$ROOT/android/app/build.gradle"

# 1. bundleInDebug toggle
if ! grep -q "airchat.bundleInDebug" "$GRADLE"; then
  echo "[patch] adding bundleInDebug toggle to $GRADLE"
  # Insert right after the autolinkLibrariesWithApp() call inside react{}
  python3 - <<PY
import re, pathlib
p = pathlib.Path("$GRADLE")
s = p.read_text()
ins = """    autolinkLibrariesWithApp()

    /**
     * Варианты из этого списка не получают вшитый JS bundle (ожидают Metro).
     * Пустой список при -Pairchat.bundleInDebug=true — вшить bundle в debug APK (standalone без USB/Metro).
     */
    def bundleInDebug = (findProperty('airchat.bundleInDebug') ?: 'false').toBoolean()
    if (bundleInDebug) {
        debuggableVariants = []
    }"""
s = s.replace("    autolinkLibrariesWithApp()", ins, 1)
p.write_text(s)
PY
else
  echo "[patch] bundleInDebug already present, skipping"
fi

# 2. splash icon resample (only if Pillow is available)
if python3 -c "import PIL" 2>/dev/null; then
  echo "[patch] resampling splash-icon.png into drawable-*/splashscreen_logo.png"
  python3 - <<PY
from PIL import Image
import os
src = Image.open("$ROOT/assets/splash-icon.png").convert("RGBA")
for bucket in ("mdpi","hdpi","xhdpi","xxhdpi","xxxhdpi"):
    path = f"$ROOT/android/app/src/main/res/drawable-{bucket}/splashscreen_logo.png"
    if not os.path.exists(path):
        continue
    w, h = Image.open(path).size
    src.resize((w, h), Image.LANCZOS).save(path, "PNG")
PY
else
  echo "[patch] python3 PIL not installed, skipping splash resample"
fi

# 3. local.properties
LOCAL_PROPS="$ROOT/android/local.properties"
if [ ! -f "$LOCAL_PROPS" ]; then
  SDK_DIR="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
  echo "sdk.dir=$SDK_DIR" > "$LOCAL_PROPS"
  echo "[patch] wrote $LOCAL_PROPS (sdk.dir=$SDK_DIR)"
fi

# 4. ic_notification drawable (small icon всех уведомлений)
ICON_SRC="$ROOT/assets/android/res/drawable/ic_notification.xml"
ICON_DST_DIR="$ROOT/android/app/src/main/res/drawable"
if [ ! -f "$ICON_SRC" ]; then
  echo "[patch] FATAL: $ICON_SRC missing." >&2
  echo "[patch] Without the small icon Android rejects every notification." >&2
  exit 1
fi
mkdir -p "$ICON_DST_DIR"
cp "$ICON_SRC" "$ICON_DST_DIR/ic_notification.xml"
echo "[patch] installed ic_notification.xml"

# 5. локальный источник для react-android (обход обрыва TLS у gradle)
ROOT_GRADLE="$ROOT/android/build.gradle"
M2="${HOME}/.m2/repository"
RN_VER="$(node -p "require('$ROOT/node_modules/react-native/package.json').version" 2>/dev/null || echo '')"
if [ -z "$RN_VER" ]; then
  echo "[patch] react-native version unknown, skipping local maven repository"
elif [ ! -f "$M2/com/facebook/react/react-android/$RN_VER/react-android-$RN_VER-release.aar" ]; then
  echo "[patch] react-android $RN_VER not cached in ~/.m2, skipping local maven repository"
elif grep -q 'react-android-local' "$ROOT_GRADLE"; then
  echo "[patch] local react-android repository already present, skipping"
else
  echo "[patch] adding local react-android repository ($RN_VER) to $ROOT_GRADLE"
  M2="$M2" ROOT_GRADLE="$ROOT_GRADLE" python3 - <<'PY5'
import os, pathlib
p = pathlib.Path(os.environ['ROOT_GRADLE'])
s = p.read_text()
old = 'allprojects {\n  repositories {\n'
new = (
    'allprojects {\n  repositories {\n'
    '    // react-android-local: gradle рвёт TLS на 144-мегабайтном aar\n'
    '    // («Tag mismatch!»), тот же файл curl качает целиком.\n'
    '    maven {\n'
    '      url = uri("%s")\n'
    "      content { includeModule('com.facebook.react', 'react-android') }\n"
    '    }\n' % os.environ['M2']
)
assert s.count(old) == 1, 'allprojects.repositories anchor not found in build.gradle'
p.write_text(s.replace(old, new, 1))
PY5
fi

# 6. TLSv1.2 для JDK-клиента gradle
GP="$ROOT/android/gradle.properties"
if grep -q 'jdk.tls.client.protocols' "$GP"; then
  echo "[patch] gradle TLS pin already present, skipping"
else
  echo "[patch] pinning gradle JDK TLS to 1.2 in $GP"
  cat >> "$GP" <<'PROPS'

# TLSv1.3 на этой сети рвётся у gradle («Tag mismatch!», «Insufficient buffer
# remaining for AEAD cipher fragment»); curl тот же файл качает целиком.
systemProp.jdk.tls.client.protocols=TLSv1.2
systemProp.https.protocols=TLSv1.2
PROPS
fi

# 7. разбиение релизного APK по ABI (выключено по умолчанию)
if grep -q "airchat.abiSplits" "$GRADLE"; then
  echo "[patch] abiSplits toggle already present, skipping"
else
  echo "[patch] adding abiSplits toggle to $GRADLE"
  GRADLE="$GRADLE" python3 - <<'PY7'
import os, pathlib
p = pathlib.Path(os.environ['GRADLE'])
s = p.read_text()
old = '    packagingOptions {\n'
new = """    /**
     * Разбиение релизного APK по ABI. Универсальный APK весит 123 МБ — больше
     * лимита GitHub в 100 МБ, из-за чего его нельзя выложить на сайт. Сборку
     * для выкладки собираем с -Pairchat.abiSplits=true -Pexpo.useLegacyPackaging=true.
     * По умолчанию выключено: обычная сборка остаётся универсальной.
     */
    splits {
        abi {
            enable ((findProperty('airchat.abiSplits') ?: 'false').toBoolean())
            reset()
            include 'arm64-v8a', 'armeabi-v7a'
            universalApk false
        }
    }
""" + old
assert s.count(old) == 1, 'packagingOptions anchor not found in app/build.gradle'
p.write_text(s.replace(old, new, 1))
PY7
fi

echo "[patch] done"
