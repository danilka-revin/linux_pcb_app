#!/usr/bin/env bash
# Быстрый запуск ЛайАут одной командой: собирает (при необходимости),
# поднимает локальный сервер на порту 8080 и открывает браузер.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
PORT="${PORT:-8080}"

command -v node >/dev/null || { echo "Нужен Node.js 18+: sudo apt install nodejs npm"; exit 1; }

if [ ! -d node_modules ]; then
  echo "==> npm install"
  npm install --no-audit --no-fund --loglevel=error
fi
if [ ! -f dist/index.html ] || [ package.json -nt dist/index.html ]; then
  echo "==> npm run build"
  npm run build
fi

URL="http://127.0.0.1:$PORT"
if curl -fsS --max-time 1 "$URL/healthz" >/dev/null 2>&1; then
  echo "Уже запущен: $URL"
else
  nohup node scripts/server.mjs "$PORT" >/dev/null 2>&1 &
  sleep 0.5
fi
echo "Открываю $URL"
xdg-open "$URL" 2>/dev/null || echo "Откройте в браузере: $URL"
