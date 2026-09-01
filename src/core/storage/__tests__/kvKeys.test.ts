/**
 * v4.32.280. Резервная копия диалогов снимается одним правилом, а
 * восстанавливается другим — и когда эти два правила разъехались, контакты в
 * копию просто перестали попадать: экспорт искал `contacts_index`, а лежали они
 * уже под `p1:contacts_index`. Молча, без ошибки: файл получался «успешным», а
 * после переустановки человек видел пустой список чатов.
 *
 * Поэтому оба конца проверяются здесь, в паре.
 */
import {
  BLOCKED_KEY_BASE,
  dialogBackupKeySelectors,
  dialogBackupLogicalKey,
  dialogBackupStoredKey,
  hasProfilePrefix,
  legacySuffixBlockedKey,
  LEGACY_GLOBAL_SYNC_KEYS,
  profileScopedKey,
} from '../kvKeys';

const PUB = 'A'.repeat(43);

describe('profileScopedKey', () => {
  it('собирает префикс профиля', () => {
    expect(profileScopedKey(2, 'contacts_index')).toBe('p2:contacts_index');
  });

  it('отличает ключ профиля от глобального', () => {
    expect(hasProfilePrefix('p12:contacts_index')).toBe(true);
    expect(hasProfilePrefix('contacts_index')).toBe(false);
    expect(hasProfilePrefix('presence:last_seen:abc')).toBe(false);
  });
});

describe('ключи резервной копии диалогов', () => {
  it('ключ профиля и старый глобальный дают одно логическое имя', () => {
    expect(dialogBackupLogicalKey('p1:contacts_index')).toBe('contacts_index');
    expect(dialogBackupLogicalKey('contacts_index')).toBe('contacts_index');
    expect(dialogBackupLogicalKey(`p7:contact:${PUB}`)).toBe(`contact:${PUB}`);
  });

  it('возвращается туда, откуда взят, — но в свой профиль', () => {
    const logical = dialogBackupLogicalKey('p1:contacts_index');
    expect(logical).not.toBeNull();
    expect(dialogBackupStoredKey(3, logical as string)).toBe('p3:contacts_index');
  });

  it('исключений не осталось: всё в копии принадлежит профилю', () => {
    // v4.32.290: подсказки переписок были последним ключом без namespace.
    expect(dialogBackupStoredKey(3, 'conversation_tips')).toBe('p3:conversation_tips');
    expect(dialogBackupLogicalKey('p3:conversation_tips')).toBe('conversation_tips');
    // Копия, снятая до v4.32.290, хранит их под логическим именем — и на
    // восстановлении попадает в namespace того профиля, куда восстанавливают.
    expect(dialogBackupLogicalKey('conversation_tips')).toBe('conversation_tips');
  });

  it('блок-лист переезжает вместе с профилем, а не мимо него', () => {
    // v4.32.281: раньше он назывался с суффиксом (`..._p2`) и в namespace
    // профиля не попадал.
    expect(legacySuffixBlockedKey(2)).toBe(`${BLOCKED_KEY_BASE}_p2`);
    expect(hasProfilePrefix(legacySuffixBlockedKey(2))).toBe(false);
    expect(dialogBackupStoredKey(3, BLOCKED_KEY_BASE)).toBe(`p3:${BLOCKED_KEY_BASE}`);
    expect(dialogBackupLogicalKey(`p3:${BLOCKED_KEY_BASE}`)).toBe(BLOCKED_KEY_BASE);
  });

  it('заглушённые авторы ленты входят в копию — как и блок-лист', () => {
    // v4.32.293: без них восстановление профиля молча возвращало в ленту всех,
    // кого человек оттуда убрал.
    expect(dialogBackupStoredKey(3, 'feed_muted_authors')).toBe('p3:feed_muted_authors');
    expect(dialogBackupLogicalKey('p3:feed_muted_authors')).toBe('feed_muted_authors');
  });

  it('чужие ключи в копию не входят — иначе подменённый файл переписал бы настройки', () => {
    for (const k of [
      'profile_active_id',
      'wallet_blocked',
      'theme',
      'p1:profile_active_id',
      'contact:слишком-короткий',
      `contact:${'A'.repeat(200)}`,
      'contact:has spaces and!@#',
    ]) {
      expect(dialogBackupLogicalKey(k)).toBeNull();
    }
  });

  it('переросший ключ отбрасывается, а не режется', () => {
    expect(dialogBackupLogicalKey(`p1:contact:${'A'.repeat(300)}`)).toBeNull();
  });
});

/**
 * v4.32.289. Отбор строк для копии жил отдельно от правил чтения — в SQL
 * экспорта — и разошёлся с ними в обе стороны сразу: блок-лист перестал
 * попадать в копию, а чужие контакты начали.
 */
describe('какие строки kv забирает копия профиля', () => {
  /** Матчер вида «попадёт ли ключ под отбор» — как SQL `k = ? OR k LIKE ?`. */
  function selects(profileId: number, key: string): boolean {
    const { exact, like } = dialogBackupKeySelectors(profileId);
    if (exact.includes(key)) return true;
    return like.some((p) => key.startsWith(p.slice(0, -1)) && p.endsWith('%'));
  }

  it('блок-лист профиля забирается — с v4.32.281 он под префиксом', () => {
    // Раньше отбор искал старое глобальное имя, которое миграция как раз
    // удаляет: список не попадал в копию ни разу, и после восстановления
    // заблокированные возвращались.
    expect(selects(2, `p2:${BLOCKED_KEY_BASE}`)).toBe(true);
    expect(selects(1, `p1:${BLOCKED_KEY_BASE}`)).toBe(true);
  });

  it('блок-лист, не успевший мигрировать, забирается тоже', () => {
    expect(selects(2, legacySuffixBlockedKey(2))).toBe(true);
    expect(dialogBackupLogicalKey(legacySuffixBlockedKey(2))).toBe(BLOCKED_KEY_BASE);
    expect(dialogBackupStoredKey(2, BLOCKED_KEY_BASE)).toBe(`p2:${BLOCKED_KEY_BASE}`);
  });

  it('чужой блок-лист не забирается', () => {
    expect(selects(2, `p1:${BLOCKED_KEY_BASE}`)).toBe(false);
    expect(selects(2, legacySuffixBlockedKey(1))).toBe(false);
  });

  it('второй профиль не забирает глобальные контакты — они первого', () => {
    expect(selects(2, 'contacts_index')).toBe(false);
    expect(selects(2, `contact:${PUB}`)).toBe(false);
    expect(selects(2, BLOCKED_KEY_BASE)).toBe(false);
    expect(selects(2, 'conversation_tips')).toBe(false);
  });

  it('первый профиль глобальные записи забирает — они писались, когда он был один', () => {
    expect(selects(1, 'contacts_index')).toBe(true);
    expect(selects(1, `contact:${PUB}`)).toBe(true);
    expect(selects(1, BLOCKED_KEY_BASE)).toBe(true);
    expect(selects(1, 'conversation_tips')).toBe(true);
  });

  it('свои контакты забирает каждый профиль', () => {
    expect(selects(2, 'p2:contacts_index')).toBe(true);
    expect(selects(2, `p2:contact:${PUB}`)).toBe(true);
    expect(selects(2, 'p2:conversation_tips')).toBe(true);
    expect(selects(2, 'p2:feed_muted_authors')).toBe(true);
    expect(selects(2, 'p1:feed_muted_authors')).toBe(false);
  });

  it('чужие контакты — нет', () => {
    expect(selects(2, 'p1:contacts_index')).toBe(false);
    expect(selects(2, `p1:contact:${PUB}`)).toBe(false);
    expect(selects(1, `p2:contact:${PUB}`)).toBe(false);
  });

  it('отбор не тащит настройки и служебные ключи', () => {
    for (const k of ['profile_active_id', 'wallet_blocked', 'app_theme_mode', 'user_username']) {
      expect(selects(1, k)).toBe(false);
      expect(selects(2, k)).toBe(false);
    }
  });

  it('всё отобранное имеет логическое имя — иначе строка молча пропадёт', () => {
    const { exact } = dialogBackupKeySelectors(2);
    for (const k of exact) {
      expect(dialogBackupLogicalKey(k)).not.toBeNull();
    }
  });
});

describe('служебные записи рассылки, оставшиеся от версий до v4.32.325', () => {
  it('перечислены без префикса профиля — это имена прежних, общих записей', () => {
    for (const k of LEGACY_GLOBAL_SYNC_KEYS) {
      expect(hasProfilePrefix(k)).toBe(false);
    }
  });

  it('в резервную копию не входят: это служебный счёт отправок, а не данные человека', () => {
    for (const k of LEGACY_GLOBAL_SYNC_KEYS) {
      expect(dialogBackupLogicalKey(k)).toBeNull();
      expect(dialogBackupLogicalKey(profileScopedKey(1, k))).toBeNull();
    }
  });
});
