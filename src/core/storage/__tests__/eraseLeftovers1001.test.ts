import fs from 'fs';
import path from 'path';

/**
 * Дефект. Четыре действия обещают человеку удаление «с этого устройства»:
 * «Очистить историю» в переписке, в группе, в настройках и выход из группы.
 * Строки они стирают всегда. Расшифрованные снимки и голосовые лежат не в
 * строке — отдельными файлами в кэше приложения, и сносит их уборщик
 * `dropOrphanBlobCache` следом за строками. Уборщик не трогал файл в двух
 * случаях, и оба молчали: часть строк не прочиталась ключом данных (тогда
 * нельзя понять, не нужен ли файл уцелевшей переписке — v4.32.564) и
 * файловая система отказала в удалении (`deleteCachedBlobs` и
 * `deleteCachedFileUris` пропускают такой файл и отдают счётчик снесённых).
 * Оба раза уборщик возвращался как ни в чём не бывало, и экран говорил
 * «Переписка удалена».
 *
 * Цена. В приложении переписки больше нет, а фотографии и голосовые из неё
 * лежат на диске расшифрованными: их видит файловый менеджер и уносит
 * резервная копия устройства. Человек прочитал, что на телефоне не осталось
 * ничего, и второй раз туда не вернётся — искать нечего, интерфейс пуст.
 *
 * Правка (v4.32.1001). `dropOrphanBlobCache` отвечает `clean` или `kept`
 * (eraseOutcome.ts), исход доезжает до четырёх функций стирания и оттуда до
 * шести мест на экранах, где о нём говорит общий `reportErased`. Дочищать
 * нельзя: осторожность уборщика защищает вложения ДРУГИХ переписок.
 *
 * Границы. Осторожность уборщика и молчание пофайловых удалений — не дефект,
 * а причина правки: они проверяются как живые ниже. Удаление ОДНОГО
 * сообщения исход не отдаёт — там обещание другое («сообщение осталось в
 * переписке»), и трогать его нечем.
 */

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const LOCAL = read('core', 'storage', 'local.ts');
const FEEDBACK = read('ui', 'components', 'userFeedback.ts');
const MEDIA = read('core', 'media', 'mediaBlob.ts');
const PEEK = read('ui', 'components', 'UserProfilePeek.tsx');
const CHAT = read('ui', 'screens', 'ChatScreen.tsx');
const LIST = read('ui', 'screens', 'ChatListScreen.tsx');
const SETTINGS = read('ui', 'screens', 'SettingsScreen.tsx');
const GROUPS = read('ui', 'screens', 'GroupsScreen.tsx');

// Отдельный модуль до правки не существовал, а `readFileSync` по нему уронил
// бы и контрольные блоки — их повод должен быть жив на обеих версиях кода.
const OUTCOME_PATH = path.join(SRC, 'core', 'storage', 'eraseOutcome.ts');
const OUTCOME = fs.existsSync(OUTCOME_PATH) ? fs.readFileSync(OUTCOME_PATH, 'utf8') : '';

/** Пояснение в комментарии не должно засчитываться за код. */
function codeOnly(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

/** Одно тело функции, чтобы совпадение не пришло от соседней. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('стирание: расшифрованные копии вложений больше не молчат', () => {
  it('уборщик кэша отвечает исходом, а не пустотой', () => {
    expect(OUTCOME).toContain("export type BlobCacheSweep = 'clean' | 'kept';");
    expect(codeOnly(LOCAL)).toContain(
      'async function dropOrphanBlobCache(doomed: AttachmentRefs): Promise<BlobCacheSweep>'
    );
  });

  it('оба молчавших выхода называют остаток', () => {
    const sweep = codeOnly(slice(LOCAL, 'async function dropOrphanBlobCache(', '\n/**'));
    // Неполный обход строк.
    expect(sweep).toContain("log.warn('blob_cache_sweep_skipped_incomplete'");
    // Пойманная ошибка.
    expect(sweep).toContain("log.warn('blob_cache_sweep_failed'");
    expect(sweep.match(/return 'kept';/g) ?? []).toHaveLength(2);
  });

  it('исход берётся с диска, а не из намерения удалить', () => {
    const sweep = codeOnly(slice(LOCAL, 'async function dropOrphanBlobCache(', '\n/**'));
    expect(sweep).toContain('cachedBlobIdsPresent(idsToDelete)');
    expect(sweep).toContain('cachedFileUrisPresent(urisToDelete)');
    expect(sweep).toContain("keptIds.length === 0 && keptUris.length === 0 ? 'clean' : 'kept'");
  });

  it('четыре стирания отдают исход наружу', () => {
    const code = codeOnly(LOCAL);
    expect(code).toContain('): Promise<BlobCacheSweep> {\n  let sweep: BlobCacheSweep');
    expect(code).toContain('export async function deleteGroup(id: string, ownerProfileId: number): Promise<BlobCacheSweep>');
    expect(code).toContain('): Promise<BlobCacheSweep | \'failed\'> {');
    // Ровно три функции возвращают исход напрямую и одна — с отказом.
    expect((code.match(/Promise<BlobCacheSweep> \{\n {2}let sweep/g) ?? []).length).toBe(3);
  });

  it('слово об остатке одно на все экраны', () => {
    expect(codeOnly(FEEDBACK)).toContain('export function reportErased(');
    expect(FEEDBACK).toContain(
      '`${done}, но расшифрованные копии вложений остались на устройстве`'
    );
    // Тон отказа: сделано не то, о чём договаривались.
    const fn = codeOnly(slice(FEEDBACK, 'export function reportErased(', '\n/**'));
    expect(fn).toContain("if (sweep === 'kept') {");
    expect(fn).toContain('showError(');
    expect(fn).toContain("if (opts?.quietOnSuccess !== true) showSuccess(done);");
  });

  it('все шесть мест на экранах говорят исходом', () => {
    expect(codeOnly(PEEK)).toContain("reportErased(sweep, 'Переписка удалена')");
    expect(codeOnly(CHAT)).toContain("reportErased(sweep, 'История очищена')");
    expect(codeOnly(LIST)).toContain(
      "reportErased(sweep, 'История очищена', { quietOnSuccess: true })"
    );
    expect(codeOnly(SETTINGS)).toContain("reportErased(res, 'История очищена')");
    expect(codeOnly(GROUPS)).toContain("reportErased(sweep, 'История очищена')");
    expect(codeOnly(GROUPS)).toContain(
      "reportErased(sweep, 'Вы вышли из группы', { quietOnSuccess: true })"
    );
  });

  it('ни одно из шести не объявляет успех в обход исхода', () => {
    expect(codeOnly(PEEK)).not.toContain("showSuccess('Переписка удалена')");
    expect(codeOnly(CHAT)).not.toContain("showSuccess('История очищена')");
    expect(codeOnly(SETTINGS)).not.toContain("showSuccess('История очищена')");
    expect(codeOnly(GROUPS)).not.toContain("showSuccess('История очищена')");
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: остаток берётся не из воздуха', () => {
  it('осторожность уборщика на месте — дочищать по-прежнему нельзя', () => {
    const sweep = slice(LOCAL, 'async function dropOrphanBlobCache(', '\n/**');
    expect(sweep).toContain('if (!mayDeleteUnreferenced(alive.scan))');
  });

  it('пофайловое удаление по-прежнему молчит и считает, а не бросает', () => {
    const del = slice(MEDIA, 'export async function deleteCachedBlobs(', 'export async function cachedBlobIdsPresent(');
    expect(del).toContain('/* skip this file */');
    expect(del).toContain('return removed;');
    const uris = slice(MEDIA, 'export async function deleteCachedFileUris(', 'export async function cachedFileUrisPresent(');
    expect(uris).toContain('/* skip this file */');
    expect(uris).toContain('return removed;');
  });

  it('все четыре подтверждения по-прежнему обещают устройство', () => {
    expect(PEEK).toContain('будут удалены на этом устройстве');
    expect(LIST).toContain('будут удалены с вашего устройства');
    expect(GROUPS).toContain('Переписка будет удалена с этого устройства');
    expect(SETTINGS).toContain('Удалить все сообщения с устройства');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: стирание на месте', () => {
  it('файлы по-прежнему сносятся только после фиксации строк', () => {
    const erase = codeOnly(slice(LOCAL, 'async function eraseAtomically(', '\n/**'));
    expect(erase).toContain('await txn.commit();');
    expect(erase).toContain('await files();');
    expect(erase.indexOf('await txn.commit();')).toBeLessThan(erase.indexOf('await files();'));
  });

  it('удаление одного сообщения исход не отдаёт — обещание там другое', () => {
    const code = codeOnly(LOCAL);
    expect(code).toContain('if (removed) await dropOrphanBlobCache(doomed);');
  });
});
