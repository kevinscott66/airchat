/**
 * Пачка отметок о прочтении и приёмные конверты группы (v4.32.507).
 *
 * Проверяется правило, а не его пересказ: сколько идентификаторов доедет до
 * базы, что произойдёт с повторами и мусором, и — по форме исходников — что
 * оба конца пользуются одним потолком, а групповые конверты разбираются
 * общим readEnvelopeBody и не принимают отметку от постороннего.
 */
import fs from 'fs';
import path from 'path';
import {
  MAX_RECEIPT_IDS,
  MAX_RECEIPT_ID_LEN,
  receiptOverflowCount,
  sanitizeReceiptIds,
} from '../receiptBatch';

const SRC = path.join(__dirname, '..', '..', '..');

describe('sanitizeReceiptIds — что доедет до базы', () => {
  test('обычная пачка проходит как есть', () => {
    expect(sanitizeReceiptIds(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  test('не массив — пустой список, а не бросок', () => {
    expect(sanitizeReceiptIds(null)).toEqual([]);
    expect(sanitizeReceiptIds(undefined)).toEqual([]);
    expect(sanitizeReceiptIds('abc')).toEqual([]);
    expect(sanitizeReceiptIds(42)).toEqual([]);
    expect(sanitizeReceiptIds({ 0: 'a', length: 1 })).toEqual([]);
  });

  test('нестроковые элементы отбрасываются', () => {
    expect(sanitizeReceiptIds(['a', 1, null, undefined, {}, [], 'b'])).toEqual(['a', 'b']);
  });

  test('пустая строка не идёт в базу', () => {
    expect(sanitizeReceiptIds(['', 'a', ''])).toEqual(['a']);
  });

  test('слишком длинный идентификатор отбрасывается', () => {
    const ok = 'x'.repeat(MAX_RECEIPT_ID_LEN);
    const tooLong = 'x'.repeat(MAX_RECEIPT_ID_LEN + 1);
    expect(sanitizeReceiptIds([ok, tooLong])).toEqual([ok]);
  });

  test('повторы схлопываются — одна строка не стоит тысячу запросов', () => {
    // Ровно тот дефект: конверт из одного идентификатора, повторённого сто
    // тысяч раз, стоил сто тысяч последовательных чтений из SQLite.
    const raw = Array.from({ length: 100_000 }, () => 'same');
    expect(sanitizeReceiptIds(raw)).toEqual(['same']);
  });

  test('потолок отсекает хвост, голова остаётся', () => {
    const raw = Array.from({ length: MAX_RECEIPT_IDS + 50 }, (_, i) => `m${i}`);
    const out = sanitizeReceiptIds(raw);
    expect(out).toHaveLength(MAX_RECEIPT_IDS);
    expect(out[0]).toBe('m0');
    expect(out[MAX_RECEIPT_IDS - 1]).toBe(`m${MAX_RECEIPT_IDS - 1}`);
  });

  test('огромный конверт не выносит наружу больше потолка', () => {
    const raw = Array.from({ length: 100_000 }, (_, i) => `m${i}`);
    expect(sanitizeReceiptIds(raw)).toHaveLength(MAX_RECEIPT_IDS);
  });

  test('порядок сохраняется', () => {
    expect(sanitizeReceiptIds(['c', 'a', 'b'])).toEqual(['c', 'a', 'b']);
  });

  test('повтор не съедает место у следующего', () => {
    expect(sanitizeReceiptIds(['a', 'a', 'b'], 2)).toEqual(['a', 'b']);
  });

  test('свой потолок уважается, мусорный — нет', () => {
    expect(sanitizeReceiptIds(['a', 'b', 'c'], 2)).toEqual(['a', 'b']);
    expect(sanitizeReceiptIds(['a', 'b', 'c'], 0)).toHaveLength(3);
    expect(sanitizeReceiptIds(['a', 'b', 'c'], -1)).toHaveLength(3);
    expect(sanitizeReceiptIds(['a', 'b', 'c'], Number.NaN)).toHaveLength(3);
  });

  test('исходный массив не меняется', () => {
    const raw = ['a', 'a', 'b'];
    sanitizeReceiptIds(raw);
    expect(raw).toEqual(['a', 'a', 'b']);
  });

  test('пустой массив остаётся пустым', () => {
    expect(sanitizeReceiptIds([])).toEqual([]);
  });

  test('потолок по умолчанию не меньше страницы переписки', () => {
    expect(MAX_RECEIPT_IDS).toBeGreaterThanOrEqual(100);
  });
});

describe('receiptOverflowCount — что попадёт в журнал', () => {
  test('ничего не отброшено — ноль', () => {
    expect(receiptOverflowCount(['a', 'b'], 2)).toBe(0);
  });

  test('видно разницу между «двести» и «сто тысяч»', () => {
    const raw = Array.from({ length: 100_000 }, (_, i) => `m${i}`);
    expect(receiptOverflowCount(raw, MAX_RECEIPT_IDS)).toBe(100_000 - MAX_RECEIPT_IDS);
  });

  test('не массив — ноль', () => {
    expect(receiptOverflowCount('nope', 0)).toBe(0);
  });

  test('отрицательная разница не выносится наружу', () => {
    expect(receiptOverflowCount(['a'], 5)).toBe(0);
  });
});

describe('форма исходников — v4.32.507', () => {
  const messaging = fs.readFileSync(path.join(SRC, 'core', 'social', 'messaging.ts'), 'utf8');
  const group = fs.readFileSync(path.join(SRC, 'core', 'social', 'groupMessaging.ts'), 'utf8');
  const mod = fs.readFileSync(path.join(SRC, 'core', 'social', 'receiptBatch.ts'), 'utf8');

  test('модуль без импортов', () => {
    expect(mod).not.toMatch(/^import\s/m);
    expect(mod).not.toContain('require(');
  });

  test('приём отметок идёт по очищенному списку, а не по конверту', () => {
    expect(messaging).toContain('const ids = sanitizeReceiptIds(payload.messageIds);');
    expect(messaging).not.toContain('for (const msgId of payload.messageIds)');
  });

  test('отправка кладёт в конверт не больше того же потолка', () => {
    expect(messaging).toContain(
      'const ids = sanitizeReceiptIds(Array.isArray(messageId) ? messageId : [messageId]);'
    );
  });

  test('переполнение видно в журнале', () => {
    expect(messaging).toContain("log.warn('read_receipts_oversized_drop'");
  });

  test('групповая отметка принимается только от участника', () => {
    // v4.32.748: различающей формой — нечитаемый состав больше не выдаётся
    // за «отправитель здесь не состоит».
    expect(group).toContain('await lookupGroupActorRead(env.groupId, env.viewerPubB64, pid);');
    expect(group).toContain("log.warn('group_read_receipt_nonmember_drop'");
    expect(group).toContain('if (!actor.group || actor.role === null)');
  });

  test('групповые конверты разбираются общим readEnvelopeBody', () => {
    expect(group).toContain(
      'readEnvelopeBody<GroupReadReceiptEnvelope>(text, GROUP_READ_RECEIPT_PREFIX, 16 * 1024)'
    );
    expect(group).toContain(
      'readEnvelopeBody<GroupJoinRequestEnvelope>(text, GROUP_JOIN_REQUEST_PREFIX, 32 * 1024)'
    );
  });

  test('ручного JSON.parse тела конверта в social не осталось', () => {
    const dir = path.join(SRC, 'core', 'social');
    const offenders = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.ts') && n !== 'envelopeBody.ts')
      .filter((n) => {
        const body = fs.readFileSync(path.join(dir, n), 'utf8');
        // Комментарии не в счёт: правило про код, а не про рассказ о коде.
        return body
          .split('\n')
          .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
          .some((l) => l.includes('JSON.parse(text.slice('));
      });
    expect(offenders).toEqual([]);
  });

  test('после проверки префикса приёмник конверт уже не отдаёт обратно', () => {
    // `return false` значило «это не мой конверт» и отправляло служебный текст
    // в переписку как обычное сообщение.
    //
    // v4.32.748: такого выхода у отметки не осталось вовсе — она отвечает
    // вердиктом, и оба его слова, `'consumed'` и `'deferred'`, значат «конверт
    // мой». Правило не ослабло, а стало строже, ровно как у заявки ниже.
    const at = group.indexOf('export async function handleIncomingGroupReadReceipt');
    expect(at).toBeGreaterThan(0);
    const body = group.slice(at, group.indexOf('\n}\n', at));
    expect(body.match(/return false;/g)).toBeNull();
    expect(body).toContain("if (!text.startsWith(GROUP_READ_RECEIPT_PREFIX)) return 'consumed';");

    // v4.32.738: у заявки на вступление такого выхода не осталось вовсе. Она
    // отвечает вердиктом, и оба его слова — `'consumed'` и `'deferred'` —
    // значат «конверт мой». Правило не ослабло, а стало строже: вернуть
    // служебный текст в переписку ей теперь нечем. Проверка префикса на месте
    // страховкой — приёмник проверяет его до вызова.
    const jr = group.indexOf('export async function handleIncomingGroupJoinRequest');
    expect(jr).toBeGreaterThan(0);
    const jrBody = group.slice(jr, group.indexOf('\n}\n', jr));
    expect(jrBody.match(/return false;/g)).toBeNull();
    expect(jrBody).toContain("if (!text.startsWith(GROUP_JOIN_REQUEST_PREFIX)) return 'consumed';");
  });
});
