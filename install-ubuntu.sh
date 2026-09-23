#!/usr/bin/env bash
# Установка ЛайАут на Ubuntu: сборка, файлы в ~/.local/share,
# запуск одним кликом из меню приложений (ярлык .desktop).
set -euo pipefail

APP_ID="linux-pcb-app"
APP_NAME_RU="ЛайАут — редактор печатных плат"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$HOME/.local/share/$APP_ID"
BIN_DIR="$HOME/.local/bin"
DESKTOP_DIR="$HOME/.local/share/applications"
PORT=8484

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
err() { printf '\033[1;31mОшибка:\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null || err "node не найден. Установите: sudo apt install nodejs npm  (или Node актуальной версии с nodejs.org)"
command -v npm  >/dev/null || err "npm не найден. Установите: sudo apt install npm"

NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
[ "$NODE_MAJOR" -ge 18 ] || err "нужен Node.js 18+, а установлен $(node -v)"

say "Установка зависимостей"
cd "$SRC_DIR"
npm install --no-audit --no-fund --loglevel=error

say "Сборка приложения"
npm run build

say "Копирование в $APP_DIR"
mkdir -p "$APP_DIR" "$BIN_DIR" "$DESKTOP_DIR"
rm -rf "$APP_DIR/dist"
cp -r dist "$APP_DIR/dist"
cp scripts/server.mjs "$APP_DIR/server.mjs"
cp scripts/icon.svg "$APP_DIR/icon.svg"

say "Создание запускающего скрипта $BIN_DIR/linux-pcb-app"
cat > "$BIN_DIR/linux-pcb-app" <<EOF
#!/usr/bin/env bash
# Запуск ЛайАут одним кликом: поднимает локальный сервер (если ещё не запущен)
# и открывает приложение в браузере.
PORT=$PORT
URL="http://127.0.0.1:\$PORT"
# уже запущен? -> просто открываем окно
if ! curl -fsS --max-time 1 "\$URL/healthz" >/dev/null 2>&1; then
  nohup node "$APP_DIR/server.mjs" "\$PORT" "$APP_DIR/dist" >/dev/null 2>&1 &
  for _ in \$(seq 1 30); do
    curl -fsS --max-time 1 "\$URL/healthz" >/dev/null 2>&1 && break
    sleep 0.2
  done
fi
exec xdg-open "\$URL"
EOF
chmod +x "$BIN_DIR/linux-pcb-app"

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
Exec=$BIN_DIR/linux-pcb-app
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
echo "  • Ярлык «ЛайАут — редактор печатных плат» появился в меню «Приложения» Ubuntu."
echo "  • Запуск из терминала:  linux-pcb-app"
echo "    (если не находится, выполните:  export PATH=\"\$HOME/.local/bin:\$PATH\"" \
     " и добавьте эту строку в ~/.bashrc)"
echo "  • Прямой запуск без установки PATH:  $BIN_DIR/linux-pcb-app"
