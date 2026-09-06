import { didFromPubB64 } from '../core/identity/did';
import { SENDER_TAG_SHAPE } from './openIntent';
import { SELF_PEER_MIRROR_KEY, pushSenderTag } from './pushSenderTag';

/**
 * Кто отправитель, если в push приехала только метка (v4.32.614).
 *
 * Обратное преобразование к `pushSenderTag`: метка перебирается по контактам,
 * потому что иначе её не развернуть — хеш односторонний, и в этом весь смысл
 * (см. pushSenderTag). Контактов десятки, каждая проверка — один sha256.
 *
 * Читает базу напрямую, а не через core/storage/local, по той же причине, что
 * и backgroundNotifyPrefs: зовут это из фонового обработчика push, который
 * поднимается отдельным запуском JS на каждое уведомление, и слой хранилища
 * потянул бы за собой миграции схемы, профили и транспорт. Здесь — два чтения
 * из уже существующей таблицы kv.
 *
 * Ключа для этого не нужно ни своего, ни чужого: имена строк контактов —
 * `p<id>:contact:<открытый ключ>` — не шифруются намеренно (см. contacts.ts,
 * v4.32.286: шифруется значение, в котором лежит symKey). Ровно поэтому
 * разбор работает при запертом телефоне, когда SecureStore не отвечает, —
 * то есть именно тогда, когда приходит фоновый push.
 *
 * Любая неясность решается в пользу `undefined`: без DID баннер всё равно
 * покажется, просто безымянным и без перехода в переписку. Молча съесть
 * сообщение было бы хуже.
 */

const LOCAL_DB_NAME = 'airchat_local.db';
/** Совпадает с backgroundNotifyPrefs: зеркало номера активного профиля. */
const ACTIVE_PROFILE_MIRROR_KEY = 'active_profile_id';
/** Совпадает с contacts.ts: имя строки контакта внутри профиля. */
const CONTACT_PREFIX = 'contact:';

export async function didForSenderTag(tag: string | undefined): Promise<string | undefined> {
  if (!tag || !SENDER_TAG_SHAPE.test(tag)) return undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const SQLite = require('expo-sqlite') as typeof import('expo-sqlite');
    const db = await SQLite.openDatabaseAsync(LOCAL_DB_NAME);
    const rows = await db.getAllAsync<{ k: string; v: string }>(
      'SELECT k, v FROM kv WHERE k IN (?, ?)',
      [SELF_PEER_MIRROR_KEY, ACTIVE_PROFILE_MIRROR_KEY]
    );
    const kv = new Map(rows.map((r) => [r.k, r.v]));
    const self = kv.get(SELF_PEER_MIRROR_KEY);
    // Зеркала нет — значит push ещё ни разу не регистрировали этой личностью,
    // и метка не наша. Перебирать контакты не с чем.
    if (!self) return undefined;
    const parsed = parseInt(kv.get(ACTIVE_PROFILE_MIRROR_KEY) ?? '', 10);
    const pid = Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
    // Записи до v4.32.490 лежали без префикса и принадлежат первому профилю —
    // то же правило, что у isBackgroundMuted.
    const patterns = pid === 1
      ? [`p1:${CONTACT_PREFIX}%`, `${CONTACT_PREFIX}%`]
      : [`p${pid}:${CONTACT_PREFIX}%`];
    const contacts = await db.getAllAsync<{ k: string }>(
      `SELECT k FROM kv WHERE ${patterns.map(() => 'k LIKE ?').join(' OR ')}`,
      patterns
    );
    for (const row of contacts) {
      const pub = row.k.slice(row.k.indexOf(CONTACT_PREFIX) + CONTACT_PREFIX.length);
      if (pub && pushSenderTag(self, pub) === tag) return didFromPubB64(pub) ?? undefined;
    }
    return undefined;
  } catch {
    // База недоступна из фона — баннер покажем безымянным, а не промолчим.
    return undefined;
  }
}
