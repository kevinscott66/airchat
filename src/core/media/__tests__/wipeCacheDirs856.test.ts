/**
 * Сброс устройства не заходил в подкаталоги кэша (v4.32.856).
 *
 * Дефект: уборка при «Выйти и удалить данные на устройстве» читала только
 * верхний уровень каталога кэша и сверяла имена файлов с приставками. Запись
 * голоса, выбор фотографии, съёмка, сжатие снимка перед отправкой и выбор
 * документа кладут своё каждый в свой подкаталог (`ExpoAudio`/`Audio`,
 * `ImagePicker`, `Camera`, `ImageManipulator`, `DocumentPicker`). Имя каталога
 * не совпадает ни с одной приставкой и ни с одним расширением, поэтому всё их
 * содержимое обход пропускал.
 *
 * Цена: файл записи после успешной отправки не удаляется никогда — он нужен,
 * чтобы своё голосовое игралось мгновенно. То есть в `ExpoAudio` лежит открытым
 * `.m4a` всё, что человек когда-либо наговорил, а рядом — исходники и сжатые
 * копии всех отправленных снимков и копии приложенных документов. Приложение
 * отчитывалось об успешном удалении данных, а эта запись целиком доставалась
 * следующему владельцу телефона или ближайшей резервной копии. Суточная уборка
 * туда тоже не ходит, так что дело не в остатках: это вся история.
 *
 * Правка: сброс сносит перечисленные каталоги целиком, независимо от обхода по
 * именам. «Очистить кэш» в настройках туда не заходит намеренно — приложение в
 * этот момент работает, и своё голосовое играется из этого самого файла.
 */
let mockRoot: string[] = [];
let mockSubdirs: Record<string, string[]> = {};
let mockRootThrows = false;
let mockDeleteThrowsFor: string[] = [];
const deleted: string[] = [];

jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: '/cache/',
  readDirectoryAsync: jest.fn(async (uri: string) => {
    if (uri === '/cache/' || uri === '/cache') {
      if (mockRootThrows) throw new Error('EIO');
      return mockRoot;
    }
    const sub = mockSubdirs[uri.replace(/^\/cache\/?/, '')];
    // Каталога нет на диске — система отказывает ровно так же.
    if (!sub) throw new Error('ENOENT');
    return sub;
  }),
  deleteAsync: jest.fn(async (uri: string) => {
    if (mockDeleteThrowsFor.includes(uri)) throw new Error('EPERM');
    deleted.push(uri);
  }),
  writeAsStringAsync: jest.fn(async () => {}),
}));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => false),
  shareAsync: jest.fn(async () => {}),
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CLEARABLE_CACHE_PREFIXES,
  CLEARABLE_CACHE_SUFFIXES,
  WIPE_CACHE_DIRS,
  WIPE_CACHE_PREFIXES,
  clearCacheFiles,
  purgeSensitiveCache,
} from '../cacheFiles';

const SRC = join(__dirname, '..', '..', '..');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

beforeEach(() => {
  mockRoot = [];
  mockSubdirs = {};
  mockRootThrows = false;
  mockDeleteThrowsFor = [];
  deleted.length = 0;
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('обход по именам не может достать до записи голоса', () => {
    // Ровно то, из-за чего каталоги и пришлось называть отдельно: ни одна
    // приставка не совпадает с именем каталога, а `.m4a` в списке расширений
    // нет вовсе — то есть даже попади файл записи в корень, его бы не убрали.
    for (const dir of WIPE_CACHE_DIRS) {
      expect(WIPE_CACHE_PREFIXES.some((p) => dir.startsWith(p))).toBe(false);
    }
    expect(CLEARABLE_CACHE_SUFFIXES).not.toContain('.m4a');
  });

  it('запись голоса после успешной отправки остаётся на диске', () => {
    // Если бы её удаляли, каталог был бы пустым и цена дефекта — нулевой.
    // Удаляют запись только там, где она никуда не ушла.
    const chat = read('ui/screens/ChatScreen.tsx');
    const at = chat.indexOf('const sendVoice = useCallback(');
    expect(at).toBeGreaterThan(0);
    const body = chat.slice(at, chat.indexOf('const sendGif = useCallback(', at));
    // v4.32.860: удалений стало два — отказ отправки перестал быть исключением
    // и убирает за собой сам. Важно не их число, а то, что оба стоят на путях
    // неудачи: после успешной отправки файл остаётся лежать.
    const spots = [...body.matchAll(/deleteCachedFileUris\(\[result\.uri\]\)/g)].map((m) => m.index ?? 0);
    expect(spots).toHaveLength(2);
    const refused = body.indexOf("if (res.outcome === 'refused') {");
    const caught = body.indexOf('} catch (e) {');
    expect(refused).toBeGreaterThan(0);
    expect(caught).toBeGreaterThan(refused);
    expect(spots[0]).toBeGreaterThan(refused);
    expect(spots[0]).toBeLessThan(caught);
    expect(spots[1]).toBeGreaterThan(caught);
    // Успешный путь — между веткой отказа и catch — файл не трогает.
    expect(body.slice(body.indexOf('await appendNewMessages();'), caught)).not.toContain(
      'deleteCachedFileUris'
    );
  });

  it('суточная уборка в подкаталоги тоже не ходит', () => {
    // Значит, накопленное не убирает вообще никто, кроме сброса.
    const blob = read('core/media/mediaBlob.ts');
    const at = blob.indexOf('export async function sweepMediaCache(');
    expect(at).toBeGreaterThan(0);
    const body = blob.slice(at, blob.indexOf('\n}', at));
    expect(body).toContain('FileSystem.readDirectoryAsync(dir)');
    for (const dir of WIPE_CACHE_DIRS) expect(body).not.toContain(dir);
  });
});

describe('сброс устройства', () => {
  it('уносит все записи голоса — и на iOS, и на Android', async () => {
    // iOS зовёт каталог ExpoAudio, Android — Audio; список покрывает обе.
    mockSubdirs = {
      ExpoAudio: ['recording-1.m4a', 'recording-2.m4a'],
      Audio: ['recording-3.m4a'],
    };
    expect(await purgeSensitiveCache()).toBe(3);
    expect(deleted).toEqual(['/cache/ExpoAudio', '/cache/Audio']);
  });

  it('уносит снимки, съёмку, сжатые копии и приложенные документы', async () => {
    mockSubdirs = {
      ImagePicker: ['a.jpg'],
      Camera: ['b.mp4'],
      ImageManipulator: ['c.jpg'],
      DocumentPicker: ['паспорт.pdf'],
    };
    expect(await purgeSensitiveCache()).toBe(4);
    expect(deleted).toEqual([
      '/cache/ImagePicker',
      '/cache/Camera',
      '/cache/ImageManipulator',
      '/cache/DocumentPicker',
    ]);
  });

  it('считает удалённое вместе с файлами верхнего уровня', async () => {
    mockRoot = ['airchat_export_chat_1.txt', 'photo.JPG'];
    mockSubdirs = { ExpoAudio: ['r1.m4a', 'r2.m4a'] };
    expect(await purgeSensitiveCache()).toBe(4);
  });

  it('отказ чтения корня кэша больше не оставляет записи на диске', async () => {
    // Прежде обход был единственным путём: не прочитался корень — не удалено
    // ничего. Имена каталогов известны заранее, и на них отказ не влияет.
    mockRootThrows = true;
    mockSubdirs = { ExpoAudio: ['r1.m4a'] };
    expect(await purgeSensitiveCache()).toBe(1);
    expect(deleted).toEqual(['/cache/ExpoAudio']);
  });

  it('каталога нет — вслепую не удаляет', async () => {
    // Список имён выписан от руки и когда-нибудь разойдётся с тем, что заводят
    // пакеты. Удалять по имени несуществующее значило бы трогать чужой кэш.
    mockRoot = ['some_other_lib.dat'];
    expect(await purgeSensitiveCache()).toBe(0);
    expect(deleted).toEqual([]);
  });

  it('один каталог не удалился — остальные всё равно уходят', async () => {
    mockSubdirs = { ExpoAudio: ['r1.m4a'], ImagePicker: ['a.jpg'] };
    mockDeleteThrowsFor = ['/cache/ExpoAudio'];
    expect(await purgeSensitiveCache()).toBe(1);
    expect(deleted).toEqual(['/cache/ImagePicker']);
  });
});

describe('«Очистить кэш» в настройках', () => {
  it('в подкаталоги не заходит — своё голосовое продолжает играться', async () => {
    // Снести файл записи на живом приложении значит получить пузырь, который
    // не играется, и перекачать его неоткуда: у своего голосового вложения на
    // релее уже нет. Это тот же дефект, что закрыт в v4.32.702.
    mockRoot = ['airchat_export_chat_1.txt'];
    mockSubdirs = { ExpoAudio: ['r1.m4a'], ImagePicker: ['a.jpg'] };
    expect(await clearCacheFiles(async () => new Set<string>())).toBe(1);
    expect(deleted).toEqual(['/cache/airchat_export_chat_1.txt']);
  });

  it('список ручной чистки не пересекается со списком каталогов', () => {
    for (const dir of WIPE_CACHE_DIRS) {
      expect(CLEARABLE_CACHE_PREFIXES.some((p) => dir.startsWith(p))).toBe(false);
    }
  });
});
