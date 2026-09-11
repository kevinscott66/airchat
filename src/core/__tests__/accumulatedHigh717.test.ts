/**
 * Накопленные HIGH-находки трёх разборов, закрытые в v4.32.717.
 *
 * Здесь закреплены те правки, у которых нет отдельного дома: поведение самих
 * модулей проверяют их собственные наборы (storyAlbumOrphans, dialogBackupFile,
 * seedWrapKey), а этот файл держит формы вызовов на местах, где поведение
 * проверить нечем — экран без окружения RN и разбор мутации синхронизации,
 * который требует всей облачной обвязки.
 */

import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

/** Код без комментариев: иначе собственное объяснение правки гасит запрет. */
function codeOnly(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const WALLPAPER = read('ui/components/modals/chat/ChatWallpaperPickerModal.tsx');
const DIALOG_BACKUP = read('core/storage/dialogBackup.ts');
const LOCAL = read('core/storage/local.ts');
const SEED = read('core/backup/seedPhrase.ts');
const LIVE = read('core/sync/liveAccountSync.ts');
const ALBUMS = read('core/social/storyAlbums.ts');

describe('файлы вообще прочитаны', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: ни один срез не оказался пустой строкой', () => {
    expect(WALLPAPER.length).toBeGreaterThan(3_000);
    expect(DIALOG_BACKUP.length).toBeGreaterThan(10_000);
    expect(LOCAL.length).toBeGreaterThan(200_000);
    expect(SEED.length).toBeGreaterThan(10_000);
    expect(LIVE.length).toBeGreaterThan(30_000);
    expect(ALBUMS.length).toBeGreaterThan(8_000);
  });
});

describe('выбор фона чата (Chat-UI HIGH #1)', () => {
  it('ответ записи проверяется, а не выбрасывается', () => {
    expect(WALLPAPER).toContain('scopedKvSetChecked(');
    // ПОВОД ДЛЯ ПРАВКИ ЖИВ: непроверяющей записи в файле больше нет.
    // scopedKvSet отдаёт void — «легло» и «база отказала» приходили одинаково.
    expect(codeOnly(WALLPAPER)).not.toMatch(/\bawait scopedKvSet\(/);
  });

  it('отказ записи виден человеку и окно не закрывается', () => {
    const from = WALLPAPER.indexOf('const save = async (');
    const body = WALLPAPER.slice(from, WALLPAPER.indexOf('\n  };', from));
    // ПРОВЕРКА НЕ ПУСТАЯ: срез захватил тело функции.
    expect(body.length).toBeGreaterThan(200);
    expect(body).toContain('showError(');
    // Возврат стоит ДО применения фона и закрытия окна.
    const stop = body.indexOf('return;');
    expect(stop).toBeGreaterThan(0);
    expect(body.indexOf('onApply(')).toBeGreaterThan(stop);
    expect(body.indexOf('onClose()')).toBeGreaterThan(stop);
  });

  it('у выбора фото из галереи есть ловец', () => {
    expect(WALLPAPER).toContain("await import('expo-image-picker')");
    expect(WALLPAPER).toMatch(/\}\)\(\)\.catch\(/);
    expect(WALLPAPER).toContain('userErrorText(');
  });
});

describe('импорт копии диалогов (Backup HIGH #2 и #3)', () => {
  it('счёт сообщений тристороннен', () => {
    expect(LOCAL).toContain(
      'export async function countChatMessages(ownerProfileId?: number): Promise<number | null>');
    expect(LOCAL).toContain("log.warn('chat_messages_count_failed'");
  });

  it('неизвестный размер базы держит импорт', () => {
    expect(DIALOG_BACKUP).toContain('existing === null');
    expect(DIALOG_BACKUP).toContain("log.warn('dialog_backup_hold_unknown_db_size')");
    // ПОВОД ДЛЯ ПРАВКИ ЖИВ: проверка непустой базы осталась на месте — она про другое.
    expect(DIALOG_BACKUP).toContain('existing > 0');
  });

  it('пять шагов импорта независимы', () => {
    expect(DIALOG_BACKUP).toContain("log.warn('dialog_backup_step_failed'");
    expect(DIALOG_BACKUP).toContain("log.warn('dialog_backup_import_partial'");
    for (const step of ["step('messages'", "step('kv'", "step('conversations'",
      "step('meta'", "step('groups'"]) {
      expect(DIALOG_BACKUP).toContain(step);
    }
  });
});

describe('наличие сид-фразы (Backup HIGH #1)', () => {
  it('наличие записи не требует, чтобы она открылась', () => {
    const from = SEED.indexOf('async function hasStoredMnemonicUncached');
    const body = SEED.slice(from, SEED.indexOf('\n}', from));
    // ПРОВЕРКА НЕ ПУСТАЯ: срез захватил тело функции.
    expect(body.length).toBeGreaterThan(150);
    expect(body).toContain('if (encRaw) return true;');
    // ПОВОД ДЛЯ ПРАВКИ ЖИВ: расшифровка сюда не вернулась. Негодный ключ обёртки
    // давал «фразы нет» — тот же ответ, что и чистая установка, а на него экран
    // приветствия показывает живую кнопку «Создать новый аккаунт».
    expect(codeOnly(body)).not.toContain('tryDecryptLocalPayload');
    // Разбирать «нет» и «не открылась» умеет отдельное решение.
    expect(SEED).toContain('tryDecryptLocalPayload');
  });
});

describe('неподтверждённая метка удаления (Sync HIGH #2)', () => {
  it('разбор мутации отвечает, применил ли он её', () => {
    expect(LIVE).toContain(
      'async function applyPulledMutation(mnemonic: string, mutation: SyncMutation): Promise<boolean>');
    expect(LIVE).toContain("log.warn('live_sync_tombstone_unauthenticated'");
  });

  it('отметка не ставится про то, что не применилось', () => {
    const from = LIVE.indexOf('applyMutation: async (mutation) => {');
    const body = LIVE.slice(from, LIVE.indexOf('afterProjection:', from));
    // ПРОВЕРКА НЕ ПУСТАЯ: срез захватил обработчик.
    expect(body.length).toBeGreaterThan(400);
    expect(body).toContain('const applied = await applyPulledMutation(mnemonic, mutation);');
    expect(body).toContain('if (!applied) return;');
    // Порядок важен: отказ отсекается ДО записи отметки, иначе отметка
    // «удалено, версия N» работала бы потолком для настоящих правок.
    expect(body.indexOf('if (!applied) return;'))
      .toBeLessThan(body.indexOf('localHeads.set(key, {'));
  });
});

describe('уборка потерянных строк альбома (Sync HIGH #1)', () => {
  it('отметке гасится признак «строка есть», но не номер версии', () => {
    expect(LOCAL).toContain('export async function suppressSyncEntityTombstones(');
    expect(LOCAL).toContain(
      "'UPDATE sync_entity_heads SET deleted = 1, fingerprint = NULL, updated_at = ? WHERE owner_profile_id = ? AND entity_kind = ? AND entity_id = ?'");
    // Забыть номер версии — значит открыть откат (v4.32.615).
    expect(codeOnly(LOCAL)).not.toContain('DELETE FROM sync_entity_heads');
    expect(ALBUMS).toContain("suppressSyncEntityTombstones('story_album_item'");
  });

  it('часы отсрочки местные, а не из содержимого строки', () => {
    expect(ALBUMS).toContain("const ORPHAN_SEEN_KEY = 'story:album_orphan_seen';");
    expect(ALBUMS).toContain('scopedKvTryGetFor(');
    expect(ALBUMS).toContain('scopedKvSetCheckedFor(');
    expect(ALBUMS).toContain("log.warn('story_album_orphan_seen_unreadable')");
  });

  it('ключ памяти местный: в облачную копию он не входит', () => {
    const kvKeys = read('core/storage/kvKeys.ts');
    // ПРОВЕРКА НЕ ПУСТАЯ: файл отбора прочитан.
    expect(kvKeys.length).toBeGreaterThan(5_000);
    expect(kvKeys).not.toContain('album_orphan_seen');
  });
});
