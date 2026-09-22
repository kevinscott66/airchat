#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# build-openflux-ios.sh — собирает ядро OpenFlux в статические архивы под
# iPhone и симулятор, пакует их в OpenFlux.xcframework и кладёт в модуль
# modules/airchat-openflux/ios.
#
#   bash scripts/build-openflux-ios.sh
#   OPENFLUX_SRC=~/src/OpenFlux bash scripts/build-openflux-ios.sh
#
# Зачем отдельный скрипт — ровно та же причина, что у сборки под Android
# (scripts/build-openflux-android.sh): ядро написано на Go, тулчейна для него в
# Xcode нет, а публичного релиза у OpenFlux не существует. Качать чужой
# бинарник и пускать через него весь трафик приложения — это отменить смысл
# самого туннеля, поэтому сборка ручная и локальная, а CocoaPods только
# проверяет, что результат на месте (см. AirChatOpenFlux.podspec).
#
# Отличие от Android — формат: там .so и загрузка через System.loadLibrary,
# здесь -buildmode=c-archive и статическая линковка в приложение. Динамических
# библиотек со своим кодом App Store не любит, а статический архив просто
# становится частью бинарника.
#
# Результат в репозиторий не коммитится (.gitignore) — 30 МБ xcframework при
# каждой пересборке того же исходника.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODULE="$ROOT/modules/airchat-openflux/ios"
OUT_XCF="$MODULE/OpenFlux.xcframework"
# Заголовок с объявлениями C-API, в отличие от Android, написан руками и лежит
# в git (MODULE/OpenFluxCoreAPI.h): без него модуль не собрался бы в свежем
# клоне, где ядра ещё нет. Скрипт сверяет его с тем, что сгенерировал cgo, —
# см. check_api ниже.
API_HEADER="$MODULE/OpenFluxCoreAPI.h"

# Где лежат исходники ядра. Переопределяется переменной окружения: у ядра свой
# репозиторий, и держать его внутри AirChat незачем.
OPENFLUX_SRC="${OPENFLUX_SRC:-$HOME/programs/OpenFlux}"

# Совпадает с deployment target приложения (app.config.base.json → ios).
# В самом репозитории OpenFlux build_ios.sh ставит 17.0 — но это требование их
# демо-приложения (WKWebsiteDataStore.proxyConfigurations), а не ядра. Собирать
# архив под более высокий минимум, чем у приложения, значит получать от
# линковщика предупреждение на каждой сборке; про iOS 17 знает нативный модуль
# (перехват трафика), и знает честно — через isSupported().
MIN_IOS="${OPENFLUX_MIN_IOS:-15.1}"

if [[ ! -d "$OPENFLUX_SRC" ]]; then
  echo "Не найдены исходники OpenFlux: $OPENFLUX_SRC" >&2
  echo "Склонируй репозиторий ядра и укажи путь: OPENFLUX_SRC=/путь/к/OpenFlux bash scripts/build-openflux-ios.sh" >&2
  exit 2
fi
if [[ ! -f "$OPENFLUX_SRC/export_mobile.go" ]]; then
  echo "В $OPENFLUX_SRC нет export_mobile.go — это не дерево OpenFlux или оно старое." >&2
  echo "Нужна версия ядра с C-обвязкой (build tag mobile)." >&2
  exit 2
fi

if ! command -v go >/dev/null 2>&1; then
  echo "Не найден go. Поставь Go (brew install go) и повтори." >&2
  exit 2
fi
if ! command -v xcrun >/dev/null 2>&1 || ! command -v xcodebuild >/dev/null 2>&1; then
  echo "Не найдены инструменты Xcode (xcrun/xcodebuild)." >&2
  echo "Поставь Xcode и выбери его: sudo xcode-select -s /Applications/Xcode.app" >&2
  exit 2
fi

DEVELOPER_DIR="$(xcode-select -p)"
CLANG="$DEVELOPER_DIR/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang"
if [[ ! -x "$CLANG" ]]; then
  echo "Не найден clang: $CLANG" >&2
  echo "Скорее всего xcode-select указывает на Command Line Tools, а не на Xcode." >&2
  exit 2
fi

if [[ ! -f "$API_HEADER" ]]; then
  echo "Нет заголовка C-API: $API_HEADER" >&2
  echo "Он лежит в git рядом с модулем — похоже, дерево неполное." >&2
  exit 2
fi

echo "OpenFlux: исходники $OPENFLUX_SRC"
echo "OpenFlux: минимальная iOS $MIN_IOS"

# Собираем во временный каталог и только потом переносим: оборванная сборка не
# должна оставить в модуле обрубок, который CocoaPods примет за готовое ядро.
TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

# $1 — подкаталог сборки, $2 — имя SDK, $3 — target triple
build_slice() {
  local dir="$1" sdk="$2" triple="$3"
  local sysroot flags
  sysroot="$(xcrun --sdk "$sdk" --show-sdk-path)"
  flags="-isysroot $sysroot -target $triple"

  echo "OpenFlux: сборка $sdk ($triple)…"
  mkdir -p "$TMP_DIR/$dir"
  # -buildmode=c-archive даёт .a плюс заголовок с сигнатурами C-API.
  # -s -w выкидывают отладочные таблицы, -trimpath убирает из бинарника пути
  # машины сборки (они бы уехали в App Store вместе с приложением).
  (
    cd "$OPENFLUX_SRC"
    GOOS=ios GOARCH=arm64 CGO_ENABLED=1 \
      CC="$CLANG $flags" \
      CXX="${CLANG}++ $flags" \
      CGO_CFLAGS="$flags" \
      CGO_LDFLAGS="$flags" \
      go build -tags mobile -buildmode=c-archive -ldflags="-s -w" -trimpath \
        -o "$TMP_DIR/$dir/liboflux.a" .
  )

  if [[ ! -f "$TMP_DIR/$dir/liboflux.a" || ! -f "$TMP_DIR/$dir/liboflux.h" ]]; then
    echo "Сборка прошла, но результата нет — ожидались liboflux.a и liboflux.h в $TMP_DIR/$dir" >&2
    echo "Чаще всего это значит, что в сборку не попал export_mobile.go (тег mobile)." >&2
    exit 1
  fi

  local info
  info="$(file -b "$TMP_DIR/$dir/liboflux.a")"
  case "$info" in
    *archive*)
      ;;
    *)
      echo "Собралось не то: $info" >&2
      echo "Ожидался статический архив (ar) — проверь GOARCH и компилятор Xcode." >&2
      exit 1
      ;;
  esac

  # Проверяем то, что ломается молча и вылезает только на линковке приложения:
  # архив без экспортов OpenFlux* собирается без единой жалобы.
  local exports
  exports="$(nm -g "$TMP_DIR/$dir/liboflux.a" 2>/dev/null | grep -c ' T _OpenFlux' || true)"
  if [[ "$exports" -lt 6 ]]; then
    echo "В срезе $dir нашлось только $exports экспортов OpenFlux*, ожидалось 6." >&2
    echo "Похоже, C-обвязка ядра изменилась — сверься с export_mobile.go." >&2
    exit 1
  fi
  echo "OpenFlux: $dir — $(du -h "$TMP_DIR/$dir/liboflux.a" | cut -f1), экспортов OpenFlux*: $exports"
}

# Сверяет объявления, которые сгенерировал cgo, с нашим заголовком в git.
# Ядро живёт в своём репозитории и меняется без нас: если там поменяют
# сигнатуру, приложение молча слинкуется с несовпадающим объявлением и упадёт
# уже на устройстве. Лучше остановиться здесь.
check_api() {
  local generated="$1" line missing=0
  while IFS= read -r line; do
    # Сравниваем без пробелов: cgo и человек расставляют их по-разному, а
    # значение имеет только сама сигнатура.
    local squashed
    squashed="$(printf '%s' "$line" | tr -d '[:space:]')"
    [[ -z "$squashed" ]] && continue
    if ! tr -d '[:space:]' < "$API_HEADER" | grep -qF "$squashed"; then
      echo "В $API_HEADER нет объявления из свежей сборки ядра:" >&2
      echo "  $line" >&2
      missing=1
    fi
  done < <(grep '^extern .*OpenFlux' "$generated" || true)
  if [[ "$missing" -ne 0 ]]; then
    echo "C-API ядра разошёлся с заголовком в git — обнови $API_HEADER под новые сигнатуры." >&2
    exit 1
  fi
}

build_slice device iphoneos        "arm64-apple-ios$MIN_IOS"
build_slice sim    iphonesimulator "arm64-apple-ios$MIN_IOS-simulator"

check_api "$TMP_DIR/device/liboflux.h"

echo "OpenFlux: упаковываю xcframework…"
xcodebuild -create-xcframework \
  -library "$TMP_DIR/device/liboflux.a" \
  -library "$TMP_DIR/sim/liboflux.a" \
  -output "$TMP_DIR/OpenFlux.xcframework" >/dev/null

rm -rf "$OUT_XCF"
mkdir -p "$MODULE"
mv -f "$TMP_DIR/OpenFlux.xcframework" "$OUT_XCF"

echo "OpenFlux: готово"
echo "  $OUT_XCF ($(du -sh "$OUT_XCF" | cut -f1))"
echo
echo "Дальше — обычная сборка приложения (npx expo prebuild -p ios && pod install)."
echo "Важно: ядро должно быть на месте ДО pod install — podspec смотрит на него"
echo "в момент установки и только тогда решает, есть ли в сборке туннель."
