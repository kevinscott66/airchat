/**
 * v4.32.594. «Активные сессии» показывали «Не удалось загрузить список
 * сессий. Unknown encoding: base64url». Ошибка не серверная: `Buffer` в
 * сборке — пакет `buffer` 6.0.3, а не модуль node, и кодировки `base64url` он
 * не знает. Под jest 'buffer' резолвится в node, где она есть с 15.7, поэтому
 * ни один тест этого не видел, а падало всё, что подписывает запрос: nonce
 * считается до отправки.
 *
 * Отсюда два рода проверок. Первый — что помощник даёт ровно то же, что node:
 * формат на проводе не меняется, сервер разбирает те же строки. Второй — что
 * прежний способ не вернётся: имя кодировки в исходниках запрещено, потому что
 * в тестах оно продолжит работать и обнаружится опять только на устройстве.
 */
import fs from 'fs';
import path from 'path';

import { base64UrlToBytes, base64UrlToUtf8, bytesToBase64Url, utf8ToBase64Url } from '../base64url';

/** Тот самый полифилл, который попадает в сборку, а не модуль node. */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const polyfill = require(path.join(__dirname, '..', '..', '..', '..', 'node_modules', 'buffer'));

const SAMPLES = [
  new Uint8Array(0),
  new Uint8Array([0]),
  new Uint8Array([0xff]),
  new Uint8Array([0xfb, 0xff, 0xbf]),
  new Uint8Array([1, 2, 3, 4, 5]),
  new Uint8Array(Array.from({ length: 16 }, (_, i) => (i * 37) % 256)),
  new Uint8Array(Array.from({ length: 32 }, (_, i) => 255 - i * 8)),
];

describe('кодировка, которой нет в полифилле', () => {
  it('полифилл действительно её не знает — иначе этот модуль незачем', () => {
    expect(() => polyfill.Buffer.from([1, 2, 3]).toString('base64url')).toThrow(/base64url/);
    expect(() => polyfill.Buffer.from('AQID', 'base64url')).toThrow(/base64url/);
  });

  it('обычный base64 полифилл знает — на нём помощник и стоит', () => {
    expect(polyfill.Buffer.from([1, 2, 3]).toString('base64')).toBe('AQID');
  });
});

describe('формат совпадает с node побайтно', () => {
  it.each(SAMPLES.map((bytes, index) => [index, bytes] as const))('образец %i', (_index, bytes) => {
    expect(bytesToBase64Url(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
  });

  it('алфавит без «+», «/» и выравнивания', () => {
    const encoded = bytesToBase64Url(new Uint8Array([0xfb, 0xff, 0xbf, 0x00]));
    expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
    expect(encoded).not.toContain('=');
  });

  it('текст туда и обратно, включая не-латиницу', () => {
    for (const value of ['', 'msg-1', 'сообщение', '🙂 emoji', 'a'.repeat(256)]) {
      expect(utf8ToBase64Url(value)).toBe(Buffer.from(value, 'utf8').toString('base64url'));
      expect(base64UrlToUtf8(utf8ToBase64Url(value))).toBe(value);
    }
  });

  it('байты туда и обратно', () => {
    for (const bytes of SAMPLES) {
      expect(Array.from(base64UrlToBytes(bytesToBase64Url(bytes)))).toEqual(Array.from(bytes));
    }
  });

  it('разбор принимает и обычный base64: чужую строку отвергать не за что', () => {
    expect(base64UrlToUtf8('0YHQvtC+0LHRidC10L3QuNC1')).toBe('сообщение');
    expect(Array.from(base64UrlToBytes('+/8='))).toEqual([0xfb, 0xff]);
    expect(Array.from(base64UrlToBytes('-_8'))).toEqual([0xfb, 0xff]);
  });
});

describe('имя кодировки не возвращается в исходники', () => {
  const SRC = path.join(__dirname, '..', '..', '..');

  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === '__mocks__') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sources(full));
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  it('ни один модуль не передаёт «base64url» в Buffer', () => {
    const guilty = sources(SRC).filter((file) => /['"]base64url['"]/.test(fs.readFileSync(file, 'utf8')));
    expect(guilty.map((file) => path.relative(SRC, file))).toEqual([]);
  });
});
