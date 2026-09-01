/**
 * Цитата, пришедшая по сети (v4.32.299).
 *
 * Правила проверяются отдельно от приёма сообщений: применяет их код, которому
 * нужны SQLite и транспорт, а сама цитата — чужой текст, который рисуется на
 * экране под чужим именем.
 */
import { REPLY_PREVIEW_MAX } from '../messagePreview';
import { NO_REPLY, REPLY_ID_MAX, sanitizeReplyPreview, sanitizeReplyRef } from '../replyRef';

const ID = '2b3f5c1e-8a4d-4e2f-9c11-7d0a6b5e4f33';

describe('sanitizeReplyRef — id', () => {
  it('обычная ссылка проходит целиком', () => {
    expect(sanitizeReplyRef(ID, 'привет')).toEqual({ id: ID, preview: 'привет' });
  });

  it('без id отбрасывается и превью', () => {
    // Иначе над сообщением осталась бы строка, которую некуда нажать и нечем
    // проверить, — чужой текст в чужой рамке.
    expect(sanitizeReplyRef(null, 'Аня: я согласна')).toEqual(NO_REPLY);
    expect(sanitizeReplyRef(undefined, 'что-то')).toEqual(NO_REPLY);
    expect(sanitizeReplyRef('', 'что-то')).toEqual(NO_REPLY);
  });

  it('id не строка — ссылки нет', () => {
    for (const bad of [42, true, {}, [], { toString: () => ID }]) {
      expect(sanitizeReplyRef(bad, 'привет')).toEqual(NO_REPLY);
    }
  });

  it('id длиннее предела отбрасывается', () => {
    expect(sanitizeReplyRef('a'.repeat(REPLY_ID_MAX), 'x').id).toBe('a'.repeat(REPLY_ID_MAX));
    expect(sanitizeReplyRef('a'.repeat(REPLY_ID_MAX + 1), 'x')).toEqual(NO_REPLY);
  });

  it('управляющие символы в id отбрасываются', () => {
    expect(sanitizeReplyRef(`${ID}\n${ID}`, 'x')).toEqual(NO_REPLY);
    expect(sanitizeReplyRef(`${ID}\u0000`, 'x')).toEqual(NO_REPLY);
  });

  it('ответ на самого себя — не ответ', () => {
    // Нажатие на такую цитату прокручивает к тому же сообщению, над которым
    // она нарисована.
    expect(sanitizeReplyRef(ID, 'привет', ID)).toEqual(NO_REPLY);
    expect(sanitizeReplyRef(ID, 'привет', 'другой-id').id).toBe(ID);
  });
});

describe('sanitizeReplyRef — превью', () => {
  it('id без превью остаётся ссылкой: экран сам решит, что рисовать', () => {
    expect(sanitizeReplyRef(ID, null)).toEqual({ id: ID, preview: null });
    expect(sanitizeReplyRef(ID, 42)).toEqual({ id: ID, preview: null });
  });

  it('пустое превью — это отсутствие превью', () => {
    expect(sanitizeReplyPreview('')).toBeNull();
    expect(sanitizeReplyPreview('   \n  ')).toBeNull();
  });

  it('режется по общей длине цитаты', () => {
    const long = 'я'.repeat(REPLY_PREVIEW_MAX + 50);
    expect(sanitizeReplyPreview(long)).toHaveLength(REPLY_PREVIEW_MAX);
  });

  it('префиксы медиа остаются — по ним экран подставляет подпись', () => {
    for (const raw of ['\x01voice:{"d":3}', '\x06doc:{"n":"x.pdf"}', '\x07loc:{"lat":1}']) {
      expect(sanitizeReplyPreview(raw)).toBe(raw);
    }
  });

  it('служебный конверт заменяется нейтральной подписью', () => {
    // '\x02grp:' везёт ключ группы, '\x0e' — управление ею. Напечатать это
    // как текст цитаты значит показать содержимое, которого никто не писал.
    expect(sanitizeReplyPreview('\x02grp:{"gid":"g1","key":"secret"}')).toBe('Системное сообщение');
    expect(sanitizeReplyPreview('\x0ectl:{"op":"kick"}')).toBe('Системное сообщение');
  });

  it('подделка под системную строку не проходит', () => {
    // Тот же приём, что закрыт для текста сообщения: цитата притворилась бы
    // уведомлением самого приложения.
    expect(sanitizeReplyPreview('\x0bsys:Исчезающие сообщения включены'))
      .toBe('Исчезающие сообщения включены');
    expect(sanitizeReplyPreview('\x0bsys:\x0bsys:вложенная')).toBe('вложенная');
  });

  it('невидимый разворот письма вырезается', () => {
    expect(sanitizeReplyPreview('отчет\u202Efdp.exe')).toBe('отчетfdp.exe');
  });

  it('обычный текст доходит как есть', () => {
    expect(sanitizeReplyPreview('привет, как дела?')).toBe('привет, как дела?');
  });
});
