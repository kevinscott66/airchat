/**
 * Групповой конверт из сети больше не разбирается мимо расшифровки (v4.32.922).
 *
 * Дефект: оба координатора транспорта — LAN и интернет — смотрели в первые 200
 * байт пришедшего кадра регулярным выражением `/"type"\s*:\s*"group/` и, если
 * оно совпадало, уводили кадр в `getGroupMessagingService().receiveGroupEnvelope`.
 * На этом пути не было расшифровки вообще. Отправителем считался DID из
 * заголовка кадра, который никто не подписывает, а `handleIncomingGroupEnvelope`
 * сверял его с полем `senderPubB64` внутри того же кадра — заявленное с
 * заявленным. Личный конверт рядом проходит `decryptSymmetric` общим ключом, и
 * подделка на нём отсеивается молча; групповой не проходил ничего.
 *
 * Цена: всякий, кто дотянулся до порта в той же сети (или до relay), писал в
 * группу от имени любого её участника — с его именем над сообщением. Тем же
 * путём шли управляющие конверты группы: смена прав, исключение участника.
 *
 * При этом своих кадров ветка не ловила никогда. И сообщение группы
 * (`\x02grp:`), и управляющий конверт (`\x0egctl:`) уходят через
 * `svc.sendMessage`, то есть внутри зашифрованного личного конверта, и
 * приходят в `messaging.ts` уже расшифрованными. Поля `type`, на которое ветка
 * смотрела, нет ни в `GroupMsgEnvelope`, ни в `GroupCtlEnvelope`, ни во внешнем
 * конверте провода. Совпасть регулярное выражение могло только с подделкой.
 *
 * Правка: ветка убрана из обоих координаторов, а вместе с ней — служба-обёртка
 * `getGroupMessagingService` в `groupMessaging.ts`, чтобы её не подключили
 * обратно. Кадр, назвавшийся групповым, теперь разбирается как личный: не
 * расшифруется — будет отброшен.
 *
 * Границы: разбор группового конверта (`handleIncomingGroupEnvelope`) остаётся
 * на месте и работает как раньше. Меняется только то, кто имеет право его
 * позвать: единственный вход — расшифрованный личный конверт.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

/** Только код: комментарии не должны сами удовлетворять проверку. */
const codeOnly = (src: string) =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('{/*');
    })
    .join('\n');

const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');

const LAN = codeOnly(read('lan', 'lanCoordinator.ts'));
const NET = codeOnly(read('internet', 'internetCoordinator.ts'));
const GM = codeOnly(read('..', 'social', 'groupMessaging.ts'));
const MSG = codeOnly(read('..', 'social', 'messaging.ts'));

describe('координаторы не угадывают групповой конверт по тексту кадра', () => {
  it.each([
    ['LAN', LAN],
    ['интернет', NET],
  ])('%s: сырой кадр не проверяется на «type»:«group»', (_name, src) => {
    expect(src).not.toContain('"type"');
    expect(src).not.toContain('isGroupEnvelope');
  });

  it.each([
    ['LAN', LAN],
    ['интернет', NET],
  ])('%s: разбор группы из координатора не зовётся', (_name, src) => {
    expect(src).not.toContain('receiveGroupEnvelope');
    expect(src).not.toContain('getGroupMessagingService');
    expect(src).not.toContain('groupMessaging');
  });
});

describe('службы-обёртки вокруг разбора группы больше нет', () => {
  it('groupMessaging её не отдаёт', () => {
    expect(GM).not.toContain('getGroupMessagingService');
    expect(GM).not.toContain('GroupMessagingService');
    expect(GM).not.toContain('receiveGroupEnvelope');
  });

  it('и предупреждения о ненайденной службе — тоже: звать её стало неоткуда', () => {
    expect(GM).not.toContain('group_envelope_no_service_drop');
  });

  it('второго входа в разбор группы не осталось: сам файл его не зовёт', () => {
    // В groupMessaging остаётся только объявление обработчика. Вызывала его
    // здесь служба-обёртка — в обход расшифровки; теперь вызовов нет.
    expect(GM.match(/handleIncomingGroupEnvelope\(/g) ?? []).toHaveLength(1);
    expect(GM).toContain('export async function handleIncomingGroupEnvelope(');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: сам разбор группы на месте', () => {
  it('единственный вход — messaging, и он стоит после расшифровки', () => {
    const at = MSG.indexOf('await handleIncomingGroupEnvelope(');
    expect(at).toBeGreaterThan(0);
    // Дальше этого вызова в файле его больше нет: вход ровно один.
    expect(MSG.indexOf('await handleIncomingGroupEnvelope(', at + 1)).toBe(-1);
    // Он стоит после расшифровки: `payload` разобран из `pt`, а `pt` — из
    // `decryptSymmetric`, без которого разбор возвращается раньше.
    const decryptAt = MSG.lastIndexOf('pt = decryptSymmetric(sym, em.encryptedContent);', at);
    expect(decryptAt).toBeGreaterThan(0);
    expect(MSG.slice(decryptAt, at)).toContain('JSON.parse(new TextDecoder().decode(pt))');
  });

  it('обработчик существует и проверяет подпись отправителя', () => {
    expect(GM).toContain('export async function handleIncomingGroupEnvelope(');
    expect(GM).toContain('senderPubB64');
  });

  it('оба координатора по-прежнему разбирают ленту и личный конверт', () => {
    for (const src of [LAN, NET]) {
      expect(src).toContain('isFeedFrame(payload)');
      expect(src).toContain('receiveDirectLanEnvelope');
    }
  });

  it('отправитель берётся из ключа, которым конверт расшифрован, а не из заголовка', () => {
    expect(MSG).toContain(
      'await handleIncomingGroupEnvelope(textPayload.text, await this.groupRecipient(), peerPubKeyB64)'
    );
    // `senderDid` — незаверенное поле кадра; в разбор группы оно не попадает.
    expect(MSG).not.toContain('handleIncomingGroupEnvelope(payload, senderDid');
  });

  it('группа отправляется по-прежнему — внутри личного конверта', () => {
    expect(MSG).toContain("textPayload.text?.startsWith('\\x02grp:')");
  });
});
