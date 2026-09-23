#!/usr/bin/env bash
# Быстрый запуск ЛайАут одной командой: собирает (при необходимости),
# поднимает локальный сервер на порту 8080 и открывает браузер.
# Пошаговая инструкция для новичков — INSTALL_UBUNTU.md.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
PORT="${PORT:-8080}"
URL="http://127.0.0.1:$PORT"
LOG="node_modules/.cache/run-server.log"

err() { printf '\033[1;31mОшибка:\033[0m %s\n' "$*" >&2; exit 1; }

if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
  err "не запускайте через sudo: файлы сборки станут недоступны вашему пользователю. Выполните просто:  bash run.sh"
fi
command -v node >/dev/null || err "Node.js не найден. Установите Node.js 18 или новее — шаг 3 в INSTALL_UBUNTU.md"
command -v npm  >/dev/null || err "npm не найден. Выполните:  sudo apt install -y npm"
[ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -ge 18 ] \
  || err "нужен Node.js 18 или новее, а установлен $(node -v). Обновите Node.js — шаг 3 в INSTALL_UBUNTU.md"

# зависимости: при первом запуске и после обновления package-lock.json (например, git pull)
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "==> npm ci"
  npm ci --no-audit --no-fund --no-update-notifier --loglevel=error
fi
# сборка: при первом запуске и после изменения исходников
if [ ! -f dist/index.html ] || [ -n "$(find src index.html package.json package-lock.json vite.config.ts tsconfig.json -newer dist/index.html -print -quit 2>/dev/null)" ]; then
  echo "==> npm run build"
  npm run build --no-update-notifier
fi

# отвечает ли на порту именно наш сервер
alive() {
  node -e 'fetch(process.argv[1], { signal: AbortSignal.timeout(1000) })
    .then((r) => r.text())
    .then((t) => process.exit(t.includes("\"ok\":true") ? 0 : 1), () => process.exit(1))' \
    "$URL/healthz" >/dev/null 2>&1
}

if alive; then
  echo "Уже запущен: $URL"
else
  mkdir -p "$(dirname "$LOG")"
  nohup node scripts/server.mjs "$PORT" >"$LOG" 2>&1 &
  PID=$!
  for _ in $(seq 1 40); do
    alive && break
    kill -0 "$PID" 2>/dev/null || break  # сервер завершился с ошибкой — ждать нечего
    sleep 0.25
  done
  if ! alive; then
    cat "$LOG" >&2
    err "сервер не запустился (причина выше). Если порт $PORT занят другой программой, выберите другой:  PORT=8090 bash run.sh"
  fi
  echo "Сервер работает в фоне (остановить: kill $PID)"
fi
echo "Открываю $URL"
xdg-open "$URL" >/dev/null 2>&1 || echo "Откройте в браузере: $URL"
