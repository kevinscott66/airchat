/**
 * Звонок, доехавший до закрытого приложения (v4.32.573).
 *
 * Проверяется ровно то, что было сломано: push о звонке не должен разбираться
 * как сообщение, а его номер — уезжать в сеть как ключ несуществующего
 * сообщения.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CALL_BANNER_TIMEOUT_MS,
  CALL_PUSH_KIND,
  callBannerId,
  newCallId,
} from '../callPush';
import {
  parseCallOpenIntent,
  parseChatOpenIntent,
  parseOpenIntent,
  deliverOpenIntent,
  resetOpenIntents,
  setOpenIntentConsumer,
  type OpenIntent,
} from '../openIntent';

const CALL_ID = 'a1b2c3d4e5f60718a1b2c3d4e5f60718';
const SENDER = 'did:key:z6MkvMHxVsrnyccHiUmVw2MAQXexvXsEyTyS4sTCLy785nLm';

beforeEach(() => resetOpenIntents());

test('номер звонка проходит и проверку устройства, и проверку сервера', () => {
  const id = newCallId(new Uint8Array(16).fill(0xab));
  expect(id).toHaveLength(32);
  // Форма, которую пропускает разбор уведомления на устройстве…
  expect(/^[a-f0-9]{16,128}$/i.test(id)).toBe(true);
  // …и форма, которую пропускает сервер (isCid в signaling-server/push.js).
  expect(/^[A-Za-z0-9]+$/.test(id)).toBe(true);
});

test('короткие случайные байты не дают короткого номера', () => {
  expect(newCallId(new Uint8Array([1, 2]))).toHaveLength(32);
});

test('один баннер на звонок', () => {
  expect(callBannerId(CALL_ID)).toBe(`call:${CALL_ID}`);
  expect(callBannerId(CALL_ID)).not.toBe(callBannerId('b'.repeat(32)));
});

test('баннер переживает срок звонящего, но ненамного', () => {
  // Звонящий вешает трубку через 45 с (OUTGOING_RINGING_TIMEOUT_MS).
  expect(CALL_BANNER_TIMEOUT_MS).toBeGreaterThan(45_000);
  expect(CALL_BANNER_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
});

test('push о звонке разбирается как звонок', () => {
  const intent = parseCallOpenIntent({ kind: CALL_PUSH_KIND, cid: CALL_ID, senderDid: SENDER });
  expect(intent).toEqual({ kind: 'call', callId: CALL_ID, contactDid: SENDER });
});

test('без DID звонок всё равно поднимает экран', () => {
  expect(parseCallOpenIntent({ kind: 'call', cid: CALL_ID })).toEqual({
    kind: 'call',
    callId: CALL_ID,
  });
});

test('чужой вид и мусорный номер звонком не считаются', () => {
  expect(parseCallOpenIntent({ kind: 'dm', cid: CALL_ID })).toBeNull();
  expect(parseCallOpenIntent({ kind: 'call', cid: 'нет' })).toBeNull();
  expect(parseCallOpenIntent({ kind: 'call' })).toBeNull();
  expect(parseCallOpenIntent(null)).toBeNull();
});

test('звонок не разбирается как сообщение', () => {
  const data = { kind: 'call', cid: CALL_ID, senderDid: SENDER };
  // Именно это и было сломано бы без ветки звонка: приложение пошло бы в сеть
  // за сообщением с номером звонка вместо ключа.
  expect(parseChatOpenIntent(data)).toBeNull();
  expect(parseOpenIntent(data)).toEqual({ kind: 'call', callId: CALL_ID, contactDid: SENDER });
});

test('сообщение звонком не становится', () => {
  const data = { cid: CALL_ID, senderDid: SENDER, kind: 'dm' };
  expect(parseOpenIntent(data)).toEqual({ kind: 'chat', cid: CALL_ID, contactDid: SENDER });
});

test('два звонка подряд доходят оба', () => {
  const seen: OpenIntent[] = [];
  setOpenIntentConsumer((intent) => { seen.push(intent); });
  const second = 'b'.repeat(32);
  expect(deliverOpenIntent({ kind: 'call', callId: CALL_ID }, 'background-press')).toBe('delivered');
  expect(deliverOpenIntent({ kind: 'call', callId: second }, 'background-press')).toBe('delivered');
  expect(seen.map((i) => (i.kind === 'call' ? i.callId : ''))).toEqual([CALL_ID, second]);
});

test('фоновый обработчик показывает звонок раньше, чем разбирает сообщение', () => {
  const src = readFileSync(join(__dirname, '../../firebaseMessagingBackground.ts'), 'utf8');
  const call = src.indexOf('parseCallOpenIntent(remoteMessage.data)');
  const chat = src.indexOf('parseChatOpenIntent(remoteMessage.data)');
  expect(call).toBeGreaterThan(-1);
  expect(chat).toBeGreaterThan(call);
  // Полноэкранное намерение — то, чем Android поднимает окно поверх
  // заблокированного экрана; без него баннер остаётся строкой в шторке.
  expect(src).toContain('fullScreenAction');
  expect(src).toContain('AndroidCategory.CALL');
});

test('вид звонка совпадает с тем, что пропускает сервер', () => {
  const server = readFileSync(join(__dirname, '../../../signaling-server/push.js'), 'utf8');
  expect(server).toContain(`'${CALL_PUSH_KIND}'`);
  expect(server).toMatch(/PUSH_KINDS = new Set\(\[[^\]]*'call'/);
});
