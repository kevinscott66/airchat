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

echo "[patch] done"
