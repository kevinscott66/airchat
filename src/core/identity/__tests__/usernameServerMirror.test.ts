/**
 * Клиент и сервер должны отвечать на одно имя одинаково (v4.32.615).
 *
 * Список зарезервированных имён продублирован намеренно — сервер живёт
 * отдельным процессом на CommonJS, — и его расхождение ловит серверный тест
 * `username-registry.test.js`. Но он сверяет ТОЛЬКО множество имён: правило,
 * записанное регулярным выражением, для него невидимо. Так и разъехалось
 * `digits_only`: клиент отвергает `@12345` с v4.32.594, а сервер выдавал его
 * — то есть пересобранное приложение получало ровно то имя, ради запрета
 * которого правило и написано.
 *
 * Поэтому здесь сверяются не списки, а ОТВЕТЫ на общий набор имён. Серверный
 * модуль на CommonJS без зависимостей, его можно позвать прямо отсюда.
 */
import { checkUsernameClaim } from '../reservedUsernames';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const server = require('../../../../server/cloud-vault/reserved-usernames.js') as {
  normalizeClaimableUsername: (value: unknown, unlocked?: unknown) => string | null;
};

/** Имя, разрешение по бумаге, ожидаемое каноническое имя либо `null` — отказ. */
type Vector = [name: unknown, unlocked: string | undefined, expected: string | null];

const VECTORS: Vector[] = [
  [' @Kevin_S ', undefined, 'kevin_s'],
  ['@@bob_x', undefined, 'bob_x'],
  ['abcde', undefined, 'abcde'],
  ['a'.repeat(32), undefined, 'a'.repeat(32)],
  ['a'.repeat(33), undefined, null],
  ['abcd', undefined, null],
  ['nft', undefined, null],
  ['support', undefined, null],
  ['founder', 'founder', 'founder'],
  ['founder', 'support', null],
  ['нет', undefined, null],
  ['', undefined, null],
  ['   ', undefined, null],
  [42, undefined, null],
  [null, undefined, null],
  // Цифровые имена: ни своей рукой, ни по бумаге, ни в верхней границе длины.
  ['12345', undefined, null],
  ['1', undefined, null],
  ['0'.repeat(32), undefined, null],
  ['12345', '12345', null],
  // А цифры в имени — можно: запрещено только имя ЦЕЛИКОМ из цифр.
  ['a12345', undefined, 'a12345'],
  ['12345a', undefined, '12345a'],
  ['123_45', undefined, '123_45'],
];

const client = (name: unknown, unlocked?: string): string | null => {
  const r = checkUsernameClaim(name, unlocked);
  return r.ok ? r.username : null;
};

describe('клиент и сервер отвечают на имя одинаково', () => {
  for (const [name, unlocked, expected] of VECTORS) {
    const label = `${JSON.stringify(name)}${unlocked ? ` (бумага «${unlocked}»)` : ''}`;
    it(`${label} → ${expected ?? 'отказ'}`, () => {
      expect(client(name, unlocked)).toBe(expected);
      expect(server.normalizeClaimableUsername(name, unlocked)).toBe(expected);
    });
  }

  it('набор проверяет обе стороны правила, а не только отказы', () => {
    expect(VECTORS.filter(([, , e]) => e !== null).length).toBeGreaterThan(5);
    expect(VECTORS.filter(([, , e]) => e === null).length).toBeGreaterThan(5);
  });
});
