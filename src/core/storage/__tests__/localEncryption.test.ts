/**
 * v4.32.279. Перешифровка при смене DEK читает старым ключом и пишет новым.
 * Если «не расшифровалось» неотличимо от «пустая строка», такая миграция
 * стирает сообщение вместо переноса — и необратимо: старого ключа после неё
 * уже нет. Поэтому различие проверяется тестом, а не глазами.
 */
import { randomBytes } from '@noble/hashes/utils.js';
import {
  AT_REST_PREFIX,
  decryptAtRestString,
  encryptAtRestIfPlain,
  encryptAtRestString,
  tryDecryptAtRest,
} from '../localEncryption';

describe('tryDecryptAtRest', () => {
  const dek = new Uint8Array(32).fill(7);
  const other = new Uint8Array(32).fill(9);

  it('возвращает исходный текст', () => {
    const stored = encryptAtRestString('привет', dek);
    expect(stored.startsWith(AT_REST_PREFIX)).toBe(true);
    expect(tryDecryptAtRest(stored, dek)).toBe('привет');
  });

  it('пустое сообщение — это пустая строка, а не отказ', () => {
    expect(tryDecryptAtRest(encryptAtRestString('', dek), dek)).toBe('');
  });

  it('чужой ключ — null, а не пустая строка', () => {
    const stored = encryptAtRestString('секрет', dek);
    expect(tryDecryptAtRest(stored, other)).toBeNull();
    // Ровно то, чем этот путь отличается от старого: decryptAtRestString здесь
    // отдаёт '' — на месте перешифровки это и есть потеря сообщения.
    expect(decryptAtRestString(stored, other)).toBe('');
  });

  it('битый шифртекст — null', () => {
    expect(tryDecryptAtRest(`${AT_REST_PREFIX}не-base64-и-не-шифртекст`, dek)).toBeNull();
  });

  it('строка без префикса — ещё не мигрированный открытый текст, отдаётся как есть', () => {
    expect(tryDecryptAtRest('старая запись', dek)).toBe('старая запись');
    expect(tryDecryptAtRest('', dek)).toBe('');
  });

  it('перешифровка случайным ключом сохраняет содержимое', () => {
    const from = randomBytes(32);
    const to = randomBytes(32);
    const stored = encryptAtRestString('текст сообщения', from);
    const plain = tryDecryptAtRest(stored, from);
    expect(plain).not.toBeNull();
    const restored = encryptAtRestString(plain as string, to);
    expect(tryDecryptAtRest(restored, to)).toBe('текст сообщения');
    expect(tryDecryptAtRest(restored, from)).toBeNull();
  });
});

/**
 * v4.32.302. Реакции и список прочитавших теперь шифруются, но в те же колонки
 * попадают строки из файла копии, сделанного раньше, — открытым текстом. Отсюда
 * правило «шифровать, если ещё не зашифровано», и цена ошибки в обе стороны:
 * не зашифровать значит оставить открытым то, что прятали, а зашифровать
 * дважды — молча отдать наружу «enc2:…» вместо содержимого.
 */
describe('encryptAtRestIfPlain', () => {
  const dek = new Uint8Array(32).fill(3);

  it('открытый текст шифрует', () => {
    const stored = encryptAtRestIfPlain('{"❤️":["ключ"]}', dek);
    expect(stored).not.toBeNull();
    expect((stored as string).startsWith(AT_REST_PREFIX)).toBe(true);
    expect(decryptAtRestString(stored as string, dek)).toBe('{"❤️":["ключ"]}');
  });

  it('уже зашифрованное не трогает — иначе enc2 поверх enc2', () => {
    const once = encryptAtRestString('["кто прочитал"]', dek);
    expect(encryptAtRestIfPlain(once, dek)).toBe(once);
    // Именно это и было бы видно на экране, если бы префикс не проверялся.
    expect(decryptAtRestString(encryptAtRestString(once, dek), dek).startsWith(AT_REST_PREFIX))
      .toBe(true);
  });

  it('двойной проход по одному значению ничего не меняет', () => {
    const once = encryptAtRestIfPlain('[]', dek);
    expect(encryptAtRestIfPlain(once, dek)).toBe(once);
  });

  it('пустое остаётся пустым: шифровать нечего', () => {
    expect(encryptAtRestIfPlain(null, dek)).toBeNull();
    expect(encryptAtRestIfPlain('', dek)).toBe('');
  });
});
