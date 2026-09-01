import { ed25519 } from '@noble/curves/ed25519.js';
import { signBytes, signJson, verifyBytes, verifySignedJson } from '../signature';
import type { KeyPairBytes } from '../keyManager';

// v4.32.349: у модуля, через который проходит КАЖДЫЙ подписанный конверт —
// профили, посты ленты, подсказки диалогов, — не было ни одного теста.
// Здесь закреплены три вещи: подпись действительно проверяется, канонизация
// взаимно однозначна (разные нагрузки не могут разделить одну подпись) и
// мусор на входе отсекается до обращения к кривой.

function keys(): KeyPairBytes {
  const { secretKey, publicKey } = ed25519.keygen();
  return { secretKey, publicKey };
}

const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('signBytes / verifyBytes', () => {
  it('своя подпись проверяется, чужая — нет', async () => {
    const a = keys();
    const b = keys();
    const msg = utf8('привет');
    const sig = await signBytes(a.secretKey, msg);

    expect(await verifyBytes(a.publicKey, msg, sig)).toBe(true);
    expect(await verifyBytes(b.publicKey, msg, sig)).toBe(false);
  });

  it('изменённое сообщение не проходит', async () => {
    const a = keys();
    const sig = await signBytes(a.secretKey, utf8('перевести 10'));
    expect(await verifyBytes(a.publicKey, utf8('перевести 20'), sig)).toBe(false);
  });

  it('подпись неверной длины даёт false, а не исключение', async () => {
    const a = keys();
    // ed25519.verify бросает на 63 байтах; verifyBytes обязан это погасить —
    // иначе один битый конверт с релея роняет разбор всей пачки.
    await expect(verifyBytes(a.publicKey, utf8('x'), new Uint8Array(63))).resolves.toBe(false);
  });
});

describe('signJson / verifySignedJson', () => {
  it('нагрузка возвращается как была', async () => {
    const a = keys();
    const payload = { did: 'did:key:z6Mk', n: 7, ok: true, tags: ['a', 'b'] };
    const env = await signJson(a, payload);

    expect(await verifySignedJson(a.publicKey, env)).toEqual(payload);
  });

  it('правка нагрузки ломает подпись', async () => {
    const a = keys();
    const env = await signJson(a, { amount: 10 });
    const tampered = { ...env, payload: env.payload.replace('10', '20') };

    expect(await verifySignedJson(a.publicKey, tampered)).toBeNull();
  });

  it('чужой ключ не подходит', async () => {
    const a = keys();
    const b = keys();
    const env = await signJson(a, { hello: 'world' });

    expect(await verifySignedJson(b.publicKey, env)).toBeNull();
  });

  it('порядок ключей на входе не влияет на подписанные байты', async () => {
    const a = keys();
    const first = await signJson(a, { b: 2, a: 1, c: 3 });
    const second = await signJson(a, { c: 3, a: 1, b: 2 });

    expect(first.payload).toBe(second.payload);
    expect(first.signature).toBe(second.signature);
  });

  it('вложенные объекты тоже сортируются, а массивы сохраняют порядок', async () => {
    const a = keys();
    const env = await signJson(a, { z: { y: 1, x: { w: 2, v: 3 } }, list: ['b', 'a'] });

    expect(env.payload).toBe('{"list":["b","a"],"z":{"x":{"v":3,"w":2},"y":1}}');
  });
});

describe('канонизация и __proto__', () => {
  it('ключ __proto__ попадает в подписанные байты, а не растворяется', async () => {
    const a = keys();
    // JSON.parse кладёт __proto__ собственным свойством — так этот ключ и
    // приходит с сети. Раньше накопителем был обычный {}, присваивание меняло
    // прототип, и ключ исчезал из результата.
    const hostile = JSON.parse('{"__proto__":{"isAdmin":true},"a":1}') as Record<string, unknown>;
    const env = await signJson(a, hostile);

    expect(env.payload).toContain('__proto__');
    expect(env.payload).toBe('{"__proto__":{"isAdmin":true},"a":1}');
  });

  it('две разные нагрузки не разделяют одну подпись', async () => {
    const a = keys();
    const hostile = JSON.parse('{"__proto__":{"isAdmin":true},"a":1}') as Record<string, unknown>;
    const plain = { a: 1 };

    const hostileEnv = await signJson(a, hostile);
    const plainEnv = await signJson(a, plain);

    expect(hostileEnv.signature).not.toBe(plainEnv.signature);
    // И подпись безобидной нагрузки нельзя предъявить под враждебной.
    expect(
      await verifySignedJson(a.publicKey, { payload: hostileEnv.payload, signature: plainEnv.signature })
    ).toBeNull();
  });

  it('проверенный объект ничего не наследует от подложенного прототипа', async () => {
    const a = keys();
    const hostile = JSON.parse('{"__proto__":{"isAdmin":true},"a":1}') as Record<string, unknown>;
    const env = await signJson(a, hostile);
    const verified = await verifySignedJson(a.publicKey, env);

    expect(verified).not.toBeNull();
    expect((verified as Record<string, unknown> & { isAdmin?: unknown }).isAdmin).toBeUndefined();
    expect(Object.getPrototypeOf(verified)).toBe(Object.prototype);
    expect(({} as { isAdmin?: unknown }).isAdmin).toBeUndefined();
  });
});

describe('отсев мусора до обращения к кривой', () => {
  const a = keys();

  it.each([
    ['пустая подпись', { payload: '{"a":1}', signature: '' }],
    ['пустая нагрузка', { payload: '', signature: b64(new Uint8Array(64)) }],
    ['подпись длиннее 128 символов', { payload: '{"a":1}', signature: 'A'.repeat(129) }],
    ['нагрузка больше 64 КиБ', { payload: 'x'.repeat(64 * 1024 + 1), signature: b64(new Uint8Array(64)) }],
    ['подпись не 64 байта после base64', { payload: '{"a":1}', signature: b64(new Uint8Array(32)) }],
    ['подпись — не base64', { payload: '{"a":1}', signature: '!!!!' }],
  ])('%s → null', async (_name, envelope) => {
    expect(await verifySignedJson(a.publicKey, envelope)).toBeNull();
  });

  it.each([
    ['нестроковая подпись', { payload: '{"a":1}', signature: 42 as unknown as string }],
    ['нестроковая нагрузка', { payload: null as unknown as string, signature: b64(new Uint8Array(64)) }],
  ])('%s → null', async (_name, envelope) => {
    expect(await verifySignedJson(a.publicKey, envelope)).toBeNull();
  });

  it('публичный ключ не 32 байта → null', async () => {
    const env = await signJson(a, { a: 1 });
    expect(await verifySignedJson(new Uint8Array(31), env)).toBeNull();
    expect(await verifySignedJson(new Uint8Array(0), env)).toBeNull();
  });

  it('корректная подпись под не-JSON всё равно даёт null', async () => {
    // Подпись честная, ключ тот же — но разобрать нечего. Вызывающий код
    // рассчитывает на объект, поэтому пропускать такое нельзя.
    const payload = 'не json';
    const sig = await signBytes(a.secretKey, utf8(payload));

    expect(await verifyBytes(a.publicKey, utf8(payload), sig)).toBe(true);
    expect(await verifySignedJson(a.publicKey, { payload, signature: b64(sig) })).toBeNull();
  });
});
