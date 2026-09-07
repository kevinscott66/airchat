import { didFromPubB64 } from '../core/identity/did';
import { SENDER_TAG_SHAPE } from './openIntent';
import { SELF_PEER_MIRROR_KEY, parseSelfPeerMirror, pushSenderTag } from './pushSenderTag';

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
 *
 * v4.32.615: перебор идёт по всем личностям и всем профилям сразу, а не по
 * активной паре. Токен FCM на устройстве один на все профили, и ретранслятор
 * помнит регистрацию каждой личности, которой этим токеном пользовались, —
 * значит уведомление приходит и той, под которой сейчас не сидят. Соль в метке
 * тогда от неё, а разворачивали метку ключом активной, и совпадения не бывало
 * никогда. Промах здесь тихий и дорогой: без DID мимо проходят и «беззвучно»,
 * и «не показывать при открытом чате», и блок-лист. Ложное совпадение при
 * таком переборе означало бы коллизию 128-битного хеша: и своя личность, и
 * чужой ключ берутся только из собственных строк базы.
 *
 * Стоило это четырёх множителей: не больше `SELF_PEER_MIRROR_MAX` личностей
 * на десятки контактов, по одному sha256 на пару.
 */

const LOCAL_DB_NAME = 'airchat_local.db';
/** Совпадает с contacts.ts: имя строки контакта внутри профиля. */
const CONTACT_PREFIX = 'contact:';
/**
 * Имя строки контакта в любом профиле: `p<N>:contact:<ключ>` либо `contact:`
 * без префикса (записи до v4.32.490 — они принадлежат первому профилю).
 * Открытый ключ base64 двоеточий не содержит, так что разбор однозначен.
 */
const CONTACT_KEY_RE = /^(?:p\d+:)?contact:(.+)$/;

export async function didForSenderTag(tag: string | undefined): Promise<string | undefined> {
  if (!tag || !SENDER_TAG_SHAPE.test(tag)) return undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const SQLite = require('expo-sqlite') as typeof import('expo-sqlite');
    const db = await SQLite.openDatabaseAsync(LOCAL_DB_NAME);
    const mirror = await db.getFirstAsync<{ v: string }>('SELECT v FROM kv WHERE k = ?', [
      SELF_PEER_MIRROR_KEY,
    ]);
    // Зеркала нет — значит push ещё ни разу не регистрировали с этого
    // устройства, и метка не наша. Перебирать контакты не с чем.
    const selves = parseSelfPeerMirror(mirror?.v);
    if (selves.length === 0) return undefined;
    const patterns = [`${CONTACT_PREFIX}%`, `%:${CONTACT_PREFIX}%`];
    const contacts = await db.getAllAsync<{ k: string }>(
      `SELECT k FROM kv WHERE ${patterns.map(() => 'k LIKE ?').join(' OR ')}`,
      patterns
    );
    const pubs = new Set<string>();
    for (const row of contacts) {
      const pub = CONTACT_KEY_RE.exec(row.k)?.[1];
      if (pub) pubs.add(pub);
    }
    for (const self of selves) {
      for (const pub of pubs) {
        if (pushSenderTag(self, pub) === tag) return didFromPubB64(pub) ?? undefined;
      }
    }
    return undefined;
  } catch {
    // База недоступна из фона — баннер покажем безымянным, а не промолчим.
    return undefined;
  }
}
