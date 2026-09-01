/**
 * v4.32.520. Ключ к локальным данным один, и второго экземпляра у него нет.
 *
 * getOrCreateDataEncryptionKey получал из SecureStore null и в обоих смыслах
 * этого null — «записи нет» и «запись не прочиталась» — делал одно и то же:
 * заводил новый случайный ключ и записывал его поверх. Дальше вся переписка
 * читалась пустыми строками (decryptAtRestString при сбое отдаёт ''), а первая
 * же поставленная реакция шифровала эту пустоту новым ключом поверх настоящего
 * шифртекста. Третий шаг необратим.
 *
 * Разобрать эти случаи можно только по канарейке — известной строке,
 * зашифрованной самим ключом. Ниже проверяется и она, и разбор случаев, и то,
 * что источники не вернулись к прежнему поведению: половина веток случается
 * раз в жизни установки на чужом телефоне, увидеть их иначе нельзя.
 */
import fs from 'fs';
import path from 'path';
import { decideDek, type DekObservation } from '../dekPolicy';
import { AT_REST_PREFIX, encryptAtRestString, tryDecryptAtRest } from '../localEncryption';

const ENC = fs.readFileSync(path.join(__dirname, '..', 'localEncryption.ts'), 'utf8');
const LOCAL = fs.readFileSync(path.join(__dirname, '..', 'local.ts'), 'utf8');
const POLICY = fs.readFileSync(path.join(__dirname, '..', 'dekPolicy.ts'), 'utf8');

/** Тело объявления: от заголовка до первой закрывающей скобки в нулевой колонке. */
function bodyOf(source: string, head: string): string {
  const start = source.indexOf(head);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Наблюдение по умолчанию — чистая установка: нет ничего. */
function obs(over: Partial<DekObservation> = {}): DekObservation {
  return {
    stored: 'absent',
    canary: 'absent',
    storedOpensCanary: null,
    mnemonic: 'absent',
    derivedOpensCanary: null,
    ...over,
  };
}

describe('канарейка: сама проверка не пустая', () => {
  it('модуль политики не зависит ни от чего', () => {
    expect(POLICY).not.toContain('import ');
    expect(POLICY).not.toContain('require(');
  });
});

describe('decideDek: ключ на месте', () => {
  it('канарейка им открывается — работаем этим ключом и ничего не пишем', () => {
    const d = decideDek(obs({ stored: 'valid', canary: 'present', storedOpensCanary: true }));
    expect(d.action).toBe('use-stored');
    expect(d.writeCanary).toBe(false);
  });

  it('канарейки нет — ключ принимается и канарейка заводится', () => {
    // Установка, поднявшаяся до появления канарейки: других ключей в её
    // истории не было, значит этот и есть настоящий.
    const d = decideDek(obs({ stored: 'valid', canary: 'absent' }));
    expect(d.action).toBe('use-stored');
    expect(d.writeCanary).toBe(true);
  });

  it('канарейка не открывается ни им, ни seed — отказ, а не перезапись', () => {
    const d = decideDek(obs({
      stored: 'valid',
      canary: 'present',
      storedOpensCanary: false,
      mnemonic: 'present',
      derivedOpensCanary: false,
    }));
    expect(d.action).toBe('refuse');
    expect(d.reason).toBe('stored_does_not_match_data');
  });

  it('канарейку открывает seed — работаем ключом из seed, хранилище устарело', () => {
    const d = decideDek(obs({
      stored: 'valid',
      canary: 'present',
      storedOpensCanary: false,
      mnemonic: 'present',
      derivedOpensCanary: true,
    }));
    expect(d.action).toBe('use-derived');
    expect(d.writeCanary).toBe(false);
  });

  it('канарейку не прочитать — работаем как раньше и её не переписываем', () => {
    const d = decideDek(obs({ stored: 'valid', canary: 'unreadable' }));
    expect(d.action).toBe('use-stored');
    expect(d.writeCanary).toBe(false);
  });
});

describe('decideDek: ключа нет, а канарейка есть', () => {
  it('seed её открывает — восстанавливаемся из seed', () => {
    const d = decideDek(obs({ canary: 'present', mnemonic: 'present', derivedOpensCanary: true }));
    expect(d.action).toBe('use-derived');
    expect(d.writeCanary).toBe(false);
  });

  it('seed её не открывает — отказ: данные под потерянным ключом', () => {
    const d = decideDek(obs({ canary: 'present', mnemonic: 'present', derivedOpensCanary: false }));
    expect(d.action).toBe('refuse');
    expect(d.reason).toBe('key_lost_data_present');
  });

  it('seed нет вовсе — тоже отказ, а не новый случайный ключ', () => {
    const d = decideDek(obs({ canary: 'present', mnemonic: 'absent' }));
    expect(d.action).toBe('refuse');
  });

  it('ключ испорчен, канарейка есть — отказ', () => {
    const d = decideDek(obs({ stored: 'malformed', canary: 'present', mnemonic: 'absent' }));
    expect(d.action).toBe('refuse');
  });
});

describe('decideDek: ни ключа, ни канарейки', () => {
  it('нет и мнемоники — это первый запуск, ключ заводится', () => {
    const d = decideDek(obs());
    expect(d.action).toBe('create-random');
    expect(d.writeCanary).toBe(true);
  });

  it('мнемоника есть — ключ выводится из неё', () => {
    const d = decideDek(obs({ mnemonic: 'present' }));
    expect(d.action).toBe('use-derived');
    expect(d.writeCanary).toBe(true);
  });

  it('мнемонику не прочитать — отказ: случайный ключ разошёлся бы с seed', () => {
    const d = decideDek(obs({ mnemonic: 'unreadable' }));
    expect(d.action).toBe('refuse');
    expect(d.reason).toBe('seed_unreadable');
  });

  it('запись есть, но обрезана — отказ, а не «как будто первый запуск»', () => {
    // Ровно тот случай, который раньше был неотличим от чистой установки.
    const d = decideDek(obs({ stored: 'malformed' }));
    expect(d.action).toBe('refuse');
    expect(d.reason).toBe('key_malformed');
  });

  it('хранилище отказало на чтении ключа — отказ', () => {
    const d = decideDek(obs({ stored: 'unreadable' }));
    expect(d.action).toBe('refuse');
    expect(d.reason).toBe('key_unreadable');
  });

  it('хранилище отказало на чтении канарейки — отказ', () => {
    const d = decideDek(obs({ stored: 'absent', canary: 'unreadable', mnemonic: 'present' }));
    expect(d.action).toBe('refuse');
    expect(d.reason).toBe('key_and_canary_unreadable');
  });
});

describe('decideDek: новый ключ — только там, где терять нечего', () => {
  const EVIDENCE: Array<Partial<DekObservation>> = [
    { canary: 'present', mnemonic: 'absent' },
    { canary: 'unreadable' },
    { stored: 'malformed' },
    { stored: 'unreadable' },
    { mnemonic: 'unreadable' },
    { stored: 'valid', canary: 'present', storedOpensCanary: false },
  ];

  it.each(EVIDENCE)('при любом признаке прошлых данных ключ не выдумывается (%j)', (over) => {
    expect(decideDek(obs(over)).action).not.toBe('create-random');
  });

  it('отказ никогда не сопровождается записью канарейки', () => {
    for (const over of EVIDENCE) {
      const d = decideDek(obs(over));
      if (d.action === 'refuse') expect(d.writeCanary).toBe(false);
    }
  });
});

describe('канарейка отличает ключ от чужого', () => {
  const dek = new Uint8Array(32).fill(11);
  const other = new Uint8Array(32).fill(12);
  const PLAIN = 'airchat-dek-canary-v1';

  it('открывается своим ключом', () => {
    const stored = encryptAtRestString(PLAIN, dek);
    expect(stored.startsWith(AT_REST_PREFIX)).toBe(true);
    expect(tryDecryptAtRest(stored, dek)).toBe(PLAIN);
  });

  it('чужим ключом — не открывается', () => {
    expect(tryDecryptAtRest(encryptAtRestString(PLAIN, dek), other)).toBeNull();
  });

  it('одно и то же значение шифруется каждый раз по-разному', () => {
    // Иначе канарейка стала бы отпечатком ключа: одинаковые записи на двух
    // устройствах выдавали бы, что seed у них общий.
    expect(encryptAtRestString(PLAIN, dek)).not.toBe(encryptAtRestString(PLAIN, dek));
  });
});

describe('источник: разбор случаев вместо «null — значит первый запуск»', () => {
  const BODY = bodyOf(ENC, 'export async function getOrCreateDataEncryptionKey()');

  it('решение принимает политика, а не сама функция', () => {
    expect(BODY).toContain('decideDek({');
  });

  it('отказ доходит до вызывающего', () => {
    expect(BODY).toContain('throw new DekUnavailableError(decision.reason)');
  });

  it('прежнего «чуть что — случайный ключ» больше нет', () => {
    expect(ENC).not.toContain('fallback: random DEK');
    expect(count(ENC, 'randomBytes(')).toBe(1);
  });

  it('случайный ключ заводится только по решению политики', () => {
    const idx = BODY.indexOf('randomBytes(');
    expect(idx).toBeGreaterThan(-1);
    expect(BODY.slice(0, idx)).toContain("decision.action === 'create-random'");
  });

  it('ключ из хранилища не переписывается', () => {
    expect(BODY).toContain("if (decision.action !== 'use-stored') {");
  });
});

describe('источник: чтение хранилища различает три исхода', () => {
  const STORED = bodyOf(ENC, 'async function observeStoredDek(');
  const SEED = bodyOf(ENC, 'async function probeSeedDek(');

  it('ключ: нет / испорчен / не прочитался', () => {
    expect(STORED).toContain("state: 'absent'");
    expect(STORED).toContain("state: 'malformed'");
    expect(STORED).toContain("state: 'unreadable'");
  });

  it('мнемоника: сбой чтения — это не «мнемоники нет»', () => {
    expect(SEED).toContain("state: 'unreadable'");
  });

  it('канарейка пишется вместе с ключом, а не отдельно', () => {
    const P = bodyOf(ENC, 'export async function persistDek(');
    expect(P).toContain('SecureStore.setItemAsync(DEK_KEY');
    expect(P).toContain('writeCanary(dek)');
  });

  it('сбой записи канарейки не роняет запуск', () => {
    expect(bodyOf(ENC, 'async function writeCanary(')).toContain('} catch {');
  });
});

describe('источник: миграция ключа спрашивает канарейку', () => {
  const MIG = bodyOf(LOCAL, 'async function migrateDekRandomToDeterministic(');

  it('перед каждым решением о ключе', () => {
    expect(count(MIG, 'canaryOpensWith(')).toBe(3);
  });

  it('перешифровка не начинается, пока канарейка не подтвердила старый ключ', () => {
    const check = MIG.indexOf('const opensStored = await canaryOpensWith(stored)');
    const rekey = MIG.indexOf('await reencryptAtRest(database, stored, derived)');
    expect(check).toBeGreaterThan(-1);
    expect(rekey).toBeGreaterThan(check);
  });

  it('ключ закрепляется одной функцией — вместе с канарейкой', () => {
    expect(MIG).not.toContain('setDekMemory(');
    expect(MIG).not.toContain('SecureStore.setItemAsync(DEK_KEY');
    expect(count(MIG, 'await persistDek(derived)')).toBe(4);
  });
});
