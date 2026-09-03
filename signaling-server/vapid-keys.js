#!/usr/bin/env node
'use strict';

/**
 * Пара ключей VAPID для web-push (v4.32.560).
 *
 * Запускать самому и один раз: `npm run vapid` в signaling-server. Приватный
 * ключ печатается в терминал и больше нигде не сохраняется — положите его в
 * секреты сервера (VAPID_PRIVATE_KEY) и забудьте вывод.
 *
 * Смена ключей отзывает все существующие подписки браузеров: они привязаны к
 * открытому ключу. Люди подпишутся заново при следующем открытии страницы.
 */

const { generateVapidKeys } = require('./webpush');

const keys = generateVapidKeys();
process.stdout.write([
  'VAPID_PUBLIC_KEY=' + keys.publicKey,
  'VAPID_PRIVATE_KEY=' + keys.privateKey,
  'VAPID_SUBJECT=mailto:вы@пример.рф',
  '',
].join('\n'));
