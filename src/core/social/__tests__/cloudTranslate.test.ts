/**
 * Облачный перевод: что уходит наружу и что считается переводом (v4.32.366).
 */

import {
  buildTranslateUrl,
  MAX_TRANSLATE_CHARS,
  parseTranslation,
  translateBlockMessage,
  translateBlockReason,
  translateFailureMessage,
  TRANSLATE_ENDPOINT,
} from '../cloudTranslate';
import { CONTACT_CARD_PREFIX } from '../contactCardEnvelope';
import { GIF_PREFIX } from '../gifEnvelope';
import { POLL_PREFIX } from '../pollEnvelope';

// Префикс группового сообщения взят строкой: groupMessaging тянет за собой
// половину ядра, а проверяем мы здесь только первый байт.
const GROUP_MSG_PREFIX = '\x02grp:';

describe('translateBlockReason', () => {
  it('обычный текст пропускается', () => {
    expect(translateBlockReason('Привет, как дела?')).toBeNull();
    expect(translateBlockReason('See you at the café')).toBeNull();
  });

  it('пустое и пробельное не отправляем', () => {
    expect(translateBlockReason('')).toBe('empty');
    expect(translateBlockReason('   \n ')).toBe('empty');
  });

  it('служебные конверты не уходят на чужой сервер', () => {
    // Правило по управляющему байту, а не по списку префиксов: список из 22
    // штук устаревает с каждым новым типом сообщения, а старый фильтр знал
    // ровно про три.
    for (const p of [CONTACT_CARD_PREFIX, GIF_PREFIX, POLL_PREFIX, GROUP_MSG_PREFIX]) {
      expect(translateBlockReason(`${p}что-то`)).toBe('payload');
    }
  });

  it('карточка контакта — данные третьего человека — тоже конверт', () => {
    // Он в разговоре не участвовал и согласия на отправку своего имени и
    // ключа стороннему сервису не давал.
    expect(translateBlockReason(`${CONTACT_CARD_PREFIX}{"name":"Аня","did":"did:key:z6Mk"}`)).toBe('payload');
  });

  it('одноразовый код наружу не уходит', () => {
    expect(translateBlockReason('Ваш код: 4821')).toBe('secret');
    expect(translateBlockReason('12345678')).toBe('secret');
  });

  it('перекос в сторону осторожности признан и закреплён', () => {
    // Год тоже блокируется. Не перевести «встретимся в 2026» не стоит ничего,
    // отдать одноразовый пароль — стоит доступа к счёту.
    expect(translateBlockReason('Встретимся в 2026')).toBe('secret');
    expect(translateBlockReason('Дом 12, квартира 3')).toBeNull();
  });

  it('у каждой причины есть человеческое объяснение', () => {
    expect(translateBlockMessage('secret')).toContain('код');
    expect(translateBlockMessage('payload')).toContain('служебное');
    expect(translateBlockMessage('empty')).toBeTruthy();
  });
});

describe('buildTranslateUrl', () => {
  it('текст и язык кодируются', () => {
    const u = buildTranslateUrl('привет & пока', 'en');
    expect(u).toContain(`${TRANSLATE_ENDPOINT}?q=`);
    expect(u).toContain('%20%26%20');
    expect(u).toContain('langpair=auto%7Cen');
  });

  it('язык из хранилища не дописывает свои параметры', () => {
    // Раньше язык подставлялся без кодирования: значение с «&» переписало бы
    // запрос целиком.
    expect(buildTranslateUrl('текст', 'en&key=x')).toBeNull();
    expect(buildTranslateUrl('текст', '../../evil')).toBeNull();
    expect(buildTranslateUrl('текст', '')).toBeNull();
  });

  it('региональный код языка допустим', () => {
    expect(buildTranslateUrl('текст', 'pt-BR')).toContain('langpair=auto%7Cpt-BR');
  });

  it('длинный текст обрезается до потолка', () => {
    const u = buildTranslateUrl('я'.repeat(2000), 'en') ?? '';
    const q = decodeURIComponent((u.match(/q=([^&]*)/) ?? ['', ''])[1]);
    expect(q).toHaveLength(MAX_TRANSLATE_CHARS);
  });
});

describe('parseTranslation', () => {
  it('обычный перевод проходит', () => {
    expect(parseTranslation({ responseData: { translatedText: 'Hello' }, responseStatus: 200 }, 'Привет'))
      .toEqual({ ok: true, text: 'Hello' });
  });

  it('статус приходит и строкой — это не отказ', () => {
    expect(parseTranslation({ responseData: { translatedText: 'Hello' }, responseStatus: '200' }, 'Привет'))
      .toEqual({ ok: true, text: 'Hello' });
  });

  it('исчерпанная квота не выдаётся за перевод', () => {
    // Сервис отвечает HTTP 200 и кладёт текст ошибки в то же поле. Раньше
    // человек видел его вместо своего сообщения.
    const quota = 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY.';
    expect(parseTranslation({ responseData: { translatedText: quota }, responseStatus: 200 }, 'Привет'))
      .toEqual({ ok: false, reason: 'quota' });
    expect(translateFailureMessage('quota')).toContain('лимит');
  });

  it('прочие служебные ответы тоже не перевод', () => {
    for (const notice of [
      'PLEASE SELECT TWO DISTINCT LANGUAGES',
      'INVALID TARGET LANGUAGE zz',
      'QUERY LENGTH LIMIT EXCEEDED',
    ]) {
      expect(parseTranslation({ responseData: { translatedText: notice }, responseStatus: 200 }, 'Привет'))
        .toEqual({ ok: false, reason: 'service' });
    }
  });

  it('ненулевой статус — отказ', () => {
    expect(parseTranslation({ responseData: { translatedText: 'x' }, responseStatus: 403 }, 'Привет'))
      .toEqual({ ok: false, reason: 'service' });
  });

  it('мусор вместо ответа не роняет разбор', () => {
    expect(parseTranslation(null, 'Привет')).toEqual({ ok: false, reason: 'service' });
    expect(parseTranslation({}, 'Привет')).toEqual({ ok: false, reason: 'service' });
    expect(parseTranslation({ responseData: { translatedText: 42 } }, 'Привет')).toEqual({ ok: false, reason: 'service' });
    expect(parseTranslation({ responseData: { translatedText: '  ' } }, 'Привет')).toEqual({ ok: false, reason: 'service' });
  });

  it('совпадение с оригиналом переводом не считается', () => {
    expect(parseTranslation({ responseData: { translatedText: 'Привет ' }, responseStatus: 200 }, 'Привет'))
      .toEqual({ ok: false, reason: 'same' });
    expect(translateFailureMessage('same')).toContain('языке');
  });

  it('огромный ответ обрезается — он идёт в Alert', () => {
    const huge = 'a'.repeat(50_000);
    const out = parseTranslation({ responseData: { translatedText: huge }, responseStatus: 200 }, 'Привет');
    expect(out.ok).toBe(true);
    expect(out.ok && out.text.length).toBe(2000);
  });
});
