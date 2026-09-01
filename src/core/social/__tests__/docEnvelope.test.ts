/**
 * Имя файла от чужого клиента.
 *
 * Разбор конверта проверял размер и CID, но имя брал как есть. Невидимый
 * U+202E разворачивает вывод: «отчет\u202Eexe.pdf» человек читает как
 * «отчетfdp.exe» — на экране .pdf, в share sheet .exe. Плюс перевод строки
 * внутри имени дописывал к названию файла вторую строку.
 */

import { DOC_PREFIX, MAX_DOC_ENVELOPE, MAX_DOC_NAME, isDocMessage, makeDocText, parseDocEnvelope, sanitizeFileName } from '../docEnvelope';

const CID = 'QmYwAPJzv5CZsnAztbCQzRKNvUfjmXHUgqPnFHkbrJabcd';
const raw = (payload: unknown): string => `${DOC_PREFIX}${JSON.stringify(payload)}`;

describe('sanitizeFileName', () => {
  it('обычное имя не меняется', () => {
    expect(sanitizeFileName('Отчёт за 2026 год.pdf')).toBe('Отчёт за 2026 год.pdf');
  });

  it('RTL-override вырезается — расширение на экране совпадает с настоящим', () => {
    expect(sanitizeFileName('отчет\u202Eexe.pdf')).toBe('отчетexe.pdf');
    expect(sanitizeFileName('фото\u202Egnp.js')).toBe('фотоgnp.js');
  });

  it('остальные метки направления письма тоже вырезаются', () => {
    for (const ch of ['\u061C', '\u200E', '\u200F', '\u202A', '\u202B', '\u202C', '\u202D', '\u2066', '\u2067', '\u2068', '\u2069']) {
      expect(sanitizeFileName(`a${ch}b.txt`)).toBe('ab.txt');
    }
  });

  it('невидимая набивка длины убирается', () => {
    expect(sanitizeFileName('файл\u200B\u200B.txt')).toBe('файл.txt');
    expect(sanitizeFileName('\uFEFFфайл.txt')).toBe('файл.txt');
  });

  it('склейка эмодзи и \u200C остаются — это настоящий текст', () => {
    expect(sanitizeFileName('семья\u200D.png')).toBe('семья\u200D.png');
    expect(sanitizeFileName('می\u200Cخواهم.txt')).toBe('می\u200Cخواهم.txt');
  });

  it('перевод строки не дописывает вторую строку к названию', () => {
    expect(sanitizeFileName('счет.pdf\nПодтверждено AirChat')).toBe('счет.pdf Подтверждено AirChat');
    expect(sanitizeFileName('a\tb')).toBe('a b');
  });

  it('не строка или пустое после чистки — null', () => {
    for (const v of [null, undefined, 42, {}, [], '', '   ', '\u202E\u202E', '\n\n']) {
      expect(sanitizeFileName(v)).toBeNull();
    }
  });

  it('длина обрезается до предела', () => {
    const long = `${'и'.repeat(400)}.txt`;
    expect(sanitizeFileName(long)!.length).toBe(MAX_DOC_NAME);
  });
});

describe('parseDocEnvelope', () => {
  it('round-trip', () => {
    const t = makeDocText('смета.xlsx', 2048, CID);
    expect(isDocMessage(t)).toBe(true);
    expect(parseDocEnvelope(t)).toEqual({ name: 'смета.xlsx', size: 2048, cid: CID });
  });

  it('имя чистится и на приёме', () => {
    expect(parseDocEnvelope(raw({ name: 'отчет\u202Eexe.pdf', size: 10, cid: CID }))!.name).toBe('отчетexe.pdf');
  });

  it('не конверт документа — null', () => {
    for (const t of ['', 'привет', '\x01voice:{}', DOC_PREFIX, `${DOC_PREFIX}не json`]) {
      expect(parseDocEnvelope(t)).toBeNull();
    }
  });

  it('имя не строкой, пустое или из одних невидимок — конверт отброшен', () => {
    for (const name of [undefined, null, 7, { a: 1 }, ['x'], '', '  ', '\u202E']) {
      expect(parseDocEnvelope(raw({ name, size: 10, cid: CID }))).toBeNull();
    }
  });

  it('размер вне допустимого — конверт отброшен', () => {
    for (const size of [undefined, '10', -1, NaN, Infinity, 11 * 1024 * 1024 * 1024]) {
      expect(parseDocEnvelope(raw({ name: 'a.txt', size, cid: CID }))).toBeNull();
    }
  });

  it('нулевой размер допустим — пустой файл это файл', () => {
    expect(parseDocEnvelope(raw({ name: 'a.txt', size: 0, cid: CID }))!.size).toBe(0);
  });

  it('cid не строкой, пустой или огромный — конверт отброшен', () => {
    for (const cid of [undefined, null, 5, '', 'x'.repeat(513)]) {
      expect(parseDocEnvelope(raw({ name: 'a.txt', size: 10, cid }))).toBeNull();
    }
  });

  it('массив и примитив вместо объекта — null', () => {
    for (const p of [[1, 2], 'строка', 42, null, true]) {
      expect(parseDocEnvelope(raw(p))).toBeNull();
    }
  });
});

/**
 * v4.32.380. Потолка длины до JSON.parse у конверта документа не было вовсе:
 * текст сообщения доезжает сюда длиной с сам транспорт, и разбор мегабайтной
 * строки случался целиком, синхронно в JS-потоке.
 */
describe('потолок длины конверта', () => {
  it('настоящий конверт с самым длинным именем проходит', () => {
    const s = makeDocText('и'.repeat(MAX_DOC_NAME), 1024, CID);
    expect(s.length).toBeLessThanOrEqual(MAX_DOC_ENVELOPE);
    expect(parseDocEnvelope(s)?.name).toHaveLength(MAX_DOC_NAME);
  });

  it('строка длиннее потолка отвергается целиком', () => {
    const s = raw({ name: 'a.pdf', size: 1, cid: CID, junk: 'x'.repeat(MAX_DOC_ENVELOPE) });
    expect(s.length).toBeGreaterThan(MAX_DOC_ENVELOPE);
    expect(parseDocEnvelope(s)).toBeNull();
  });

  it('до JSON.parse дело не доходит', () => {
    const spy = jest.spyOn(JSON, 'parse');
    try {
      expect(parseDocEnvelope(DOC_PREFIX + 'x'.repeat(MAX_DOC_ENVELOPE))).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
