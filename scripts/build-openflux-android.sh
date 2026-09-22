#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# build-openflux-android.sh — собирает ядро OpenFlux в нативную библиотеку для
# Android (arm64-v8a) и кладёт её в модуль modules/airchat-openflux.
#
#   bash scripts/build-openflux-android.sh
#   OPENFLUX_SRC=~/src/OpenFlux bash scripts/build-openflux-android.sh
#
# Зачем отдельный скрипт, а не задача Gradle. Ядро — это Go, и собирается оно
# тулчейном, которого в Gradle нет: нужен установленный go и NDK. Скачивать
# готовый .so, как это делает airchat-vpn для Xray, здесь нельзя — публичного
# релиза у OpenFlux нет, и ссылка на чужую сборку означала бы, что в туннель
# едет непроверённый бинарник. Поэтому сборка ручная и локальная, а Gradle
# только проверяет, что результат на месте (см. modules/airchat-openflux/android/build.gradle).
#
# Результат в репозиторий не коммитится (.gitignore) — 13 МБ бинарника при
# каждой пересборке того же исходника.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODULE="$ROOT/modules/airchat-openflux/android/src/main"
OUT_SO="$MODULE/jniLibs/arm64-v8a/libopenflux.so"
OUT_H="$MODULE/cpp/include/libopenflux.h"

# Где лежат исходники ядра. Переопределяется переменной окружения: у ядра свой
# репозиторий, и держать его внутри AirChat незачем.
OPENFLUX_SRC="${OPENFLUX_SRC:-$HOME/programs/OpenFlux}"

# API 35 — минимальный уровень, под который линкуется ядро. Ниже уровня самого
# приложения его опускать нет смысла, выше — отрежет часть устройств.
API_LEVEL="${OPENFLUX_API_LEVEL:-35}"

if [[ ! -d "$OPENFLUX_SRC" ]]; then
  echo "Не найдены исходники OpenFlux: $OPENFLUX_SRC" >&2
  echo "Склонируй репозиторий ядра и укажи путь: OPENFLUX_SRC=/путь/к/OpenFlux bash scripts/build-openflux-android.sh" >&2
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

# ── NDK ──────────────────────────────────────────────────────────────────────
# Явно заданный NDK важнее найденного: на машине их обычно несколько версий, и
# сборка ядра должна попадать в ту же, которой собирается приложение.
find_ndk() {
  if [[ -n "${ANDROID_NDK_HOME:-}" && -d "$ANDROID_NDK_HOME" ]]; then
    echo "$ANDROID_NDK_HOME"
    return 0
  fi
  local sdk="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
  local candidate
  # Свежие версии первыми, но берём первую, где реально есть нужный clang:
  # в NDK периодически выкидывают старые уровни API, и «самый новый» не значит
  # «подходящий».
  for candidate in $(ls -1d "$sdk"/ndk/* 2>/dev/null | sort -Vr); do
    if [[ -x "$candidate/toolchains/llvm/prebuilt/darwin-x86_64/bin/aarch64-linux-android${API_LEVEL}-clang" ]]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

NDK="$(find_ndk || true)"
if [[ -z "$NDK" ]]; then
  echo "Не найден Android NDK с тулчейном под API $API_LEVEL." >&2
  echo "Поставь NDK через Android Studio (SDK Manager → NDK) или укажи путь: ANDROID_NDK_HOME=/путь/к/ndk" >&2
  exit 2
fi

TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/darwin-x86_64/bin"
CC_BIN="$TOOLCHAIN/aarch64-linux-android${API_LEVEL}-clang"
CXX_BIN="$TOOLCHAIN/aarch64-linux-android${API_LEVEL}-clang++"
if [[ ! -x "$CC_BIN" ]]; then
  echo "В NDK $NDK нет компилятора $CC_BIN." >&2
  echo "Либо версия NDK не поддерживает API $API_LEVEL, либо это не NDK для macOS." >&2
  exit 2
fi

echo "OpenFlux: исходники $OPENFLUX_SRC"
echo "OpenFlux: NDK $NDK (API $API_LEVEL)"

mkdir -p "$(dirname "$OUT_SO")" "$(dirname "$OUT_H")"

# Собираем во временный каталог и только потом переносим: оборванная сборка не
# должна оставить в модуле обрубок, который Gradle примет за готовое ядро.
TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

echo "OpenFlux: сборка arm64-v8a…"
# -buildmode=c-shared даёт .so плюс заголовок с сигнатурами C-API.
# -s -w выкидывают отладочные таблицы (13 МБ вместо 30).
# -checklinkname=0 нужен зависимостям ядра, которые дёргают приватные символы
# рантайма Go: без него линковка падает на go1.23+.
# -soname задаётся руками: Go его не проставляет, а без него линковщик пишет в
# обёртку (libopenflux_jni.so) ту строку, которой библиотеку назвали при
# линковке — то есть полный путь на машине сборки. На телефоне такого пути нет,
# и загрузка падает с «library … not found».
(
  cd "$OPENFLUX_SRC"
  GOARCH=arm64 GOOS=android CGO_ENABLED=1 \
    CC="$CC_BIN" \
    CXX="$CXX_BIN" \
    go build -tags mobile -buildmode=c-shared \
      -ldflags="-s -w -checklinkname=0 -extldflags=-Wl,-soname,libopenflux.so" \
      -o "$TMP_DIR/libopenflux.so" .
)

if [[ ! -f "$TMP_DIR/libopenflux.so" || ! -f "$TMP_DIR/libopenflux.h" ]]; then
  echo "Сборка прошла, но результата нет — ожидались libopenflux.so и libopenflux.h в $TMP_DIR" >&2
  exit 1
fi

FILE_INFO="$(file -b "$TMP_DIR/libopenflux.so")"
case "$FILE_INFO" in
  *ELF*ARM\ aarch64*|*ELF*aarch64*)
    ;;
  *)
    echo "Собралось не то: $FILE_INFO" >&2
    echo "Ожидался ELF shared object для ARM aarch64 — проверь GOARCH и компилятор из NDK." >&2
    exit 1
    ;;
esac

# Проверяем именно то, что чаще всего ломается молча и вылезает только на
# устройстве при System.loadLibrary.
if [[ -x "$TOOLCHAIN/llvm-readelf" ]]; then
  if ! "$TOOLCHAIN/llvm-readelf" -d "$TMP_DIR/libopenflux.so" | grep -q 'SONAME.*libopenflux\.so'; then
    echo "У собранной библиотеки нет SONAME=libopenflux.so — см. -extldflags выше." >&2
    exit 1
  fi
fi

mv -f "$TMP_DIR/libopenflux.so" "$OUT_SO"
mv -f "$TMP_DIR/libopenflux.h" "$OUT_H"

echo "OpenFlux: готово"
echo "  $OUT_SO"
echo "  ($FILE_INFO, $(du -h "$OUT_SO" | cut -f1))"
echo "  $OUT_H"
echo
echo "Дальше — обычная сборка приложения (npm run android:build:standalone-debug)."
