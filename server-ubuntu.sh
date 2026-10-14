#!/usr/bin/env bash
# PSBees — установка и управление общим сервером на Ubuntu.
# Запуск из клона проекта: sudo bash server-ubuntu.sh [install|update|start|stop|restart|status|logs|smtp-check|backup]
set -Eeuo pipefail

SERVICE="psbees"
SERVICE_USER="psbees"
APP_DIR="${PSBEES_APP_DIR:-/opt/psbees}"
DATA_DIR="${PSBEES_DATA_DIR:-/var/lib/psbees}"
ENV_DIR="/etc/psbees"
ENV_FILE="$ENV_DIR/psbees.env"
UNIT_FILE="/etc/systemd/system/psbees.service"
DEFAULT_PORT="${PSBEES_PORT:-8080}"
APP_HOST="${PSBEES_BIND_HOST:-0.0.0.0}"
USER_QUOTA_MB="${PSBEES_USER_QUOTA_MB:-250}"
TRUST_PROXY="${PSBEES_TRUST_PROXY:-0}"
SECURE_COOKIES="${PSBEES_SECURE_COOKIES:-0}"
LAN_CIDR="${PSBEES_LAN_CIDR:-}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="/usr/bin/node"
NPM_BIN="/usr/bin/npm"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mВнимание:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mОшибка:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
PSBees — общий сервер печатных плат для Ubuntu

  sudo bash server-ubuntu.sh install    установить и запустить одной командой (без настройки почты)
  sudo bash server-ubuntu.sh update     обновить код/сборку без изменения пользователей и плат
  sudo bash server-ubuntu.sh start      запустить systemd-сервис
  sudo bash server-ubuntu.sh stop       остановить сервис
  sudo bash server-ubuntu.sh restart    перезапустить сервис
  sudo bash server-ubuntu.sh status     показать состояние и локальный health-check
  sudo bash server-ubuntu.sh logs       последние 100 строк журнала, далее — просмотр вживую
  sudo bash server-ubuntu.sh smtp-check проверить SMTP без отправки письма (если включён SMTP)
  sudo bash server-ubuntu.sh backup     безопасно создать архив SQLite-каталога

Установка настроек: PSBEES_APP_DIR (по умолчанию /opt/psbees),
PSBEES_DATA_DIR (/var/lib/psbees), PSBEES_PORT (8080), PSBEES_BIND_HOST
(0.0.0.0), PSBEES_LAN_CIDR (например, 192.168.1.0/24).
По умолчанию вход и регистрация работают просто по имени (нику) без почты и пароля;
первый вошедший пользователь автоматически становится администратором.
EOF
}

require_root() {
  [[ "$(id -u)" -eq 0 ]] || die "выполните от root: sudo bash server-ubuntu.sh $1"
}

port_valid() {
  [[ "$1" =~ ^[0-9]{1,5}$ ]] && (( 10#$1 >= 1024 && 10#$1 <= 65535 ))
}

config_value() {
  local key="$1" line
  line="$(sed -n "s/^${key}=//p" "$ENV_FILE" | head -n 1)"
  [[ -n "$line" ]] || return 1
  if [[ "$line" == \"*\" ]]; then line="${line:1:${#line}-2}"; fi
  printf '%s' "$line"
}

load_installed_config() {
  [[ -f "$ENV_FILE" ]] || return 0
  local configured
  configured="$(config_value PSBEES_APP_DIR || true)"; if [[ -n "$configured" ]]; then APP_DIR="$configured"; fi
  configured="$(config_value PSBEES_DATA_DIR || true)"; if [[ -n "$configured" ]]; then DATA_DIR="$configured"; fi
  configured="$(config_value PORT || true)"; if [[ -n "$configured" ]]; then DEFAULT_PORT="$configured"; fi
  configured="$(config_value HOST || true)"; if [[ -n "$configured" ]]; then APP_HOST="$configured"; fi
  configured="$(config_value PSBEES_USER_QUOTA_MB || true)"; if [[ -n "$configured" ]]; then USER_QUOTA_MB="$configured"; fi
  configured="$(config_value PSBEES_TRUST_PROXY || true)"; if [[ -n "$configured" ]]; then TRUST_PROXY="$configured"; fi
  configured="$(config_value PSBEES_SECURE_COOKIES || true)"; if [[ -n "$configured" ]]; then SECURE_COOKIES="$configured"; fi
  configured="$(config_value PSBEES_LAN_CIDR || true)"; if [[ -n "$configured" ]]; then LAN_CIDR="$configured"; fi
}

node_is_ready() {
  [[ -x "$NODE_BIN" ]] && "$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' >/dev/null 2>&1 \
    && "$NODE_BIN" --input-type=module -e "import('node:sqlite').then(()=>process.exit(0),()=>process.exit(1))" >/dev/null 2>&1 \
    && [[ -x "$NPM_BIN" ]]
}

install_node() {
  say "Устанавливаю Node.js 24 LTS с node:sqlite"
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --batch --yes -o /etc/apt/keyrings/nodesource.gpg
  chmod 0644 /etc/apt/keyrings/nodesource.gpg
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main\n' "$(dpkg --print-architecture)" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update
  apt-get install -y nodejs
  hash -r
  node_is_ready || die "Node.js 24 не установился. Проверьте доступ к репозиторию NodeSource и повторите."
}

ensure_ubuntu() {
  [[ -r /etc/os-release ]] || die "скрипт предназначен для Ubuntu."
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || die "обнаружена ${PRETTY_NAME:-неизвестная ОС}; скрипт поддерживает Ubuntu."
  command -v systemctl >/dev/null 2>&1 || die "не найден systemd/systemctl."
  [[ -f "$SRC_DIR/package.json" && -f "$SRC_DIR/package-lock.json" ]] || die "запустите файл из клона PSBees рядом с package.json."
  port_valid "$DEFAULT_PORT" || die "PSBEES_PORT должен быть числом 1024–65535 (сейчас: $DEFAULT_PORT)."
  [[ "$APP_HOST" =~ ^[A-Za-z0-9:._-]+$ ]] || die "HOST должен быть IPv4/IPv6-адресом или именем узла без пробелов."
  [[ "$USER_QUOTA_MB" =~ ^[0-9]{1,7}$ ]] && (( 10#$USER_QUOTA_MB >= 8 && 10#$USER_QUOTA_MB <= 1000000 )) || die "PSBEES_USER_QUOTA_MB: укажите целое число от 8 до 1000000."
  [[ "$TRUST_PROXY" == "0" || "$TRUST_PROXY" == "1" ]] || die "PSBEES_TRUST_PROXY должен быть 0 или 1."
  [[ "$SECURE_COOKIES" == "0" || "$SECURE_COOKIES" == "1" ]] || die "PSBEES_SECURE_COOKIES должен быть 0 или 1."
  [[ -z "$LAN_CIDR" || "$LAN_CIDR" =~ ^[0-9A-Fa-f:.]+(/[0-9]{1,3})?$ ]] || die "PSBEES_LAN_CIDR должен быть IPv4/IPv6-адресом или CIDR-сетью."
  local app_real data_real
  app_real="$(realpath -m "$APP_DIR")"; data_real="$(realpath -m "$DATA_DIR")"
  [[ "$app_real" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "PSBEES_APP_DIR должен быть абсолютным путём без пробелов и специальных символов."
  [[ "$data_real" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "PSBEES_DATA_DIR должен быть абсолютным путём без пробелов и специальных символов."
  case "$app_real" in /|/opt|/var|/etc|/home|/home/*|/root|/root/*|/usr|/tmp|/tmp/*|/run|/run/*|/dev|/dev/*|/proc|/proc/*|/sys|/sys/*) die "опасный PSBEES_APP_DIR: $app_real (используйте каталог вроде /opt/psbees)" ;; esac
  [[ "$(basename "$app_real")" == "psbees" ]] || die "PSBEES_APP_DIR должен быть отдельной папкой с именем psbees, например /opt/psbees."
  case "$data_real" in /|/var|/var/lib|/opt|/etc|/home|/home/*|/root|/root/*|/usr|/tmp|/tmp/*|/run|/run/*|/dev|/dev/*|/proc|/proc/*|/sys|/sys/*) die "опасный PSBEES_DATA_DIR: $data_real. Укажите отдельный каталог, например /var/lib/psbees или /srv/psbees-data." ;; esac
  [[ "$app_real" != "$data_real" && "$app_real" != "$data_real/"* && "$data_real" != "$app_real/"* ]] \
    || die "каталоги приложения и базы должны быть отдельными, не вложенными друг в друга."
  APP_DIR="$app_real"
  DATA_DIR="$data_real"
}

sync_source() {
  local source_real app_real
  source_real="$(realpath "$SRC_DIR")"
  app_real="$(realpath -m "$APP_DIR")"
  if [[ "$source_real" != "$app_real" ]]; then
    command -v rsync >/dev/null 2>&1 || apt-get install -y rsync
    install -d -m 0755 "$APP_DIR"
    say "Копирую проверенную рабочую копию в $APP_DIR (данные пользователей остаются отдельно)"
    rsync -a --delete \
      --exclude='/.git/' --exclude='/node_modules/' --exclude='/dist/' \
      --exclude='/.env' --exclude='/.env.*' --exclude='/psbees-data/' \
      --exclude='/.update-cache/' --exclude='/coverage/' \
      "$SRC_DIR/" "$APP_DIR/"
  fi
  chown -R root:root "$APP_DIR"
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$APP_DIR/.update-cache"
}

build_app() {
  say "Устанавливаю npm-зависимости"
  (cd "$APP_DIR" && "$NPM_BIN" ci --no-audit --no-fund --no-update-notifier)
  say "Собираю веб-приложение"
  (cd "$APP_DIR" && "$NPM_BIN" run build --no-update-notifier)
  [[ -s "$APP_DIR/dist/index.html" ]] || die "сборка не создала dist/index.html."
}

ensure_service_user() {
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$DATA_DIR"
  if find "$DATA_DIR" ! -user "$SERVICE_USER" -print -quit | grep -q .; then
    chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
  fi
}

systemd_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

check_saved_smtp() {
  say "Проверяю сохранённый SMTP-конфиг (письмо не отправляется)"
  systemd-run --quiet --wait --pipe --collect \
    --property="EnvironmentFile=$ENV_FILE" \
    "$NODE_BIN" "$APP_DIR/scripts/check-smtp.mjs" \
    || die "SMTP-проверка не пройдена. Исправьте $ENV_FILE или задайте PSBEES_RECONFIGURE_SMTP=1 при повторном install."
}

configure_smtp() {
  local smtp_host smtp_port smtp_from smtp_user smtp_pass smtp_secure
  if [[ -f "$ENV_FILE" && "${PSBEES_RECONFIGURE_SMTP:-0}" != "1" && -z "${PSBEES_SMTP_HOST:-}" ]]; then
    say "Существующий конфиг сохраняю ($ENV_FILE)."
    return 0
  fi
  if [[ "${PSBEES_RECONFIGURE_SMTP:-0}" != "1" && -z "${PSBEES_SMTP_HOST:-}" ]]; then
    say "Создаю конфигурацию сервера ($ENV_FILE) — вход и регистрация по имени/нику без почты"
    install -d -m 0755 "$ENV_DIR"
    umask 077
    {
      printf 'PSBEES_APP_DIR=%s\nPSBEES_DATA_DIR=%s\n' "$APP_DIR" "$DATA_DIR"
      printf 'HOST=%s\nPORT=%s\n' "$(systemd_quote "$APP_HOST")" "$DEFAULT_PORT"
      printf 'PSBEES_USER_QUOTA_MB=%s\nPSBEES_TRUST_PROXY=%s\nPSBEES_SECURE_COOKIES=%s\n' \
        "$USER_QUOTA_MB" "$TRUST_PROXY" "$SECURE_COOKIES"
      if [[ -n "$LAN_CIDR" ]]; then printf 'PSBEES_LAN_CIDR=%s\n' "$LAN_CIDR"; fi
    } > "$ENV_FILE"
    chown root:root "$ENV_FILE"
    chmod 0600 "$ENV_FILE"
    return 0
  fi
  if [[ ! -t 0 ]]; then
    [[ -n "${PSBEES_SMTP_HOST:-}" && -n "${PSBEES_SMTP_FROM:-}" ]] \
      || die "нужен интерактивный терминал для ввода SMTP либо передайте PSBEES_SMTP_HOST/PSBEES_SMTP_FROM и учётные переменные окружения."
  fi

  smtp_host="${PSBEES_SMTP_HOST:-}"
  smtp_port="${PSBEES_SMTP_PORT:-587}"
  smtp_from="${PSBEES_SMTP_FROM:-}"
  smtp_user="${PSBEES_SMTP_USER:-}"
  smtp_pass="${PSBEES_SMTP_PASS:-}"
  smtp_secure="${PSBEES_SMTP_SECURE:-}"
  if [[ -z "$smtp_secure" ]]; then
    if [[ "$smtp_port" == "465" ]]; then smtp_secure=1; else smtp_secure=0; fi
  fi
  if [[ -t 0 ]]; then
    [[ -n "$smtp_host" ]] || read -r -p "SMTP сервер, например smtp.example.com: " smtp_host
    answer=""
    read -r -p "SMTP порт [${smtp_port}]: " answer || true
    [[ -n "$answer" ]] && smtp_port="$answer"
    if [[ -z "${PSBEES_SMTP_SECURE:-}" ]]; then
      local tls_default='n'
      [[ "$smtp_secure" == "1" ]] && tls_default='Y'
      answer=""
      read -r -p "TLS сразу при подключении? [y/N, по умолчанию ${tls_default}]: " answer || true
      if [[ "${answer:-}" =~ ^[YyДд]$ ]]; then smtp_secure=1;
      elif [[ "${answer:-}" =~ ^[NnНн]$ ]]; then smtp_secure=0; fi
    fi
    if [[ -z "$smtp_user" ]]; then
      read -r -p "SMTP логин (оставьте пустым для IP-релея): " smtp_user
    fi
    if [[ -n "$smtp_user" && -z "$smtp_pass" ]]; then
      read -r -s -p "SMTP пароль (ввод скрыт): " smtp_pass; printf '\n'
    fi
    [[ -n "$smtp_from" ]] || read -r -p "Адрес отправителя, например pcb@example.com: " smtp_from
  fi
  [[ -n "$smtp_host" && -n "$smtp_from" ]] || die "SMTP host и адрес отправителя обязательны для email-2FA."
  [[ "$smtp_port" =~ ^[0-9]{1,5}$ ]] && (( 10#$smtp_port >= 1 && 10#$smtp_port <= 65535 )) || die "SMTP порт должен быть 1–65535."
  [[ "$smtp_secure" == "0" || "$smtp_secure" == "1" ]] || die "PSBEES_SMTP_SECURE должен быть 0 или 1."
  if [[ -n "$smtp_user" && -z "$smtp_pass" ]] || [[ -z "$smtp_user" && -n "$smtp_pass" ]]; then
    die "SMTP_USER и SMTP_PASS указываются вместе (или оба пусты для доверенного релея)."
  fi
  [[ "$smtp_user" != *$'\n'* && "$smtp_user" != *$'\r'* && "$smtp_pass" != *$'\n'* && "$smtp_pass" != *$'\r'* ]] \
    || die "SMTP логин и пароль не должны содержать перевод строки."

  install -d -m 0755 "$ENV_DIR"
  umask 077
  {
    printf 'PSBEES_APP_DIR=%s\nPSBEES_DATA_DIR=%s\n' "$APP_DIR" "$DATA_DIR"
    printf 'HOST=%s\nPORT=%s\n' "$(systemd_quote "$APP_HOST")" "$DEFAULT_PORT"
    printf 'PSBEES_USER_QUOTA_MB=%s\nPSBEES_TRUST_PROXY=%s\nPSBEES_SECURE_COOKIES=%s\n' \
      "$USER_QUOTA_MB" "$TRUST_PROXY" "$SECURE_COOKIES"
    if [[ -n "$LAN_CIDR" ]]; then printf 'PSBEES_LAN_CIDR=%s\n' "$LAN_CIDR"; fi
    printf 'PSBEES_SMTP_HOST=%s\n' "$(systemd_quote "$smtp_host")"
    printf 'PSBEES_SMTP_PORT=%s\n' "$smtp_port"
    printf 'PSBEES_SMTP_SECURE=%s\n' "$smtp_secure"
    printf 'PSBEES_SMTP_FROM=%s\n' "$(systemd_quote "$smtp_from")"
    printf 'PSBEES_SMTP_USER=%s\n' "$(systemd_quote "$smtp_user")"
    printf 'PSBEES_SMTP_PASS=%s\n' "$(systemd_quote "$smtp_pass")"
  } > "$ENV_FILE"
  chown root:root "$ENV_FILE"
  chmod 0600 "$ENV_FILE"

  say "Проверяю соединение с SMTP (письмо не отправляется)"
  PSBEES_SMTP_HOST="$smtp_host" PSBEES_SMTP_PORT="$smtp_port" PSBEES_SMTP_SECURE="$smtp_secure" \
    PSBEES_SMTP_FROM="$smtp_from" PSBEES_SMTP_USER="$smtp_user" PSBEES_SMTP_PASS="$smtp_pass" \
    "$NODE_BIN" "$APP_DIR/scripts/check-smtp.mjs" \
    || die "SMTP не готов. Проверьте адрес, порт, TLS и SMTP-учётные данные; повторите установку или исправьте $ENV_FILE."
}

write_systemd_unit() {
  cat > "$UNIT_FILE" <<EOF
[Unit]
Description=PSBees shared PCB workspace
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $APP_DIR/scripts/server.mjs --cloud --app-dir $APP_DIR
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
LockPersonality=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=$DATA_DIR $APP_DIR/.update-cache
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "$UNIT_FILE"
  systemctl daemon-reload
  systemctl enable "$SERVICE"
}

validate_cidr() {
  python3 - "$1" <<'PY'
import ipaddress, sys
try: ipaddress.ip_network(sys.argv[1], strict=False)
except ValueError: raise SystemExit(1)
PY
}

configure_firewall_hint() {
  local cidr rule_number rule_index
  local -a lan_cidrs=()
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
    if [[ -n "$LAN_CIDR" ]]; then
      validate_cidr "$LAN_CIDR" || die "неверная сеть CIDR: $LAN_CIDR"
      lan_cidrs=("$LAN_CIDR")
    else
      lan_cidrs=(10.0.0.0/8 172.16.0.0/12 192.168.0.0/16)
    fi
    say "Ограничиваю вход на порт $DEFAULT_PORT только выбранной локальной сетью в UFW"
    while true; do
      rule_number="$(ufw status numbered | sed -nE '/# PSBees LAN|# PSBees non-LAN/s/^[[:space:]]*\[ *([0-9]+)\].*/\1/p' | head -n 1)"
      [[ -n "$rule_number" ]] || break
      ufw --force delete "$rule_number" >/dev/null
    done
    rule_index=1
    for cidr in "${lan_cidrs[@]}"; do
      ufw insert "$rule_index" allow from "$cidr" to any port "$DEFAULT_PORT" proto tcp comment 'PSBees LAN' >/dev/null
      rule_index=$((rule_index + 1))
    done
    ufw insert "$rule_index" deny "$DEFAULT_PORT"/tcp comment 'PSBees non-LAN' >/dev/null
  elif command -v ufw >/dev/null 2>&1; then
    cidr="$LAN_CIDR"
    if [[ -n "$cidr" ]]; then
      validate_cidr "$cidr" || die "неверная сеть CIDR: $cidr"
      if ! grep -q '^PSBEES_LAN_CIDR=' "$ENV_FILE"; then printf 'PSBEES_LAN_CIDR=%s\n' "$cidr" >> "$ENV_FILE"; fi
      LAN_CIDR="$cidr"
      ufw allow from "$cidr" to any port "$DEFAULT_PORT" proto tcp comment 'PSBees LAN' >/dev/null
      warn "UFW сейчас выключен — правило добавлено, но оно начнёт действовать только после включения firewall. Скрипт не включает firewall, чтобы не отрезать SSH."
    else
      warn "UFW не активен. Скрипт не включает его автоматически (чтобы не оборвать SSH); настройте firewall/роутер вручную."
    fi
  else
    warn "UFW не установлен. Ограничьте порт $DEFAULT_PORT в firewall вашего сервера и не настраивайте проброс порта на WAN."
  fi
}

bootstrap_admin() {
  if [[ -s "$DATA_DIR/psbees.sqlite" ]]; then
    say "База уже существует; учётные записи и проекты не сбрасываю."
    return 0
  fi
  if [[ -n "${PSBEES_ADMIN:-}" ]]; then
    say "Создаю администратора «${PSBEES_ADMIN}» (вход по нику без пароля)"
    runuser -u "$SERVICE_USER" -- env PSBEES_DATA_DIR="$DATA_DIR" \
      "$NODE_BIN" "$APP_DIR/scripts/cloud-admin.mjs" create-admin "$PSBEES_ADMIN" --no-password
    return 0
  fi
  say "Первый пользователь, который войдёт через браузер по своему имени/нику, автоматически станет администратором."
}

wait_health() {
  local port="$1"
  for _ in $(seq 1 40); do
    if curl -fsS --max-time 1 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then return 0; fi
    sleep 0.25
  done
  return 1
}

install_server() {
  require_root install
  ensure_ubuntu
  node_is_ready || install_node
  if ! command -v curl >/dev/null 2>&1; then
    apt-get update
    apt-get install -y ca-certificates curl
  fi
  ensure_service_user
  sync_source
  build_app
  configure_smtp
  bootstrap_admin
  write_systemd_unit
  configure_firewall_hint
  say "Запускаю сервер при загрузке Ubuntu"
  systemctl restart "$SERVICE"
  if ! wait_health "$DEFAULT_PORT"; then
    journalctl -u "$SERVICE" -n 50 --no-pager >&2 || true
    die "сервер не ответил на health-check. Исправьте журнал выше и запустите: sudo bash server-ubuntu.sh restart"
  fi
  print_addresses
}

print_addresses() {
  local address
  printf '\nPSBees запущен! С любого компьютера в сети откройте:\n'
  while IFS= read -r address; do
    [[ -n "$address" ]] && printf '  http://%s:%s/\n' "$address" "$DEFAULT_PORT"
  done < <(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true)
  printf 'Вход и регистрация — просто по имени/нику (без почты и пароля).\n'
  printf 'Первый вошедший пользователь становится администратором.\n'
  printf 'Админ-панель: http://<IP-сервера>:%s/admin\n' "$DEFAULT_PORT"
  printf 'Данные: %s/psbees.sqlite · журнал: sudo journalctl -u %s -f\n' "$DATA_DIR" "$SERVICE"
}

update_server() {
  require_root update
  ensure_ubuntu
  [[ -f "$UNIT_FILE" ]] || die "сервис не установлен. Сначала выполните: sudo bash server-ubuntu.sh install"
  node_is_ready || install_node
  if ! command -v curl >/dev/null 2>&1; then
    apt-get update
    apt-get install -y ca-certificates curl
  fi
  sync_source
  build_app
  systemctl restart "$SERVICE"
  if ! wait_health "$DEFAULT_PORT"; then journalctl -u "$SERVICE" -n 50 --no-pager >&2 || true; die "обновлённый сервис не запустился."; fi
  say "Код обновлён; база и пользователи не затронуты."
  systemctl --no-pager --full status "$SERVICE" || true
}

make_backup() {
  require_root backup
  ensure_ubuntu
  [[ -d "$DATA_DIR" ]] || die "каталог данных не найден: $DATA_DIR"
  local backup_dir backup_real archive was_active
  backup_dir="${PSBEES_BACKUP_DIR:-/var/backups/psbees}"
  backup_real="$(realpath -m "$backup_dir")"
  [[ "$backup_real" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "PSBEES_BACKUP_DIR должен быть абсолютным путём без пробелов и специальных символов."
  case "$backup_real" in /|/var|/var/backups|/var/lib|/opt|/etc|/home|/root|/usr) die "опасный PSBEES_BACKUP_DIR: $backup_real" ;; esac
  [[ "$backup_real" != "$DATA_DIR" && "$backup_real" != "$DATA_DIR/"* && "$DATA_DIR" != "$backup_real/"* ]] \
    || die "каталог резервных копий и база должны быть отдельными, не вложенными друг в друга."
  backup_dir="$backup_real"
  install -d -o root -g root -m 0700 "$backup_dir"
  archive="$backup_dir/psbees-$(date -u +%Y%m%dT%H%M%S%NZ).tar.gz"
  was_active=0
  systemctl is-active --quiet "$SERVICE" && was_active=1 || true
  if (( was_active )); then systemctl stop "$SERVICE"; fi
  local restart_needed="$was_active"
  trap 'if [[ "$restart_needed" == 1 ]]; then systemctl start "$SERVICE" || true; fi' EXIT
  tar -czf "$archive" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"
  chmod 0600 "$archive"
  if (( was_active )); then systemctl start "$SERVICE"; restart_needed=0; fi
  trap - EXIT
  say "Резервная копия готова: $archive"
}

main() {
  local action="${1:-install}"
  if [[ "$action" == "-h" || "$action" == "--help" || "$action" == "help" ]]; then usage; return 0; fi
  load_installed_config
  case "$action" in
    -h|--help|help) usage ;;
    install) install_server ;;
    update) update_server ;;
    start) require_root start; systemctl start "$SERVICE"; systemctl --no-pager --full status "$SERVICE" ;;
    stop) require_root stop; systemctl stop "$SERVICE" ;;
    restart) require_root restart; systemctl restart "$SERVICE"; systemctl --no-pager --full status "$SERVICE" ;;
    status)
      require_root status
      systemctl --no-pager --full status "$SERVICE" || true
      if [[ -f "$ENV_FILE" ]]; then
        local port
        port="$(sed -n 's/^PORT=\([0-9][0-9]*\)$/\1/p' "$ENV_FILE" | head -n1)"
        [[ -n "$port" ]] && curl -fsS --max-time 2 "http://127.0.0.1:$port/healthz" || true
      fi
      ;;
    logs) require_root logs; journalctl -u "$SERVICE" -n 100 -f ;;
    smtp-check)
      require_root smtp-check
      ensure_ubuntu
      node_is_ready || install_node
      [[ -f "$ENV_FILE" ]] || die "SMTP ещё не настроен. Выполните: sudo bash server-ubuntu.sh install"
      check_saved_smtp
      ;;
    backup) make_backup ;;
    *) usage; die "неизвестная команда: $action" ;;
  esac
}

main "$@"
