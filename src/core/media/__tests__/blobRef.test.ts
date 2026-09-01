import { blobCacheId, blobCacheIdsIn, cachedBlobIdOf, fileExt, guessImageMime, isBlobRef, isDecryptedBlobUri, isNbCid, makeNbCid, parseNbCid, voiceFileUrisIn } from '../blobRef';

const KEY = 'a'.repeat(44);
const ID = '0123456789abcdef0123456789abcdef';

describe('isBlobRef', () => {
  it('принимает дескриптор с http-источником', () => {
    expect(isBlobRef({ u: 'https://ntfy.sh/file/x.bin', k: KEY })).toBe(true);
  });

  it('принимает дескриптор только с локальным идентификатором (доставка по сети WiFi)', () => {
    expect(isBlobRef({ i: ID, k: KEY })).toBe(true);
  });

  it('отвергает дескриптор без ключа', () => {
    expect(isBlobRef({ u: 'https://ntfy.sh/file/x.bin' })).toBe(false);
  });

  it('отвергает дескриптор без единого источника шифртекста', () => {
    expect(isBlobRef({ k: KEY })).toBe(false);
  });

  it('отвергает не-http источник — иначе загрузчик пойдёт по чужой схеме', () => {
    expect(isBlobRef({ u: 'file:///etc/passwd', k: KEY })).toBe(false);
    expect(isBlobRef({ u: 'javascript:alert(1)', k: KEY })).toBe(false);
  });

  it('отвергает идентификатор не из 32 hex-символов', () => {
    expect(isBlobRef({ i: 'нет', k: KEY })).toBe(false);
    expect(isBlobRef({ i: ID + 'ff', k: KEY })).toBe(false);
  });

  it('отвергает раздутый ключ и раздутый источник', () => {
    expect(isBlobRef({ u: 'https://ntfy.sh/f', k: 'a'.repeat(65) })).toBe(false);
    expect(isBlobRef({ u: 'https://ntfy.sh/' + 'a'.repeat(600), k: KEY })).toBe(false);
  });

  it('отвергает не-объект', () => {
    expect(isBlobRef(null)).toBe(false);
    expect(isBlobRef('nb:')).toBe(false);
  });
});

describe('nb:-дескриптор', () => {
  it('обход туда-обратно', () => {
    const ref = { u: 'https://ntfy.sh/file/x.bin', k: KEY, m: 'image/jpeg', i: ID };
    const cid = makeNbCid(ref);
    expect(isNbCid(cid)).toBe(true);
    expect(parseNbCid(cid)).toEqual(ref);
  });

  it('обычный CID дескриптором не считается', () => {
    expect(isNbCid('Qm' + 'a'.repeat(44))).toBe(false);
    expect(parseNbCid('Qm' + 'a'.repeat(44))).toBeNull();
  });

  it('испорченный JSON не роняет разбор', () => {
    expect(parseNbCid('nb:{')).toBeNull();
    expect(parseNbCid('nb:')).toBeNull();
  });
});

describe('fileExt / guessImageMime', () => {
  it('расширение из имени, иначе bin', () => {
    expect(fileExt('отчёт.PDF')).toBe('pdf');
    expect(fileExt('без-расширения')).toBe('bin');
  });

  it('тип снимка по расширению, по умолчанию jpeg', () => {
    expect(guessImageMime('file:///tmp/a.png')).toBe('image/png');
    expect(guessImageMime('file:///tmp/a.HEIC')).toBe('image/heic');
    expect(guessImageMime('file:///tmp/a.webp')).toBe('image/webp');
    expect(guessImageMime('content://media/1234')).toBe('image/jpeg');
  });

  it('хвост запроса не мешает определить расширение', () => {
    expect(guessImageMime('https://host/a.png?v=2')).toBe('image/png');
  });
});

describe('blobCacheId', () => {
  it('идентификатор LAN-дескриптора используется как есть', () => {
    expect(blobCacheId({ i: ID, k: KEY })).toBe(ID);
  });

  it('из ссылки берётся сегмент после /file/', () => {
    expect(blobCacheId({ u: 'https://ntfy.sh/file/abc-123.bin', k: KEY })).toBe('abc-123.bin');
  });

  it('идентификатор важнее ссылки — иначе один и тот же файл кэшировался бы дважды', () => {
    expect(blobCacheId({ i: ID, u: 'https://ntfy.sh/file/other.bin', k: KEY })).toBe(ID);
  });

  it('ссылка без /file/ сворачивается в устойчивый префикс', () => {
    const id = blobCacheId({ u: 'https://host/x', k: KEY });
    expect(id).toBe(blobCacheId({ u: 'https://host/x', k: KEY }));
    expect(id).toMatch(/^[0-9a-f]{1,24}$/);
  });

  it('негодный дескриптор не даёт имени файла', () => {
    expect(blobCacheId({ k: KEY } as never)).toBeNull();
  });
});

describe('blobCacheIdsIn', () => {
  it('пусто на пустом входе', () => {
    expect(blobCacheIdsIn(null)).toEqual([]);
    expect(blobCacheIdsIn('')).toEqual([]);
  });

  it('находит дескриптор в колонке media_cids', () => {
    const col = JSON.stringify([makeNbCid({ i: ID, k: KEY })]);
    expect(blobCacheIdsIn(col)).toContain(ID);
  });

  it('находит дескриптор внутри текста голосового сообщения', () => {
    const voice = `\x01voice:${JSON.stringify({ uri: 'file:///a.m4a', durationMs: 1200, b: { i: ID, k: KEY } })}`;
    expect(blobCacheIdsIn(voice)).toContain(ID);
  });

  it('находит идентификатор в ссылке на вложение', () => {
    expect(blobCacheIdsIn('https://ntfy.sh/file/zz-9.bin')).toContain('zz-9.bin');
  });

  it('несколько вложений в одном сообщении — все', () => {
    const other = 'f'.repeat(32);
    const col = JSON.stringify([makeNbCid({ i: ID, k: KEY }), makeNbCid({ i: other, k: KEY })]);
    const ids = blobCacheIdsIn(col);
    expect(ids).toContain(ID);
    expect(ids).toContain(other);
  });

  it('повторы схлопываются', () => {
    expect(blobCacheIdsIn(`${ID} ${ID}`)).toEqual([ID]);
  });

  it('обычный текст без вложений ничего не даёт', () => {
    expect(blobCacheIdsIn('привет, как дела? 1234567890')).toEqual([]);
  });
});

/**
 * Своя запись голосового.
 *
 * Форма ищется ровно та, что пишет makeVoiceText: разбирать JSON нельзя —
 * голосовое встречается вложенным в пересылку, а сканирование находит его в
 * любой обёртке.
 */
describe('voiceFileUrisIn', () => {
  const CACHE = 'file:///data/user/0/com.anonymous.airchat/cache/';
  const voice = (uri: string, extra = ''): string =>
    `\x01voice:${JSON.stringify({ uri, durationMs: 1200 })}`.replace('}', `${extra}}`);

  it('пусто на пустом входе', () => {
    expect(voiceFileUrisIn(null)).toEqual([]);
    expect(voiceFileUrisIn('обычный текст')).toEqual([]);
  });

  it('находит адрес записи', () => {
    const uri = `${CACHE}Audio/recording-1.m4a`;
    expect(voiceFileUrisIn(voice(uri))).toEqual([uri]);
  });

  it('находит запись внутри пересылки — кавычки там экранированы', () => {
    const uri = `${CACHE}Audio/recording-2.m4a`;
    const fwd = `\x08fwd:${JSON.stringify({ from: 'Кто-то', text: voice(uri) })}`;
    expect(voiceFileUrisIn(fwd)).toContain(uri);
  });

  it('находит запись и в пересылке пересылки', () => {
    // Экранирование накладывается ещё раз — а копия по-прежнему обязана
    // считаться живой ссылкой, иначе удаление оригинала её сломает.
    const uri = `${CACHE}Audio/recording-4.m4a`;
    const once = `\x08fwd:${JSON.stringify({ from: 'А', text: voice(uri) })}`;
    const twice = `\x08fwd:${JSON.stringify({ from: 'Б', text: once })}`;
    expect(voiceFileUrisIn(twice)).toContain(uri);
  });

  it('повторы схлопываются', () => {
    const uri = `${CACHE}Audio/recording-3.m4a`;
    expect(voiceFileUrisIn(`${voice(uri)} ${voice(uri)}`)).toEqual([uri]);
  });

  it('чужой http-адрес записью не считается', () => {
    // Играть чужой uri всё равно нельзя (voiceUriPolicy), а удалять по нему
    // нечего: файла на диске нет.
    expect(voiceFileUrisIn('\x01voice:{"uri":"https://evil.example/beacon.m4a","durationMs":1}')).toEqual([]);
  });

  it('адрес без префикса голосового не подхватывается', () => {
    // Иначе под удаление ушло бы всё, что похоже на путь, — включая снимки,
    // которые эта функция трогать не должна.
    expect(voiceFileUrisIn(`смотри ${CACHE}photo.jpg`)).toEqual([]);
  });
});

describe('cachedBlobIdOf / isDecryptedBlobUri', () => {
  const CACHE = 'file:///data/user/0/com.anonymous.airchat/cache/';

  it('имя нашего файла разбирается обратно в id', () => {
    // Обратная сторона blobCacheId: по нему файл называют, по этому — узнают.
    expect(cachedBlobIdOf('airchat_media_abc123.jpg')).toBe('abc123');
    expect(cachedBlobIdOf('airchat_media_abc123.mp4')).toBe('abc123');
  });

  it('точка в id не мешает — режем по последней', () => {
    expect(cachedBlobIdOf('airchat_media_a.b.c.bin')).toBe('a.b.c');
  });

  it('без расширения id всё равно виден', () => {
    expect(cachedBlobIdOf('airchat_media_abc123')).toBe('abc123');
  });

  it('чужое имя — не наш файл', () => {
    // Здесь решается, можно ли файл удалять: снимок из галереи и ciphertext
    // LAN-кэша нам не принадлежат.
    expect(cachedBlobIdOf('IMG_0421.HEIC')).toBeNull();
    expect(cachedBlobIdOf('airchat_blobcache_deadbeef')).toBeNull();
    expect(cachedBlobIdOf('airchat_media_')).toBeNull();
    expect(cachedBlobIdOf('airchat_media_.jpg')).toBeNull();
  });

  it('приставка проверяется с начала имени, а не где попало', () => {
    expect(cachedBlobIdOf('не_airchat_media_abc.jpg')).toBeNull();
  });

  it('по адресу узнаётся только наш файл', () => {
    expect(isDecryptedBlobUri(`${CACHE}airchat_media_abc123.jpg`)).toBe(true);
    // Своя сторис держит в media_uri снимок из галереи: он лежит в том же
    // кэше, но принадлежит не нам, и стереть его — значит забрать у человека
    // его собственную фотографию.
    expect(isDecryptedBlobUri(`${CACHE}ImagePicker/xyz.jpg`)).toBe(false);
    expect(isDecryptedBlobUri('file:///storage/emulated/0/DCIM/IMG_1.jpg')).toBe(false);
    expect(isDecryptedBlobUri('data:image/jpeg;base64,AAAA')).toBe(false);
  });

  it('хвост запроса в адресе не мешает', () => {
    expect(isDecryptedBlobUri(`${CACHE}airchat_media_abc.jpg?v=2`)).toBe(true);
  });
});
