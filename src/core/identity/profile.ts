import type { KeyPairBytes } from '../crypto/keyManager';
import { signJson } from '../crypto/signature';
import { log } from '../logger';
import {
  kvDelete,
  kvGetSecret,
  kvGetSecretUpgrading,
  kvSetSecret,
  kvSetSecretScoped,
  notifyChatStorageChanged,
  profileScopedKey,
} from '../storage/local';
import { isPlainCid } from '../cid';
import { publicKeyToDidKey } from './did';
import { getOwnDisplayName, ownFieldGet, ownFieldSet } from './ownProfile';
import { profileManager } from './profileManager';
import { addToIpfs, catFromIpfs } from '../transport/ipfs/node';
import { isIpfsEnabled } from '../transport/ipfs/heliaNode';

export type ProfilePayload = {
  username: string;
  avatarCid?: string;
  bio?: string;
  did: string;
  updatedAt: number;
  /**
   * Ключ пары `${didA}:${didB}` → CID последнего сообщения в ней (голова DAG).
   *
   * v4.32.291: только на чтении — своё сюда больше не кладём. Карточка
   * публикуется одним документом по CID, и этот CID раздаётся контактам: кто
   * его получил, читает документ целиком. То есть поле раздавало каждому
   * контакту список did ВСЕХ собеседников — весь круг общения, хотя читателю
   * нужна ровно одна запись, его собственная пара (см. messageSync).
   *
   * Раздача карточки контактам с v4.32.247 идёт через social/profileSync
   * поверх личных сообщений — адресно, каждому своё. Общий документ для
   * такого не годится в принципе.
   */
  conversationTips?: Record<string, string>;
};

export async function buildSignedProfile(
  pair: KeyPairBytes,
  username: string,
  avatarCid?: string,
  bio?: string
): Promise<{ envelope: { payload: string; signature: string }; cid: string | null }> {
  const payload: ProfilePayload = {
    username,
    avatarCid,
    ...(bio ? { bio } : {}),
    did: publicKeyToDidKey(pair.publicKey),
    updatedAt: Date.now(),
  };
  const envelope = await signJson(pair, payload as unknown as Record<string, unknown>);
  let cid: string | null = null;
  try {
    cid = await addToIpfs(new TextEncoder().encode(JSON.stringify({ envelope, v: 1 })));
  } catch (e) {
    log.warn('profile_ipfs_add_failed', {
      err: e instanceof Error ? e.message : String(e),
    });
  }
  return { envelope, cid };
}

export async function fetchProfileByCid(cid: string): Promise<ProfilePayload | null> {
  try {
    const merged = await catFromIpfs(cid);
    if (!merged) return null;
    const raw = JSON.parse(new TextDecoder().decode(merged)) as {
      envelope?: { payload?: unknown; signature?: unknown };
    };
    // v4.32.195 (Round-25 #8): validate envelope shape before trusting fields.
    // Attacker-controlled CID could publish JSON with missing/non-string fields,
    // and JSON.parse(undefined) below would throw → silent log + null, but the
    // explicit guard makes the contract obvious and avoids the throw path.
    if (!raw?.envelope || typeof raw.envelope.payload !== 'string' || typeof raw.envelope.signature !== 'string') return null;
    const envelope = raw.envelope as { payload: string; signature: string };
    const { verifySignedJson } = await import('../crypto/signature');
    const { parseDidKey } = await import('./did');
    const parsed = JSON.parse(envelope.payload) as ProfilePayload;
    const pub = parseDidKey(parsed.did);
    if (!pub) return null;
    const verified = await verifySignedJson(pub, envelope);
    if (!verified) return null;
    // v4.32.196 (Round-26 #6): even after signature verification, cap/validate
    // field shapes. A legitimate-keyed contact can publish a 5 MB username or
    // conversationTips-as-array — signature alone doesn't bound UI/SQL impact.
    // v4.32.198 (Round-28 #9): clamp updatedAt so a signed profile with
    // 9e15 can't win "most-recent" comparisons forever and block genuine
    // future republishes from the same DID.
    const nowTs = Date.now();
    const rawUpdated = typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : nowTs;
    const clampedUpdated = Math.min(Math.max(rawUpdated, 0), nowTs + 5 * 60_000);
    const safe: ProfilePayload = {
      did: parsed.did,
      updatedAt: clampedUpdated,
      username: typeof parsed.username === 'string' ? parsed.username.slice(0, 64) : 'anonymous',
    };
    if (typeof parsed.bio === 'string') safe.bio = parsed.bio.slice(0, 512);
    if (isPlainCid(parsed.avatarCid)) {
      safe.avatarCid = parsed.avatarCid;
    }
    if (parsed.conversationTips && typeof parsed.conversationTips === 'object' && !Array.isArray(parsed.conversationTips)) {
      const tips: Record<string, string> = {};
      let count = 0;
      for (const [k, v] of Object.entries(parsed.conversationTips as Record<string, unknown>)) {
        if (count >= 1024) break;
        if (typeof k === 'string' && k.length <= 256 && typeof v === 'string' && v.length <= 128) {
          tips[k] = v;
          count += 1;
        }
      }
      safe.conversationTips = tips;
    }
    return safe;
  } catch (e) {
    log.warn('profile_fetch_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/**
 * Подсказки переписок: `${didA}:${didB}` (пара отсортирована) → CID последнего
 * сообщения в ней. По сути — список всех, с кем идёт переписка.
 *
 * v4.32.290: по профилям. Запись была одна на устройство, а значит связывала
 * адреса разных профилей в одном месте: тот, кто получил доступ к базе, видел
 * не «два аккаунта», а один список, где рядом лежат пары обоих. И эта же
 * запись целиком уходила в резервную копию каждого профиля, а в подписанную
 * карточку — контактам (это убрано в v4.32.291, см. ProfilePayload).
 *
 * Функционально каждый профиль и раньше находил в общей записи только свои
 * пары — свой did входит в ключ. Поэтому разделение делается по нему: при
 * первом чтении профиль забирает своё из общей записи и оставляет там чужое.
 * Опустевшая общая запись удаляется — последний забравший убирает за всеми.
 *
 * v4.32.306: значение — шифртекст. Ключ пары составлен из двух did, то есть
 * запись целиком — это список «кто с кем переписывается», а сами контакты
 * зашифрованы с v4.32.286. Разделение по профилям (290) прятало этот список от
 * соседнего аккаунта, но не от того, кто открыл файл базы.
 */
export const CONVERSATION_TIPS_KEY = 'conversation_tips';

/** Пара содержит did этого профиля: ключ — `${didA}:${didB}`, а сам did с двоеточиями. */
function tipBelongsTo(pairKey: string, did: string): boolean {
  return pairKey.startsWith(`${did}:`) || pairKey.endsWith(`:${did}`);
}

/**
 * Разбор и проверка формы. Значение kv может прийти из восстановленной копии
 * или быть повреждено — вызывающий не должен получить массив или строку
 * (v4.32.195, Round-25 #9). `did` — фильтр «своё»: чужие пары не показываем,
 * даже если они попали в запись профиля из старой копии.
 */
function parseTips(raw: string | null, did: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const p = JSON.parse(raw) as unknown;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (typeof v !== 'string' || v.length > 128) continue;
      if (did && !tipBelongsTo(k, did)) continue;
      out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Забрать свои пары из общей записи в запись профиля — один раз на профиль.
 * Без известного did не трогаем ничего: разделить пары не по чему, а стереть
 * подсказки значит заставить переписки начаться с пустой истории.
 */
async function claimSharedConversationTips(
  pid: number,
  did: string | null
): Promise<Record<string, string>> {
  const sharedRaw = await kvGetSecret(CONVERSATION_TIPS_KEY);
  if (!did) return parseTips(sharedRaw, null);
  const mine = parseTips(sharedRaw, did);
  // Не записалось — общую запись не трогаем: иначе свои пары исчезнут, а
  // чужие останутся у тех, кто ещё не забирал (v4.32.293).
  if (!(await kvSetSecretScoped(pid, CONVERSATION_TIPS_KEY, JSON.stringify(mine)))) return mine;
  if (!sharedRaw) return mine;
  const rest = parseTips(sharedRaw, null);
  for (const k of Object.keys(mine)) delete rest[k];
  if (Object.keys(rest).length === 0) await kvDelete(CONVERSATION_TIPS_KEY);
  else await kvSetSecret(CONVERSATION_TIPS_KEY, JSON.stringify(rest));
  return mine;
}

/** Чтение подсказок ровно того профиля, который назван — без обращения к «активному». */
async function readTipsFor(pid: number, did: string | null): Promise<Record<string, string>> {
  try {
    const raw = await kvGetSecretUpgrading(profileScopedKey(pid, CONVERSATION_TIPS_KEY));
    if (raw == null) return await claimSharedConversationTips(pid, did);
    return parseTips(raw, did);
  } catch {
    return {};
  }
}

export async function getLocalConversationTips(): Promise<Record<string, string>> {
  const active = profileManager.getActiveProfile();
  return await readTipsFor(active?.id ?? 1, active?.did ?? null);
}

/**
 * Чей это ключ пары. Владельца определяет сам ключ: в нём стоит did профиля,
 * ведущего переписку, — а не то, какой профиль открыт на экране прямо сейчас.
 *
 * v4.32.473. Раньше запись шла под активный профиль, причём номер брался уже
 * ПОСЛЕ чтения (между ними — обращение к базе). Переключение профиля в этот
 * промежуток означало: прочитали подсказки одного аккаунта, записали их
 * целиком в хранилище другого. То есть список «кто с кем переписывается»
 * перетекал соседнему аккаунту, а у своего пропадал.
 *
 * Быстрый путь — did активного профиля уже стоит в ключе, это обычный случай.
 * Полный список профилей выводит ключевую пару на каждый профиль (PBKDF2), и
 * трогать его на каждое сообщение незачем.
 */
function ownerOfPairKey(pairKey: string): { pid: number; did: string | null } | null {
  const active = profileManager.getActiveProfile();
  if (!active?.did || tipBelongsTo(pairKey, active.did)) {
    return { pid: active?.id ?? 1, did: active?.did ?? null };
  }
  const all = profileManager.getAllProfiles?.() ?? [];
  const owner = all.find((p) => p.did && tipBelongsTo(pairKey, p.did));
  if (owner) return { pid: owner.id, did: owner.did };
  // Список профилей недоступен (мнемоника ещё не поднята) — судить не по чему,
  // и прежнее поведение остаётся единственно возможным. Чужую пару при чтении
  // всё равно отфильтрует parseTips.
  if (all.length === 0) return { pid: active.id, did: active.did };
  return null;
}

/**
 * Очередь записи подсказок: чтение и запись одной пары не должны разъезжаться.
 *
 * v4.32.473. Два сообщения, ушедшие почти одновременно, читали одну и ту же
 * запись и по очереди записывали её обратно — второй записавший затирал хвост,
 * проставленный первым. Обход истории после этого упирался в пропуск. Здесь
 * тот же порядок, что у очереди публикаций (v4.32.456): `apply` синхронная,
 * поэтому между чтением и записью нельзя вклиниться обращением к сети.
 */
let tipsTx: Promise<unknown> = Promise.resolve();

async function updateTips(
  pid: number,
  did: string | null,
  apply: (tips: Record<string, string>) => Record<string, string>,
): Promise<boolean> {
  const run = async (): Promise<boolean> => {
    const tips = await readTipsFor(pid, did);
    return await kvSetSecretScoped(pid, CONVERSATION_TIPS_KEY, JSON.stringify(apply(tips)));
  };
  const started = tipsTx.then(run, run);
  tipsTx = started.catch(() => {});
  return await started;
}

/**
 * Хвост переписки — последний НАСТОЯЩИЙ CID и ничего кроме.
 *
 * v4.32.432. Правило записано словами трижды (v4.32.120 #6, v4.32.128 и
 * рядом в retrySendDm), а проверялось ровно в одном месте приёма — и в одном
 * месте отправки нарушалось: повтор из очереди писал сюда `fallback:<uuid>`.
 * Дальше плейсхолдер уходил в поле «предыдущее» следующего сообщения,
 * получатель отбрасывал его по форме, и обход истории вставал на призрачном
 * хвосте. Проверка стоит здесь, а не у вызывающих: так её нельзя забыть.
 */
export async function setLocalConversationTip(pairKey: string, messageCid: string): Promise<void> {
  // Длина снимается до проверки: после неё тип отрицательной ветки — never,
  // потому что предикат обещает ровно string.
  const len = messageCid.length;
  if (!isPlainCid(messageCid)) {
    log.warn('conversation_tip_not_a_cid', { pairKey, len });
    return;
  }
  const owner = ownerOfPairKey(pairKey);
  if (!owner) {
    // Пара не принадлежит ни одному профилю на устройстве. Записать её под
    // открытый профиль значит подложить ему чужую переписку.
    log.warn('conversation_tip_foreign_pair', { len });
    return;
  }
  const ok = await updateTips(owner.pid, owner.did, (tips) => {
    tips[pairKey] = messageCid;
    return tips;
  });
  if (!ok) {
    // Раньше отказ записи проходил молча, и «последнее сообщение потерялось»
    // не оставляло следа в журнале.
    log.warn('conversation_tip_write_failed', { pid: owner.pid, len });
    return;
  }
  notifyChatStorageChanged();
}

/**
 * Переподписать и опубликовать карточку профиля (вызывается после отправки DM).
 *
 * v4.32.247: на телефоне выходить некуда — addToIpfs отключён с v4.32.19 и
 * возвращает null, то есть user_profile_cid не записывался ни разу. При этом
 * функция вызывается после КАЖДОГО отправленного сообщения и каждый раз читала
 * четыре ключа из SQLite и подписывала весь список conversationTips (до 1024
 * записей) — заметная работа впустую на каждое сообщение. Раздачу профиля
 * контактам взял на себя core/social/profileSync поверх личных сообщений.
 *
 * v4.32.291: список подсказок в карточку больше не кладётся — ни читать его
 * из kv, ни подписывать не нужно.
 */
export async function republishProfileFromKv(pair: KeyPairBytes): Promise<string | null> {
  if (!isIpfsEnabled()) return null;
  try {
    const username = (await getOwnDisplayName()) ?? 'anonymous';
    const avatarCid = await ownFieldGet('user_avatar_cid');
    const bio = await ownFieldGet('user_bio');
    const { cid } = await buildSignedProfile(pair, username, avatarCid ?? undefined, bio ?? undefined);
    if (cid) await ownFieldSet('user_profile_cid', cid);
    return cid;
  } catch (e) {
    log.warn('profile_republish_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}
