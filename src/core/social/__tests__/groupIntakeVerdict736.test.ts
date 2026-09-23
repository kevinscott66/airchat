/**
 * v4.32.736: «сейчас не смогли» у группового сообщения перестало теряться.
 *
 * Дефект. Групповое сообщение едет к участнику обычным личным конвертом с
 * префиксом `\x02grp:` — это основной и почти единственный его путь.
 * Обработчик группы умеет ответить `'deferred'`: состав группы не прочитался,
 * проверить право отправителя писать нечем, и записывать сообщение нельзя
 * (v4.32.648, v4.32.730). Ответ означает «перезапросить», и relay держит кадр
 * тридцать суток именно ради этого.
 *
 * Ответ выбрасывался. `persistIncomingFromEnvelope` был объявлен как
 * `Promise<void>`, вызов обработчика стоял отдельным `await` без присваивания,
 * а `receiveDirectLanEnvelope` дальше отвечал `'consumed'` буквой — всегда.
 * Координатор интернета верит этому слову и двигает отметку «докуда
 * прочитано»: кадр, лежащий на relay ещё месяц, не запрашивался больше
 * никогда. У отправителя — «Доставлено», у получателя — ничего, ни сейчас, ни
 * потом. Хватало секундной заминки локальной базы на приёме.
 *
 * Проверка идёт по исходнику: `messaging.ts` тянет `uuid`, который приходит
 * как ESM и не проходит трансформацию jest, — тот же довод, что в
 * `contactsUnreadableLoss724.test.ts`. Другая половина этой дороги — что
 * координатор действительно удерживает отметку на `'deferred'` — проверена
 * поведением в `transport/internet/__tests__/backlogIntake730.test.ts`.
 */

import fs from 'fs';
import path from 'path';

const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

/** Только код: комментарии не должны сами удовлетворять проверку. */
const codeOnly = (src: string) =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const MSG = codeOnly(read('messaging.ts'));
const GRP = codeOnly(read('groupMessaging.ts'));

/** Кусок исходника от объявления до СЛЕДУЮЩЕГО объявления, не дальше. */
const between = (src: string, start: string, end: string): string => {
  const a = src.indexOf(start);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(end, a);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
};

const PERSIST = between(
  MSG,
  'private async persistIncomingFromEnvelope(',
  'private async uploadMediaFromUri('
);

describe('разбор конверта отвечает словом', () => {
  it('объявление обещает вердикт, а не молчание', () => {
    expect(PERSIST).toContain('): Promise<EnvelopeIntake> {');
    // Прежняя форма — та, в которой ответить было нечем.
    expect(PERSIST).not.toContain('): Promise<void> {');
  });

  it('ни один выход не остался немым', () => {
    // `return;` внутри разбора означал бы выход, снаружи неотличимый от
    // удачи, — ровно тот, из-за которого и терялось групповое сообщение.
    expect(PERSIST).not.toMatch(/\breturn;/);
    // И выход по концу тела тоже назван словом.
    expect(PERSIST.trimEnd().endsWith("return 'consumed';\n  }")).toBe(true);
  });
});

describe('ответ обработчика группы доходит наружу', () => {
  const BRANCH = between(MSG, "if (textPayload.text?.startsWith('\\x02grp:')) {", 'GROUP_READ_RECEIPT_PREFIX');

  it('вердикт обработчика возвращается, а не выбрасывается', () => {
    expect(BRANCH).toContain(
      'return await handleIncomingGroupEnvelope(textPayload.text, await this.groupRecipient(), peerPubKeyB64);'
    );
    // Прежняя форма: вызов ради вызова, ответ в никуда.
    expect(BRANCH).not.toContain('if (inbound) await handleIncomingGroupEnvelope(');
  });

  it('своё эхо разобрано по определению и отвечает отдельно', () => {
    expect(BRANCH).toContain("if (!inbound) return 'consumed';");
  });

  it('приём по локальной сети отдаёт ответ разбора, а не свою букву', () => {
    const LAN = between(MSG, 'const storageCid = `lan:${em.messageId}`;', 'private async persistIncomingFromEnvelope(');
    expect(LAN).toContain(
      'return await this.persistIncomingFromEnvelope(em, peerPubKeyB64, storageCid, pt);'
    );
    // Прежняя форма: разбор отдельно, ответ отдельно и всегда один и тот же.
    expect(LAN).not.toContain("await this.persistIncomingFromEnvelope(em, peerPubKeyB64, storageCid, pt);\n    return 'consumed';");
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: обработчику группы есть что ответить', () => {
  it('нечитаемый состав — это «перезапросить», и так было до правки', () => {
    const HANDLER = between(
      GRP,
      'export async function handleIncomingGroupEnvelope(',
      "export const GROUP_JOIN_REQUEST_PREFIX"
    );
    expect(HANDLER).toContain("const members = await listGroupMembersRead(env.groupId, pid);");
    expect(HANDLER).toContain("log.warn('group_msg_verdict_failed_drop', {");
    expect(HANDLER).toContain("return 'deferred';");
  });
});
