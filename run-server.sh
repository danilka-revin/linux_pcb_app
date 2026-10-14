#!/usr/bin/env bash
# Простой запуск общего сервера PSBees одной командой (без почты, SMTP и systemd):
#   bash run-server.sh          — собрать (если нужно) и запустить общий сервер в фоне
#   bash run-server.sh --fg     — запустить в текущем окне терминала
#   bash run-server.sh stop     — остановить запущенный сервер
#   bash run-server.sh status   — проверить состояние сервера
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

ACTION="${1:-start}"
PORT="${PORT:-8080}"
HOST="${HOST:-0.0.0.0}"
DATA_DIR="${PSBEES_DATA_DIR:-$(pwd)/psbees-data}"
URL="http://127.0.0.1:$PORT"
LOG="node_modules/.cache/run-cloud-server.log"
PIDFILE="node_modules/.cache/run-cloud-server.pid"

err() { printf '\033[1;31mОшибка:\033[0m %s\n' "$*" >&2; exit 1; }
say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }

alive() {
  node -e 'fetch(process.argv[1], { signal: AbortSignal.timeout(1000) })
    .then((r) => r.text())
    .then((t) => process.exit(t.includes("\"ok\":true") ? 0 : 1), () => process.exit(1))' \
    "$URL/healthz" >/dev/null 2>&1
}

stop_server() {
  local pid="" p i=0
  [ -f "$PIDFILE" ] && pid=$(cat "$PIDFILE" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
  elif command -v fuser >/dev/null 2>&1; then
    fuser -k "$PORT/tcp" 2>/dev/null || true
  else
    for p in $(pgrep -f "server\.mjs.*$PORT" 2>/dev/null || true); do
      kill "$p" 2>/dev/null || true
    done
  fi
  rm -f "$PIDFILE"
  while [ "$i" -lt 40 ] && alive; do sleep 0.25; i=$((i + 1)); done
  ! alive
}

print_info() {
  local ip
  printf '\n\033[1;32mОбщий сервер PSBees запущен!\033[0m\n'
  printf '  Локально:           %s/\n' "$URL"
  if command -v hostname >/dev/null 2>&1; then
    for ip in $(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true); do
      printf '  Для других в сети:  http://%s:%s/\n' "$ip" "$PORT"
    done
  fi
  printf '  Админ-панель:       %s/admin\n' "$URL"
  printf '  База данных:        %s/psbees.sqlite\n' "$DATA_DIR"
  printf '\nВход и регистрация работают просто по имени (нику) — без почты и пароля.\n'
  printf 'Первый вошедший пользователь автоматически становится администратором.\n'
  printf 'Остановить сервер:  bash run-server.sh stop\n'
}

if [ "$ACTION" = "stop" ]; then
  if stop_server; then
    say "Сервер на порту $PORT остановлен."
  else
    err "Не удалось остановить сервер на порту $PORT."
  fi
  exit 0
fi

if [ "$ACTION" = "status" ]; then
  if alive; then
    print_info
    exit 0
  else
    say "Сервер на порту $PORT сейчас не запущен."
    exit 1
  fi
fi

if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
  err "не запускайте run-server.sh через sudo. Выполните просто:  bash run-server.sh
(Или для системной службы Ubuntu:  sudo bash server-ubuntu.sh install)"
fi

node_is_ready() {
  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' >/dev/null 2>&1
}

install_nodejs() {
  command -v apt-get >/dev/null 2>&1 || err "Для общего сервера нужен Node.js 22.13+ (рекомендуется 24 LTS). Установите его и повторите: bash run-server.sh"
  say "Устанавливаю Node.js 24 LTS (может потребоваться пароль от системы)…"
  local run_root=()
  if [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null 2>&1 || err "Для автоматической установки Node.js нужен sudo."
    run_root=(sudo)
  fi
  "${run_root[@]}" apt-get update
  "${run_root[@]}" apt-get install -y ca-certificates curl gnupg
  "${run_root[@]}" install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | "${run_root[@]}" gpg --dearmor --batch --yes -o /etc/apt/keyrings/nodesource.gpg
  "${run_root[@]}" chmod 0644 /etc/apt/keyrings/nodesource.gpg
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main\n' "$(dpkg --print-architecture)" \
    | "${run_root[@]}" tee /etc/apt/sources.list.d/nodesource.list >/dev/null
  "${run_root[@]}" apt-get update
  "${run_root[@]}" apt-get install -y nodejs
  hash -r
  node_is_ready || err "Node.js 24 не установился. Проверьте интернет и повторите."
}

node_is_ready || install_nodejs

CODE_CHANGED=0
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  say "Установка зависимостей (npm ci)…"
  npm ci --no-audit --no-fund --no-update-notifier --loglevel=error
fi
if [ ! -f dist/index.html ] || [ -n "$(find src index.html package.json package-lock.json vite.config.ts tsconfig.json scripts -newer dist/index.html -print -quit 2>/dev/null)" ]; then
  say "Сборка приложения (npm run build)…"
  npm run build --no-update-notifier
  CODE_CHANGED=1
fi

mkdir -p -m 0700 "$DATA_DIR"
chmod 0700 "$DATA_DIR"

if [ "$ACTION" = "--fg" ] || [ "$ACTION" = "fg" ]; then
  stop_server || true
  say "Запуск общего сервера на $HOST:$PORT (Ctrl+C для остановки)…"
  exec env HOST="$HOST" PORT="$PORT" PSBEES_DATA_DIR="$DATA_DIR" node scripts/server.mjs --cloud "$PORT"
fi

if alive; then
  if [ "$CODE_CHANGED" = "1" ]; then
    say "Перезапуск сервера с обновлённой сборкой…"
    stop_server || err "Не удалось остановить старый сервер на порту $PORT."
  else
    print_info
    exit 0
  fi
fi

mkdir -p "$(dirname "$LOG")"
nohup env HOST="$HOST" PORT="$PORT" PSBEES_DATA_DIR="$DATA_DIR" node scripts/server.mjs --cloud "$PORT" >"$LOG" 2>&1 &
PID=$!
echo "$PID" > "$PIDFILE"
for _ in $(seq 1 40); do
  alive && break
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.25
done
if ! alive; then
  cat "$LOG" >&2
  err "Сервер не запустился (причина выше). Если порт $PORT занят, укажите другой:  PORT=8090 bash run-server.sh"
fi
print_info
