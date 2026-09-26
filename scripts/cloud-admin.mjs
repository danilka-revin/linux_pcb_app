#!/usr/bin/env node
// Первый администратор и аварийный сброс его пароля выполняются только в терминале
// сервера с доступом к PSBEES_DATA_DIR. Пароль не передаётся через аргументы/env.
import { openCloudStore } from './cloud.mjs';

function secret(label) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Для безопасного ввода пароля откройте интерактивный терминал на сервере (TTY).');
  }
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    let value = '';
    process.stdout.write(label);
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    const cleanup = () => {
      input.off('data', onData);
      input.setRawMode(!!wasRaw);
      input.pause();
      process.stdout.write('\n');
    };
    const onData = (buffer) => {
      for (const ch of buffer.toString('utf8')) {
        if (ch === '\r' || ch === '\n') { cleanup(); resolve(value); return; }
        if (ch === '\u0003') { cleanup(); reject(new Error('Прервано.')); return; }
        if (ch === '\u007f' || ch === '\b') { value = Array.from(value).slice(0, -1).join(''); continue; }
        if (ch >= ' ' && value.length < 128) value += ch;
      }
    };
    input.on('data', onData);
  });
}

const [, , action, email] = process.argv;
if (!['create-admin', 'reset-admin-password', 'reset-user-password'].includes(action) || !email || process.argv.length !== 4) {
  console.error('Использование: PSBEES_DATA_DIR=/путь/к/данным node scripts/cloud-admin.mjs create-admin admin@example.com');
  console.error('            PSBEES_DATA_DIR=/путь/к/данным node scripts/cloud-admin.mjs reset-admin-password admin@example.com');
  console.error('            PSBEES_DATA_DIR=/путь/к/данным node scripts/cloud-admin.mjs reset-user-password user@example.com');
  process.exitCode = 1;
} else {
  let store;
  try {
    store = await openCloudStore(process.env.PSBEES_DATA_DIR);
    const password = await secret('Новый пароль (10–128 символов, ввод скрыт): ');
    const confirm = await secret('Повторите пароль: ');
    if (password !== confirm) throw new Error('Пароли не совпадают.');
    if (action === 'create-admin') await store.createAdmin(email, password);
    else if (action === 'reset-admin-password') await store.resetAdminPassword(email, password);
    else await store.resetUserPassword(email, password);
    console.log(action === 'create-admin' ? 'Администратор создан. Теперь можно войти через браузер.' : 'Пароль изменён, все старые сеансы отозваны. Передайте новый пароль лично и попросите его сменить после входа.');
  } catch (e) {
    console.error('Ошибка:', e?.message || e);
    process.exitCode = 1;
  } finally {
    store?.close();
  }
}
