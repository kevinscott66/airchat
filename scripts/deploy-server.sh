#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy-server.sh — выкладка signaling / cloud-vault на production VPS (AC-07).
#
#   bash scripts/deploy-server.sh signaling            # выложить
#   bash scripts/deploy-server.sh cloud-vault
#   bash scripts/deploy-server.sh signaling --dry-run  # показать diff и выйти
#   bash scripts/deploy-server.sh signaling --rollback # вернуть предыдущий релиз
#
# Production — systemd на vps78 (ssh-алиас, ubuntu@78.17.30.171), за nginx.
# fly.toml в каталогах серверов — запасной вариант, НЕ production; до v4.32.721
# `npm run deploy:signaling` вызывал flyctl и «успешно» выкладывал не туда.
#
# Порядок: тесты сервера локально → архив только рабочих файлов (без тестов)
# + release.json (версия, commit) → /opt/<svc>.new на сервере → npm ci
# --omit=dev → текущий каталог уходит в /opt/<svc>.prev-<ts> → подмена →
# restart → /health должен ответить ok и назвать этот commit. Не ответил —
# автоматический откат на prev и ненулевой выход.
#
# Серверный релиз выкладывается РАНЬШЕ клиентов: протокол обратно совместим.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SVC="${1:?Укажи сервис: signaling | cloud-vault}"
MODE="${2:-deploy}"
HOST_ALIAS="${DEPLOY_HOST:-vps78}"

case "$SVC" in
  signaling)
    SRC=signaling-server
    DEST=/opt/airchat-signaling
    UNIT=airchat-signaling
    PORT=3001
    FILES=(index.js push.js wire.js tokenStore.js webpush.js vapid-keys.js package.json package-lock.json)
    ;;
  cloud-vault)
    SRC=server/cloud-vault
    DEST=/opt/airchat-cloud-vault
    UNIT=airchat-cloud-vault
    PORT=3010
    FILES=(index.js sync-db.js reserved-usernames.js official-badge.js geoip.js seed-binding.js package.json package-lock.json tools)
    ;;
  *) echo "Неизвестный сервис: $SVC" >&2; exit 2 ;;
esac

# Одно SSH-соединение на весь прогон: сервер ограничивает частоту подключений
# к 22-му порту, и десяток отдельных ssh подряд упирается в блокировку.
CTL_DIR="$(mktemp -d /tmp/acd.XXXXXX)"  # короткий путь: у unix-сокета лимит 104 байта
SSH_OPTS=(-o ConnectTimeout=15 -o ControlMaster=auto -o "ControlPath=$CTL_DIR/%C" -o ControlPersist=120)
cleanup() { ssh "${SSH_OPTS[@]}" -O exit "$HOST_ALIAS" 2>/dev/null || true; rm -rf "$CTL_DIR" "${STAGE:-}"; }
trap cleanup EXIT
ssh_run() { ssh "${SSH_OPTS[@]}" "$HOST_ALIAS" "$@"; }

health() {
  ssh_run "curl -fsS --max-time 5 http://127.0.0.1:$PORT/health" 2>/dev/null || true
}

if [[ "$MODE" == "--rollback" ]]; then
  PREV="$(ssh_run "ls -1d ${DEST}.prev-* 2>/dev/null | sort | tail -1")"
  [[ -n "$PREV" ]] || { echo "Нет предыдущего релиза ${DEST}.prev-*" >&2; exit 1; }
  echo "→ откат $SVC на $PREV"
  ssh_run "set -e; sudo rm -rf ${DEST}.failed; sudo mv $DEST ${DEST}.failed; sudo mv $PREV $DEST; sudo systemctl restart $UNIT; sleep 2; systemctl is-active $UNIT"
  echo "health: $(health)"
  exit 0
fi

if [[ -n "$(git status --porcelain -- "$SRC")" && "${ALLOW_DIRTY:-0}" != "1" ]]; then
  echo "В $SRC есть незакоммиченные изменения — на сервер должно ехать то, что в git. ALLOW_DIRTY=1, чтобы выложить всё равно." >&2
  exit 1
fi

VER="$(node -p "require('./package.json').version")"
SHA="$(git rev-parse HEAD)"
SHORT="${SHA:0:12}"

echo "→ тесты $SRC"
(cd "$SRC" && { [[ -d node_modules ]] || npm ci --silent; } && npm test --silent >/dev/null) || { echo "Тесты $SRC не прошли — выкладка остановлена." >&2; exit 1; }

STAGE="$(mktemp -d)"
mkdir -p "$STAGE/pkg"
for f in "${FILES[@]}"; do cp -R "$SRC/$f" "$STAGE/pkg/"; done
printf '{"version":"%s","commit":"%s","builtAt":"%s"}\n' "$VER" "$SHORT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STAGE/pkg/release.json"
tar -C "$STAGE/pkg" -czf "$STAGE/release.tgz" .

echo "→ сравнение с $HOST_ALIAS:$DEST"
ssh_run true || { echo "Нет SSH-доступа к $HOST_ALIAS — выкладка остановлена." >&2; exit 1; }
REMOTE_HASHES="$(ssh_run "cd $DEST 2>/dev/null && sha256sum ${FILES[*]} 2>/dev/null" || true)"
for f in "${FILES[@]}"; do
  [[ -f "$SRC/$f" ]] || continue
  local_hash="$(shasum -a 256 "$SRC/$f" | cut -d' ' -f1)"
  remote_hash="$(awk -v f="$f" '$2==f {print $1}' <<<"$REMOTE_HASHES")"
  [[ "$local_hash" == "$remote_hash" ]] && echo "   = $f" || echo "   ≠ $f"
done
echo "   сейчас: $(health)"

if [[ "$MODE" == "--dry-run" ]]; then
  echo "dry-run: ничего не выложено."
  exit 0
fi

TS="$(date -u +%Y%m%d-%H%M%S)"
echo "→ выкладка $SVC $VER @ $SHORT"
scp -q "${SSH_OPTS[@]}" "$STAGE/release.tgz" "$HOST_ALIAS:/tmp/airchat-$SVC-$TS.tgz"
ssh_run "set -euo pipefail
  sudo rm -rf ${DEST}.new && sudo mkdir -p ${DEST}.new
  sudo tar -C ${DEST}.new -xzf /tmp/airchat-$SVC-$TS.tgz && rm -f /tmp/airchat-$SVC-$TS.tgz
  cd ${DEST}.new && sudo npm ci --omit=dev --no-audit --no-fund --silent
  sudo chown -R root:root ${DEST}.new
  sudo mv $DEST ${DEST}.prev-$TS
  sudo mv ${DEST}.new $DEST
  sudo systemctl restart $UNIT
  # Хранить три прошлых релиза, не больше.
  ls -1d ${DEST}.prev-* | sort | head -n -3 | xargs -r sudo rm -rf"

ok=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 2
  out="$(health)"
  if [[ "$out" == *'"ok":true'* && "$out" == *"$SHORT"* ]]; then ok=1; break; fi
done
if [[ "$ok" != 1 ]]; then
  echo "✗ /health не подтвердил релиз ($out) — откатываю" >&2
  ssh_run "set -e; sudo rm -rf ${DEST}.failed; sudo mv $DEST ${DEST}.failed; sudo mv ${DEST}.prev-$TS $DEST; sudo systemctl restart $UNIT"
  exit 1
fi
echo "✓ $SVC: $out"
