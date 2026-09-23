#!/usr/bin/env bash
# Установка ЛайАут на Ubuntu: сборка, файлы в ~/.local/share,
# запуск одним кликом из меню приложений (ярлык .desktop).
# Пошаговая инструкция для новичков — INSTALL_UBUNTU.md.
set -euo pipefail

APP_ID="linux-pcb-app"
APP_NAME_RU="ЛайАут — редактор печатных плат"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$HOME/.local/share/$APP_ID"
BIN_DIR="$HOME/.local/bin"
DESKTOP_DIR="$HOME/.local/share/applications"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
err() { printf '\033[1;31mОшибка:\033[0m %s\n' "$*" >&2; exit 1; }

# порт локального сервера: PCB_APP_PORT=8485 bash install-ubuntu.sh,
# иначе — порт прошлой установки (переустановка его не сбрасывает), иначе 8484
PREV_PORT=""
if [ -f "$BIN_DIR/$APP_ID" ]; then
  PREV_PORT=$(sed -n 's/^PORT=\([0-9][0-9]*\)$/\1/p' "$BIN_DIR/$APP_ID" | head -n 1) || PREV_PORT=""
fi
PORT="${PCB_APP_PORT:-${PREV_PORT:-8484}}"
case "$PORT" in
  ''|*[!0-9]*) err "порт должен быть числом, а указано: $PORT" ;;
esac
{ [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ]; } || err "порт должен быть от 1024 до 65535, а указано: $PORT"

# частая ошибка новичков: «sudo bash install-ubuntu.sh» ставит программу пользователю root,
# и в вашем меню её не будет
if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
  err "не запускайте установку через sudo: программа ставится в вашу домашнюю папку.
  Выполните без sudo:  bash install-ubuntu.sh"
fi
command -v node >/dev/null || err "Node.js не найден. Установите Node.js 18 или новее — шаг 3 в INSTALL_UBUNTU.md"
command -v npm  >/dev/null || err "npm не найден. Выполните:  sudo apt install -y npm   (подробнее — шаг 3 в INSTALL_UBUNTU.md)"

NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
[ "$NODE_MAJOR" -ge 18 ] || err "нужен Node.js 18 или новее, а установлен $(node -v). Обновите Node.js — шаг 3 в INSTALL_UBUNTU.md"
NODE_BIN="$(command -v node)"

say "Установка зависимостей"
cd "$SRC_DIR"
# npm ci ставит ровно то, что в package-lock.json, и не меняет его (git pull не конфликтует)
npm ci --no-audit --no-fund --no-update-notifier --loglevel=error

say "Сборка приложения"
npm run build --no-update-notifier

say "Копирование в $APP_DIR"
mkdir -p "$APP_DIR" "$BIN_DIR" "$DESKTOP_DIR"
rm -rf "$APP_DIR/dist" "$APP_DIR/dist.old"
cp -r dist "$APP_DIR/dist"
cp scripts/server.mjs "$APP_DIR/server.mjs"
cp scripts/update.mjs "$APP_DIR/update.mjs"
cp scripts/icon.svg "$APP_DIR/icon.svg"
# данные для автообновления при запуске: откуда качать и какая версия установлена
REPO_URL=$(git -C "$SRC_DIR" remote get-url origin 2>/dev/null || true)
[ -n "$REPO_URL" ] || REPO_URL="https://github.com/danilka-revin/linux_pcb_app.git"
printf '%s\n' "$REPO_URL" > "$APP_DIR/repo.txt"
INST_SHA=$(node -e 'try{const v=JSON.parse(require("fs").readFileSync("dist/version.json","utf8"));process.stdout.write(v.sha||"")}catch{}' 2>/dev/null || true)
[ -n "$INST_SHA" ] || INST_SHA=$(git -C "$SRC_DIR" rev-parse HEAD 2>/dev/null || true)
[ -n "$INST_SHA" ] && printf '%s\n' "$INST_SHA" > "$APP_DIR/version.txt" || rm -f "$APP_DIR/version.txt"

say "Создание запускающего скрипта $BIN_DIR/$APP_ID"
{
  echo '#!/usr/bin/env bash'
  echo '# Запуск ЛайАут одним кликом: поднимает локальный сервер (если ещё не запущен)'
  echo '# и открывает приложение в браузере. Файл создан install-ubuntu.sh.'
  printf 'PORT=%q\nAPP_DIR=%q\nNODE_BIN=%q\n' "$PORT" "$APP_DIR" "$NODE_BIN"
  cat <<'EOF'
URL="http://127.0.0.1:$PORT"
LOG="$APP_DIR/server.log"

# node, найденный при установке (так работает и Node.js из nvm), иначе — из PATH
NODE="$NODE_BIN"
[ -x "$NODE" ] || NODE="$(command -v node || true)"

fail() {
  echo "ЛайАут: $1" >&2
  if command -v notify-send >/dev/null; then notify-send -i "$APP_DIR/icon.svg" "ЛайАут" "$1"; fi
  exit 1
}

# отвечает ли на порту именно наш сервер
alive() {
  "$NODE" -e 'fetch(process.argv[1], { signal: AbortSignal.timeout(1000) })
    .then((r) => r.text())
    .then((t) => process.exit(t.includes("\"ok\":true") ? 0 : 1), () => process.exit(1))' \
    "$URL/healthz" >/dev/null 2>&1
}

[ -n "$NODE" ] || fail "не найден Node.js. Установите его и повторите установку (INSTALL_UBUNTU.md, шаг 3)."
PIDFILE="$APP_DIR/server.pid"

notify() {
  command -v notify-send >/dev/null && notify-send -i "$APP_DIR/icon.svg" "ЛайАут" "$1" 2>/dev/null || true
}

# ---------- автообновление из GitHub при запуске ----------
# Проверяем последний комит ветки main. Если он новее установленного —
# скачиваем, собираем и ставим новую версию (scripts/update.mjs).
# Без сети или при ошибке — тихо остаёмся на текущей версии.
NEED_RESTART=0
if [ -f "$APP_DIR/update.mjs" ]; then
  UPD_OUT=$("$NODE" "$APP_DIR/update.mjs" --app-dir "$APP_DIR" 2>&1)
  RC=$?
  { printf '%s\n' "$UPD_OUT"; } >> "$APP_DIR/update.log" 2>/dev/null || true
  if [ "$RC" -eq 10 ]; then
    NEED_RESTART=1
    notify "Обновление установлено. Запуск новой версии…"
  elif [ "$RC" -ne 0 ]; then
    notify "Не удалось обновиться. Запускаем текущую версию."
  fi
fi

stop_server() {
  if [ -f "$PIDFILE" ]; then
    OLD_PID=$(cat "$PIDFILE" 2>/dev/null || true)
    [ -n "$OLD_PID" ] && kill "$OLD_PID" 2>/dev/null || true
  elif command -v fuser >/dev/null; then
    fuser -k "$PORT/tcp" 2>/dev/null || true
  else
    for P in $(pgrep -f "server\.mjs $PORT( |$)" 2>/dev/null || true); do
      kill "$P" 2>/dev/null || true
    done
  fi
  rm -f "$PIDFILE"
  for _ in $(seq 1 40); do alive && sleep 0.25 || break; done
}

# новая версия собрана -> перезапускаем сервер, чтобы работал свежий код
if [ "$NEED_RESTART" = "1" ] && alive; then
  stop_server
fi
# уже запущен? -> просто открываем окно
if ! alive; then
  nohup "$NODE" "$APP_DIR/server.mjs" "$PORT" "$APP_DIR/dist" >"$LOG" 2>&1 &
  PID=$!
  echo "$PID" > "$PIDFILE"
  for _ in $(seq 1 40); do
    alive && break
    kill -0 "$PID" 2>/dev/null || break  # сервер завершился с ошибкой — ждать нечего
    sleep 0.25
  done
  alive || fail "не удалось запустить локальный сервер. Подробности в файле $LOG"
fi
if command -v xdg-open >/dev/null; then
  exec xdg-open "$URL"
fi
echo "Откройте в браузере: $URL"
EOF
} > "$BIN_DIR/$APP_ID"
chmod +x "$BIN_DIR/$APP_ID"

say "Установка ярлыка приложения (.desktop)"
cat > "$DESKTOP_DIR/$APP_ID.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=$APP_NAME_RU
Name[ru]=$APP_NAME_RU
GenericName=PCB layout editor
GenericName[ru]=Редактор печатных плат
Comment=Sprint-Layout compatible PCB editor (lay6/lmk)
Comment[ru]=Редактор печатных плат, совместимый со Sprint-Layout (.lay6, .lmk)
Exec="$BIN_DIR/$APP_ID"
Icon=$APP_DIR/icon.svg
Terminal=false
Categories=Development;Engineering;Electronics;
Keywords=pcb;плата;sprint;layout;lay6;lmk;ЛУТ;gerber;
StartupNotify=true
EOF
chmod +x "$DESKTOP_DIR/$APP_ID.desktop"

# обновить кеш меню, если утилита есть (не критично)
if command -v update-desktop-database >/dev/null; then
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
fi

say "Готово!"
echo "  • Ярлык «$APP_NAME_RU» появился в меню приложений:"
echo "    нажмите клавишу Super (с логотипом Windows) и наберите «ЛайАут»."
echo "  • Адрес программы в браузере:  http://127.0.0.1:$PORT"
case ":$PATH:" in
  *":$BIN_DIR:"*)
    echo "  • Запуск из терминала:  $APP_ID" ;;
  *)
    echo "  • Запуск из терминала:  $BIN_DIR/$APP_ID"
    echo "    (короткая команда «$APP_ID» заработает после следующего входа в систему)" ;;
esac
