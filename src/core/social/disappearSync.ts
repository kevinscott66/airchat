/**
 * Таймер исчезающих сообщений в личном чате: локальная запись, отправка
 * собеседнику, применение входящего решения.
 *
 * v4.32.237. Разбор конверта — в disappearEnvelope.ts (без зависимостей,
 * тестируется отдельно); здесь доставка, запись и системная строка в чате.
 *
 * Прав в личке нет: собеседники равны, включить и снять таймер может любой из
 * двоих — как в Telegram. Опасность такой симметрии в том, что чужая команда
 * удаляет МОЮ переписку, поэтому она ограничена с двух сторон:
 *  1. `decodeDisappearEnvelope` не пропускает значения меньше минуты;
 *  2. `purgeDisappearedMessages` удаляет только сообщения, написанные после
 *     включения таймера, — прошлая история под чужую команду не попадает.
 * Плюс обе стороны видят системную строку «кто и что включил».
 */
import { setConversationDisappearTimer, saveChatMessage } from '../storage/local';
import { commitControlTs, controlTsFresh } from './controlWatermark';
import { profileManager } from '../identity/profileManager';
import { fanoutControlEnvelope, fanoutReasonText, type FanoutUndelivered } from './controlFanout';
import { log } from '../logger';
import { SYS_LINE_PREFIX } from './sysLineGuard';
import {
  DISAPPEAR_PREFIX,
  encodeDisappearEnvelope,
  decodeDisappearEnvelope,
  formatDisappearLabel,
  type DisappearEnvelope,
} from './disappearEnvelope';

export { DISAPPEAR_PREFIX, encodeDisappearEnvelope, decodeDisappearEnvelope, formatDisappearLabel };
export type { DisappearEnvelope };

/**
 * Системная строка в переписке — тот же префикс, что у системных строк групп.
 * v4.32.263: берётся из sysLineGuard, а не выписан литералом. Именно этот
 * префикс снимает stripSpoofedSysPrefix у всего, что пришло по сети; разойдись
 * копии — приложение рисовало бы «от своего имени» строку, которую защита уже
 * не считает системной.
 */
const SYS_PREFIX = SYS_LINE_PREFIX;

function sysText(ms: number, byMe: boolean): string {
  const who = byMe ? 'Вы' : 'Собеседник';
  return ms > 0
    ? `${SYS_PREFIX}${who} ${byMe ? 'включили' : 'включил'} исчезающие сообщения: ${formatDisappearLabel(ms)}`
    : `${SYS_PREFIX}${who} ${byMe ? 'выключили' : 'выключил'} исчезающие сообщения`;
}

/**
 * Системная строка с детерминированным id (INSERT OR IGNORE ⇒ повтор
 * конверта не плодит дубликатов).
 */
async function insertSysRow(params: {
  peerPubB64: string;
  ownerProfileId: number;
  ms: number;
  /** Метка автора решения — делает id повторяемым, чтобы дубль конверта не плодил строк. */
  key: number;
  createdAt: number;
  byMe: boolean;
}): Promise<void> {
  const { peerPubB64, ownerProfileId, ms, key, createdAt, byMe } = params;
  await saveChatMessage({
    id: `dis-${byMe ? 'me' : 'peer'}-${key}-${ms}`,
    contactPubB64: peerPubB64,
    cid: null,
    text: sysText(ms, byMe),
    direction: byMe ? 'out' : 'in',
    status: 'read',
    mediaCids: null,
    createdAt,
    ownerProfileId,
  });
}

/**
 * Итог включения таймера.
 *
 * v4.32.448: раньше отсюда не возвращалось ничего, и «собеседник согласился с
 * таймером» не отличалось от «собеседник о нём не узнал». Расхождение молчит по
 * своей природе: у себя таймер стоит, системная строка в переписке есть,
 * сообщения исчезают — а у собеседника они лежат вечно. Экран при этом обещает
 * дословно: «Выбранное время действует у обоих собеседников». Для приватной
 * переписки это не мелочь: человек считает, что переписка стирается с двух
 * устройств, и пишет, исходя из этого.
 *
 * Повторной отправки у служебного конверта нет — «не ушло» значит «не уйдёт».
 *
 * v4.32.750: у отказа появилось поле `applied` — встал ли таймер хотя бы у
 * себя. Запись в базу тоже умеет не лечь, и тогда неправда получается вдвое
 * больше: таймера нет нигде, а экран показывает выбранное значение.
 */
export type DisappearSyncResult =
  | { synced: true }
  | { synced: false; applied: boolean; warning: string };

/**
 * Что сказать, когда решение о таймере до собеседника не доехало. Формулировка
 * называет и то, что уже произошло, и то, чего теперь не произойдёт у него.
 */
function disappearWarning(ms: number, reason: FanoutUndelivered): string {
  const head = ms > 0 ? 'Таймер включён только у вас' : 'Таймер выключен только у вас';
  const why = fanoutReasonText(reason, 'dm');
  const what =
    ms > 0
      ? 'У него сообщения этой переписки удаляться не будут'
      : 'У него сообщения этой переписки продолжат удаляться';
  return `${head}: собеседник об этом не узнал (${why}). ${what}`;
}

/**
 * Что сказать, когда таймер не встал даже у себя (v4.32.750). Собеседнику в
 * этом случае не отправляют ничего: конверт объявлял бы состояние, которого у
 * нас нет, — у него переписка стиралась бы, у нас копилась.
 */
function disappearLocalWarning(ms: number): string {
  const what = ms > 0 ? 'Автоудаление не включилось' : 'Автоудаление не выключилось';
  return `${what}: не удалось сохранить настройку на этом устройстве. Попробуйте ещё раз.`;
}

/**
 * Ставит таймер локально и сообщает решение собеседнику.
 * `ms` — 0 или «Выкл»; значение уже должно быть из набора экрана чата.
 */
export async function setDisappearAndSync(params: {
  peerPubB64: string;
  ms: number;
}): Promise<DisappearSyncResult> {
  const { peerPubB64 } = params;
  const ms = Number.isFinite(params.ms) && params.ms > 0 ? Math.round(params.ms) : 0;
  const pid = profileManager.getActiveProfile()?.id ?? 1;
  const ts = Date.now();
  // v4.32.750: запись у себя тоже умеет не лечь, и раньше её ответ никто не
  // смотрел. Тогда дальше шли обе неправды сразу: системная строка «Вы
  // включили исчезающие сообщения» в переписке и конверт собеседнику — при
  // том, что у нас таймера нет. Собеседник бы стирал, мы бы копили.
  if (!(await setConversationDisappearTimer(peerPubB64, pid, ms))) {
    log.warn('disappear_local_write_failed', { to: peerPubB64.slice(0, 12), ms });
    return { synced: false, applied: false, warning: disappearLocalWarning(ms) };
  }
  await insertSysRow({ peerPubB64, ownerProfileId: pid, ms, key: ts, createdAt: ts, byMe: true });

  // v4.32.448: рассылка — общая воронка служебных конвертов, и её отказ
  // возвращается наверх. Таймер уже стоит у себя; у собеседника — нет, и
  // молчать об этом нельзя.
  const delivery = await fanoutControlEnvelope('disappear', encodeDisappearEnvelope({ ms, ts }), {
    kind: 'dm',
    peerPubB64,
  });
  if (!delivery.sent) {
    return { synced: false, applied: true, warning: disappearWarning(ms, delivery.reason) };
  }
  return { synced: true };
}

/**
 * Применяет входящий конверт. true — конверт наш (даже если отброшен):
 * вызывающий не должен сохранять его как обычное сообщение.
 */
export async function handleIncomingDisappear(
  text: string,
  senderPubB64: string | undefined,
  ownerPid: number
): Promise<boolean> {
  if (!text.startsWith(DISAPPEAR_PREFIX)) return false;
  const env = decodeDisappearEnvelope(text);
  if (!env || !senderPubB64) return true;
  // Профиль-владелец — от службы переписки (v4.32.481).
  const pid = ownerPid;
  // v4.32.615: повтор старого конверта откатывал состояние. Окно приёма — 30
  // суток, а единственной защитой от повтора был Set в памяти, гибнущий при
  // перезапуске; служебный конверт вдобавок выходит раньше, чем в базе
  // появится строка с его messageId. Отметка времени монотонна для каждой
  // пары «профиль — собеседник» (см. controlWatermark.ts).
  if (!(await controlTsFresh('disappear', senderPubB64, pid, env.ts))) return true;
  // Разговор определяется ПОДПИСАННЫМ отправителем DM: иначе любой контакт
  // включал бы автоудаление в чужой переписке.
  const applied = await setConversationDisappearTimer(senderPubB64, pid, env.ms);
  // v4.32.750: знак двигаем ПОСЛЕ применения — та же пара, что у запрета
  // копирования (v4.32.655) и в группе. Сдвиг до него делал отказ вечным:
  // запись могла не лечь, а повтор того же конверта отвергался уже как старый.
  // Само собой это не чинилось ничем: повтора у служебного конверта нет,
  // отправитель второй раз его не шлёт, а ответить ему нечем — и переписка,
  // которую собеседник считает исчезающей, оставалась у нас навсегда.
  if (!applied) {
    log.warn('disappear_apply_failed', { from: senderPubB64.slice(0, 12), ms: env.ms });
    return true;
  }
  await commitControlTs('disappear', senderPubB64, pid, env.ts);
  // Место в ленте — по своему времени: по чужому ts строка легла бы куда
  // угодно, в том числе в будущее. А id считается от ts отправителя, чтобы
  // повторная доставка того же конверта не добавляла вторую строку.
  await insertSysRow({
    peerPubB64: senderPubB64,
    ownerProfileId: pid,
    ms: env.ms,
    key: env.ts,
    createdAt: Date.now(),
    byMe: false,
  });
  log.info('disappear_applied_remote', { from: senderPubB64.slice(0, 12), ms: env.ms });
  return true;
}
