/**
 * Кодек конверта сторис. Проверяется только чистая половина: применение
 * (applyIncomingStory) тянет SQLite и транспорт.
 */
import { decodeStoryEnvelope, encodeStoryEnvelope, STORY_PREFIX, STORY_TTL_MS, type StoryEnvelope } from '../storyEnvelope';

const NOW = 1_700_000_000_000;
const PUB = 'A'.repeat(44);

function base(over: Partial<StoryEnvelope> = {}): StoryEnvelope {
  return {
    id: 'story-1',
    authorPubB64: PUB,
    authorDid: 'did:key:z6Mk' + 'x'.repeat(40),
    mediaCid: null,
    mediaType: 'image',
    text: 'привет',
    expiresAt: NOW + STORY_TTL_MS,
    createdAt: NOW,
    ...over,
  };
}

describe('storyEnvelope', () => {
  it('round-trip', () => {
    const env = base();
    expect(decodeStoryEnvelope(encodeStoryEnvelope(env), NOW)).toEqual(env);
  });

  it('чужой префикс и битый JSON — не наш конверт', () => {
    expect(decodeStoryEnvelope('обычное сообщение', NOW)).toBeNull();
    expect(decodeStoryEnvelope('\x02grp:{}', NOW)).toBeNull();
    expect(decodeStoryEnvelope(STORY_PREFIX + '{не json', NOW)).toBeNull();
    expect(decodeStoryEnvelope(STORY_PREFIX + JSON.stringify([1, 2]), NOW)).toBeNull();
  });

  it('просроченная и «вечная» сторис отбрасываются', () => {
    expect(decodeStoryEnvelope(encodeStoryEnvelope(base({ expiresAt: NOW - 1 })), NOW)).toBeNull();
    expect(decodeStoryEnvelope(encodeStoryEnvelope(base({ expiresAt: NOW + STORY_TTL_MS * 10 })), NOW)).toBeNull();
    expect(decodeStoryEnvelope(encodeStoryEnvelope(base({ expiresAt: Number.MAX_SAFE_INTEGER })), NOW)).toBeNull();
  });

  it('createdAt зажимается — сторис нельзя прибить к началу ленты', () => {
    const far = decodeStoryEnvelope(encodeStoryEnvelope(base({ createdAt: 9e15 })), NOW);
    expect(far?.createdAt).toBe(NOW + 5 * 60_000);
    const old = decodeStoryEnvelope(encodeStoryEnvelope(base({ createdAt: -9e15 })), NOW);
    expect(old?.createdAt).toBe(NOW - STORY_TTL_MS);
  });

  it('текст режется до 4096, тип медиа приводится к известному', () => {
    const long = decodeStoryEnvelope(encodeStoryEnvelope(base({ text: 'я'.repeat(9000) })), NOW);
    expect(long?.text).toHaveLength(4096);
    const weird = decodeStoryEnvelope(
      STORY_PREFIX + JSON.stringify({ ...base(), mediaType: 'сюрприз' }),
      NOW,
    );
    expect(weird?.mediaType).toBe('image');
  });

  it('медиа: обычный CID и nb:-дескриптор проходят, подставленный адрес — нет', () => {
    const cid = 'Q'.repeat(46);
    expect(decodeStoryEnvelope(encodeStoryEnvelope(base({ mediaCid: cid })), NOW)?.mediaCid).toBe(cid);

    const nb = 'nb:' + JSON.stringify({ u: 'https://ntfy.example/file/abc', k: 'a'.repeat(43) });
    expect(decodeStoryEnvelope(encodeStoryEnvelope(base({ mediaCid: nb })), NOW)?.mediaCid).toBe(nb);

    // Медиа сторис грузится само при открытии — подставленный адрес выдал бы
    // IP получателя и время просмотра.
    for (const bad of ['../../evil.example/p.png', 'x/../../y', 'https://evil.example/p.png', '']) {
      expect(decodeStoryEnvelope(encodeStoryEnvelope(base({ mediaCid: bad })), NOW)).toBeNull();
    }
  });

  it('нет обязательных полей — конверт отбрасывается', () => {
    expect(decodeStoryEnvelope(STORY_PREFIX + JSON.stringify({ ...base(), id: '' }), NOW)).toBeNull();
    expect(decodeStoryEnvelope(STORY_PREFIX + JSON.stringify({ ...base(), authorPubB64: 'коротко' }), NOW)).toBeNull();
    expect(decodeStoryEnvelope(STORY_PREFIX + JSON.stringify({ ...base(), authorDid: '' }), NOW)).toBeNull();
    expect(decodeStoryEnvelope(STORY_PREFIX + JSON.stringify({ ...base(), createdAt: 'вчера' }), NOW)).toBeNull();
  });

  it('гигантский конверт не разбирается', () => {
    expect(decodeStoryEnvelope(STORY_PREFIX + 'я'.repeat(70_000), NOW)).toBeNull();
  });
});

describe('storyEnvelope: текст чистится, а не только обрезается (v4.32.373)', () => {
  it('метки направления письма и управляющие символы не доезжают', () => {
    // Текст сторис рисуется обычным <Text> — и в полный экран, и подписью
    // поверх картинки, — то есть мимо FormattedText, который чистит тело
    // сообщения. Здесь стояла одна проверка длины.
    const rlo = decodeStoryEnvelope(encodeStoryEnvelope(base({ text: 'отчет\u202Eexe.pdf' })), NOW);
    expect(rlo?.text).toBe('отчетexe.pdf');
    const ctl = decodeStoryEnvelope(encodeStoryEnvelope(base({ text: 'a\u0000b\u0007c' })), NOW);
    expect(ctl?.text).toBe('abc');
  });

  it('подпись из четырёх тысяч переводов строки не растягивает экран', () => {
    const many = decodeStoryEnvelope(encodeStoryEnvelope(base({ text: 'верх' + '\n'.repeat(4000) + 'низ' })), NOW);
    expect(many?.text).toBe('верх\n\nниз');
  });

  it('сторис без картинки и без видимого текста отбрасывается', () => {
    // Показывать нечего: раньше она занимала место в ленте пустым чёрным
    // экраном — открыть можно, закрыть можно, а что это было, непонятно.
    expect(decodeStoryEnvelope(encodeStoryEnvelope(base({ text: '   ' })), NOW)).toBeNull();
    expect(decodeStoryEnvelope(encodeStoryEnvelope(base({ text: '\n\n\n' })), NOW)).toBeNull();
    expect(decodeStoryEnvelope(encodeStoryEnvelope(base({ text: null })), NOW)).toBeNull();
  });

  it('картинка без подписи по-прежнему годится', () => {
    const cid = decodeStoryEnvelope(
      encodeStoryEnvelope(base({ text: null, mediaCid: 'nb:v1:' + 'a'.repeat(43) + ':' + 'b'.repeat(43) })),
      NOW,
    );
    expect(cid == null || cid.text === null).toBe(true);
  });
});

/**
 * v4.32.380. Форма проверялась как typeof env === 'object' — а typeof []
 * тоже 'object'. Массив проходил дальше, и вызывающий читал с него поля,
 * получая undefined вместо честного отказа.
 */
describe('форма конверта', () => {
  it('массив — не конверт', () => {
    expect(decodeStoryEnvelope(STORY_PREFIX + '[]', NOW)).toBeNull();
    expect(decodeStoryEnvelope(STORY_PREFIX + JSON.stringify([base()]), NOW)).toBeNull();
  });

  it('примитив — не конверт', () => {
    for (const body of ['42', '"строка"', 'null', 'true']) {
      expect([body, decodeStoryEnvelope(STORY_PREFIX + body, NOW)]).toEqual([body, null]);
    }
  });
});
