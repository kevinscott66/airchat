/**
 * Что уезжает в Sentry вместе с ошибкой (v4.32.614).
 *
 * `ErrorHandler` кладёт `context` ошибки в `extra` отчёта, а отчёт уходит на
 * чужой сервер. Правило «ключи и DID сюда не кладём» до сих пор держалось на
 * трёх комментариях в messaging.ts — рядом с тремя вызовами, где о нём
 * вспомнили. Здесь оно проверяется как поведение.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  SCRUBBED,
  SCRUB_MAX_LEN,
  looksSecret,
  scrubTelemetryContext,
  scrubTelemetryText,
} from '../errorScrub';

const DID = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
const B64 = 'Zm9vYmFyYmF6cXV1eGNvcmdlZ3JhdWx0Z2FycGx5aA==';
const HEX = 'f0e1d2c3b4a5968778695a4b3c2d1e0f';

describe('строка целиком похожа на ключ', () => {
  it('DID, base64 и hex узнаются', () => {
    expect(looksSecret(DID)).toBe(true);
    expect(looksSecret(B64)).toBe(true);
    expect(looksSecret(HEX)).toBe(true);
  });

  it('обычный текст — нет', () => {
    expect(looksSecret('Нет защищённого канала с этим контактом')).toBe(false);
    expect(looksSecret('MEDIA_PARTIAL')).toBe(false);
    expect(looksSecret('parentCode')).toBe(false);
    // Короткий огрызок ключа под ключ не подходит: он и в логах живёт.
    expect(looksSecret('AbCdEf012345')).toBe(false);
  });
});

describe('очистка context', () => {
  it('значение под подозрительным именем скрывается целиком', () => {
    expect(scrubTelemetryContext({ peerDid: 'аня', publicKeyB64: 'x', nonce: 1 })).toEqual({
      peerDid: SCRUBBED,
      publicKeyB64: SCRUBBED,
      nonce: SCRUBBED,
    });
  });

  it('имя, где нужные буквы попались случайно, не страдает', () => {
    // «candidate» содержит «did», но словом «did» не является.
    expect(scrubTelemetryContext({ candidate: 'host', hidden: true })).toEqual({
      candidate: 'host',
      hidden: true,
    });
  });

  it('ключ, положенный под безобидным именем, всё равно скрывается', () => {
    expect(scrubTelemetryContext({ to: DID, from: B64, code: 'RATE_LIMIT_DM' })).toEqual({
      to: SCRUBBED,
      from: SCRUBBED,
      code: 'RATE_LIMIT_DM',
    });
  });

  it('вложенность разбирается, но не бесконечно', () => {
    const deep = { a: { b: { c: { d: { e: 'дно' } } } } };
    expect(scrubTelemetryContext(deep)).toEqual({ a: { b: { c: { d: SCRUBBED } } } });
  });

  it('кольцевая ссылка не уводит в бесконечность', () => {
    const loop: Record<string, unknown> = { name: 'узел' };
    loop.self = loop;
    expect(() => scrubTelemetryContext(loop)).not.toThrow();
  });

  it('пустой вход остаётся пустым', () => {
    expect(scrubTelemetryContext(undefined)).toBeUndefined();
  });

  it('длинная строка обрезается, а не уезжает целиком', () => {
    const long = 'я'.repeat(SCRUB_MAX_LEN + 500);
    const out = scrubTelemetryContext({ componentStack: long }) as { componentStack: string };
    expect(out.componentStack.length).toBe(SCRUB_MAX_LEN + 1);
  });

  it('стек падения остаётся читаемым', () => {
    const stack = 'Error: boom\n    at FeedScreen (FeedScreen.tsx:120:5)\n    at App';
    expect(scrubTelemetryContext({ stack })).toEqual({ stack });
  });
});

describe('очистка текста сообщения', () => {
  it('ключ внутри фразы скрывается, а фраза остаётся', () => {
    expect(scrubTelemetryText(`Нет сессии с ${DID}`)).toBe(`Нет сессии с ${SCRUBBED}`);
  });

  it('ключ с точкой на конце тоже', () => {
    expect(scrubTelemetryText(`Нет сессии с ${HEX}.`)).toBe(`Нет сессии с ${SCRUBBED}`);
  });

  it('обычное сообщение человеку не меняется', () => {
    const msg = 'Слишком много сообщений этому контакту (лимит в час). Попробуйте позже.';
    expect(scrubTelemetryText(msg)).toBe(msg);
  });
});

describe('обработчик ошибок пользуется очисткой', () => {
  const HANDLER = readFileSync(join(__dirname, '..', 'errorHandler.ts'), 'utf8');

  it('в отчёт уходит очищенный context', () => {
    expect(HANDLER).toContain('extra: scrubTelemetryContext(error.context),');
    expect(HANDLER).not.toContain('extra: error.context as Record<string, unknown> | undefined,');
  });

  it('и очищенный текст ошибки', () => {
    expect(HANDLER).toContain('scrubTelemetryText(error.message)');
  });
});
