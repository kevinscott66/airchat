/**
 * v4.32.518. Уборщик кэша вложений удалял файлы по одному только возрасту, и
 * это стирало вложения из живой переписки. Каталог называется «кэш», но
 * восстановить оттуда можно не всё: у вложения, доставленного по LAN,
 * `airchat_blobcache_<id>.bin` — единственный экземпляр шифротекста (ссылки на
 * сеть у такого дескриптора нет вовсе), а у приехавшего с релея вложение на
 * ntfy живёт около трёх часов, так что к суткам единственной остаётся уже
 * расшифрованная копия `airchat_media_<id>.<ext>`. Через 24 часа сообщение
 * оставалось на месте, а по нажатию не открывалось ничего.
 *
 * Проверок здесь два рода. Поведение: возраст — необходимое условие, но
 * решает ссылка, и при любой неопределённости файл остаётся. И форма
 * исходников: что решение принимается в одном месте, что список таблиц с
 * живыми ссылками один на всё приложение и что разбор имени файла не
 * размножился обратно.
 */

import fs from 'fs';
import path from 'path';

import { BLOB_CACHE_PREFIX, cachedBlobIdOf } from '../blobRef';
import { cacheFileBlobId, classifyCacheFile, isUnverifiableBlobId, sweepVerdict } from '../cacheSweepPolicy';

const SRC = path.join(__dirname, '..', '..', '..');
const CIPHER_PREFIX = 'airchat_blobcache_';
const PREFIXES = [BLOB_CACHE_PREFIX, CIPHER_PREFIX];
const TTL = 24 * 60 * 60_000;
const OLD = TTL + 1;
const FRESH = TTL - 1;

const POLICY = fs.readFileSync(path.join(SRC, 'core', 'media', 'cacheSweepPolicy.ts'), 'utf8');
const MEDIA_BLOB = fs.readFileSync(path.join(SRC, 'core', 'media', 'mediaBlob.ts'), 'utf8');
const BLOB_REF = fs.readFileSync(path.join(SRC, 'core', 'media', 'blobRef.ts'), 'utf8');
const LOCAL = fs.readFileSync(path.join(SRC, 'core', 'storage', 'local.ts'), 'utf8');
const APP = fs.readFileSync(path.join(SRC, 'App.tsx'), 'utf8');

/** LAN-id: ровно 32 шестнадцатеричных знака, как их пишет lanBlob. */
const LAN_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OTHER_ID = '00112233445566778899aabbccddeeff';

describe('старый файл удаляется, только если на него никто не ссылается', () => {
  it('шифротекст с LAN остаётся, пока сообщение с ним живо', () => {
    const live = new Set([LAN_ID]);
    expect(sweepVerdict(`${CIPHER_PREFIX}${LAN_ID}.bin`, OLD, TTL, PREFIXES, live)).toBe('keep');
  });

  it('шифротекст без единой ссылки — мусор и удаляется', () => {
    const live = new Set([OTHER_ID]);
    expect(sweepVerdict(`${CIPHER_PREFIX}${LAN_ID}.bin`, OLD, TTL, PREFIXES, live)).toBe('delete');
  });

  it('расшифрованная копия живого вложения тоже остаётся: с релея её взять уже негде', () => {
    const live = new Set([LAN_ID]);
    expect(sweepVerdict(`${BLOB_CACHE_PREFIX}${LAN_ID}.jpg`, OLD, TTL, PREFIXES, live)).toBe('keep');
  });

  it('расшифрованная копия исчезнувшего сообщения удаляется', () => {
    expect(sweepVerdict(`${BLOB_CACHE_PREFIX}${LAN_ID}.jpg`, OLD, TTL, PREFIXES, new Set())).toBe('delete');
  });

  it('свежий файл не трогается, даже если ссылок на него нет', () => {
    expect(sweepVerdict(`${CIPHER_PREFIX}${LAN_ID}.bin`, FRESH, TTL, PREFIXES, new Set())).toBe('keep');
    expect(sweepVerdict(`${BLOB_CACHE_PREFIX}${LAN_ID}.jpg`, FRESH, TTL, PREFIXES, new Set())).toBe('keep');
  });

  it('чужой файл в том же каталоге не удаляется никогда', () => {
    for (const name of ['IMG_0042.jpg', 'ExponentAsset-abc.ttf', 'airchat_media_.jpg', '']) {
      expect(classifyCacheFile(name, OLD, TTL, PREFIXES)).toBe('foreign');
      expect(sweepVerdict(name, OLD, TTL, PREFIXES, new Set())).toBe('keep');
    }
  });
});

describe('неизвестность решается в пользу сохранения', () => {
  it('не удалось получить список живых ссылок — не удаляется ничего', () => {
    expect(sweepVerdict(`${CIPHER_PREFIX}${LAN_ID}.bin`, OLD, TTL, PREFIXES, null)).toBe('keep');
    expect(sweepVerdict(`${BLOB_CACHE_PREFIX}${LAN_ID}.jpg`, OLD, TTL, PREFIXES, null)).toBe('keep');
  });

  it('id, выведенный хешированием адреса, сверить нечем — файл остаётся', () => {
    // 24 шестнадцатеричных знака — форма hex(url).slice(0, 24); в тексте
    // сообщения такой id не встречается, поэтому «нет в живых» о нём не значит
    // ничего.
    const hashed = 'deadbeefcafe0123456789ab';
    expect(isUnverifiableBlobId(hashed)).toBe(true);
    expect(sweepVerdict(`${BLOB_CACHE_PREFIX}${hashed}.jpg`, OLD, TTL, PREFIXES, new Set())).toBe('keep');
  });

  it('обычный LAN-id сверяется как есть', () => {
    expect(isUnverifiableBlobId(LAN_ID)).toBe(false);
    expect(isUnverifiableBlobId('ZZZZZZZZZZZZZZZZZZZZZZZZ')).toBe(false);
  });
});

describe('имя файла разбирается одним правилом', () => {
  it('обе приставки дают id', () => {
    expect(cacheFileBlobId(`${BLOB_CACHE_PREFIX}${LAN_ID}.jpg`, PREFIXES)).toBe(LAN_ID);
    expect(cacheFileBlobId(`${CIPHER_PREFIX}${LAN_ID}.bin`, PREFIXES)).toBe(LAN_ID);
  });

  it('режется последняя точка, а не первая: расширение может быть любым', () => {
    expect(cacheFileBlobId(`${BLOB_CACHE_PREFIX}my.file.name.m4a`, PREFIXES)).toBe('my.file.name');
    expect(cacheFileBlobId(`${BLOB_CACHE_PREFIX}${LAN_ID}`, PREFIXES)).toBe(LAN_ID);
  });

  it('пустой id — не наш файл', () => {
    expect(cacheFileBlobId(`${BLOB_CACHE_PREFIX}.jpg`, PREFIXES)).toBeNull();
    expect(cacheFileBlobId('', PREFIXES)).toBeNull();
    expect(cacheFileBlobId(`${BLOB_CACHE_PREFIX}${LAN_ID}.jpg`, [''])).toBeNull();
  });

  it('cachedBlobIdOf — тот же разбор, а не своя копия', () => {
    expect(BLOB_REF).toContain('return cacheFileBlobId(fileName, [BLOB_CACHE_PREFIX]);');
    for (const name of [`${BLOB_CACHE_PREFIX}${LAN_ID}.jpg`, `${BLOB_CACHE_PREFIX}.jpg`, `${CIPHER_PREFIX}${LAN_ID}.bin`, 'IMG_1.jpg']) {
      expect(cachedBlobIdOf(name)).toBe(cacheFileBlobId(name, [BLOB_CACHE_PREFIX]));
    }
  });
});

describe('уборщик не решает сам', () => {
  it('модуль правила ни от чего не зависит', () => {
    expect(POLICY.split('\n').filter((line) => line.startsWith('import '))).toEqual([]);
  });

  it('sweepMediaCache спрашивает правило, а не сравнивает возраст сам', () => {
    expect(MEDIA_BLOB).toContain('sweepVerdict(');
    expect(MEDIA_BLOB).toContain("classifyCacheFile(name, ageMs, ttlMs, CACHE_PREFIXES) === 'expired'");
    // Прежняя форма: возраст сравнивался прямо перед удалением файла.
    expect(MEDIA_BLOB).not.toContain('if (ageMs > ttlMs) {');
  });

  it('источник живых ссылок передаётся аргументом, а не берётся импортом', () => {
    // Отложенный import() тоже разорвал бы кольцо mediaBlob ↔ local, но его
    // сбой виден только в логе живого устройства. Для решения об удалении
    // файлов такая слепая зона недопустима, поэтому связь — обычный параметр.
    expect(MEDIA_BLOB).toContain('export type LiveBlobIdsLoader');
    expect(MEDIA_BLOB).toContain('sweepMediaCache(loadLiveIds: LiveBlobIdsLoader');
    expect(MEDIA_BLOB).not.toContain("import('../storage/local')");
  });

  it('сбой при чтении базы не удаляет ничего', () => {
    const sweep = MEDIA_BLOB.slice(MEDIA_BLOB.indexOf('export async function sweepMediaCache'));
    expect(sweep).toContain('let liveIds: ReadonlySet<string> | null = null;');
    expect(sweep.indexOf('liveIds = await loadLiveIds();')).toBeGreaterThan(0);
  });

  it('запуск приложения передаёт уборщику настоящий источник', () => {
    expect(APP).toContain('sweepMediaCache(liveAttachmentBlobIds)');
    expect(APP).toContain('liveAttachmentBlobIds');
  });
});

describe('живой считается ссылка из любой таблицы, а не только из переписки', () => {
  it('перечислены все пять таблиц, способных держать вложение', () => {
    for (const table of ['chat_messages', 'group_messages', 'scheduled_messages', 'stories', 'outbox']) {
      expect(LOCAL).toContain(`FROM ${table}`);
    }
    const sources = LOCAL.slice(LOCAL.indexOf('const ATTACHMENT_REF_SOURCES'), LOCAL.indexOf('export async function liveAttachmentRefs'));
    for (const table of ['chat_messages', 'group_messages', 'scheduled_messages', 'stories', 'outbox']) {
      expect(sources).toContain(`FROM ${table}`);
    }
  });

  it('список без WHERE: кэш один на приложение, а профилей несколько', () => {
    const sources = LOCAL.slice(LOCAL.indexOf('const ATTACHMENT_REF_SOURCES'), LOCAL.indexOf('export async function liveAttachmentRefs'));
    expect(sources).not.toContain('WHERE');
  });

  it('удаление вслед за сообщением пользуется тем же списком', () => {
    const drop = LOCAL.slice(LOCAL.indexOf('async function dropOrphanBlobCache'));
    expect(drop.slice(0, 1600)).toContain('await liveAttachmentRefs()');
    expect(drop.slice(0, 1600)).not.toContain("FROM chat_messages'");
  });
});
