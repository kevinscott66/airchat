/**
 * Закрепление сообщений в личном чате: локальная запись + отправка собеседнику.
 *
 * v4.32.235. Разбор конверта живёт в dmPinEnvelope.ts (без импортов, чтобы
 * тестировался отдельно); здесь — доставка и запись в БД.
 *
 * Заодно изменён формат kv `pinned_list_<peer>`: раньше рядом с id лежала
 * КОПИЯ текста сообщения открытым текстом, хотя chat_messages.text шифруется
 * at-rest (CRIT-4). Теперь в kv только id, текст всегда читается из
 * chat_messages — и не расходится с оригиналом после правки. Старый формат
 * (массив объектов `{id, text}`) на чтении понимается.
 *
 * Прав в личке нет: собеседники равны, закрепить может любой из двоих —
 * ровно как в Telegram/WhatsApp. Ограничитель один: закрепить можно только
 * существующее у получателя сообщение (resolveDmPinned отбрасывает id, которых
 * нет в chat_messages), поэтому чужой id в баннер не превращается.
 *
 * v4.32.343: «существующее» уточнено до «существующее в ЭТОЙ переписке».
 * Проверка шла по одному id, и сообщение из другого диалога того же профиля
 * находилось: собеседник закреплял у меня строку из моего разговора с третьим
 * человеком и читал её текст в собственном баннере. Область теперь входит в
 * условие запроса (getChatMessageTexts).
 */
import {
  setConversationPinnedMessage,
  getChatMessageTexts,
  notifyChatStorageChanged,
} from '../storage/local';
import { scopedKvGetFor, scopedKvSetFor } from '../storage/profileScopedKv';
import { profileManager } from '../identity/profileManager';
import { fanoutControlEnvelope } from './controlFanout';
import { log } from '../logger';
import type { DmPinOp, DmPinOutcome } from './dmPinOutcome';
import {
  DM_PIN_PREFIX,
  encodeDmPinEnvelope,
  decodeDmPinEnvelope,
  type DmPinEnvelope,
} from './dmPinEnvelope';

export { DM_PIN_PREFIX, encodeDmPinEnvelope, decodeDmPinEnvelope };
export type { DmPinEnvelope };

/**
 * Закреплённое сообщение так, как его показывают.
 *
 * v4.32.576: `unreadable` — своя копия сообщения есть, но ключом данных не
 * открывается. Текст остаётся пустым: пометка живёт РЯДОМ с текстом, а не
 * вместо него (см. unreadableText).
 */
export type DmPinnedEntry = { id: string; text: string; unreadable: boolean };

/** Сколько закреплённых держим на чат. */
const MAX_PINNED = 50;

function pinListKey(peerPubB64: string): string {
  return `pinned_list_${peerPubB64}`;
}

/**
 * id закреплённых, свежие первыми. Понимает и старый формат `{id, text}`.
 *
 * v4.32.484: запись живёт в namespace профиля. До этого имя ключа состояло из
 * одного открытого ключа собеседника — то есть один список на всю установку.
 * Два аккаунта, у которых есть общий контакт, вели один и тот же список
 * закреплений: «Открепить всё» в одном стирало закрепления другого, чужой
 * входящий конверт `clear` — тоже, а полусотенный потолок они делили на
 * двоих. Уборка удалённого профиля (`p<id>:%`) под общее имя не подпадала,
 * и новый профиль с тем же номером получал закрепления предыдущего.
 */
export async function loadDmPinnedIds(
  peerPubB64: string,
  ownerProfileId: number
): Promise<string[]> {
  const raw = await scopedKvGetFor(ownerProfileId, pinListKey(peerPubB64));
  if (!raw) return [];
  try {
    const p = JSON.parse(raw) as unknown;
    if (!Array.isArray(p)) return [];
    return p
      .map((e) => (typeof e === 'string' ? e : (e as { id?: unknown } | null)?.id))
      .filter((id): id is string => typeof id === 'string' && !!id)
      .slice(0, MAX_PINNED);
  } catch {
    return [];
  }
}

/**
 * Закреплённые с актуальным текстом. Сообщения, которых уже нет (удалены либо
 * пришёл чужой id), из списка выпадают — иначе баннер показывал бы фантом.
 *
 * v4.32.576: `null` от getChatMessageTexts значит «строка есть, но не
 * открылась», и это не то же самое, что пустой текст. Отсутствие ключа
 * по-прежнему выбрасывает id: такого сообщения в этой переписке нет.
 */
export async function resolveDmPinned(
  peerPubB64: string,
  ownerProfileId: number
): Promise<DmPinnedEntry[]> {
  const ids = await loadDmPinnedIds(peerPubB64, ownerProfileId);
  if (!ids.length) return [];
  const texts = await getChatMessageTexts(ids, peerPubB64, ownerProfileId);
  const out: DmPinnedEntry[] = [];
  for (const id of ids) {
    if (!texts.has(id)) continue;
    const text = texts.get(id) ?? null;
    out.push({ id, text: text === null ? '' : text.slice(0, 120), unreadable: text === null });
  }
  return out;
}

/** Пишет закрепление в kv + conversations.pinned_message_id. */
export async function applyLocalDmPin(params: {
  peerPubB64: string;
  ownerProfileId: number;
  msgId: string;
  on: boolean;
}): Promise<DmPinnedEntry[]> {
  const { peerPubB64, ownerProfileId, msgId, on } = params;
  const current = await loadDmPinnedIds(peerPubB64, ownerProfileId);
  const nextIds = on
    ? [msgId, ...current.filter((id) => id !== msgId)].slice(0, MAX_PINNED)
    : current.filter((id) => id !== msgId);
  await scopedKvSetFor(ownerProfileId, pinListKey(peerPubB64), JSON.stringify(nextIds));
  const entries = await resolveDmPinned(peerPubB64, ownerProfileId);
  await setConversationPinnedMessage(peerPubB64, ownerProfileId, entries[0]?.id ?? null);
  return entries;
}

/** Убирает из закреплённых всё. */
export async function clearDmPinned(peerPubB64: string, ownerProfileId: number): Promise<void> {
  await scopedKvSetFor(ownerProfileId, pinListKey(peerPubB64), '[]');
  await setConversationPinnedMessage(peerPubB64, ownerProfileId, null);
}

/**
 * Отправка через общую воронку служебных конвертов (v4.32.454): «принят к
 * отправке» здесь считается ровно так же, как у реакций, опросов и группы.
 */
async function sendDmPin(
  op: DmPinOp,
  peerPubB64: string,
  env: DmPinEnvelope
): Promise<DmPinOutcome> {
  const res = await fanoutControlEnvelope(`dm_${op}`, encodeDmPinEnvelope(env), {
    kind: 'dm',
    peerPubB64,
  });
  return res.sent
    ? { op, sent: true, recipients: res.recipients }
    : { op, sent: false, reason: res.reason };
}

/**
 * Что осталось после закрепления или открепления.
 *
 * `sync` — обещание, а не готовый итог: баннер рисуется по `entries` сразу и
 * ждать сети ему незачем. Но и выбросить исход вызывающий больше не может —
 * прежде отправка уходила немым `void`, и отказ не доходил ни до кого, кроме
 * лога.
 */
export type DmPinSyncResult = {
  entries: DmPinnedEntry[];
  sync: Promise<DmPinOutcome>;
};

/** Закрепляет/открепляет локально и сообщает решение собеседнику. */
export async function toggleDmPinAndSync(params: {
  peerPubB64: string;
  msgId: string;
  on: boolean;
}): Promise<DmPinSyncResult> {
  const { peerPubB64, msgId, on } = params;
  const pid = profileManager.getActiveProfile()?.id ?? 1;
  const entries = await applyLocalDmPin({ peerPubB64, ownerProfileId: pid, msgId, on });
  const sync = sendDmPin(on ? 'pin' : 'unpin', peerPubB64, { msgId, on, ts: Date.now() });
  return { entries, sync };
}

/** «Открепить всё» локально + у собеседника. */
export async function clearDmPinnedAndSync(peerPubB64: string): Promise<DmPinSyncResult> {
  const pid = profileManager.getActiveProfile()?.id ?? 1;
  await clearDmPinned(peerPubB64, pid);
  const sync = sendDmPin('clear', peerPubB64, { msgId: '', on: false, ts: Date.now(), all: true });
  return { entries: [], sync };
}

/**
 * Применяет входящий конверт. Возвращает true, если конверт наш (независимо
 * от того, применился он или был отброшен) — вызывающий не должен сохранять
 * его как обычное DM-сообщение.
 */
export async function handleIncomingDmPin(
  text: string,
  senderPubB64: string | undefined,
  ownerPid: number
): Promise<boolean> {
  if (!text.startsWith(DM_PIN_PREFIX)) return false;
  const env = decodeDmPinEnvelope(text);
  if (!env || !senderPubB64) return true;
  // Профиль-владелец — от службы переписки (v4.32.481).
  const pid = ownerPid;
  // Чат определяется ПОДПИСАННЫМ отправителем DM, а не полем конверта: иначе
  // любой контакт менял бы закрепления в чужой переписке.
  if (env.all === true) {
    await clearDmPinned(senderPubB64, pid);
    // Строки сообщения закрепление не создаёт, поэтому открытый чат сам о нём
    // не узнает — будим подписчиков явно.
    notifyChatStorageChanged();
    log.info('dm_pin_cleared_remote', { from: senderPubB64.slice(0, 12) });
    return true;
  }
  const entries = await applyLocalDmPin({
    peerPubB64: senderPubB64,
    ownerProfileId: pid,
    msgId: env.msgId,
    on: env.on,
  });
  notifyChatStorageChanged();
  log.info('dm_pin_applied', { from: senderPubB64.slice(0, 12), on: env.on, total: entries.length });
  return true;
}
