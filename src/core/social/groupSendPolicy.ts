/**
 * groupSendPolicy — кто и что вправе отправить в группу.
 *
 * v4.32.234. До этой версии проверка прав на отправку существовала, но не
 * работала ни разу. groupPermissions.canSendMessage написан против модели
 * core/storage/groupStorage.ts (GroupRow с полями memberPubKeys/adminPubKeys),
 * а живая группа лежит в core/storage/local.ts, где таких полей нет вовсе.
 * Единственный вызов делал `group as unknown as ...`, после чего
 * `group.memberPubKeys.includes(...)` бросал TypeError, а обрамляющий
 * `catch { /* fail-open *\/ }` его глотал. Плюс сам вызов сидел в
 * getGroupMessagingService().sendGroupMessage — методе, который не вызывает
 * никто: весь UI шлёт через fanoutGroupMessage напрямую.
 *
 * Итог: «только для админов», роль restricted и канал ограничивали ровно
 * видимость кнопок в UI. Модифицированный клиент — или обычный, у которого
 * настройка ещё не доехала, — писал куда угодно.
 *
 * Модуль без единого импорта: та же причина, что у groupControlEnvelope и
 * groupPinPolicy — решение о недоверенном вводе должно тестироваться без
 * SQLite и транспорта, которые тянет за собой groupMessaging.ts. Одна и та же
 * функция обязана вызываться и на отправке, и на приёме: расхождение означает
 * либо тихо теряемые сообщения, либо дыру.
 */

import { SYS_LINE_PREFIX } from './sysLineGuard';

export type SendRole = 'owner' | 'admin' | 'member' | 'restricted' | 'banned';
export type SendGroupType = 'group' | 'channel' | 'supergroup';

/**
 * Виды группы одним списком — v4.32.513.
 *
 * Перечень был выписан литералами в трёх местах: в схеме таблицы groups, в
 * разборе конверта 'invite' и здесь, в типе. Проверка «это вообще вид
 * группы?» нужна везде, куда вид приезжает снаружи — и конвертом, и
 * пригласительной ссылкой, — а двум её копиям разойтись ничего не мешает:
 * одна сторона сочтёт значение законным, другая нет.
 */
export const GROUP_TYPES: readonly SendGroupType[] = ['group', 'channel', 'supergroup'];

export function isGroupType(v: unknown): v is SendGroupType {
  return typeof v === 'string' && (GROUP_TYPES as readonly string[]).includes(v);
}

/**
 * Вид вложения. Определяется по управляющему префиксу текста — отдельного
 * поля в конверте нет, и добавлять его нельзя: отправитель проставил бы туда
 * что угодно.
 */
export type SendMediaKind = 'text' | 'media' | 'voice' | 'file' | 'location' | 'poll' | 'system';

export type SendPolicyInput = {
  /** null — отправителя нет в списке участников. */
  role: SendRole | null;
  type: SendGroupType;
  adminOnlyPosting: boolean;
  media?: SendMediaKind;
};

export type SendDenyCode =
  | 'not_member'
  | 'banned'
  | 'restricted'
  | 'channel_admin_only'
  | 'admin_only_posting';

export type SendVerdict = { allowed: true } | { allowed: false; code: SendDenyCode; reason: string };

/**
 * Текст отказа по коду. Экспортируется функцией, а не таблицей: причина
 * отказа обязана звучать одинаково и там, где её выносят (SendVerdict.reason),
 * и там, где о ней сообщают постфактум — после рассылки (groupSendOutcome).
 */
export function sendDenyText(code: SendDenyCode): string {
  return DENY[code];
}

const DENY: Record<SendDenyCode, string> = {
  not_member: 'Вы не участник этой группы',
  banned: 'Вы заблокированы в этой группе',
  restricted: 'Вам запрещено отправлять сообщения в этой группе',
  channel_admin_only: 'В канале публикуют только администраторы',
  admin_only_posting: 'Сейчас писать могут только администраторы',
};

/**
 * Вид сообщения по управляющему префиксу.
 *
 * Префиксы продублированы литералами намеренно: модуль обязан оставаться без
 * транспортных зависимостей, а константы живут в модулях, тянущих за собой
 * транспорт. Карта протокола: '\x01voice:', '\x02grp:', '\x03grpr:',
 * '\x04poll:', '\x05contact:', '\x06doc:', '\x07loc:', '\x08fwd:',
 * '\x09vo:', '\x0agjr:', '\x0bsys:', '\x0cliveloc:', '\x0egctl:',
 * '\x0freact:'.
 *
 * v4.32.263: исключение — системный префикс. Он берётся из sysLineGuard (тоже
 * модуль без импортов), потому что от совпадения этих двух строк зависит не
 * подпись, а право отправки: 'system' проходит проверку всегда, и разойдись
 * они с тем префиксом, который снимает stripSpoofedSysPrefix на приёме, —
 * забаненный получил бы способ протолкнуть сообщение мимо запрета.
 */
export function mediaKindOfText(text: string): SendMediaKind {
  if (text.startsWith(SYS_LINE_PREFIX)) return 'system';
  if (text.startsWith('\x01voice:')) return 'voice';
  if (text.startsWith('\x04poll:')) return 'poll';
  if (text.startsWith('\x06doc:')) return 'file';
  if (text.startsWith('\x07loc:') || text.startsWith('\x0cliveloc:')) return 'location';
  if (text.startsWith('\x09vo:')) return 'media';
  return 'text';
}

/**
 * Можно ли отправить. Вызывается и отправителем (до записи в свою БД), и
 * получателем (до записи входящего) — вердикт обязан совпадать.
 */
export function canSendToGroup({ role, type, adminOnlyPosting, media = 'text' }: SendPolicyInput): SendVerdict {
  // Служебные сообщения ('\x0bsys:') генерирует сам протокол при бане, киках,
  // смене настроек. Они обязаны проходить даже в «закрытой» группе — иначе
  // участник не узнает, что режим включили.
  if (media === 'system') return { allowed: true };

  if (role == null) return { allowed: false, code: 'not_member', reason: DENY.not_member };
  if (role === 'banned') return { allowed: false, code: 'banned', reason: DENY.banned };
  if (role === 'owner' || role === 'admin') return { allowed: true };

  // Канал — вещание: подписчик не публикует ничего, независимо от настроек.
  if (type === 'channel') return { allowed: false, code: 'channel_admin_only', reason: DENY.channel_admin_only };

  // restricted — «read-only участник». Это точечный бан на отправку, поэтому
  // сильнее любой групповой настройки.
  if (role === 'restricted') return { allowed: false, code: 'restricted', reason: DENY.restricted };

  if (adminOnlyPosting) return { allowed: false, code: 'admin_only_posting', reason: DENY.admin_only_posting };
  return { allowed: true };
}

/** Формулировки запрета для реакции и голоса — речь не об отправке сообщения. */
const DENY_INTERACT: Record<'not_member' | 'banned' | 'restricted', string> = {
  not_member: 'Вы не участник этой группы',
  banned: 'Вы заблокированы в этой группе',
  restricted: 'Вам ограничили права в этой группе',
};

/**
 * Можно ли поставить реакцию или проголосовать в опросе.
 *
 * v4.32.273. Реакции и голоса проверялись только на бан — роль restricted их
 * не касалась вовсе. «Только читать» означало «только читать и ещё голосовать
 * в опросах и расставлять реакции»: и то и другое видно всей группе, то есть
 * ограничение снималось само собой. Проверка отсутствовала с обеих сторон, так
 * что и модифицированный клиент был не нужен — хватало обычного.
 *
 * Это НЕ canSendToGroup: подписчик канала и участник группы в режиме «пишут
 * только администраторы» публиковать не вправе, но голосовать и реагировать
 * обязаны — иначе опрос в канале теряет смысл, а реакция остаётся
 * единственным доступным ответом. Запрет ровно у тех, у кого отобрали право
 * говорить лично: бан и read-only.
 *
 * Как и canSendToGroup, зовётся и отправителем, и получателем: вердикт обязан
 * совпадать, иначе голос виден только своему автору.
 */
export function canInteractInGroup(role: SendRole | null): SendVerdict {
  if (role == null) return { allowed: false, code: 'not_member', reason: DENY_INTERACT.not_member };
  if (role === 'banned') return { allowed: false, code: 'banned', reason: DENY_INTERACT.banned };
  if (role === 'restricted') return { allowed: false, code: 'restricted', reason: DENY_INTERACT.restricted };
  return { allowed: true };
}

export type MsgOp = 'edit' | 'del';

export type MsgOpDenyCode = SendDenyCode | 'not_author' | 'not_moderator';

export type MsgOpVerdict = { allowed: true } | { allowed: false; code: MsgOpDenyCode; reason: string };

const DENY_MSG_OP: Record<'not_author' | 'not_moderator', string> = {
  not_author: 'Править можно только своё сообщение',
  not_moderator: 'Удалять чужие сообщения может только администратор',
};

/**
 * Кто вправе изменить уже отправленное сообщение группы.
 *
 * v4.32.275. Правка и удаление проверялись прямо в обработчике конверта, и
 * проверка была неполной: кроме авторства смотрели только на бан. А правка —
 * это публикация нового текста в историю всей группы, то есть право на неё то
 * же самое, что на отправку. Отправляющая сторона это и делает (в GroupsScreen
 * ветка правки идёт после общего sendVerdict), получающая — нет. Свой клиент
 * правку запрещал, чужой применял: участник в режиме «только чтение»,
 * подписчик канала и любой участник при «пишут только администраторы» могли
 * переписать своё старое сообщение и сказать группе что угодно в обход
 * запрета говорить.
 *
 * Удаление намеренно осталось только под проверкой авторства и роли: убрать
 * свой текст — не высказывание, и запрещать это молчащему участнику незачем.
 *
 * Вид 'system' для правки не признаётся: системные строки протокол порождает
 * сам, отредактировать сообщение в системное нельзя по определению. Приёмник
 * конверта и так снимает поддельный префикс, но правило не должно зависеть от
 * того, что кто-то раньше по цепочке не забыл это сделать.
 */
export function canApplyGroupMessageOp(input: {
  op: MsgOp;
  role: SendRole | null;
  isAuthor: boolean;
  type: SendGroupType;
  adminOnlyPosting: boolean;
  media?: SendMediaKind;
}): MsgOpVerdict {
  const { op, role, isAuthor, type, adminOnlyPosting, media = 'text' } = input;
  if (role == null) return { allowed: false, code: 'not_member', reason: DENY.not_member };
  if (role === 'banned') return { allowed: false, code: 'banned', reason: DENY.banned };

  if (op === 'edit') {
    // Править чужое нельзя даже администратору: это подмена авторства, а не
    // модерация.
    if (!isAuthor) return { allowed: false, code: 'not_author', reason: DENY_MSG_OP.not_author };
    return canSendToGroup({ role, type, adminOnlyPosting, media: media === 'system' ? 'text' : media });
  }

  const isAdmin = role === 'owner' || role === 'admin';
  if (!isAuthor && !isAdmin) return { allowed: false, code: 'not_moderator', reason: DENY_MSG_OP.not_moderator };
  return { allowed: true };
}

/**
 * Сколько секунд осталось до следующей отправки в медленном режиме.
 * 0 — можно отправлять. Администрация медленным режимом не ограничена.
 *
 * Функция чистая: время и «когда отправлял в прошлый раз» передаются
 * снаружи, чтобы её можно было проверить без таймеров.
 */
export function slowModeRemaining(params: {
  role: SendRole | null;
  slowModeSeconds: number;
  lastSentAt: number;
  now: number;
}): number {
  const { role, slowModeSeconds, lastSentAt, now } = params;
  if (!Number.isFinite(slowModeSeconds) || slowModeSeconds <= 0) return 0;
  if (role === 'owner' || role === 'admin') return 0;
  if (!Number.isFinite(lastSentAt) || lastSentAt <= 0) return 0;
  // Часы устройства могли уехать назад — отрицательная разница не должна
  // превращаться в вечный запрет отправки.
  const elapsed = Math.floor((now - lastSentAt) / 1000);
  if (elapsed < 0) return 0;
  const left = slowModeSeconds - elapsed;
  return left > 0 ? left : 0;
}

/** Человекочитаемая задержка медленного режима для UI. */
export function formatSlowMode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Выключен';
  if (seconds < 60) return `${seconds} сек`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} мин`;
  return `${Math.floor(seconds / 3600)} ч`;
}

/**
 * Системная строка о смене медленного режима.
 *
 * v4.32.265: одно и то же число писалось четырьмя разными способами —
 * «Медленный режим: 5 мин» в истории у включившего, «Медленный режим: 300 сек»
 * в истории у всех остальных (строку там собирал приёмник конверта), «(300с)»
 * в подписи пункта меню и «300 сек» во всплывающем подтверждении команды
 * /slowmode. Формулировка одна на всех: расхождение читается как два разных
 * события, а сравнить свою историю с чужой нельзя.
 */
export function slowModeSysLine(seconds: number): string {
  return seconds > 0 ? `Медленный режим: ${formatSlowMode(seconds)}` : 'Медленный режим отключён';
}

export const SLOW_MODE_OPTIONS = [0, 10, 30, 60, 300, 900, 3600] as const;

/**
 * Максимальная задержка медленного режима — сутки. Кап протокольный: его
 * применяет декодер входящего конверта, и по нему же проверяется команда
 * /slowmode, иначе введённое число молча урезалось бы только у получателей.
 */
export const MAX_SLOWMODE_SECONDS = 86400;
