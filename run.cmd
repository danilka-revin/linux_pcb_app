@echo off
rem Быстрый запуск ЛайАут на Windows из исходников (нужен Node.js 18+).
rem Для обычной установки скачайте LayAut-Setup.exe — см. INSTALL_WINDOWS.md.
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Ошибка: Node.js не найден. Установите Node.js 18 или новее: https://nodejs.org/
  echo Подробнее: INSTALL_WINDOWS.md
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%a in ('node -e "process.stdout.write(process.versions.node)"') do set NODE_MAJOR=%%a
if %NODE_MAJOR% LSS 18 (
  echo Ошибка: нужен Node.js 18 или новее, а установлен:
  node -v
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo ==^> npm ci
  call npm ci --no-audit --no-fund --no-update-notifier --loglevel=error
  if errorlevel 1 (
    echo Не удалось установить зависимости.
    pause
    exit /b 1
  )
)

if not exist "dist\index.html" (
  echo ==^> npm run build
  call npm run build --no-update-notifier
  if errorlevel 1 (
    echo Сборка не удалась.
    pause
    exit /b 1
  )
)

if not defined PORT set PORT=8080
echo ==^> сервер http://127.0.0.1:%PORT%
start "LayAut-server" /min node scripts\server.mjs %PORT%
ping -n 2 127.0.0.1 >nul
start http://127.0.0.1:%PORT%
echo Браузер должен открыться. Сервер работает в свёрнутом окне «ЛайАут».
echo Чтобы остановить — закройте это свёрнутое окно или Диспетчер задач → node.
