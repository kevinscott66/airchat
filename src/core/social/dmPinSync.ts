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
import { scopedKvSetCheckedFor, scopedKvTryGetFor } from '../storage/profileScopedKv';
import { profileManager } from '../identity/profileManager';
import { fanoutControlEnvelope } from './controlFanout';
import { createSerialRunner } from '../../notifications/lifecycleQueue';
import { log } from '../logger';
import { commitControlTs, controlTsFresh } from './controlWatermark';
import type { EnvelopeIntake } from '../transport/envelopeIntake';
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
/**
 * Тот же список, но «не прочиталось» отличимо от «ничего не закреплено»
 * (v4.32.643).
 *
 * scopedKvGetFor отвечает одним null на оба случая, а список читается перед
 * КАЖДОЙ записью и пишется целиком. Заминка базы приходила сюда как пустой
 * список: одно новое закрепление ложилось поверх полусотни настоящих и
 * стирало их — при том что человек всего лишь добавил ещё одно, и ни одной
 * ошибки на экране при этом не было. null здесь значит «не знаем», и по нему
 * не пишут.
 */
async function readDmPinnedIds(
  peerPubB64: string,
  ownerProfileId: number
): Promise<string[] | null> {
  const read = await scopedKvTryGetFor(ownerProfileId, pinListKey(peerPubB64));
  if (read === null) return null;
  if (!read.value) return [];
  try {
    const p = JSON.parse(read.value) as unknown;
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
 * То же для показа: баннер рисуется по тому, что удалось прочитать, и пустая
 * шапка при заминке базы сама себя чинит следующим чтением. Отменить показ
 * можно, отменить запись поверх — нет, поэтому различает провал только тот,
 * кто пишет.
 */
export async function loadDmPinnedIds(
  peerPubB64: string,
  ownerProfileId: number
): Promise<string[]> {
  return (await readDmPinnedIds(peerPubB64, ownerProfileId)) ?? [];
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

/**
 * Дорожка записи закреплений (v4.32.675). То же, что в группе: список
 * читается перед каждой записью и пишется целиком, а пишущих двое — своё
 * нажатие и входящий конверт `pin` от собеседника. Между чтением и записью
 * стоит await, и одно из двух закреплений терялось молча.
 */
const dmPinWrites = createSerialRunner();

/**
 * Что вышло из записи закрепления.
 *
 * v4.32.757: раньше отсюда возвращалось `DmPinnedEntry[] | null`, и `null`
 * значил ровно один отказ — список не прочитался. Сама запись при этом шла
 * немым `scopedKvSetFor`, который о провале не сообщает никому: вызывающий
 * получал список закреплённых, перечитанный из kv уже ПОСЛЕ неудачной записи,
 * то есть прежний, и считал, что всё применилось.
 */
export type DmPinWrite =
  | { ok: true; entries: DmPinnedEntry[] }
  | { ok: false; reason: DmPinRefusal };

/** Пишет закрепление в kv + conversations.pinned_message_id. */
export async function applyLocalDmPin(params: {
  peerPubB64: string;
  ownerProfileId: number;
  msgId: string;
  on: boolean;
}): Promise<DmPinWrite> {
  return dmPinWrites(() => applyLocalDmPinSerial(params));
}

async function applyLocalDmPinSerial(params: {
  peerPubB64: string;
  ownerProfileId: number;
  msgId: string;
  on: boolean;
}): Promise<DmPinWrite> {
  const { peerPubB64, ownerProfileId, msgId, on } = params;
  // v4.32.643: список не прочитался — не пишем ничего. Прежде сюда приходил
  // пустой массив, и запись сводила все закрепления переписки к одному.
  const current = await readDmPinnedIds(peerPubB64, ownerProfileId);
  if (current === null) {
    log.warn('dm_pin_list_read_failed', { pid: ownerProfileId });
    return { ok: false, reason: 'read_failed' };
  }
  const nextIds = on
    ? [msgId, ...current.filter((id) => id !== msgId)].slice(0, MAX_PINNED)
    : current.filter((id) => id !== msgId);
  // v4.32.757: запись проверяется. Прежде она уходила немым scopedKvSetFor, и
  // занятая база означала «ничего не записано» при полном молчании: список
  // ниже перечитывался из kv и приходил прежним, а вызывающий объявлял
  // закрепление применённым — и своё нажатие, и конверт собеседника.
  if (!(await scopedKvSetCheckedFor(ownerProfileId, pinListKey(peerPubB64), JSON.stringify(nextIds)))) {
    log.warn('dm_pin_list_write_failed', { pid: ownerProfileId });
    return { ok: false, reason: 'write_failed' };
  }
  const entries = await resolveDmPinned(peerPubB64, ownerProfileId);
  await setConversationPinnedMessage(peerPubB64, ownerProfileId, entries[0]?.id ?? null);
  return { ok: true, entries };
}

/**
 * Убирает из закреплённых всё. По той же дорожке, что и запись.
 *
 * v4.32.757: отвечает, легло ли. «Открепить всё» — единственная операция,
 * которую нельзя доделать следующим нажатием: список уже показан пустым.
 */
export async function clearDmPinned(peerPubB64: string, ownerProfileId: number): Promise<boolean> {
  return dmPinWrites(async () => {
    if (!(await scopedKvSetCheckedFor(ownerProfileId, pinListKey(peerPubB64), '[]'))) {
      log.warn('dm_pin_clear_write_failed', { pid: ownerProfileId });
      return false;
    }
    await setConversationPinnedMessage(peerPubB64, ownerProfileId, null);
    return true;
  });
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
export type DmPinSyncResult =
  | { ok: true; entries: DmPinnedEntry[]; sync: Promise<DmPinOutcome> }
  | { ok: false; reason: DmPinRefusal };

/**
 * Почему закрепление не состоялось (v4.32.643). Record ниже не даёт завести
 * причину без фразы для человека — ровно как у группы. Вторая причина
 * появилась в v4.32.757: до неё провал самой записи не считался отказом.
 */
export type DmPinRefusal = 'read_failed' | 'write_failed';

/** Record по всем причинам: новая не соберётся, пока ей не написали фразу. */
const DM_PIN_REFUSAL: Record<DmPinRefusal, string> = {
  read_failed: 'Не удалось прочитать закреплённые в этой переписке — попробуйте ещё раз.',
  write_failed: 'Не удалось сохранить закреплённые в этой переписке — попробуйте ещё раз.',
};

/** Текст отказа для человека. */
export function dmPinRefusalText(reason: DmPinRefusal): string {
  return DM_PIN_REFUSAL[reason];
}

/** Закрепляет/открепляет локально и сообщает решение собеседнику. */
export async function toggleDmPinAndSync(params: {
  peerPubB64: string;
  msgId: string;
  on: boolean;
}): Promise<DmPinSyncResult> {
  const { peerPubB64, msgId, on } = params;
  const pid = profileManager.getActiveProfile()?.id ?? 1;
  const write = await applyLocalDmPin({ peerPubB64, ownerProfileId: pid, msgId, on });
  // Ничего не записано — и рассылать нечего: у собеседника закрепление
  // появилось бы, а у себя нет.
  if (!write.ok) return { ok: false, reason: write.reason };
  const sync = sendDmPin(on ? 'pin' : 'unpin', peerPubB64, { msgId, on, ts: Date.now() });
  return { ok: true, entries: write.entries, sync };
}

/** «Открепить всё» локально + у собеседника. */
export async function clearDmPinnedAndSync(peerPubB64: string): Promise<DmPinSyncResult> {
  const pid = profileManager.getActiveProfile()?.id ?? 1;
  // v4.32.757: не легло — не рассылаем. Иначе у собеседника закрепления
  // стёрты, у себя остались, а экран в обоих случаях показывал пустую шапку.
  if (!(await clearDmPinned(peerPubB64, pid))) return { ok: false, reason: 'write_failed' };
  const sync = sendDmPin('clear', peerPubB64, { msgId: '', on: false, ts: Date.now(), all: true });
  return { ok: true, entries: [], sync };
}

/**
 * Применяет входящий конверт.
 *
 * v4.32.757: отвечает словом, а не `true`. Прежний `boolean` значил «конверт
 * наш, обычным сообщением его не сохраняйте», и вызывающий его не читал вовсе:
 * `await handleIncomingDmPin(...)` и сразу `return 'consumed'`. «Разобрано»
 * значит «метку докуда прочитано можно двигать», а relay отдаёт накопленное
 * только по метке — значит занятая база стоила закрепления навсегда: кадр
 * лежит ещё тридцать суток, но его больше никогда не запросят, а повтора у
 * служебного конверта нет. У собеседника закрепление есть, у нас нет, и узнать
 * об этом неоткуда — строки в переписке закрепление не создаёт.
 */
export async function handleIncomingDmPin(
  text: string,
  senderPubB64: string | undefined,
  ownerPid: number
): Promise<EnvelopeIntake> {
  // Префикс проверяет и единственный вызывающий (messaging.ts). Слово здесь
  // отвечает не на «конверт наш», а на «двигать ли метку»: чужой текст сюда
  // не попадает, а если попадёт — разбирать в нём нечего.
  if (!text.startsWith(DM_PIN_PREFIX)) return 'consumed';
  const env = decodeDmPinEnvelope(text);
  if (!env || !senderPubB64) return 'consumed';
  // Профиль-владелец — от службы переписки (v4.32.481).
  const pid = ownerPid;
  // Чат определяется ПОДПИСАННЫМ отправителем DM, а не полем конверта: иначе
  // любой контакт менял бы закрепления в чужой переписке.
  if (env.all === true) {
    // v4.32.622: «открепить всё» — единственная скалярная операция в этом
    // конверте, и до этой проверки её повтор был бесплатным: relay хранит
    // накопленное 30 суток, тема выводится из DID, так что один и тот же
    // подписанный конверт можно подать снова через месяц и заново стереть
    // список закреплений. Водяной знак на пару отсекает и повтор, и откат.
    //
    // v4.32.757: знак проверяется до применения и сдвигается после. Прежний
    // acceptControlTs делал и то и другое разом, а применение умеет не
    // удаться: знак вставал, стирание не проходило, и ПОВТОР того же конверта
    // отвергался как устаревший — отказ становился вечным.
    if (!(await controlTsFresh('dmpin_clear', senderPubB64, pid, env.ts))) {
      log.info('dm_pin_clear_stale_drop', { from: senderPubB64.slice(0, 12) });
      return 'consumed';
    }
    if (!(await clearDmPinned(senderPubB64, pid))) {
      log.warn('dm_pin_clear_not_applied', { from: senderPubB64.slice(0, 12) });
      return 'deferred';
    }
    await commitControlTs('dmpin_clear', senderPubB64, pid, env.ts);
    // Строки сообщения закрепление не создаёт, поэтому открытый чат сам о нём
    // не узнает — будим подписчиков явно.
    notifyChatStorageChanged();
    log.info('dm_pin_cleared_remote', { from: senderPubB64.slice(0, 12) });
    return 'consumed';
  }
  const write = await applyLocalDmPin({
    peerPubB64: senderPubB64,
    ownerProfileId: pid,
    msgId: env.msgId,
    on: env.on,
  });
  // v4.32.643: конверт наш в любом случае — обычным сообщением его сохранять
  // нельзя, человек увидел бы служебную строку. Но применить его не вышло, и
  // молчать об этом в логе не о чем: у собеседника закрепление есть, у нас нет.
  // v4.32.757: и метку за него двигать нельзя — обе причины отказа (список не
  // прочитался, запись не легла) пройдут сами, а второй посылки не будет.
  if (!write.ok) {
    log.warn('dm_pin_not_applied', { from: senderPubB64.slice(0, 12), reason: write.reason });
    return 'deferred';
  }
  notifyChatStorageChanged();
  log.info('dm_pin_applied', {
    from: senderPubB64.slice(0, 12),
    on: env.on,
    total: write.entries.length,
  });
  return 'consumed';
}
