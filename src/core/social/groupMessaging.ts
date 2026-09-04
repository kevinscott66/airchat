/**
 * groupMessaging — рассылка сообщений групп через индивидуальные DM (fanout).
 *
 * Формат конверта: PREFIX + JSON
 * PREFIX = '\x02grp:'
 * JSON = { groupId, msgId, senderName, senderPubB64, text, ts, mediaCids? }
 *
 * Когда получатель видит сообщение с этим префиксом, он парсит его и
 * сохраняет в group_messages (если он является участником группы).
 */

import { readEnvelopeBody } from './envelopeBody';
import { clampEnvelopeTs } from './envelopeTime';
import { profileManager } from '../identity/profileManager';
import { getOwnDisplayNameFor } from '../identity/ownProfile';
import {
  listGroupMembers,
  getGroup,
  getGroupMessageTexts,
  getGroupMessageTarget,
  insertGroupMessage,
  updateGroupMessageText,
  deleteGroupMessage,
  touchGroupConversation,
  markGroupMessageSeen,
  insertGroupJoinRequest,
  createGroup,
  upsertGroupMember,
  updateGroupMemberRole,
  removeGroupMember,
  updateGroupMeta,
  recountGroupMembers,
  setGroupSlowMode,
  setGroupDisappearTimer,
  profileKvGet,
  kvDeleteScoped,
  type GroupMessageRow,
} from '../storage/local';
import { type GroupRecipient } from './groupRecipient';
import { getMessagingService } from './messaging';
import { activeRecipients, fanoutControlEnvelope } from './controlFanout';
import type { FanoutResult } from './controlFanout';
import type { GroupControlOutcome } from './groupControlOutcome';
import { canApplyGroupMessageOp, canSendToGroup, mediaKindOfText, slowModeSysLine, type SendDenyCode, type SendVerdict } from './groupSendPolicy';
import { lookupGroupActor, roleOf } from './groupActor';
import { isAdminRole, ownGroupRole, roleAfterCtl } from './ownGroupRole';
import { displayNameOrNull, sanitizeDisplayName, stripSpoofedSysPrefix } from './sysLineGuard';
import { previewLabelForText, truncateReplyPreview } from './messagePreview';
import { sanitizeReplyRef } from './replyRef';
import { isMentionOf } from './mentions';
import { canModerate } from './groupModerationPolicy';
import { roleChangeSysText } from './groupRolePolicy';
import { sanitizeMediaCids } from '../media/mediaCidPolicy';
import { withinMessageTextLimit } from './messageTextLimit';
import { privacyPrefTryBoolFor, readReceiptsAllowedFor } from '../settings/privacyPrefs';
import { log } from '../logger';
import { isPollMessage } from './pollEnvelope';
import { decideMetaField } from './groupMetaEvents';

export const GROUP_MSG_PREFIX = '\x02grp:';

export type GroupMsgEnvelope = {
  groupId: string;
  msgId: string;
  senderName: string;
  senderPubB64: string;
  text: string;
  ts: number;
  mediaCids?: string[];
  /**
   * v4.32.299: цитата. До этой версии её в конверте не было вовсе — ответ в
   * группе видел цитатой только тот, кто его написал, а всем остальным
   * приходило сообщение без всякой связи с тем, на что оно отвечает.
   * Необязательные поля: сборки без них шлют конверт прежнего вида.
   */
  replyToId?: string;
  replyToPreview?: string;
};

/** Encode a group message as a DM text payload. */
export function encodeGroupMsgEnvelope(env: GroupMsgEnvelope): string {
  return GROUP_MSG_PREFIX + JSON.stringify(env);
}

/** Decode a DM text payload into a group message envelope. Returns null if not a group message. */
export function decodeGroupMsgEnvelope(text: string): GroupMsgEnvelope | null {
  // v4.32.196 (Round-26 #5): cap inner JSON length. DM-layer text can reach
  // ~64 KB (wire cap); group metadata envelopes are tiny (groupId + msgId +
  // displayName + short text + ≤ a few CIDs). 128 KB keeps headroom while
  // blocking multi-MB JSON.parse stalls.
  //
  // v4.32.380: проверки формы здесь не было вовсе — что вернул JSON.parse, то и
  // уезжало вызывающему, хоть число, хоть строка, хоть массив. Теперь общий
  // разбор (envelopeBody) отдаёт только объект.
  return readEnvelopeBody<GroupMsgEnvelope>(text, GROUP_MSG_PREFIX, 128 * 1024);
}

/**
 * Send a group message to all members via individual DMs.
 * Called after the message is already stored locally.
 *
 * v4.32.269: возвращает false, если рассылка НЕ состоялась — нет транспорта
 * либо права на отправку отозваны (бан, «только чтение», «только админы»,
 * режим канала). Экран пишет свою строку до вызова и о вердикте узнать не мог,
 * но у планировщика выбор есть: записывать себе отложенное сообщение, которого
 * никто не получил, — значит показывать автору отправленным то, чего в группе
 * нет.
 */
/**
 * Вправе ли я отправить этот текст в эту группу — по живым данным из БД.
 *
 * v4.32.270: тот же вердикт, что выносит fanoutGroupMessage, но доступный
 * ДО записи своей копии. Экран чата держит право отправки в своём состоянии
 * (myRole/adminOnlyPosting) и просто прячет поле ввода, а вот пересылка
 * (ChatForwardModal) и «поделиться публикацией» (FeedScreen) шлют в группу,
 * которую пользователь выбрал из общего списка, не зная о ней ничего. Они
 * писали свою строку в историю, показывали «Переслано» и звали fanout через
 * void — а тот молча отказывал. Автор видел отправленным то, чего в группе
 * нет; никакого способа это заметить у него не было.
 *
 * Строки группы нет — вердикт положительный: проверять нечего, и запрет
 * «на всякий случай» превратил бы сбой чтения в невозможность писать.
 */
export async function groupSendVerdict(
  groupId: string,
  senderPubB64: string,
  text: string
): Promise<SendVerdict> {
  try {
    const pid = profileManager.getActiveProfile()?.id ?? 1;
    const actor = await lookupGroupActor(groupId, senderPubB64, pid);
    if (!actor.group) return { allowed: true };
    return canSendToGroup({
      role: actor.role,
      type: actor.group.type,
      adminOnlyPosting: !!actor.group.adminOnlyPosting,
      media: mediaKindOfText(text),
    });
  } catch (e) {
    // Группа не читается — не повод молча проглотить отправку, но и не повод
    // её заблокировать: без строки группы проверять нечего.
    log.warn('group_send_verdict_failed', { err: e instanceof Error ? e.message : String(e) });
    return { allowed: true };
  }
}

/**
 * Чем кончилась рассылка сообщения в группу (v4.32.440).
 *
 * Раньше здесь было `boolean`, и `false` значил сразу две несовместимые вещи:
 * «права не позволяют» и «служба обмена не поднята». Планировщик отложенных
 * сообщений читал этот ответ как «права отозвали» и УДАЛЯЛ строку расписания —
 * то есть исчезновение службы на долю секунды стирало сообщение, которое
 * человек назначил на утро, без единого следа в интерфейсе. А `true` значил
 * всего лишь «мы попробовали»: отправка каждому участнику обёрнута в свой
 * try/catch, и провал ВСЕХ отправок давал ровно тот же ответ, что и успех.
 *
 * Поэтому не флаг, а разбор случаев: удалить расписание можно только по
 * `denied`, а сколько адресатов действительно получили — видно числом.
 */
export type GroupFanoutResult =
  /** Разослано (или отправка ушла в очередь службы) — `sent` из `members`. */
  | { ok: true; members: number; sent: number; failed: number }
  /** Службы обмена нет — ничего не отправлено, повторить позже. */
  | { ok: false; reason: 'no_service' }
  /** Права не позволяют — повторять бессмысленно. */
  | { ok: false; reason: 'denied'; code: SendDenyCode };

export async function fanoutGroupMessage(
  groupId: string,
  text: string,
  senderName: string,
  senderPubB64: string,
  msgId: string,
  mediaCids?: string[],
  /**
   * Цитата: id сообщения, на которое отвечают, и превью его текста — ровно то,
   * что отправитель уже записал себе в строку. Отдельным объектом, а не двумя
   * позиционными аргументами: их нельзя перепутать местами и незачем указывать
   * там, где ответа нет (медиа, опрос, пересылка).
   */
  reply?: { id: string | null; preview: string | null }
): Promise<GroupFanoutResult> {
  const svc = getMessagingService();
  if (!svc) {
    log.warn('group_fanout_no_service');
    return { ok: false, reason: 'no_service' };
  }

  // v4.32.466: состав спрашивается у своего профиля — его называет служба
  // переписки, чьим ключом сообщение и уйдёт.
  const members = await listGroupMembers(groupId, (await svc.groupRecipient()).pid);

  // v4.32.234: единственная точка, через которую уходит ЛЮБОЕ сообщение
  // группы (текст, медиа, голос, опрос, отложенное, пересланное). Проверка
  // прав раньше жила в методе, который не вызывал никто, и падала на приведении
  // типов — то есть «только для админов», роль restricted и режим канала
  // ограничивали лишь видимость кнопок. Тот же вердикт выносится на приёме.
  const verdict = await groupSendVerdict(groupId, senderPubB64, text);
  if (!verdict.allowed) {
    log.warn('group_fanout_denied', { gid: groupId.slice(0, 8), code: verdict.code });
    return { ok: false, reason: 'denied', code: verdict.code };
  }

  const envelope = encodeGroupMsgEnvelope({
    groupId,
    msgId,
    senderName,
    senderPubB64,
    text,
    ts: Date.now(),
    mediaCids,
    // Цитата уходит только целиком: id без превью нарисовал бы у получателя
    // пустую рамку, превью без id — строку, которую некуда нажать.
    replyToId: reply?.id ?? undefined,
    replyToPreview: reply?.id ? (reply.preview ?? undefined) : undefined,
  });

  // v4.32.172: не отправляем сообщения забаненным участникам — их role=='banned',
  // они не должны ни видеть, ни получать трафик из группы (иначе бан ничего не делает).
  const targets = members.filter((m) => m.peerPubB64 !== senderPubB64 && m.role !== 'banned');
  // Отказ по каждому адресату считается здесь же, где ловится: считать его
  // потом, по логам, вызывающему негде.
  let sent = 0;
  let failed = 0;
  const sends = targets.map(async (m) => {
    try {
      await svc.sendMessage(m.peerPubB64, envelope);
      sent += 1;
    } catch (e) {
      failed += 1;
      log.warn('group_fanout_member_failed', {
        member: m.peerPubB64.slice(0, 12),
        err: e instanceof Error ? e.message : String(e),
      });
    }
  });

  await Promise.allSettled(sends);
  log.info('group_fanout_done', {
    groupId: groupId.slice(0, 8),
    members: members.length,
    sent,
    failed,
  });
  return { ok: true, members: targets.length, sent, failed };
}

// ─── Read Receipts ────────────────────────────────────────────────────────────

export const GROUP_READ_RECEIPT_PREFIX = '\x03grpr:';

export type GroupReadReceiptEnvelope = {
  groupId: string;
  /** Last message ID that was seen (all messages before it are implicitly seen too). */
  lastSeenMsgId: string;
  viewerPubB64: string;
  ts: number;
};

/**
 * Отметка о прочтении отправителю группового сообщения.
 *
 * v4.32.312: переключатель «не отправлять отметки о прочтении» здесь не
 * спрашивали вовсе — он закрывал только личные переписки. Человек выключал его
 * затем, чтобы не сообщать, когда именно он читает; в группах отметки при этом
 * продолжали уходить, да ещё и складывались в `seen_by` — список «кто видел» с
 * временем, видимый другим участникам. Проверка стоит внутри, а не у
 * вызывающего: следующий вызов её бы не вспомнил.
 */
export async function sendGroupReadReceipt(
  groupId: string,
  lastSeenMsgId: string,
  senderPubB64: string,
  myPubB64: string
): Promise<void> {
  const svc = getMessagingService();
  if (!svc) return;
  if (senderPubB64 === myPubB64) return; // don't send to self
  // v4.32.465: спрашиваем тот аккаунт, чьим ключом отметка будет подписана.
  // Экран группы выпускает до 20 таких вызовов разом, каждый ждёт чтения kv
  // из SQLite; переключись человек в это время — отметки уходили бы ключом
  // «Личного», но по разрешению «Рабочего», хотя в «Личном» он их запретил.
  if (!(await readReceiptsAllowedFor((await svc.groupRecipient()).pid))) return;

  const envelope: GroupReadReceiptEnvelope = {
    groupId,
    lastSeenMsgId,
    viewerPubB64: myPubB64,
    ts: Date.now(),
  };
  try {
    await svc.sendMessage(senderPubB64, GROUP_READ_RECEIPT_PREFIX + JSON.stringify(envelope));
    log.debug('group_read_receipt_sent', { groupId: groupId.slice(0, 8), msgId: lastSeenMsgId.slice(0, 8) });
  } catch {
    // Non-critical
  }
}

/**
 * Handle an incoming group read receipt.
 * Returns true if this was a receipt (so messaging layer skips normal DM storage).
 */
export async function handleIncomingGroupReadReceipt(
  text: string,
  rcpt: GroupRecipient,
  senderPubB64?: string
): Promise<boolean> {
  if (!text.startsWith(GROUP_READ_RECEIPT_PREFIX)) return false;
  // v4.32.197 (Round-27 #1): byte-cap + field-shape validation before trust.
  // Peer could DM multi-MB read-receipt JSON to stall parse / flood SQLite.
  // v4.32.507: потолок и разбор — через общий readEnvelopeBody, как у
  // остальных четырнадцати конвертов. Своя копия этих трёх шагов не отсеивала
  // массив (`typeof [] === 'object'`) и разъезжалась с общим правилом.
  const env = readEnvelopeBody<GroupReadReceiptEnvelope>(text, GROUP_READ_RECEIPT_PREFIX, 16 * 1024);
  // Дальше конверт наш при любом исходе: возвращать false значило бы отдать
  // сырой служебный текст в переписку как обычное сообщение.
  if (!env) return true;
  try {
    if (typeof env.groupId !== 'string' || !env.groupId || env.groupId.length > 128) return true;
    if (typeof env.lastSeenMsgId !== 'string' || !env.lastSeenMsgId || env.lastSeenMsgId.length > 128) return true;
    if (typeof env.viewerPubB64 !== 'string' || env.viewerPubB64.length < 43 || env.viewerPubB64.length > 48) return true;
    if (env.ts != null && (typeof env.ts !== 'number' || !Number.isFinite(env.ts))) return true;
    // v4.32.176: anti-spoof — DM-signer (senderPubB64, Ed25519-верифицированный)
    // должен совпадать с viewerPubB64 в envelope. Раньше любой peer мог
    // написать "Bob прочёл" и отравить seen_by для чужого.
    if (senderPubB64 && env.viewerPubB64 !== senderPubB64) {
      log.warn('group_read_receipt_spoof_drop', {
        env: env.viewerPubB64.slice(0, 12),
        signer: senderPubB64.slice(0, 12),
      });
      return true;
    }
    const pid = rcpt.pid;
    // v4.32.507: отметку принимаем только от участника этой группы. Проверка
    // подписи выше говорит лишь «конверт от того, кем подписан», а не «он
    // здесь состоит»: узнав id группы и id сообщения, посторонний собеседник
    // добавлял себя в seen_by и накручивал счётчик просмотров чужого канала.
    const actor = await lookupGroupActor(env.groupId, env.viewerPubB64, pid);
    if (!actor.group || actor.role === null) {
      log.warn('group_read_receipt_nonmember_drop', {
        gid: env.groupId.slice(0, 8),
        viewer: env.viewerPubB64.slice(0, 12),
        known: !!actor.group,
      });
      return true;
    }
    await markGroupMessageSeen(env.lastSeenMsgId, env.groupId, pid, env.viewerPubB64);
    log.debug('group_read_receipt_applied', { groupId: env.groupId.slice(0, 8), viewer: env.viewerPubB64.slice(0, 8) });
  } catch (e) {
    log.debug('group_read_receipt_apply_failed', { err: e instanceof Error ? e.message : String(e) });
  }
  return true;
}

/**
 * Registered by push notification layer to trigger local notification on group messages.
 * v4.32.168: добавлен `kind` ('group'|'channel') — pushNotifications.ts гасит
 * @mention-override для каналов (в каналах нет реальных mentions, только broadcast).
 */
export type GroupKind = 'group' | 'channel';
// v4.32.195 (Round-25 #4): multi-subscriber registry. Previously a single
// slot — App.tsx's setter clobbered pushNotifications.ts's, so group push
// banners never fired. Return an unsubscribe so each caller manages its own.
// v4.32.255: добавлен isMention. Раньше push-слой выводил его сам — но
// получал он не текст сообщения, а превью, обрезанное до 80 символов, и
// сравнивал регистрозависимо. Упоминание в замьюченной группе (единственный
// случай, когда флаг вообще что-то решает) терялось, если написано в другом
// регистре или дальше 80-го символа. Считаем один раз, здесь, по полному
// тексту — и отдаём готовым.
// v4.32.560: добавлен msgId. Групповой баннер не нёс полезной нагрузки вовсе,
// поэтому нажатие на него не вело в группу; теперь показ кладёт в уведомление
// groupId и msgId, а идентификатор сообщения известен только здесь.
type GroupNotifyCb = (groupName: string, senderName: string, text: string, groupId?: string, kind?: GroupKind, isMention?: boolean, msgId?: string) => void;
const groupMsgNotifyCallbacks: Set<GroupNotifyCb> = new Set();
export function setGroupMessageNotifyCallback(cb: GroupNotifyCb | null): () => void {
  if (!cb) { groupMsgNotifyCallbacks.clear(); return () => { /* noop */ }; }
  groupMsgNotifyCallbacks.add(cb);
  return () => { groupMsgNotifyCallbacks.delete(cb); };
}

/**
 * Handle an incoming group message envelope received via DM.
 * Returns true if the message was handled (so the caller can skip normal DM storage).
 */
export async function handleIncomingGroupEnvelope(
  text: string,
  rcpt: GroupRecipient,
  senderPubB64: string
): Promise<boolean> {
  const env = decodeGroupMsgEnvelope(text);
  if (!env) return false;

  // v4.32.188 (Round-18 #4): strict shape validation. env comes straight
  // from an over-the-wire JSON — a malformed payload (non-string text,
  // NaN ts, oversized names) used to crash downstream (`env.text.toLowerCase`
  // throws if text is an object) or produce rows that poison date-sep
  // labels and dialog previews forever. Reject hard.
  if (typeof env.groupId !== 'string' || env.groupId.length === 0 || env.groupId.length > 128) return true;
  if (typeof env.msgId !== 'string' || env.msgId.length === 0 || env.msgId.length > 128) return true;
  if (typeof env.senderPubB64 !== 'string' || env.senderPubB64.length < 43 || env.senderPubB64.length > 48) return true;
  if (!withinMessageTextLimit(env.text)) return true;
  // v4.32.238: системную строку («Вы заблокированы в группе» и т. п.) рисует
  // приложение, поэтому участник не вправе её прислать — см. sysLineGuard.
  env.text = stripSpoofedSysPrefix(env.text);
  if (env.senderName != null) {
    if (typeof env.senderName !== 'string' || env.senderName.length > 128) return true;
    // v4.32.239: имя автора — это ещё и первая строка пересылки
    // ('\x08fwd:' + имя + '\n' + текст, см. makeForwardText). Перевод строки
    // внутри имени обрывал имя на нём, а остаток становился «оригинальным
    // текстом» — то есть чужое имя дописывало пересылке содержимое, которого
    // в сообщении не было.
    env.senderName = sanitizeDisplayName(env.senderName, 128) ?? env.senderName;
  }
  // v4.32.382: то же правило, что у системной строки группы и у даты
  // вступления участника, — см. envelopeTime. Раньше оно было написано здесь
  // руками, слово в слово повторено ниже и не применено к joinedAt вовсе.
  env.ts = clampEnvelopeTs(env.ts);
  if (env.mediaCids != null) {
    if (!Array.isArray(env.mediaCids)) return true;
    // v4.32.197 (Round-27 #3): cap count BEFORE filter — attacker can ship
    // 10k valid-shape CIDs to bloat SQLite rows / UI. Legit messages ≤ 10.
    // v4.32.244: правила разбора переехали в core/media/mediaCidPolicy — там же
    // разрешён `nb:`-дескриптор зашифрованного вложения (форма проверяется),
    // без которого фото в группе не доезжало до участников.
    env.mediaCids = sanitizeMediaCids(env.mediaCids);
  }

  // v4.32.175: anti-spoof. Верхний слой DM-транспорта пришёл от senderPubB64
  // (сверен по Ed25519), но внутри JSON-envelope атакующий мог написать
  // чужой senderPubB64 → мы бы сохранили сообщение «от имени» другого юзера.
  if (env.senderPubB64 !== senderPubB64) {
    log.warn('group_msg_spoof_drop', {
      env: env.senderPubB64.slice(0, 12),
      signer: senderPubB64.slice(0, 12),
    });
    return true;
  }

  // Check if we are a member of this group
  const pid = rcpt.pid;
  // v4.32.511: по идентификатору, а не выбором из списка активных групп.
  // `listGroups` отдаёт только `archived = 0`, и всё время, пока группа лежала
  // в архиве, её сообщения съедались здесь как «неизвестная группа» — молча и
  // без следа, потому что архив в этой сборке скрывает строку, а не выводит из
  // группы.
  const group = await getGroup(env.groupId, pid);
  if (!group) {
    log.debug('group_msg_unknown_group', { groupId: env.groupId.slice(0, 8) });
    return true; // still consumed — don't create a phantom DM
  }

  // Не-члены, забаненные, ограниченные, подписчики канала и «только для
  // администраторов» — один вердикт той же функции, что и на отправке
  // (v4.32.234; раньше здесь лежали четыре разъезжающиеся проверки, а роль
  // restricted не проверялась вовсе). Системные сообщения протокола проходят
  // всегда — иначе участник не узнает, что режим включили.
  try {
    const verdict = canSendToGroup({
      role: roleOf(await listGroupMembers(env.groupId, pid), senderPubB64),
      type: group.type,
      adminOnlyPosting: !!group.adminOnlyPosting,
      media: mediaKindOfText(env.text),
    });
    if (!verdict.allowed) {
      log.warn('group_msg_denied_drop', {
        gid: env.groupId.slice(0, 8),
        from: senderPubB64.slice(0, 12),
        code: verdict.code,
      });
      return true;
    }
  } catch (e) {
    // v4.32.581. Отказ проверки прав — это отказ, а не пропуск. Сейчас ветка
    // почти недостижима (listGroupMembers гасит свои ошибки и отдаёт пустой
    // список, а на нём вердикт и так «не участник»), но «почти» — не то
    // основание, на котором записывают чужое сообщение в группу.
    log.warn('group_msg_verdict_failed_drop', {
      gid: env.groupId.slice(0, 8),
      err: e instanceof Error ? e.message : String(e),
    });
    return true;
  }

  // v4.32.299: цитата. Приходит от участника, то есть это недоверенный ввод,
  // который рисуется на экране, — правила разбора в social/replyRef.
  const reply = sanitizeReplyRef(env.replyToId, env.replyToPreview, env.msgId);
  let replyPreview = reply.preview;
  if (reply.id) {
    // Если цитируемое сообщение у нас есть, показываем СВОЙ его текст, а не
    // присланный: иначе участник подписал бы под чужим сообщением любую
    // строку («Аня: я согласна»), и отличить подделку было бы нечем. Заодно
    // цитата перестаёт расходиться с оригиналом после его правки.
    try {
      const own = (await getGroupMessageTexts([reply.id], env.groupId, pid)).get(reply.id);
      // v4.32.575: своя копия не открылась — это не «в сообщении пусто».
      // Раньше сюда приходила пустая строка, и цитата стиралась в ничто.
      // Своей копии нет и своей копии не прочесть — риск одинаковый (проверить
      // присланное превью нечем ни там, ни там), поэтому и ответ одинаковый:
      // остаётся присланное превью, уже пропущенное через sanitizeReplyRef.
      if (own === null) {
        log.warn('reply_own_copy_unreadable', { msgId: reply.id.slice(0, 8) });
      } else if (own !== undefined) {
        replyPreview = truncateReplyPreview(own);
      }
    } catch { /* своей копии нет — остаётся присланное превью */ }
  }

  // Dedup by msgId
  const row: GroupMessageRow = {
    id: env.msgId,
    groupId: env.groupId,
    senderPubB64: env.senderPubB64,
    // v4.32.371: пустое имя ложится в базу как отсутствие имени. Экран
    // подставляет вместо него начало ключа (`senderName ?? '...'`), а пустая
    // строка эту подстановку проходит насквозь — и сообщение остаётся вовсе
    // без подписи, хотя ключ отправителя рядом и известен.
    senderName: env.senderName || null,
    text: env.text,
    mediaCids: env.mediaCids?.length ? JSON.stringify(env.mediaCids) : null,
    replyToId: reply.id,
    replyToPreview: replyPreview,
    reactions: null,
    createdAt: env.ts,
    ownerProfileId: pid,
  };

  try {
    // v4.32.581. Счётчик непрочитанных, бейдж упоминаний и баннер — только на
    // сообщении, которое действительно записалось. Повтор конверта — событие
    // штатное: пуш и транспорт могут принести один и тот же msgId дважды, а
    // постоянного списка разобранных идентификаторов у групп нет (в памяти
    // `seenMessageIds` живёт до перезапуска). Раньше повтор давал «5 новых»
    // на группе со вчерашним текстом и заново будил экран блокировки.
    const stored = await insertGroupMessage(row);
    if (!stored) {
      log.debug('group_msg_duplicate_skip', { msgId: env.msgId.slice(0, 8) });
      return true;
    }
    // v4.32.573: голос, обогнавший свой опрос, ждал на полке — см.
    // pollVotePending. Сообщение записано, значит его можно применить.
    if (isPollMessage(env.text)) {
      void import('./pollVoteSync')
        .then(({ flushPendingPollVotes }) => flushPendingPollVotes(env.msgId, pid))
        .catch((e) => log.warn('poll_vote_flush_failed', { err: e instanceof Error ? e.message : String(e) }));
    }
    // v4.32.478: имя владельца сообщения (pid), а не того профиля, что открыт
    // на экране: приём идёт в фоне и активным может быть любой аккаунт.
    const myUsername = (await getOwnDisplayNameFor(pid)) ?? '';
    const kind: GroupKind = group.type === 'channel' ? 'channel' : 'group';
    // v4.32.255: раньше здесь был `.includes('@' + имя)` — он срабатывал внутри
    // более длинного имени (@аня внутри @анна) и на почтовом адресе
    // (alice@bob.com считался упоминанием bob). Границы слова проверяет
    // isMentionOf. Плюс каналы: там нет реальных упоминаний, только рассылка
    // админа, — push это учитывал, а счётчик mention_count нет, и на канале
    // висел бейдж упоминаний.
    const isMention = kind === 'group' && isMentionOf(env.text, myUsername);
    // v4.32.256: «Анонимные посты» прятали имя только в ленте сообщений, а
    // список чатов показывал «Вася: текст» и push выносил то же имя на экран
    // блокировки. В самой строке имя сохраняется (иначе выключение настройки
    // уже ничего не вернёт) — скрывается только там, где оно показывается.
    const shownSenderName = group.anonymousPosting ? null : (env.senderName || null);
    await touchGroupConversation(env.groupId, pid, env.text.slice(0, 120), true, shownSenderName, isMention, env.senderPubB64);
    log.info('group_msg_received', { groupId: env.groupId.slice(0, 8), msgId: env.msgId.slice(0, 8) });
    // v4.32.168: всегда зовём callback — он сам решает (notify_groups/mentions/mute).
    // Ранее фильтр `notifyGroupsSetting !== 'false'` здесь инвертировал
    // «mentions piercing mute»: при глобально выключенных группах @упоминание
    // в muted-группе никогда не доходило до handler'а.
    if (groupMsgNotifyCallbacks.size > 0) {
      // v4.32.239: этот текст уходит в тело системного уведомления, то есть на
      // экран блокировки и в журнал уведомлений Android. Своя цепочка знала
      // только опрос и голосовое, а всё остальное отдавала сырым конвертом:
      // '\x07loc:{"lat":…}' показывал точные координаты, '\x06doc:{…"cid":…}' —
      // ссылку на файл, '\x05contact:{…"pub":…}' — публичный ключ, а '\x09vo:'
      // — подпись одноразового сообщения, которая обязана исчезнуть после
      // просмотра. Подпись теперь общая для всего проекта (messagePreview.ts).
      const preview = previewLabelForText(env.text).slice(0, 80);
      for (const cb of groupMsgNotifyCallbacks) {
        try { cb(group.name, shownSenderName ?? (group.anonymousPosting ? 'Участник' : '?'), preview, env.groupId, kind, isMention, env.msgId); } catch { /* best effort */ }
      }
    }
  } catch (e) {
    // Likely duplicate — ignore UNIQUE constraint violations
    log.debug('group_msg_insert_skip', { err: e instanceof Error ? e.message : String(e) });
  }

  return true;
}

// ─── Join Requests ────────────────────────────────────────────────────────────

/** Protocol prefix for join-request signals sent to group admin via DM. */
export const GROUP_JOIN_REQUEST_PREFIX = '\x0agjr:';

export type GroupJoinRequestEnvelope = {
  groupId: string;
  groupName: string;
  requesterPubB64: string;
  requesterName: string;
  message?: string;
  /**
   * v4.32.303: токен из ссылки, по которой человек постучался. У заявки та же
   * ссылка на входе, что и у 'join', — значит и отзыв должен действовать на
   * обеих дорогах. Иначе отозванная ссылка перестала бы пускать в группу без
   * одобрения и продолжала бы приводить незнакомцев в список заявок.
   */
  inviteToken?: string;
  ts: number;
};

/**
 * Send a join request to the group admin.
 * Called by the requester when the group has requireApproval=true.
 */
export async function sendGroupJoinRequest(
  groupId: string,
  groupName: string,
  adminPubB64: string,
  requesterPubB64: string,
  requesterName: string,
  message?: string,
  inviteToken?: string
): Promise<FanoutResult> {
  const env: GroupJoinRequestEnvelope = {
    groupId,
    groupName,
    requesterPubB64,
    requesterName,
    message,
    ...(inviteToken ? { inviteToken } : {}),
    ts: Date.now(),
  };
  /**
   * v4.32.451: исход заявки возвращается наверх. Раньше отправка была void, и
   * «Запрос на вступление отправлен администратору» показывалось в том числе
   * когда отправлять было нечем. Хуже, чем просто неверная надпись: группы у
   * заявителя нет, повторить заявку ему неоткуда, а администратор ничего не
   * получил — человек ждёт ответа, которого никто не собирается давать.
   */
  const res = await fanoutControlEnvelope(
    'group_join_request',
    GROUP_JOIN_REQUEST_PREFIX + JSON.stringify(env),
    { kind: 'dm', peerPubB64: adminPubB64 }
  );
  if (res.sent) log.info('group_join_request_sent', { groupId: groupId.slice(0, 8) });
  return res;
}

/**
 * Собирает недостающие для acceptJoinRequest факты: «в контактах ли заявитель»
 * и «включена ли настройка “Добавление в группы — только контакты”».
 *
 * Вынесено отдельно, чтобы оба пути заявки (личный конверт '\x0agjr:' и
 * управляющий 'join') считали их одинаково. При ошибке чтения контактов или kv
 * возвращаются значения «фильтр не применять»: недоступная база не должна
 * молча превращаться в потерю заявок.
 */
async function joinRequestIntake(requesterPubB64: string, pid: number): Promise<{
  requesterIsContact: boolean;
  onlyContactsMayRequest: boolean;
}> {
  let requesterIsContact = false;
  let onlyContactsMayRequest = false;
  try {
    // v4.32.311: решение своё у каждого аккаунта, см. privacyPrefs.
    // v4.32.465: и спрашивается оно у того аккаунта, чьим ключом расшифрована
    // заявка, а не у того, чей экран открыт: между расшифровкой и этим местом
    // стоит сеть, и человек успевает переключиться.
    // v4.32.474: отказ чтения — не то же самое, что выключенный переключатель.
    // Осторожная сторона здесь — применить фильтр: заявку человек подаёт сам и
    // может подать ещё раз, а впустить незнакомца в обход просьбы «только
    // контакты» назад не отыграть.
    onlyContactsMayRequest = (await privacyPrefTryBoolFor(pid, 'privacy_only_contacts_group')) ?? true;
  } catch { onlyContactsMayRequest = true; }
  if (onlyContactsMayRequest) {
    try {
      const { listContactsFor } = await import('./contacts');
      requesterIsContact = (await listContactsFor(pid)).some((c) => c.peerPublicKey === requesterPubB64);
    } catch { onlyContactsMayRequest = false; }
  }
  return { requesterIsContact, onlyContactsMayRequest };
}

/**
 * Handle an incoming join request sent to us as group admin.
 * Returns true if handled so messaging layer skips normal DM storage.
 */
export async function handleIncomingGroupJoinRequest(text: string, rcpt: GroupRecipient, senderPubB64?: string): Promise<boolean> {
  if (!text.startsWith(GROUP_JOIN_REQUEST_PREFIX)) return false;
  // v4.32.197 (Round-27 #2): byte-cap before parse; no legitimate join-request
  // ever approaches 32 KB.
  // v4.32.507: потолок и разбор — через общий readEnvelopeBody (см. соседнюю
  // отметку о прочтении): своя копия не отсеивала массив и примитив.
  const env = readEnvelopeBody<GroupJoinRequestEnvelope>(text, GROUP_JOIN_REQUEST_PREFIX, 32 * 1024);
  if (!env) return true;
  try {
    // Конверт наш при любом исходе: false отдал бы служебный текст в
    // переписку как обычное сообщение.
    if (!env.groupId || !env.requesterPubB64 || !env.requesterName) return true;
    // v4.32.188 (Round-18 #6): cap untrusted string fields so a malicious
    // requester can't bloat SQLite with a multi-MB message or freeze the
    // admin UI rendering an emoji-bomb name.
    if (typeof env.groupId !== 'string' || env.groupId.length > 128) return true;
    if (typeof env.requesterPubB64 !== 'string' || env.requesterPubB64.length < 43 || env.requesterPubB64.length > 48) return true;
    // v4.32.239: имя заявителя админ видит не только в списке заявок — при
    // одобрении оно подставляется в системную строку «X вступил(а) в группу»
    // (GroupsScreen). Без вычистки control-символов перевод строки внутри
    // имени дорисовывал к ней вторую строку от имени приложения, а прислать
    // заявку может кто угодно по ссылке-приглашению.
    const requesterName = sanitizeDisplayName(env.requesterName);
    if (!requesterName) return true;
    env.requesterName = requesterName;
    if (env.message != null) {
      if (typeof env.message !== 'string') return true;
      env.message = env.message.slice(0, 512);
    }
    // v4.32.176: anti-spoof — requesterPubB64 должен совпадать с DM-отправителем,
    // иначе Mallory могла бы записать в env чужой pubkey, админ бы одобрил и
    // добавил Bob без его согласия.
    if (senderPubB64 && env.requesterPubB64 !== senderPubB64) {
      log.warn('group_join_request_spoof_drop', {
        env: env.requesterPubB64.slice(0, 12),
        signer: senderPubB64.slice(0, 12),
      });
      return true;
    }
    const pid = rcpt.pid;
    // Only store if we actually admin this group
    // v4.32.511: см. приём сообщения — архив не делает группу чужой, иначе
    // администратор терял заявки на вступление, пока группа скрыта.
    const grp = await getGroup(env.groupId, pid);
    if (!grp) return true; // not our group — consume silently
    /**
     * v4.32.512: «администратор ли я» спрашивается у group_members — той же
     * таблицы, по которой нас судят остальные участники. Колонку
     * `groups.is_admin` писал один только createGroup, повышение её не
     * трогало: назначенный администратор получал подпись и системную
     * строку, а заявки на вступление продолжал молча выбрасывать здесь.
     * Заявитель при этом не узнавал ничего — заявка ушла, ответа нет.
     *
     * Список участников всё равно читается ниже (проверка «знаком ли
     * заявитель»), так что запросов не прибавилось — он просто поднят выше.
     */
    const grpMembers = await listGroupMembers(env.groupId, pid);
    if (!isAdminRole(ownGroupRole(grpMembers, rcpt.myPub, !!grp.isAdmin))) return true;
    /**
     * v4.32.171: фильтр «Добавление в группы — только контакты» — чтобы
     * администратор не разбирал спам от незнакомцев.
     *
     * v4.32.264: решение переехало в acceptJoinRequest — тот же вызов делает
     * и управляющий конверт 'join'. До этого проверки на двух дорогах не
     * совпадали: здесь не было бана (забаненный доходил до списка заявок и
     * получал отказ только при нажатии «Принять»), а там — фильтра по
     * контактам.
     */
    const known = grpMembers.find((m) => m.peerPubB64 === env.requesterPubB64);
    /**
     * v4.32.303: отозванная ссылка не доводит и до списка заявок. Спрашиваем
     * только у незнакомого — уже состоящий в группе переспрашивать себя не
     * должен (см. тот же порядок в конверте 'join').
     *
     * Ответить заявителю нечем: группы у себя он не создавал (её создаёт лишь
     * путь без одобрения), и системную строку писать некуда. Ровно так же
     * молча отбрасываются заявки от забаненных и не-контактов.
     */
    if (
      known === undefined &&
      inviteTokenBlocks(
        decideInviteToken({
          knownToken: grp.inviteToken,
          knownUnreadable: grp.inviteTokenUnreadable,
          presented: env.inviteToken,
        })
      )
    ) {
      log.info('group_join_request_revoked_link', { from: env.requesterPubB64.slice(0, 8) });
      return true;
    }
    const intake = await joinRequestIntake(env.requesterPubB64, pid);
    if (!acceptJoinRequest({ knownRole: known?.role, ...intake })) {
      log.info('group_join_request_filtered', {
        from: env.requesterPubB64.slice(0, 8),
        reason: known?.role === 'banned' ? 'banned' : 'non_contact',
      });
      return true;
    }
    await insertGroupJoinRequest(env.groupId, env.requesterPubB64, env.requesterName, env.message ?? null, pid);
    log.info('group_join_request_received', { groupId: env.groupId.slice(0, 8), from: env.requesterPubB64.slice(0, 8) });
  } catch (e) {
    log.debug('group_join_request_parse_failed', { err: e instanceof Error ? e.message : String(e) });
  }
  return true;
}

// ─── Group control envelopes (синхронизация ролей и настроек) ────────────────

// Кодек и валидация конверта живут в отдельном модуле без импортов —
// см. groupControlEnvelope.ts. Здесь только применение к локальной БД.
import {
  GROUP_CTL_PREFIX,
  encodeGroupCtlEnvelope,
  decodeGroupCtlEnvelope,
  type GroupCtlOp,
  type GroupCtlEnvelope,
} from './groupControlEnvelope';
import { FALLBACK_GROUP_NAME, normalizeOwnGroupName } from './groupNameRule';

import { GROUP_SYS_PREFIX } from './groupSysLine';
import { decideJoin, acceptJoinRequest } from './groupJoinPolicy';
import { decideInviteToken, inviteTokenBlocks, isInviteToken } from './groupInviteToken';

export { GROUP_CTL_PREFIX, encodeGroupCtlEnvelope, decodeGroupCtlEnvelope };
export type { GroupCtlOp, GroupCtlEnvelope };

/**
 * Префикс системных сообщений группы. v4.32.258: раньше здесь стояла своя
 * копия литерала — с объяснением, что core не должен импортировать UI. Вывод
 * был неверный: общее значение переехало в core/social/groupSysLine, откуда
 * его видят обе стороны без цикла.
 */
const CTL_SYS_PREFIX = GROUP_SYS_PREFIX;

/**
 * Разослать управляющий конверт участникам группы.
 *
 * Адресат операции (target) получает конверт ВСЕГДА, даже если он уже помечен
 * banned или удалён из members: иначе разбаненный никогда не узнал бы, что его
 * разбанили, а забаненный продолжал бы писать в пустоту.
 */
export async function fanoutGroupControl(
  groupId: string,
  /**
   * Профиль, чей состав рассылать (v4.32.466). Параметром, а не запросом к
   * активному профилю: состав группы у каждого аккаунта свой, а отправку
   * начинает экран, который про свой профиль знает точно. Своей копии «взять
   * службу переписки» здесь по-прежнему нет — этим ведает воронка.
   */
  ownerProfileId: number,
  senderPubB64: string,
  ctl: GroupCtlOp,
  actorName?: string
): Promise<GroupControlOutcome> {
  const payload = encodeGroupCtlEnvelope({ ...ctl, groupId, ts: Date.now(), actorName } as GroupCtlEnvelope);
  const members = await listGroupMembers(groupId, ownerProfileId);
  // Правило адресатов остаётся здесь: оно своё у управляющих конвертов группы
  // (адресат операции получает конверт даже забаненным). Отправкой же ведает
  // общая воронка — своей копии «есть ли сервис / поймать исключение» тут
  // больше нет.
  const recipients = new Set(activeRecipients(members, senderPubB64));
  if ('target' in ctl && ctl.target && ctl.target !== senderPubB64) recipients.add(ctl.target);

  const res = await fanoutControlEnvelope(`group_ctl_${ctl.op}`, payload, {
    kind: 'group',
    recipients: [...recipients],
  });
  log.info('group_ctl_fanout', { gid: groupId.slice(0, 8), op: ctl.op, to: recipients.size });
  return res.sent
    ? { op: ctl.op, sent: true, recipients: res.recipients }
    : { op: ctl.op, sent: false, reason: res.reason };
}

/**
 * Отправить управляющий конверт адресно, а не всей группе.
 *
 * v4.32.266: ответ на заявку ('joinres') касается двоих — администратора и
 * заявителя. Через fanoutGroupControl он ушёл бы всем участникам, то есть
 * группа узнавала бы, кому отказали. Заявитель к тому же может не быть
 * участником, и рассылка «по участникам» до него бы просто не дошла.
 */
export async function sendGroupControlTo(
  recipients: string[],
  groupId: string,
  ctl: GroupCtlOp,
  actorName?: string
): Promise<GroupControlOutcome> {
  const payload = encodeGroupCtlEnvelope({ ...ctl, groupId, ts: Date.now(), actorName } as GroupCtlEnvelope);
  const res = await fanoutControlEnvelope(`group_ctl_direct_${ctl.op}`, payload, {
    kind: 'group',
    recipients,
  });
  if (res.sent) log.info('group_ctl_direct_sent', { gid: groupId.slice(0, 8), op: ctl.op, to: res.recipients });
  // Операция вшивается в исход здесь, а не у вызывающего: иначе отказ ответа
  // на заявку можно было бы по недосмотру объявить отказом чего-то другого.
  return res.sent
    ? { op: ctl.op, sent: true, recipients: res.recipients }
    : { op: ctl.op, sent: false, reason: res.reason };
}

/**
 * Токен группы вместе с исходом рассылки его остальным администраторам
 * (v4.32.452).
 *
 * Две вещи в одном ответе потому, что порознь их теряли: функция отдавала
 * только токен, а «сообщили ли о нём другим администраторам» гасилось внутри.
 * Цена молчания здесь та же, что у самого отзыва ссылки: у второго
 * администратора остаётся прежний токен, его кнопка «Пригласительная ссылка»
 * продолжает выдавать ссылки, которые группа уже не пускает, — и узнать об
 * этом ему неоткуда.
 */
export type InviteTokenResult = {
  /** Действующий токен группы — он же записан в БД. */
  token: string;
  /** Итог рассылки; null — токен не менялся, рассылать было нечего. */
  announced: GroupControlOutcome | null;
};

/**
 * v4.32.303: новый токен пригласительной ссылки — и рассылка его остальным
 * администраторам.
 *
 * Рассылка адресная и только администраторам. Обычному участнику токен даёт
 * ровно то, чего у него нет: возможность собрать действующую ссылку в группу.
 * Раздать его всем «за компанию» значило бы сделать отзыв бессмысленным — с
 * тем же успехом можно было бы не заводить токен вовсе.
 *
 * Без рассылки было бы хуже, чем без токена: у каждого администратора завёлся
 * бы свой, и ссылки одного отвергались бы приложением другого — то есть
 * «Пригласительная ссылка» у второго админа перестала бы работать.
 *
 * @returns новый токен и исход рассылки его остальным администраторам.
 */
export async function rotateGroupInviteToken(
  groupId: string,
  ownerProfileId: number,
  myPubB64: string,
  myName?: string
): Promise<InviteTokenResult> {
  const { randomBytes } = await import('@noble/hashes/utils.js');
  const { makeInviteToken } = await import('./groupInviteToken');
  const token = makeInviteToken(randomBytes);
  await updateGroupMeta(groupId, ownerProfileId, { inviteToken: token });
  const admins = (await listGroupMembers(groupId, ownerProfileId))
    .filter((m) => (m.role === 'owner' || m.role === 'admin') && m.peerPubB64 !== myPubB64)
    .map((m) => m.peerPubB64);
  // v4.32.452: пустой список администраторов — законный случай (я единственный),
  // и воронка отвечает на него «разослано нулю», а не отказом. Прежний guard
  // `if (admins.length)` тут больше не нужен, а исход рассылки перестал
  // теряться внутри: он уходит наверх вместе с токеном.
  const announced = await sendGroupControlTo(admins, groupId, { op: 'meta', inviteToken: token }, myName);
  log.info('group_invite_token_rotated', { gid: groupId.slice(0, 8), admins: admins.length });
  return { token, announced };
}

/**
 * Токен группы, создавая его при необходимости.
 *
 * Нужен для групп, созданных до v4.32.303: у них колонка пустая, и без этого
 * «Пригласительная ссылка» выдавала бы ссылку без токена — то есть такую,
 * которую нечем отозвать. Первое же нажатие после обновления заводит токен и
 * сообщает его остальным администраторам.
 *
 * Плата за это названа честно: ссылки, разосланные из старой версии, токена не
 * несут и с этого момента перестают пускать в группу. Отозвать их иначе было
 * невозможно — в том и была дыра.
 *
 * Токен читается из БД, а не из переданной строки группы: экран держит её
 * копию в состоянии, и после сброса она осталась бы со старым значением — то
 * есть следующая кнопка выдала бы ссылку с уже отозванным токеном.
 */
export async function ensureGroupInviteToken(
  groupId: string,
  ownerProfileId: number,
  myPubB64: string,
  myName?: string
): Promise<InviteTokenResult | null> {
  const fresh = await getGroup(groupId, ownerProfileId);
  // v4.32.437: null от getGroup — это ДВА разных случая: такой группы у
  // профиля нет и группу не удалось прочитать (getGroup гасит любую ошибку
  // чтения). Прежде оба вели к рождению нового токена, и это была тихая
  // потеря: все уже разосланные ссылки переставали пускать в группу, а
  // администратор об этом не узнавал — кнопка отдавала свежую ссылку как ни в
  // чём не бывало. Второй случай хуже первого: запись нового токена шла в
  // ноль строк, то есть выданная ссылка не сверялась бы ни с чем.
  // Новый токен рождается только после успешного чтения группы.
  if (!fresh) {
    log.warn('group_invite_token_group_unreadable', { gid: groupId.slice(0, 8) });
    return null;
  }
  // v4.32.601: столбец с токеном есть, но ключом данных не открывается.
  // Прежде отсюда шёл rotateGroupInviteToken: настоящий токен затирался новым
  // — необратимо, тот же запрет, что у реакций в v4.32.544, — и все уже
  // разосланные ссылки переставали пускать в группу, а администратор получал
  // обычную свежую ссылку и не узнавал ни о чём.
  if (fresh.inviteTokenUnreadable) {
    log.warn('group_invite_token_unreadable', { gid: groupId.slice(0, 8) });
    return null;
  }
  // announced: null — не отказ, а «рассылать было нечего»: токен не менялся.
  if (isInviteToken(fresh.inviteToken)) return { token: fresh.inviteToken, announced: null };
  return rotateGroupInviteToken(groupId, ownerProfileId, myPubB64, myName);
}

/**
 * Ключ kv-маркера «мы сами попросились в эту группу»: значение — публичный
 * ключ администратора, которому ушла заявка. Позволяет принять его
 * приглашение даже если он не в наших контактах: мы первыми к нему обратились.
 */
export const INVITE_PENDING_KEY_PREFIX = 'grp_invite_pending_';

/**
 * Можно ли принять приглашение в неизвестную нам группу от этого отправителя.
 *
 * Два законных случая: (1) мы сами отправляли заявку на вступление именно
 * этому администратору; (2) отправитель — наш контакт. Незнакомцы отсекаются,
 * если включена настройка «Добавление в группы — только контакты».
 */
async function isInviteTrusted(groupId: string, senderPubB64: string, rcpt: GroupRecipient): Promise<boolean> {
  try {
    if ((await profileKvGet(rcpt.pid, INVITE_PENDING_KEY_PREFIX + groupId)) === senderPubB64) return true;
  } catch { /* ignore */ }
  try {
    const { listContactsFor } = await import('./contacts');
    const contacts = await listContactsFor(rcpt.pid);
    if (contacts.some((c) => c.peerPublicKey === senderPubB64)) return true;
  } catch { /* ignore */ }
  // v4.32.312: решение своё у каждого аккаунта, см. privacyPrefs. Чтение по
  // старому общему имени возвращало здесь пустоту — то есть «только контакты»
  // переставало работать ровно на приглашениях от незнакомцев.
  //
  // v4.32.474: то же самое делал отказ базы — он приходил сюда как «выключено»,
  // и приглашение незнакомца становилось доверенным. Не прочитали — не доверяем:
  // приглашение можно прислать повторно, а добавление в чужую группу человек
  // увидит уже случившимся.
  return (await privacyPrefTryBoolFor(rcpt.pid, 'privacy_only_contacts_group')) === false;
}

/**
 * Отправить приглашение в группу тем, у кого её ещё нет.
 *
 * Нужно потому, что раньше выбор контактов при создании группы был чистой
 * декорацией: участники записывались только в БД создателя, их устройства о
 * группе не знали, и входящие сообщения отбрасывались как «unknown_group».
 * Тот же конверт закрывает вторую дыру — одобренный заявитель наконец узнаёт,
 * что его приняли (до этого «Одобрить» не отправляло ему вообще ничего).
 */
export async function sendGroupInvite(
  groupId: string,
  groupName: string,
  groupType: 'group' | 'channel' | 'supergroup',
  members: { pub: string; name?: string | null }[],
  recipients: string[],
  actorName?: string
): Promise<GroupControlOutcome> {
  // v4.32.246: аватар берём из своей же строки группы, а не параметром, — иначе
  // пришлось бы править все вызовы, а приглашённый до сих пор видел бы кружок
  // с буквой, пока админ не изменит какую-нибудь настройку.
  let avatarCid: string | undefined;
  try {
    const pid = profileManager.getActiveProfile()?.id ?? 1;
    avatarCid = (await getGroup(groupId, pid))?.avatarCid ?? undefined;
  } catch { /* без аватара приглашение всё равно уходит */ }
  // v4.32.379: последняя остановка перед отправкой. Разбор приглашения требует
  // непустого названия и отбрасывает конверт целиком, если его нет, — а
  // названия, набранные до этой версии, чистку не проходили. Уйди такое имя как
  // есть, приглашение молча пропало бы у всех приглашённых: группа у них не
  // завелась бы, а их сообщения отбрасывались бы как «неизвестная группа» —
  // ровно то, что чинили в v4.32.231.
  const payload = encodeGroupCtlEnvelope({
    op: 'invite',
    groupId,
    groupName: normalizeOwnGroupName(groupName) || FALLBACK_GROUP_NAME,
    groupType,
    members: members.slice(0, 200),
    avatarCid,
    ts: Date.now(),
    actorName,
  });
  const res = await fanoutControlEnvelope('group_invite', payload, { kind: 'group', recipients });
  if (res.sent) log.info('group_invite_sent', { gid: groupId.slice(0, 8), to: res.recipients });
  return res.sent
    ? { op: 'invite', sent: true, recipients: res.recipients }
    : { op: 'invite', sent: false, reason: res.reason };
}

/** Записать системное сообщение группы с детерминированным id (INSERT OR IGNORE ⇒ повтор безопасен). */
async function insertCtlSysMessage(env: GroupCtlEnvelope, pid: number, event: string): Promise<void> {
  const key = 'target' in env && env.target ? env.target.slice(0, 12) : 'meta';
  // v4.32.239: время берётся из чужого конверта, а сортировка переписки идёт по
  // created_at. Без ограничения ts из 2100 года навсегда прибивал системную
  // строку к низу группы — и убрать её было нечем, потому что удалять
  // системные строки интерфейс не даёт. Границы те же, что у обычного
  // сообщения группы (см. handleIncomingGroupEnvelope): неделя назад — пять
  // минут вперёд, чтобы расхождение часов между устройствами не мешало.
  const createdAt = clampEnvelopeTs(env.ts);
  try {
    await insertGroupMessage({
      id: `ctl-${env.groupId}-${env.ts}-${env.op}-${key}`,
      groupId: env.groupId,
      senderPubB64: '',
      senderName: null,
      text: CTL_SYS_PREFIX + event,
      mediaCids: null,
      replyToId: null,
      replyToPreview: null,
      reactions: null,
      createdAt,
      ownerProfileId: pid,
    });
  } catch { /* дубликат — не страшно */ }
}

/**
 * Применить входящий управляющий конверт.
 *
 * Модель доверия: отправитель обязан быть owner/admin В НАШЕЙ собственной БД.
 * Мы не верим конверту на слово — роль берётся из локальной таблицы
 * group_members, которая заполняется при создании группы или при вступлении по
 * ссылке-приглашению (App.tsx помечает автора приглашения как 'admin').
 * Дополнительно: владельца группы нельзя ни разжаловать, ни забанить, а
 * обычный админ не может трогать другого админа — только владелец.
 *
 * Возвращает true, если конверт наш (тогда messaging.ts не сохраняет его как DM).
 */
export async function handleIncomingGroupControl(text: string, rcpt: GroupRecipient, senderPubB64?: string): Promise<boolean> {
  if (!text.startsWith(GROUP_CTL_PREFIX)) return false;
  const env = decodeGroupCtlEnvelope(text);
  if (!env || !senderPubB64) return true;

  const pid = rcpt.pid;
  // v4.32.511: по идентификатору, а не выбором из списка активных групп. От
  // этой строки зависит вся защита ветки 'invite' ниже, а `listGroups` отдаёт
  // только `archived = 0`: собственная группа, убранная в архив, читалась как
  // незнакомая — и приглашение в неё применялось целиком. Любой контакт,
  // знающий id, переписывал этим состав и роли: себя администратором, хозяина
  // группы рядовым участником.
  const group = await getGroup(env.groupId, pid);

  // 'invite' — единственная операция, применимая к ЕЩЁ НЕ ИЗВЕСТНОЙ группе,
  // поэтому её разбор идёт до проверки «знаем ли мы такую группу».
  if (env.op === 'invite') {
    if (group) return true; // уже состоим — приглашение идемпотентно
    if (!(await isInviteTrusted(env.groupId, senderPubB64, rcpt))) {
      log.warn('group_ctl_invite_untrusted_drop', { gid: env.groupId.slice(0, 8), from: senderPubB64.slice(0, 12) });
      return true;
    }
    const myPub = rcpt.myPub;
    const myName = (await getOwnDisplayNameFor(pid)) ?? 'Вы';
    // isAdmin=false — приглашённый не администратор (см. createGroup).
    await createGroup(env.groupId, pid, env.groupName, env.groupType ?? 'group', undefined, false);
    // Пригласивший — администратор: именно его ctl-конверты мы будем принимать.
    // v4.32.371: `|| null`, а не `?? null`. Разбор конверта отдаёт пустую
    // строку там, где имя ничего не рисует, и через `??` она доезжала до
    // списка участников как полноценное имя — участник без подписи, которого
    // не отличить от соседнего такого же.
    await upsertGroupMember({ groupId: env.groupId, peerPubB64: senderPubB64, role: 'admin', displayName: env.actorName || null, joinedAt: env.ts, ownerProfileId: pid });
    for (const m of env.members) {
      if (m.pub === senderPubB64 || m.pub === myPub) continue;
      await upsertGroupMember({ groupId: env.groupId, peerPubB64: m.pub, role: 'member', displayName: m.name || null, joinedAt: env.ts, ownerProfileId: pid });
    }
    if (myPub) await upsertGroupMember({ groupId: env.groupId, peerPubB64: myPub, role: 'member', displayName: myName, joinedAt: env.ts, ownerProfileId: pid });
    // v4.32.267: считаем по только что записанным строкам, а не по env.members:
    // приглашение от создателя группы список себя не содержит, приглашение
    // одобренному заявителю — содержит (там снимок group_members админа
    // целиком), а дубли в списке никого не удивят. Строки уже разложены выше —
    // они и есть ответ.
    await recountGroupMembers(env.groupId, pid);
    if (env.avatarCid) await updateGroupMeta(env.groupId, pid, { avatarCid: env.avatarCid });
    await insertCtlSysMessage(env, pid, `${env.actorName || 'Администратор'} добавил(а) вас в группу`);
    await kvDeleteScoped(pid, INVITE_PENDING_KEY_PREFIX + env.groupId);
    log.info('group_ctl_invite_applied', { gid: env.groupId.slice(0, 8), members: env.members.length });
    return true;
  }

  if (!group) {
    log.debug('group_ctl_unknown_group', { gid: env.groupId.slice(0, 8) });
    return true;
  }

  const members = await listGroupMembers(env.groupId, pid);
  /**
   * v4.32.512: свои права — из своей строки в group_members, а не из
   * `groups.is_admin`. Флаг ставился один раз при создании группы и дальше не
   * менялся никогда, поэтому повышенный администратор здесь оставался рядовым
   * участником: не пересказывал вступивших остальным (и новичка не видела
   * половина группы), не отвечал отказом по отозванной ссылке, не принимал
   * сброс пригласительной ссылки. Флаг остаётся запасным ответом на случай
   * пустого списка — например, у группы, созданной до появления своей строки.
   */
  const storedAdmin = !!group.isAdmin;
  const iAmAdmin = isAdminRole(ownGroupRole(members, rcpt.myPub, storedAdmin));

  /**
   * v4.32.231 (CRIT): 'join' — самопредставление вступившего по ссылке.
   *
   * Приглашённый создавал группу у себя и записывал участников из ссылки, но
   * САМ НИКОМУ О СЕБЕ НЕ СООБЩАЛ — его не было ни в одной чужей таблице
   * group_members. А анти-спуф-фильтр входящих (добавлен в 4.32.175) дропает
   * сообщения от не-участников. Итог: вступление по ссылке «работало», но все
   * сообщения новичка молча выбрасывались на каждом устройстве группы.
   *
   * Единственная операция без проверки прав администратора — представить можно
   * только себя (target === отправитель), и только в уже известную нам группу.
   */
  if (env.op === 'join') {
    if (env.target !== senderPubB64) {
      log.warn('group_ctl_join_spoof_drop', { env: env.target.slice(0, 12), signer: senderPubB64.slice(0, 12) });
      return true;
    }
    const knownRole = members.find((m) => m.peerPubB64 === senderPubB64)?.role;
    /**
     * v4.32.303: отзыв ссылки. Токен спрашивается только у НОВОГО человека —
     * это входной билет, а не пропуск, который предъявляют каждый раз. Уже
     * известный участник переспрашивается регулярно (переустановка, повторное
     * представление), и его старый токен не должен ничего значить: иначе сброс
     * ссылки выбрасывал бы из группы тех, кто давно в ней состоит.
     *
     * Своего токена нет — 'unenforceable', и всё решает decideJoin, как и
     * раньше: у групп, созданных до этой версии, сверять не с чем, а у обычных
     * участников токена нет никогда.
     */
    if (knownRole === undefined) {
      const tokenVerdict = decideInviteToken({
        knownToken: group.inviteToken,
        knownUnreadable: group.inviteTokenUnreadable,
        presented: env.inviteToken,
      });
      if (inviteTokenBlocks(tokenVerdict)) {
        // Молча уронить — значит отправить человека в ту же немоту, из-за
        // которой в v4.32.266 завели 'joinres': у себя он группу уже создал и
        // видит «Вы добавлены», пишет в неё, а его сообщения выбрасывает
        // анти-спуф-фильтр у каждого — без единого признака, в чём дело.
        if (iAmAdmin) {
          const myPubRv = rcpt.myPub;
          if (myPubRv) {
            const myNameRv = (await getOwnDisplayNameFor(pid)) ?? undefined;
            void sendGroupControlTo(
              [senderPubB64],
              env.groupId,
              { op: 'joinres', target: senderPubB64, status: 'revoked', targetName: env.targetName },
              myNameRv
            );
          }
        }
        log.info('group_ctl_join_revoked_drop', {
          gid: env.groupId.slice(0, 8),
          from: senderPubB64.slice(0, 12),
          verdict: tokenVerdict,
        });
        return true;
      }
    }
    /**
     * v4.32.259 (CRIT): гейт «Вход по ссылке требует одобрения» проверяет
     * принимающий, а не ссылка. Решение целиком в decideJoin — см. пояснение
     * дыры в groupJoinPolicy.ts.
     */
    // v4.32.264: фильтр «только контакты» действует и здесь — иначе настройку
    // приватности обходила та же правка ссылки, что и сам гейт одобрения.
    const verdict = decideJoin({
      knownRole,
      requireApproval: !!group.requireApproval,
      iAmAdmin,
      ...(group.requireApproval && iAmAdmin ? await joinRequestIntake(senderPubB64, pid) : {}),
    });
    if (verdict === 'banned') {
      // Бан держится: забаненный не вернётся, просто переслав себе ссылку.
      log.info('group_ctl_join_banned_drop', { gid: env.groupId.slice(0, 8) });
      return true;
    }
    if (verdict === 'ignore') return true;
    if (verdict === 'queue') {
      // Дедуп по (group_id, requester, pending): повторное открытие ссылки не
      // наплодит заявок.
      // v4.32.372: имя в заявке задаёт тот, кто просится, и пустым оно быть
      // может. `?? null` его пропускал, а список заявок рисует первую букву
      // как `(requesterName ?? '?')[0]` — у пустой строки это undefined, и
      // экран заявок у администратора не открывался вовсе.
      const queued = await insertGroupJoinRequest(env.groupId, senderPubB64, displayNameOrNull(env.targetName), null, pid);
      /**
       * v4.32.266: и сразу отвечаем заявителю — но только на первую заявку,
       * иначе каждое повторное открытие ссылки дописывало бы ему ещё одну
       * строку «ждём одобрения». Он открыл ссылку, выданную до
       * включения одобрения, поэтому у себя уже создал группу и увидел «Вы
       * добавлены». Без ответа он пишет в группу, а его сообщения выбрасывает
       * анти-спуф-фильтр на каждом устройстве — молча и без единого признака,
       * что дело в неодобренной заявке.
       */
      const myPubQ = queued.created ? rcpt.myPub : '';
      if (myPubQ) {
        const myNameQ = (await getOwnDisplayNameFor(pid)) ?? undefined;
        void sendGroupControlTo(
          [senderPubB64],
          env.groupId,
          { op: 'joinres', target: senderPubB64, status: 'pending', targetName: env.targetName },
          myNameQ
        );
      }
      log.info('group_ctl_join_queued', { gid: env.groupId.slice(0, 8), from: senderPubB64.slice(0, 12) });
      return true;
    }
    await upsertGroupMember({
      groupId: env.groupId,
      peerPubB64: senderPubB64,
      role: 'member',
      // v4.32.372: пустое имя — это отсутствие имени, иначе у участника
      // группы `displayName` перестаёт быть `string | null` по смыслу и все
      // `?? 'Участник'` ниже по течению молча ломаются.
      displayName: displayNameOrNull(env.targetName),
      joinedAt: env.ts,
      ownerProfileId: pid,
    });
    await recountGroupMembers(env.groupId, pid);
    await insertCtlSysMessage(env, pid, `${env.targetName || 'Участник'} вступил(а) в группу`);
    /**
     * v4.32.262: администратор пересказывает вступление остальным.
     *
     * Вступивший по ссылке рассылает 'join' только тем, кого несла ссылка, —
     * а она несёт не больше 20 участников. В группе из тридцати оставшиеся
     * десять о новичке не узнают, и анти-спуф-фильтр входящих молча
     * выбрасывает у них КАЖДОЕ его сообщение: он пишет, ему отвечает часть
     * группы, и понять, почему остальные молчат, невозможно.
     *
     * Конверт 'add' от администратора — ровно тот же путь, каким расходится
     * одобренная заявка. Он идемпотентен (уже известный участник отбрасывается
     * на приёме), поэтому повтор от второго администратора безвреден.
     */
    if (iAmAdmin) {
      const myPubAdd = rcpt.myPub;
      if (myPubAdd) {
        const myNameAdd = (await getOwnDisplayNameFor(pid)) ?? undefined;
        // v4.32.266: самому вступившему пересказ не нужен — он о себе и так
        // знает. Важнее другое: 'add' про себя, пришедший уже состоящему в
        // группе, теперь означает ровно одно — «заявку одобрили», и по нему
        // пишется системная строка. Пересылка новичку сделала бы эту строку
        // ложной у каждого, кто вошёл по ссылке без всякого одобрения.
        void sendGroupControlTo(
          members
            .filter((m) => m.role !== 'banned' && m.peerPubB64 !== senderPubB64 && m.peerPubB64 !== myPubAdd)
            .map((m) => m.peerPubB64),
          env.groupId,
          { op: 'add', target: senderPubB64, targetName: env.targetName },
          myNameAdd
        );
      }
    }
    log.info('group_ctl_join_applied', { gid: env.groupId.slice(0, 8), from: senderPubB64.slice(0, 12) });
    return true;
  }

  /**
   * v4.32.268: «я вышел из группы» — вторая и последняя операция без проверки
   * прав администратора, по тем же правилам, что и 'join': выйти можно только
   * самому. Забаненного она НЕ трогает: строка с role='banned' — чёрный список
   * группы, и удалить её «выходом» значило бы снимать с себя бан одной кнопкой
   * и возвращаться по любой ссылке.
   */
  if (env.op === 'leave') {
    if (env.target !== senderPubB64) {
      log.warn('group_ctl_leave_spoof_drop', { env: env.target.slice(0, 12), signer: senderPubB64.slice(0, 12) });
      return true;
    }
    const leaver = members.find((m) => m.peerPubB64 === senderPubB64);
    if (!leaver || leaver.role === 'banned') return true;
    await removeGroupMember(env.groupId, senderPubB64, pid);
    await recountGroupMembers(env.groupId, pid);
    // v4.32.372: через `??` пустое имя из конверта вытесняло и подпись из
    // списка участников, и «Участник» — оставалась строка « покинул(а) группу».
    await insertCtlSysMessage(env, pid, `${env.targetName || leaver.displayName || 'Участник'} покинул(а) группу`);
    log.info('group_ctl_leave_applied', { gid: env.groupId.slice(0, 8), from: senderPubB64.slice(0, 12) });
    return true;
  }

  const actor = members.find((m) => m.peerPubB64 === senderPubB64);

  /**
   * v4.32.232: правка и удаление сообщения в группе тоже никуда не уходили —
   * автор правил текст только у себя, а «Удалить» у администратора чистило
   * только его собственную БД. У остальных оставалась исходная версия.
   *
   * Права здесь не ролевые, а по авторству строки, поэтому ветка идёт до
   * общей проверки «отправитель — администратор»: править можно только своё,
   * удалять — своё либо (для админа) любое.
   *
   * v4.32.275: само правило вынесено в canApplyGroupMessageOp. Здесь оно было
   * неполным — кроме авторства смотрели только на бан, — а правка означает
   * публикацию нового текста в историю всей группы, то есть требует того же
   * права, что и отправка. Отправляющая сторона его и проверяет, получающая не
   * проверяла: молчащий участник переписывал своё старое сообщение и говорил
   * группе что угодно.
   */
  if (env.op === 'edit' || env.op === 'del') {
    // v4.32.342: сообщение обязано лежать именно в той группе, которую назвал
    // конверт. Права считались по env.groupId, а правилось и удалялось по
    // env.msgId, и связи между ними не было никакой: администратор своей группы
    // стирал или переписывал любое сообщение в любой чужой, зная только его id.
    const target = await getGroupMessageTarget(env.msgId, pid);
    if (target == null || target.groupId !== env.groupId) {
      log.debug('group_ctl_msgop_unknown_msg', { msgId: env.msgId.slice(0, 8) });
      return true;
    }
    const author = target.senderPubB64;
    const verdict = canApplyGroupMessageOp({
      op: env.op,
      role: roleOf(members, senderPubB64),
      isAuthor: author === senderPubB64,
      type: group.type,
      adminOnlyPosting: !!group.adminOnlyPosting,
      media: env.op === 'edit' ? mediaKindOfText(env.text) : 'text',
    });
    if (!verdict.allowed) {
      log.warn('group_ctl_msgop_denied', {
        op: env.op,
        gid: env.groupId.slice(0, 8),
        from: senderPubB64.slice(0, 12),
        code: verdict.code,
      });
      return true;
    }
    if (env.op === 'edit') {
      // v4.32.530: правка могла не примениться (нет строки, сбой базы). Тогда
      // это не «применено» — иначе в журнале успех, а у человека старый текст.
      const applied = await updateGroupMessageText(env.msgId, env.text, pid);
      if (!applied) {
        log.warn('group_ctl_edit_not_applied', {
          gid: env.groupId.slice(0, 8),
          msgId: env.msgId.slice(0, 8),
        });
        return true;
      }
    } else await deleteGroupMessage(env.msgId, pid);
    log.info('group_ctl_msgop_applied', { op: env.op, gid: env.groupId.slice(0, 8) });
    return true;
  }

  /**
   * v4.32.233: закрепление тоже жило только в своём kv. Право проверяется не
   * ролью напрямую, а canPinInGroup — настройка группы adminOnlyPinning может
   * отдать закрепление всем участникам, — поэтому ветка идёт до общей проверки
   * «отправитель — администратор».
   */
  if (env.op === 'pin') {
    if (!actor || actor.role === 'banned') {
      log.warn('group_ctl_pin_not_member_drop', { gid: env.groupId.slice(0, 8), from: senderPubB64.slice(0, 12) });
      return true;
    }
    const { canPinInGroup } = await import('./groupPinPolicy');
    if (!canPinInGroup({ role: actor.role, adminOnlyPinning: group.adminOnlyPinning, type: group.type })) {
      log.warn('group_ctl_pin_denied', { gid: env.groupId.slice(0, 8), from: senderPubB64.slice(0, 12), role: actor.role });
      return true;
    }
    // Текст баннера берётся из своей строки group_messages, а не из конверта:
    // иначе закрепление стало бы способом показать группе произвольный текст.
    // Неизвестное сообщение просто выпадет при resolvePinned.
    //
    // v4.32.342: и сообщение из другой группы — тоже отказ. Иначе баннер группы
    // заполнялся текстом сообщения из чужой переписки: у каждого получателя
    // resolvePinned берёт текст по id из его собственной БД, и тем, кто состоит
    // в обеих группах, показывалось бы содержимое второй.
    const pinTarget = await getGroupMessageTarget(env.msgId, pid);
    if (pinTarget == null || pinTarget.groupId !== env.groupId) {
      log.debug('group_ctl_pin_unknown_msg', { msgId: env.msgId.slice(0, 8) });
      return true;
    }
    const { applyLocalPin } = await import('./groupPinSync');
    await applyLocalPin({ groupId: env.groupId, ownerProfileId: pid, msgId: env.msgId, on: env.on });
    await insertCtlSysMessage(env, pid, env.on ? 'Сообщение закреплено' : 'Сообщение откреплено');
    log.info('group_ctl_pin_applied', { gid: env.groupId.slice(0, 8), on: env.on });
    return true;
  }

  if (!actor || (actor.role !== 'owner' && actor.role !== 'admin')) {
    log.warn('group_ctl_not_admin_drop', { gid: env.groupId.slice(0, 8), from: senderPubB64.slice(0, 12) });
    return true;
  }

  // v4.32.371: `||` вместо `??` — иначе имя, ничего не рисующее на экране,
  // вытесняет и подпись из списка участников, и слово «Администратор», и
  // системная строка получается без действующего лица вовсе.
  const actorLabel = env.actorName || actor.displayName || 'Администратор';

  /**
   * v4.32.266: ответ на нашу заявку. Приходит только тому, о ком он, — но
   * проверяем и здесь: конверт мог долететь и до другого участника.
   */
  if (env.op === 'joinres') {
    const myPubR = rcpt.myPub;
    if (!myPubR || env.target !== myPubR) return true;
    await insertCtlSysMessage(
      env,
      pid,
      env.status === 'pending'
        ? 'Заявка на вступление ждёт одобрения администратора. Пока её не одобрят, ваших сообщений в группе не увидят.'
        : env.status === 'revoked'
          // v4.32.303: ссылку отозвали. Человек ни в чём не виноват и заявки не
          // подавал — сказать ему «вам отказали» было бы неправдой.
          ? 'Ссылка-приглашение больше не действует. Попросите у администратора новую.'
          : `${actorLabel} отклонил(а) заявку на вступление`
    );
    log.info('group_ctl_joinres_applied', { gid: env.groupId.slice(0, 8), status: env.status });
    return true;
  }

  if (env.op === 'meta') {
    const patch: Parameters<typeof updateGroupMeta>[2] = {};
    const events: string[] = [];
    // v4.32.577: своё название могло не открыться ключом данных — тогда оно
    // приходит сюда пустой строкой, и ЛЮБОЕ присланное название выглядит как
    // переименование. Строку в истории пишем только там, где было с чем
    // сравнивать; само название применяем в обоих случаях — оно приехало от
    // участника группы и лечит нечитаемый столбец. См. groupMetaEvents.
    const nameDecision = decideMetaField(env.name, group.name, group.nameUnreadable);
    if (nameDecision.apply && env.name != null) {
      patch.name = env.name;
      if (nameDecision.announce) events.push(`Группа переименована в «${env.name}»`);
      else log.warn('group_meta_name_unreadable', { gid: env.groupId.slice(0, 8) });
    }
    // v4.32.579: описание — тем же решением, что название и аватар. Пока
    // непрочитанный столбец приходил пустой строкой, присланное пустое
    // описание считалось совпадающим и столбец не лечился никогда.
    const descDecision = decideMetaField(env.description, group.description ?? '', group.descriptionUnreadable);
    if (descDecision.apply && env.description != null) {
      patch.description = env.description;
      if (!descDecision.announce) log.warn('group_meta_desc_unreadable', { gid: env.groupId.slice(0, 8) });
    }
    // v4.32.246: до этой версии аватар группы вообще не рассылался — его видел
    // только тот администратор, который его поставил. Форму CID проверил кодек.
    const avatarDecision = decideMetaField(env.avatarCid, group.avatarCid ?? '', group.avatarCidUnreadable);
    if (avatarDecision.apply && env.avatarCid != null) {
      patch.avatarCid = env.avatarCid;
      if (avatarDecision.announce) events.push('Аватар группы обновлён');
      else log.warn('group_meta_avatar_unreadable', { gid: env.groupId.slice(0, 8) });
    }
    if (env.adminOnlyPosting != null && env.adminOnlyPosting !== group.adminOnlyPosting) {
      patch.adminOnlyPosting = env.adminOnlyPosting;
      events.push(env.adminOnlyPosting ? 'Режим «только для администраторов» включён' : 'Режим «только для администраторов» выключен');
    }
    if (env.adminOnlyPinning != null && env.adminOnlyPinning !== group.adminOnlyPinning) {
      patch.adminOnlyPinning = env.adminOnlyPinning;
      events.push(env.adminOnlyPinning ? 'Закреплять сообщения могут только администраторы' : 'Закреплять сообщения могут все участники');
    }
    // v4.32.256: обе настройки раньше не рассылались вовсе. requireApproval
    // читается при выдаче пригласительной ссылки, поэтому без синхронизации
    // второй администратор выдавал ссылку с выключенным одобрением;
    // anonymousPosting скрывает имена отправителей в списке сообщений, и без
    // синхронизации «анонимными» посты были ровно у включившего.
    if (env.requireApproval != null && env.requireApproval !== group.requireApproval) {
      patch.requireApproval = env.requireApproval;
      events.push(env.requireApproval ? 'Вход по ссылке теперь требует одобрения' : 'Вход по ссылке без одобрения');
    }
    if (env.anonymousPosting != null && env.anonymousPosting !== group.anonymousPosting) {
      patch.anonymousPosting = env.anonymousPosting;
      events.push(env.anonymousPosting ? 'Имена отправителей скрыты' : 'Имена отправителей видны');
    }
    /**
     * v4.32.303: новый токен пригласительной ссылки от другого администратора.
     *
     * Берём его только если сами вправе приглашать. Обычному участнику токен
     * не нужен и опасен вдвойне: он собрал бы по нему действующую ссылку (то
     * есть присвоил право приглашать) и начал бы отбраковывать чужие ссылки,
     * сверяя их с чем-то, о чём знать не должен. Конверт до него, по-хорошему,
     * и не долетит — рассылка идёт адресно администраторам, — но полагаться на
     * это, разбирая недоверенный ввод, нельзя.
     *
     * Побеждает последний дошедший: сброс — редкое действие одного человека.
     * Если два администратора сбросят ссылку одновременно, группа сойдётся на
     * том токене, чей конверт пришёл позже, а ссылки, выданные в промежутке,
     * получат честный отказ «ссылка больше не действует».
     */
    if (env.inviteToken != null && iAmAdmin && env.inviteToken !== group.inviteToken) {
      patch.inviteToken = env.inviteToken;
      events.push('Пригласительная ссылка сброшена: прежние больше не действуют');
    }
    if (Object.keys(patch).length) await updateGroupMeta(env.groupId, pid, patch);
    if (env.slowModeSeconds != null && env.slowModeSeconds !== group.slowModeSeconds) {
      await setGroupSlowMode(env.groupId, pid, env.slowModeSeconds);
      // v4.32.265: строку собирает slowModeSysLine — та же, что пишет себе
      // включивший. Раньше он видел «5 мин», а все остальные «300 сек».
      events.push(slowModeSysLine(env.slowModeSeconds));
    }
    if (env.disappearMs != null && env.disappearMs !== (group.disappearAfterMs ?? 0)) {
      const { formatDisappearLabel } = await import('./disappearEnvelope');
      // Своя переписка до этого момента не трогается: setGroupDisappearTimer
      // записывает disappear_set_at, и удаление ограничено им.
      await setGroupDisappearTimer(env.groupId, pid, env.disappearMs > 0 ? env.disappearMs : null);
      events.push(
        env.disappearMs > 0
          ? `Исчезающие сообщения включены: ${formatDisappearLabel(env.disappearMs)}`
          : 'Исчезающие сообщения выключены'
      );
    }
    for (const ev of events) await insertCtlSysMessage(env, pid, ev);
    log.info('group_ctl_meta_applied', { gid: env.groupId.slice(0, 8), events: events.length });
    return true;
  }

  const target = members.find((m) => m.peerPubB64 === env.target);
  // v4.32.255: те же две проверки (владелец неприкосновенен, чужого админа
  // трогает только владелец) теперь живут в groupModerationPolicy и вызываются
  // ещё и экраном — до отправки. Раньше экран о них не знал: применял
  // изменение локально и рассылал конверт, который здесь отбрасывался, и у
  // администратора участник оказывался исключён, а у всех остальных — нет.
  const verdict = canModerate(actor.role, target?.role);
  if (!verdict.allowed) {
    log.warn('group_ctl_moderation_denied', { gid: env.groupId.slice(0, 8), actor: actor.role, target: target?.role ?? 'none' });
    return true;
  }

  const myPub = rcpt.myPub;
  const isMe = !!myPub && env.target === myPub;
  // v4.32.372: то же, что и с actorLabel в v4.32.371 — подстановка через `??`
  // не срабатывает на пустом имени, а оно приходит по сети.
  const label = env.targetName || target?.displayName || 'Участник';

  switch (env.op) {
    case 'ban': {
      // v4.32.267: повтор бана — не редкость (второй администратор нажал то же
      // самое, конверт пришёл дважды), и раньше он вычитал из числа участников
      // ещё раз и писал вторую системную строку. unban был идемпотентен с
      // самого начала — теперь и ban.
      if (target?.role === 'banned') return true;
      if (target) await updateGroupMemberRole(env.groupId, env.target, 'banned', pid);
      else await upsertGroupMember({ groupId: env.groupId, peerPubB64: env.target, role: 'banned', displayName: displayNameOrNull(env.targetName), joinedAt: env.ts, ownerProfileId: pid });
      await recountGroupMembers(env.groupId, pid);
      await insertCtlSysMessage(env, pid, isMe ? `Вы заблокированы в группе (${actorLabel})` : `${label} заблокирован(а) в группе`);
      break;
    }
    case 'unban': {
      if (target?.role !== 'banned') return true;
      await updateGroupMemberRole(env.groupId, env.target, 'member', pid);
      await recountGroupMembers(env.groupId, pid);
      await insertCtlSysMessage(env, pid, isMe ? 'Блокировка снята' : `${label} разблокирован(а)`);
      break;
    }
    case 'kick': {
      if (!target) return true;
      await removeGroupMember(env.groupId, env.target, pid);
      await recountGroupMembers(env.groupId, pid);
      await insertCtlSysMessage(env, pid, isMe ? `Вас исключили из группы (${actorLabel})` : `${label} исключён(а) из группы`);
      break;
    }
    case 'add': {
      // INSERT OR REPLACE сбросил бы роль уже существующего админа — поэтому
      // добавляем только по-настоящему новых участников.
      if (target) {
        /**
         * v4.32.266: единственный случай, когда 'add' приходит про уже
         * состоящего, — это мы сами, вошедшие по устаревшей ссылке и
         * попавшие в очередь заявок. Ждать одобрения человека оставляли
         * молча: сообщения он писал, а их выбрасывал анти-спуф-фильтр у
         * всех остальных. Пересказ вступления самому вступившему убран
         * там же, где он отправляется, — иначе строка была бы ложной у
         * каждого, кто вошёл в группу без одобрения.
         */
        if (isMe) await insertCtlSysMessage(env, pid, `${actorLabel} одобрил(а) вашу заявку на вступление`);
        return true;
      }
      await upsertGroupMember({ groupId: env.groupId, peerPubB64: env.target, role: 'member', displayName: displayNameOrNull(env.targetName), joinedAt: env.ts, ownerProfileId: pid });
      await recountGroupMembers(env.groupId, pid);
      await insertCtlSysMessage(env, pid, `${label} вступил(а) в группу`);
      break;
    }
    case 'role': {
      if (!target || target.role === env.role) return true;
      // v4.32.257: роль 'restricted' («только чтение») добавлена к admin/member,
      // а текст системной строки считается по ПРЕЖНЕЙ роли — иначе снятие
      // ограничения и снятие админских прав описывались бы одинаково.
      const prev = target.role;
      await updateGroupMemberRole(env.groupId, env.target, env.role, pid);
      await insertCtlSysMessage(env, pid, roleChangeSysText(env.role, prev, label, isMe));
      break;
    }
  }

  /**
   * v4.32.512: собственную роль поменяли — значит, флаг `groups.is_admin`
   * обязан её догнать. Он остаётся запасным ответом на «кто я», пока список
   * участников не прочитан, а до этой версии не менялся вовсе: понизившийся
   * администратор видел у себя админские кнопки, повышенный — не видел.
   *
   * Второго запроса к базе не нужно: новая роль однозначно следует из
   * операции, которую мы только что применили (роли до этого места не
   * доходят непроверенными — их отсеивает разбор конверта).
   */
  if (isMe) {
    const mineNext = roleAfterCtl(env.op, env.op === 'role' ? env.role : null);
    if (mineNext !== undefined) {
      const nextAdmin = isAdminRole(mineNext);
      if (nextAdmin !== storedAdmin) await updateGroupMeta(env.groupId, pid, { isAdmin: nextAdmin });
    }
  }

  log.info('group_ctl_applied', { gid: env.groupId.slice(0, 8), op: env.op, target: env.target.slice(0, 12) });
  return true;
}

// ── GroupMessagingService singleton ──────────────────────────────────────────

/**
 * v4.32.234: сервис ужат до единственного метода, который кто-то вызывает.
 * sendGroupMessage / editGroupMessage / deleteGroupMessage / sendReadReceipt
 * не звал никто (весь UI работает через fanoutGroupMessage и fanoutGroupControl
 * напрямую), но именно в sendGroupMessage жила «проверка прав на отправку» —
 * и создавала полную иллюзию, что режимы группы кем-то форсируются. Проверка
 * переехала в fanoutGroupMessage, мёртвые методы удалены.
 */
export type GroupMessagingService = {
  receiveGroupEnvelope: (payload: Uint8Array, senderDid: string) => Promise<void>;
};

let _groupSvc: GroupMessagingService | null = null;

export function getGroupMessagingService(): GroupMessagingService {
  if (!_groupSvc) {
    _groupSvc = {
      receiveGroupEnvelope: async (payload, senderDid) => {
        const text = new TextDecoder().decode(payload);
        // v4.32.188 (Round-18 #2): LAN/Internet direct transports pass the
        // DID (did:key:z...) as sender, but handleIncomingGroupEnvelope's
        // anti-spoof check compares against `env.senderPubB64` which is
        // raw base64(pubkey). Convert here so the spoof check actually
        // runs — otherwise every LAN/Internet group envelope was dropped.
        let senderPubB64 = senderDid;
        try {
          const { parseDidKey } = await import('../identity/did');
          const pub = parseDidKey(senderDid);
          if (pub) senderPubB64 = Buffer.from(pub).toString('base64');
        } catch { /* fall through — handleIncomingGroupEnvelope will reject on mismatch */ }
        // v4.32.465: чей это конверт, знает только служба переписки — у неё
        // пара ключей, которой он расшифрован. Без неё писать некуда: раньше
        // здесь молча брался активный профиль, и сообщение группы «Личного»
        // ложилось (или терялось) в «Рабочем».
        const svc = getMessagingService();
        if (!svc) {
          log.warn('group_envelope_no_service_drop', { from: senderPubB64.slice(0, 12) });
          return;
        }
        await handleIncomingGroupEnvelope(text, await svc.groupRecipient(), senderPubB64);
      },
    };
  }
  return _groupSvc;
}
