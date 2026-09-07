/**
 * Отказ сервера уведомлений перестал выглядеть как успех (v4.32.623).
 *
 * `POST /send-push` отправлялся и результат выбрасывался целиком: переполненная
 * очередь, протухший токен, отключённый релей — всё это молча считалось
 * доставкой, а catch рядом ловит только обрыв сети. Соседний `/register-token`
 * в том же файле проверяется с самого начала — здесь просто не было проверки.
 *
 * Заодно проверяется вторая половина: ветка «уведомления не разрешили» на
 * телефоне была недостижима (`let granted = true`), то есть ответ системы на
 * запрос разрешения не доходил никуда.
 */
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(path.join(__dirname, '..', 'pushNotifications.ts'), 'utf8');

it('ответ /send-push читается и отказ попадает в журнал', () => {
  expect(SRC).toContain('const res = await fetch(`${base}/send-push`');
  expect(SRC).toContain("log.warn('push_send_rejected', { status: res.status })");
  // Прежняя форма — fetch, чей результат никуда не идёт: строка начиналась
  // прямо с await, без присваивания.
  expect(SRC).not.toContain('\n      await fetch(`${base}/send-push`');
});

it('ПРОВЕРКА НЕ ПУСТАЯ: /register-token проверялся и раньше, образец на месте', () => {
  expect(SRC).toContain('const res = await fetch(`${base}/register-token`');
  expect(SRC).toContain("log.warn('push_register_failed', { status: res.status })");
});

it('ответ системы на запрос разрешения записывается, а не теряется', () => {
  expect(SRC).toContain('const status = await messaging().requestPermission();');
  expect(SRC).toContain("log.info('push_permission_status'");
  // Флага, который на телефоне всегда true, больше нет.
  expect(SRC).not.toContain('let granted = true;');
});

it('разрешение на вебе по-прежнему обязательно, а на телефоне регистрация не отменяется', () => {
  // На вебе без разрешения токена не выдадут — там выход остаётся.
  expect(SRC).toContain("log.info('push_permission_pending', { platform: Platform.OS });");
  const from = SRC.indexOf('const authorized = messaging.AuthorizationStatus');
  expect(from).toBeGreaterThan(0);
  const body = SRC.slice(from, SRC.indexOf('} catch (e) {', from));
  // Возврат ровно один — веб-ветка. На телефоне идём за токеном в любом случае:
  // разрешение человек вправе выдать позже, из настроек системы.
  expect(body.split('return;').length - 1).toBe(1);
  expect(body).toContain('await this.registerTokenWithSignaling(options.peerId, token);');
});
