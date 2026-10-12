#!/usr/bin/env node
// Проверка SMTP-настроек без отправки письма и без вывода пароля/конфигурации.
import { createOtpMailer } from './cloud.mjs';

try {
  const mailer = await createOtpMailer();
  if (typeof mailer.verify === 'function') await mailer.verify();
  console.log('SMTP готов: сервер доступен и принял настройки авторизации.');
} catch (error) {
  console.error('Проверка SMTP не пройдена:', error?.message || 'ошибка настройки.');
  process.exitCode = 1;
}
