/**
 * Вложения входящего поста разбираются без доверия отправителю (v4.32.614).
 * Разбор описан в feedInlineAttachments.ts — там же и причины каждой проверки.
 */
import fs from 'fs';
import path from 'path';

import {
  FEED_INLINE_DEFAULT_MIME,
  FEED_INLINE_DOC_MAX_COUNT,
  FEED_INLINE_MEDIA_MAX_COUNT,
  isInlineBase64,
  safeInlineMime,
  sanitizeInlineDocuments,
  sanitizeInlineMedia,
} from '../feedInlineAttachments';

const B64 = 'QUJDRA=='; // 8 символов, кратно четырём

describe('тип содержимого', () => {
  it('обычный тип проходит как есть', () => {
    expect(safeInlineMime('image/jpeg')).toBe('image/jpeg');
    expect(safeInlineMime('application/vnd.ms-excel')).toBe('application/vnd.ms-excel');
  });

  it('запятая и точка с запятой внутри типа рвут data:-адрес — не проходят', () => {
    // `data:text/html,<script>…;base64,AAA` — всё после запятой становится
    // самим содержимым, а не типом.
    expect(safeInlineMime('text/html,<script>alert(1)</script>')).toBe(FEED_INLINE_DEFAULT_MIME);
    expect(safeInlineMime('image/png;base64,AAAA')).toBe(FEED_INLINE_DEFAULT_MIME);
    expect(safeInlineMime('image/ png')).toBe(FEED_INLINE_DEFAULT_MIME);
    expect(safeInlineMime('imagepng')).toBe(FEED_INLINE_DEFAULT_MIME);
    expect(safeInlineMime(42)).toBe(FEED_INLINE_DEFAULT_MIME);
    expect(safeInlineMime('a/'.padEnd(400, 'b'))).toBe(FEED_INLINE_DEFAULT_MIME);
  });
});

describe('фотографии и их типы', () => {
  it('выпадают парой — номера не разъезжаются', () => {
    const got = sanitizeInlineMedia(
      [B64, 12345, B64],
      ['image/jpeg', 'image/png', 'video/mp4'],
    );
    expect(got.media).toEqual([B64, B64]);
    // Прежний код оставлял ['image/jpeg','image/png'] — второй снимок
    // показывался бы как png, хотя это video/mp4.
    expect(got.mediaMime).toEqual(['image/jpeg', 'video/mp4']);
  });

  it('содержимое не из набора base64 не принимается', () => {
    expect(sanitizeInlineMedia(['%%%%'], ['image/jpeg']).media).toEqual([]);
    expect(sanitizeInlineMedia(['QUJD'], ['image/jpeg']).media).toEqual(['QUJD']);
    expect(sanitizeInlineMedia(['QUJDR'], ['image/jpeg']).media).toEqual([]);
    expect(isInlineBase64(B64, 4)).toBe(false);
  });

  it('число вложений ограничено', () => {
    const many = Array.from({ length: 40 }, () => B64);
    expect(sanitizeInlineMedia(many, []).media).toHaveLength(FEED_INLINE_MEDIA_MAX_COUNT);
    expect(sanitizeInlineMedia(many, []).mediaMime).toHaveLength(FEED_INLINE_MEDIA_MAX_COUNT);
    expect(sanitizeInlineMedia('не массив', null).media).toEqual([]);
  });
});

describe('документы', () => {
  it('метаданные без принятых байтов не превращаются в вложение', () => {
    const got = sanitizeInlineDocuments([
      { name: 'нет байтов.pdf', mime: 'application/pdf', size: 10 },
      { name: 'есть.pdf', mime: 'application/pdf', size: 4, data: B64 },
    ]);
    expect(got.meta.map((m) => m.name)).toEqual(['есть.pdf']);
    expect(got.data).toEqual([B64]);
  });

  it('имя, тип и размер приводятся к безопасному виду', () => {
    const got = sanitizeInlineDocuments([
      { name: 'x'.repeat(500), mime: 'application/pdf;evil', size: -1, data: B64 },
    ]);
    expect(got.meta[0].name).toHaveLength(200);
    expect(got.meta[0].mime).toBe(FEED_INLINE_DEFAULT_MIME);
    expect(got.meta[0].size).toBe(0);
  });

  it('число документов ограничено', () => {
    const many = Array.from({ length: 20 }, () => ({ name: 'd', mime: 'application/pdf', size: 1, data: B64 }));
    expect(sanitizeInlineDocuments(many).meta).toHaveLength(FEED_INLINE_DOC_MAX_COUNT);
    expect(sanitizeInlineDocuments(null).meta).toEqual([]);
  });
});

describe('приёмный путь пользуется именно этим разбором', () => {
  const SERVICE = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');

  it('ни один тип от отправителя не попадает в cid напрямую', () => {
    // Прежние места: `d.mediaMime?.[i] ?? 'application/octet-stream'` в feed_post
    // и `rawMime.length <= 64` в feed_repost.
    expect(SERVICE).not.toContain("d.mediaMime?.[i] ??");
    expect(SERVICE).not.toContain('rawMime');
    expect(SERVICE).toContain('sanitizeInlineMedia(d.media, d.mediaMime)');
    expect(SERVICE).toContain('safeInlineMime(d.originalMediaBase64Mime?.[i])');
  });

  it('номер ключа документа считается по отфильтрованному списку', () => {
    expect(SERVICE).toContain('for (let i = 0; i < inlineDocs.data.length; i++)');
    expect(SERVICE).toContain('inlineDocs.meta.length > 0 ? inlineDocs.meta : null');
  });
});
