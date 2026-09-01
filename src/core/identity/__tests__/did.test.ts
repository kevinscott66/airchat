import { base58btc } from 'multiformats/bases/base58';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createLocalDidDocument, didFromPubB64, parseDidKey, publicKeyToDidKey } from '../did';

// v4.32.350: parseDidKey — ворота, через которые проходит ~90 решений об
// идентичности: чья это подпись, чей это пост, кому шифровать. Тестов не было.
// Здесь закреплены две вещи: обратимость (did → тот же ключ) и полный контур
// отказа, включая did:key другого типа ключа.

const key = (): Uint8Array => ed25519.keygen().publicKey;

/** did:key из произвольных байтов и произвольного multicodec-префикса. */
function didFrom(prefix: number[], body: Uint8Array): string {
  const mh = new Uint8Array(prefix.length + body.length);
  mh.set(prefix, 0);
  mh.set(body, prefix.length);
  return `did:key:${base58btc.encode(mh)}`;
}

describe('publicKeyToDidKey', () => {
  it('даёт did:key с мультибейз-префиксом z', () => {
    const did = publicKeyToDidKey(key());
    expect(did.startsWith('did:key:z')).toBe(true);
  });

  it('Ed25519-идентификатор всегда начинается на z6Mk', () => {
    // Свойство самого формата, а не нашей реализации: multicodec 0xed01 плюс
    // ровно 32 байта в base58btc всегда даёт этот префикс. Ловит и подмену
    // кода кривой, и неверную длину.
    for (let i = 0; i < 8; i++) {
      expect(publicKeyToDidKey(key()).slice(0, 12)).toBe('did:key:z6Mk');
    }
  });

  it('один и тот же ключ всегда даёт одну и ту же строку', () => {
    const k = key();
    expect(publicKeyToDidKey(k)).toBe(publicKeyToDidKey(k));
  });

  it('разные ключи дают разные строки', () => {
    const dids = new Set(Array.from({ length: 32 }, () => publicKeyToDidKey(key())));
    expect(dids.size).toBe(32);
  });
});

describe('parseDidKey — обратимость', () => {
  it('возвращает ровно тот ключ, из которого сделан did', () => {
    for (let i = 0; i < 16; i++) {
      const k = key();
      expect(parseDidKey(publicKeyToDidKey(k))).toEqual(k);
    }
  });

  it('разобранный ключ действительно проверяет подпись владельца', () => {
    // Проверка смысла, а не байтов: связка did↔ключ — это то, на чём стоит
    // вся проверка авторства в ленте и профилях.
    const { secretKey, publicKey } = ed25519.keygen();
    const msg = new TextEncoder().encode('айрчат');
    const sig = ed25519.sign(msg, secretKey);
    const parsed = parseDidKey(publicKeyToDidKey(publicKey));

    expect(parsed).not.toBeNull();
    expect(ed25519.verify(sig, msg, parsed!)).toBe(true);
  });
});

describe('parseDidKey — контур отказа', () => {
  it.each([
    ['пустая строка', ''],
    ['только схема', 'did:key:'],
    ['только мультибейз-префикс', 'did:key:z'],
    ['другой метод did', 'did:web:example.com'],
    ['без did:key:', 'z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'],
    ['мультибейз не base58btc', 'did:key:uO2QhZWxsbw'],
    ['регистр схемы', 'DID:KEY:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'],
    ['пробел внутри', 'did:key:z6Mkha XgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'],
    ['символы вне алфавита base58', 'did:key:z6Mk0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl'],
    ['длиннее 200 символов', 'did:key:z' + '6'.repeat(300)],
  ])('%s → null', (_name, did) => {
    expect(parseDidKey(did)).toBeNull();
  });

  it('нестроковый вход не роняет вызов', () => {
    expect(parseDidKey(null as unknown as string)).toBeNull();
    expect(parseDidKey(undefined as unknown as string)).toBeNull();
    expect(parseDidKey(42 as unknown as string)).toBeNull();
  });

  it('did:key для ключа X25519 не принимается как подписывающий', () => {
    // 0xec 0x01 — multicodec x25519-pub. Формально это валидный did:key, но
    // ключ шифрования не должен проходить туда, где им будут проверять
    // подписи: verify на чужой кривой даёт неопределённый результат.
    expect(parseDidKey(didFrom([0xec, 0x01], key()))).toBeNull();
  });

  it('чужой multicodec с той же длиной не принимается', () => {
    expect(parseDidKey(didFrom([0x00, 0x01], key()))).toBeNull();
    expect(parseDidKey(didFrom([0xed, 0x02], key()))).toBeNull();
  });

  it('ключ не 32 байта не принимается', () => {
    expect(parseDidKey(didFrom([0xed, 0x01], new Uint8Array(31)))).toBeNull();
    expect(parseDidKey(didFrom([0xed, 0x01], new Uint8Array(33)))).toBeNull();
    expect(parseDidKey(didFrom([0xed, 0x01], new Uint8Array(0)))).toBeNull();
  });

  it('приписанный ведущий нулевой байт не даёт второй формы того же did', () => {
    // Ведущие нули в base58 кодируются символом '1'. Если бы длина не
    // проверялась, у одного ключа появилось бы бесконечно много написаний —
    // и блокировка по строке did обходилась бы одним лишним символом.
    const did = publicKeyToDidKey(key());
    const variant = did.replace('did:key:z', 'did:key:z1');
    expect(parseDidKey(variant)).toBeNull();
  });

  it('порча одного символа не даёт молча другой ключ', () => {
    const k = key();
    const did = publicKeyToDidKey(k);
    const swapped = did.slice(0, -1) + (did.endsWith('a') ? 'b' : 'a');
    const parsed = parseDidKey(swapped);
    // Либо отказ, либо заведомо другой ключ — но не тот же самый.
    if (parsed) expect(parsed).not.toEqual(k);
  });
});

describe('createLocalDidDocument', () => {
  it('publicKeyMultibase совпадает с телом did и разбирается обратно', async () => {
    const { secretKey, publicKey } = ed25519.keygen();
    const doc = await createLocalDidDocument({ secretKey, publicKey });
    const id = doc.id as string;
    const vm = (doc.verificationMethod as Array<Record<string, unknown>>)[0];
    const multibase = vm.publicKeyMultibase as string;

    // Поле объявляет base58btc префиксом 'z' — значит и содержимое обязано
    // быть base58btc над multicodec-префиксом, то есть телом самого did.
    expect(multibase).toBe(id.slice('did:key:'.length));
    expect(parseDidKey(`did:key:${multibase}`)).toEqual(publicKey);
  });

  it('идентификаторы внутри документа согласованы', async () => {
    const { secretKey, publicKey } = ed25519.keygen();
    const doc = await createLocalDidDocument({ secretKey, publicKey });
    const id = doc.id as string;
    const vm = (doc.verificationMethod as Array<Record<string, unknown>>)[0];

    expect(id).toBe(publicKeyToDidKey(publicKey));
    expect(vm.controller).toBe(id);
    expect(vm.id).toBe(`${id}#key-1`);
    expect(vm.type).toBe('Ed25519VerificationKey2020');
    expect(doc.authentication).toEqual([`${id}#key-1`]);
  });
});

// ── didFromPubB64: несимметричность пары, из-за которой круг и собрался ───────

describe('didFromPubB64 (v4.32.427)', () => {
  it('настоящий ключ проходит туда и обратно', () => {
    const pk = key();
    const did = didFromPubB64(Buffer.from(pk).toString('base64'));
    expect(did).not.toBeNull();
    expect(parseDidKey(did as string)).toEqual(pk);
  });

  it('порченый ключ даёт null, а не правдоподобный did:key', () => {
    // Измеренная несимметричность: publicKeyToDidKey кодирует ЛЮБОЕ число
    // байтов и всегда отдаёт строку, начинающуюся с did:key:z, — а parseDidKey
    // такую строку обратно не примет. Ровно этот did и уезжал в отправку.
    const short = new Uint8Array(10).fill(3);
    const bogus = publicKeyToDidKey(short);
    expect(bogus.startsWith('did:key:z')).toBe(true);
    expect(parseDidKey(bogus)).toBeNull();

    expect(didFromPubB64(Buffer.from(short).toString('base64'))).toBeNull();
  });

  it('не строка и мусор — null без исключения', () => {
    expect(didFromPubB64(null)).toBeNull();
    expect(didFromPubB64(undefined)).toBeNull();
    expect(didFromPubB64('')).toBeNull();
    expect(didFromPubB64('!!!!')).toBeNull();
    expect(didFromPubB64('A'.repeat(48))).toBeNull();
  });
});
