import { parseDidKey } from '../core/identity/did';
import { readDekFromSecureStoreRaw, tryDecryptAtRest } from '../core/storage/localEncryption';
import { BLOCKED_KEY_BASE, legacySuffixBlockedKey, profileScopedKey } from '../core/storage/kvKeys';

/**
 * Заблокирован ли отправитель — для баннера, пришедшего при закрытом приложении.
 *
 * v4.32.615. Блокировка означает «этот человек со мной не связывается», и
 * решение v4.32.318 записано в callService прямым текстом: звонок из неё не
 * исключение, а отвечать на него нельзя даже «занято» — звонящему полагается
 * видеть ровно то же, что при выключенном телефоне. Проверка стояла ровно в
 * одном месте — в `onOffer`, то есть в живом сокете сигналинга.
 *
 * С v4.32.573 у звонка появился второй канал: push поднимает полноэкранный
 * баннер на канале звонков поверх экрана блокировки, и до него `onOffer` не
 * доходит вовсе — приложение в этот момент закрыто. Push-сервер про блок-лист
 * не знает и знать не должен, звонящий про свою блокировку тоже не знает и
 * шлёт wake как обычно. Получалось, что заблокированный человек снова звонил
 * на весь дом — единственным каналом, который в v4.32.318 и закрывали.
 *
 * То же и с личным сообщением: конверт от заблокированного отбрасывается в
 * messaging, но push отправитель шлёт независимо от того, приняли ли конверт,
 * и баннер «новое сообщение» приходил на сообщение, которого не будет.
 *
 * Группы сюда не относятся: групповое сообщение переживает блокировку
 * намеренно (см. blockPolicy — заблокирован человек, а не общая беседа).
 *
 * Почему чтение базы своё, а не через core/storage/local: причина та же, что
 * у backgroundNotifyPrefs и senderTagLookup — фоновый обработчик поднимается
 * отдельным запуском JS на каждый push, и слой хранилища потянул бы за собой
 * миграции схемы, профили и транспорт. Здесь два чтения из таблицы kv.
 *
 * Ключ нужен: сам список с v4.32.286 лежит шифртекстом, и открытым его не
 * сделать — строка блок-листа отвечает на вопрос «с кем человек поссорился» в
 * базе, где само общение спрятано. Значит, при запертом с самой загрузки
 * телефоне список не прочитается, и баннер покажется. Так и задумано: любая
 * неясность решается в пользу показа — молча съесть звонок хуже, чем показать
 * лишний баннер. Ключ хранится с доступом «после первой разблокировки», так
 * что обычный запертый экран чтению не мешает.
 */

const LOCAL_DB_NAME = 'airchat_local.db';
/** Совпадает с backgroundNotifyPrefs: зеркало номера активного профиля. */
const ACTIVE_PROFILE_MIRROR_KEY = 'active_profile_id';

/** did:key → base64 открытого ключа, в том же виде, в каком лежит блок-лист. */
function pubB64FromDid(did: string | undefined): string | null {
  if (!did) return null;
  const bytes = parseDidKey(did);
  return bytes ? Buffer.from(bytes).toString('base64') : null;
}

/**
 * Имена, под которыми блок-лист мог лечь. Порядок повторяет loadBlockedOnce в
 * rateLimiter: сначала нынешнее имя в пространстве профиля, затем два старых.
 * Переносить записи отсюда нельзя — фоновый контекст не имеет права на уборку
 * чужого слоя, он только читает.
 */
function blockedKeysFor(pid: number): string[] {
  const keys = [profileScopedKey(pid, BLOCKED_KEY_BASE), legacySuffixBlockedKey(pid)];
  if (pid === 1) keys.push(BLOCKED_KEY_BASE);
  return keys;
}

export async function isBackgroundBlocked(contactDid: string | undefined): Promise<boolean> {
  const pub = pubB64FromDid(contactDid);
  if (!pub) return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const SQLite = require('expo-sqlite') as typeof import('expo-sqlite');
    const db = await SQLite.openDatabaseAsync(LOCAL_DB_NAME);
    const pidRow = await db.getFirstAsync<{ v: string }>('SELECT v FROM kv WHERE k = ?', [
      ACTIVE_PROFILE_MIRROR_KEY,
    ]);
    const parsed = parseInt(pidRow?.v ?? '', 10);
    const pid = Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
    const keys = blockedKeysFor(pid);
    const rows = await db.getAllAsync<{ k: string; v: string }>(
      `SELECT k, v FROM kv WHERE k IN (${keys.map(() => '?').join(',')})`,
      keys
    );
    const byKey = new Map(rows.map((r) => [r.k, r.v]));
    const stored = keys.map((k) => byKey.get(k)).find((v) => v != null);
    if (stored == null) return false;
    // Именно сырое чтение: getOrCreateDataEncryptionKey при отсутствии ключа
    // завёл бы новый, и фоновый обработчик, поднявшийся раньше приложения,
    // подменил бы ключ ко всей переписке ради одного баннера.
    const dek = await readDekFromSecureStoreRaw();
    if (!dek) return false;
    const raw = tryDecryptAtRest(stored, dek);
    if (!raw) return false;
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) && arr.includes(pub);
  } catch {
    // База или ключ недоступны из фона — показываем, а не молчим.
    return false;
  }
}
