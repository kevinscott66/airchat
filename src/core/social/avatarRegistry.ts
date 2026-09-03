/**
 * Единый ответ на вопрос «какое фото у этого человека».
 *
 * v4.32.565. Снимок, выбранный в профиле, до сих пор был виден только на
 * самом экране профиля. Список чатов, карточка публикации, реплика в группе и
 * списки участников рисовали цветной кружок с буквой (theme/identityAvatar) —
 * при том, что фото собеседника уже лежало в его контакте (`avatarCid`, его
 * кладёт туда profileSync), а своё — в `user_avatar_uri`. Не хватало только
 * общего места, куда за этим ходить.
 *
 * Таблица держится в памяти целиком и перечитывается на изменение контактов.
 * Иначе каждая строка списка читала бы базу на своей отрисовке — а строк в
 * списке чатов и в ленте столько, сколько влезает на экран, и перерисовываются
 * они на каждую входящую реплику.
 *
 * Ключом служит и открытый ключ (base64), и did: лента знает автора по did,
 * переписка и группы — по ключу, а человек за ними один и тот же.
 */
import { Buffer } from 'buffer';
import { listContacts, subscribeContactsChanged } from './contacts';
import { ownAvatarUri } from '../identity/ownAvatar';
import { loadKeyPair } from '../crypto/keyManager';
import { didFromPubB64 } from '../identity/did';
import { log } from '../logger';

export type PersonAvatarSource = {
  /**
   * Фото контакта: обычный CID или `nb:`-дескриптор вложения. Показывающая
   * сторона пропускает его через useResolvedMediaUrl — расшифровка вложения
   * асинхронная, и до неё рисуется запасной кружок с буквой.
   */
  cid: string | null;
  /** Свой снимок: готовый путь к файлу, шлюз ему не нужен. */
  uri: string | null;
};

let table = new Map<string, PersonAvatarSource>();
const subs = new Set<() => void>();
let unsubContacts: (() => void) | null = null;
/** Одновременных перечитываний не бывает: второе ждёт первое. */
let inFlight: Promise<void> | null = null;
/**
 * Пришло ли изменение, пока таблица читалась. Без этой отметки просьба,
 * поданная в середине чтения, просто присоединялась бы к уже идущему запросу
 * — то есть возвращала бы состояние ДО изменения, ради которого её и подали.
 */
let restale = false;

/** Подписаться на обновление таблицы. Возвращает отписку. */
export function subscribeAvatarsChanged(cb: () => void): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}

/**
 * Фото по открытому ключу или did. `null` — фото нет, рисуйте букву.
 *
 * Синхронная: вызывается из отрисовки строки списка.
 */
export function avatarSourceFor(key: string | null | undefined): PersonAvatarSource | null {
  if (!key) return null;
  return table.get(key) ?? null;
}

/** Только для тестов и диагностики: сколько лиц знает таблица. */
export function knownAvatarCount(): number {
  return table.size;
}

function put(next: Map<string, PersonAvatarSource>, pubB64: string, src: PersonAvatarSource): void {
  next.set(pubB64, src);
  const did = didFromPubB64(pubB64);
  if (did) next.set(did, src);
}

async function build(): Promise<Map<string, PersonAvatarSource>> {
  const next = new Map<string, PersonAvatarSource>();
  const contacts = await listContacts();
  for (const c of contacts) {
    if (!c.avatarCid) continue;
    put(next, c.peerPublicKey, { cid: c.avatarCid, uri: null });
  }
  // Своё фото кладётся последним намеренно: если собственный ключ почему-то
  // оказался и в списке контактов, показать себе надо свой снимок, а не тот,
  // что когда-то приехал конвертом.
  const mine = await ownAvatarUri();
  if (mine) {
    const pair = await loadKeyPair();
    if (pair) put(next, Buffer.from(pair.publicKey).toString('base64'), { cid: null, uri: mine });
  }
  return next;
}

/**
 * Перечитать таблицу. Вызывается на изменение контактов и вручную — после
 * того, как человек сменил себе снимок в профиле.
 *
 * Просьбы, поданные во время чтения, не теряются и не множатся: они помечают
 * таблицу устаревшей, и по окончании чтения делается ровно один повторный
 * заход — на всех сразу. Без этого изменение, пришедшее в середине чтения,
 * молча возвращало бы состояние ДО себя.
 */
export async function refreshAvatarTable(): Promise<void> {
  if (inFlight) {
    restale = true;
    return await inFlight;
  }
  const run = (async () => {
    do {
      restale = false;
      try {
        table = await build();
        for (const cb of subs) {
          try { cb(); } catch { /* подписчик отвалился — остальных это не касается */ }
        }
      } catch (e) {
        // Прежняя таблица остаётся в силе: пустая означала бы, что у всех разом
        // пропали фото, только потому что база была занята.
        log.warn('avatar_table_refresh_failed', { err: e instanceof Error ? e.message : String(e) });
      }
    } while (restale);
  })().finally(() => {
    if (inFlight === run) inFlight = null;
  });
  inFlight = run;
  return await run;
}

/**
 * Включить реестр: первое чтение и подписка на контакты. Идемпотентна —
 * второй вызов не заводит вторую подписку.
 */
export function startAvatarRegistry(): void {
  if (!unsubContacts) {
    unsubContacts = subscribeContactsChanged(() => { void refreshAvatarTable(); });
  }
  void refreshAvatarTable();
}

/** Погасить реестр — смена аккаунта, выход. Таблица очищается. */
export function stopAvatarRegistry(): void {
  unsubContacts?.();
  unsubContacts = null;
  table = new Map();
  for (const cb of subs) {
    try { cb(); } catch { /* см. refreshAvatarTable */ }
  }
}
