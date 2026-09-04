/**
 * v4.32.581 — рэтчет: границы доверия не разыменовывают разобранный JSON вслепую.
 *
 * `JSON.parse` возвращает `any`. Приведение `as SomeShape` сразу после него —
 * это заявление о наших намерениях, а не проверка того, что прислали. Четыре
 * байта `null`, число, массив — валидный JSON, try/catch вокруг разбора их
 * пропускает, а первое же обращение к полю ниже роняет вызов исключением.
 *
 * Три места, где такой разбор приходит с чужой стороны, закрыты проверкой
 * «объект и не массив». Инстанцировать эти модули в jest нечем — они тянут за
 * собой сеть, ключи и хранилище целиком, — поэтому проверка идёт по исходнику,
 * как в остальных рэтчетах этого репозитория (см. feedFlushTimeout).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (rel: string): string => readFileSync(join(__dirname, rel), 'utf8');

const MESSAGING = read('../messaging.ts');
const FEED = read('../feedService.ts');
const CONTACTS = read('../contacts.ts');

/** Индекс единственного вхождения, иначе -1. */
const only = (hay: string, needle: string): number => {
  const i = hay.indexOf(needle);
  return i >= 0 && hay.indexOf(needle, i + 1) < 0 ? i : -1;
};

const NOT_OBJECT = "typeof payload !== 'object' || Array.isArray(payload)";

describe('D1 — полезная нагрузка личного сообщения', () => {
  it('проверяется на объект до первого обращения к полю', () => {
    const guard = only(MESSAGING, NOT_OBJECT);
    expect(guard).toBeGreaterThan(0);
    // Разбор — выше проверки, разыменование — ниже.
    const parse = MESSAGING.indexOf('JSON.parse', MESSAGING.lastIndexOf('persistIncomingFromEnvelope'));
    expect(parse).toBeGreaterThan(0);
  });

  it('негодный конверт не остаётся помеченным как виденный', () => {
    const guard = MESSAGING.indexOf(NOT_OBJECT);
    const tail = MESSAGING.slice(guard, guard + 400);
    // Иначе повторная доставка того же сообщения молча отбрасывалась бы
    // дедупликацией, и починка отправителя ничего бы не изменила.
    expect(tail).toContain('this.seenMessageIds.delete(em.messageId)');
    expect(tail).toContain('return;');
  });
});

describe('D4 — вложение ленты', () => {
  it('ни один разбор не берёт data приведением', () => {
    expect(FEED).not.toMatch(/const d = payload\.data as /);
  });

  it('все разборы идут через общий помощник и выходят на пустом', () => {
    const calls = FEED.match(/const d = feedEnvelopeData</g) ?? [];
    expect(calls).toHaveLength(9);
    // У каждого вызова сразу за ним — выход из ветки.
    for (const m of FEED.matchAll(/const d = feedEnvelopeData<[^>]+>\(payload\);\n(\s*)if \(!d\) break;/g)) {
      expect(m[0]).toContain('if (!d) break;');
    }
    expect([...FEED.matchAll(/if \(!d\) break;/g)]).toHaveLength(9);
  });

  it('помощник отбрасывает не только null', () => {
    const h = FEED.slice(FEED.indexOf('function feedEnvelopeData'));
    expect(h.slice(0, 400)).toContain("typeof d !== 'object' || Array.isArray(d)");
  });
});

describe('D6 — запись контакта при переименовании', () => {
  it('пустая строка не доходит до JSON.parse', () => {
    const fn = CONTACTS.slice(CONTACTS.indexOf('export async function renameContact'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    const empty = body.indexOf('!row.trim()');
    const parse = body.indexOf('JSON.parse(row)');
    expect(empty).toBeGreaterThan(0);
    expect(parse).toBeGreaterThan(empty);
  });

  it('результат разбора проверяется до присвоения поля', () => {
    const fn = CONTACTS.slice(CONTACTS.indexOf('export async function renameContact'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    const guard = body.indexOf("typeof j !== 'object' || Array.isArray(j)");
    expect(guard).toBeGreaterThan(body.indexOf('JSON.parse(row)'));
    expect(body.indexOf('j.displayName =')).toBeGreaterThan(guard);
  });
});
