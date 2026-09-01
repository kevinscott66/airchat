/**
 * groupControlEnvelope — чистый кодек управляющих конвертов группы.
 *
 * v4.32.231. До этой версии протокол групп знал ровно три конверта: сообщение
 * ('\x02grp:'), отметку о прочтении ('\x03grpr:') и заявку на вступление
 * ('\x0agjr:'). Синхронизации МЕТАДАННЫХ не было вообще: бан, кик, назначение
 * админа, переименование, «только для админов» и slowmode записывались ТОЛЬКО
 * в локальную БД того, кто нажал кнопку. Следствие — забаненный участник
 * спокойно продолжал переписываться со всеми остальными, потому что их
 * устройства о бане не знали; переименование группы видел только автор; режим
 * adminOnlyPosting не проверялся на приёме ни у кого.
 *
 * Модуль зависит только от таких же чистых модулей без импортов: разбор
 * недоверенного ввода — самая security-чувствительная часть протокола, и её
 * нужно уметь тестировать без SQLite, IPFS и транспорта (groupMessaging.ts
 * тянет за собой весь этот граф). Применение конверта живёт в
 * groupMessaging.ts.
 *
 * '\x0e' — единственный свободный управляющий байт в этом протоколе
 * ('\x01' voice, '\x02' grp, '\x03' grpr, '\x04' poll, '\x05' contact,
 *  '\x0a' gjr, '\x0b' sys, '\x0c' liveloc).
 */

import { readEnvelopeBody } from './envelopeBody';
import { isPubKeyB64 } from '../crypto/pubKeyFormat';
import { MIN_AUTO_DELETE_MS, MAX_AUTO_DELETE_MS } from '../storage/autoDeletePolicy';
import { isSafeMediaCid } from '../media/mediaCidPolicy';
import { sanitizeDisplayName as sanitizeName, sanitizeParagraphText, stripSpoofedSysPrefix } from './sysLineGuard';
import { isInviteToken } from './groupInviteToken';
import { OWN_GROUP_DESC_MAX, OWN_GROUP_NAME_MAX } from './groupNameRule';
import { withinMessageTextLimit } from './messageTextLimit';
import { isAssignableRole, type AssignableRole } from './groupRolePolicy';
import { isGroupType, MAX_SLOWMODE_SECONDS } from './groupSendPolicy';

export const GROUP_CTL_PREFIX = '\x0egctl:';

export type GroupCtlMember = { pub: string; name?: string | null };

export type GroupCtlOp =
  /**
   * Самопредставление: «я вступил(а) по ссылке-приглашению». Единственная
   * операция, которую шлёт не администратор, поэтому target обязан совпадать с
   * DM-отправителем — представить можно только себя.
   *
   * v4.32.303: inviteToken — секрет из ссылки, по которой вступают. Сверяет
   * его получатель со своим (groupInviteToken); без этого поля ссылку нечем
   * было отозвать, и один раз утёкшая пускала в группу вечно.
   */
  | { op: 'join'; target: string; targetName?: string; inviteToken?: string }
  /**
   * «Я вышел(вышла) из группы». Вторая операция, которую шлёт не
   * администратор, и по тем же правилам: target обязан совпадать с
   * DM-отправителем — выйти можно только самому.
   *
   * v4.32.268. «Покинуть / удалить» удаляло группу ТОЛЬКО на своём
   * устройстве. Никто из группы об этом не узнавал: вышедший навсегда
   * оставался в чужих списках участников и в числе «N участников», ему
   * бесконечно слали каждое сообщение группы (а его клиент молча выбрасывал
   * их как «неизвестная группа»), и собеседники были уверены, что он читает.
   * Пункт меню назывался «Покинуть», но покинуть группу было нечем.
   */
  | { op: 'leave'; target: string; targetName?: string }
  /**
   * Приглашение в группу, которой у получателя ещё нет: снимок группы +
   * список участников. Шлётся автором группы выбранным контактам и
   * администратором — одобренному заявителю.
   */
  | { op: 'invite'; groupName: string; groupType?: 'group' | 'channel' | 'supergroup'; members: GroupCtlMember[]; avatarCid?: string }
  /**
   * Ответ администратора на заявку: 'pending' — «положили в очередь»,
   * 'rejected' — «отказано». target — заявитель.
   *
   * v4.32.266. Ссылка, выданная до включения одобрения, несёт
   * requireApproval:false навсегда: открывший её создаёт группу у себя, видит
   * «Вы добавлены в группу» — и на этом всё. Приёмники кладут его в очередь
   * заявок (4.32.259), но сказать ему об этом было нечем: он писал в группу,
   * а анти-спуф-фильтр молча выбрасывал каждое его сообщение у всех, и понять
   * причину было невозможно. Клиенты старых версий этот конверт отбросят как
   * неизвестную операцию — молча и без вреда.
   */
  | { op: 'joinres'; target: string; status: 'pending' | 'rejected' | 'revoked'; targetName?: string }
  | { op: 'ban'; target: string; targetName?: string }
  | { op: 'unban'; target: string; targetName?: string }
  | { op: 'kick'; target: string; targetName?: string }
  | { op: 'add'; target: string; targetName?: string }
  /**
   * Смена роли участника. 'restricted' — «только чтение»: роль проверялась
   * groupSendPolicy с самого начала, но конверт её не принимал, и назначить её
   * было нечем (v4.32.257).
   */
  | { op: 'role'; target: string; role: AssignableRole; targetName?: string }
  /**
   * Настройки группы. disappearMs — общий таймер исчезающих сообщений: 0 —
   * выключить, иначе от минуты до года. До v4.32.238 таймер группы вообще не
   * рассылался, то есть «исчезающие сообщения» работали только у того, кто
   * нажал кнопку, а у остальных переписка оставалась целиком.
   *
   * v4.32.256: сюда же добавлены requireApproval и anonymousPosting. До этой
   * версии обе настройки писались только в локальную БД нажавшего:
   * «Одобрение входа» второй администратор не видел и выдавал ссылку,
   * пускающую в группу без заявки, а «Анонимные посты» скрывали имена
   * отправителей ровно на одном устройстве — на всех остальных имена
   * оставались на экране, хотя включивший видел «Имена отправителей скрыты».
   *
   * v4.32.303: inviteToken — новый секрет пригласительной ссылки, и он ЕДЕТ НЕ
   * ВСЕМ. Обычный участник, узнав токен, соберёт действующую ссылку сам, и
   * отзыв снова станет пустой кнопкой; поэтому 'meta' с этим полем уходит
   * адресно администраторам (sendGroupControlTo), а не общей рассылкой. Без
   * рассылки второй администратор выдавал бы ссылки со своим, никому не
   * известным токеном — ровно та же болезнь, от которой в v4.32.256 сюда
   * добавили requireApproval.
   */
  | {
      op: 'meta';
      name?: string;
      description?: string;
      adminOnlyPosting?: boolean;
      slowModeSeconds?: number;
      adminOnlyPinning?: boolean;
      disappearMs?: number;
      avatarCid?: string;
      requireApproval?: boolean;
      anonymousPosting?: boolean;
      inviteToken?: string;
    }
  /**
   * Правка своего сообщения. Права проверяются по авторству строки, а не по
   * роли, поэтому разбирается до проверки «отправитель — администратор».
   */
  | { op: 'edit'; msgId: string; text: string }
  /** Удаление сообщения: автором — своего, администратором — любого. */
  | { op: 'del'; msgId: string }
  /**
   * Закрепление/открепление. Кто вправе — решает canPinInGroup по роли
   * отправителя и настройке группы adminOnlyPinning, поэтому проверка тоже
   * идёт до общей проверки «отправитель — администратор».
   */
  | { op: 'pin'; msgId: string; on: boolean };

export type GroupCtlEnvelope = GroupCtlOp & {
  groupId: string;
  ts: number;
  /** Имя администратора, инициировавшего изменение (для системного сообщения). */
  actorName?: string;
};

const CTL_OPS = new Set(['join', 'leave', 'joinres', 'invite', 'ban', 'unban', 'kick', 'add', 'role', 'meta', 'edit', 'del', 'pin']);

/** Сколько участников максимум переносит одно приглашение. */
const MAX_INVITE_MEMBERS = 200;

/**
 * Base64 Ed25519-ключ. v4.32.368: раньше проверялась только длина, и под неё
 * подходили 43 произвольных символа. Ключ из конверта уезжает в список
 * участников как есть — чистку имени он не проходит, — так что чужой участник
 * добавлял в группу запись из управляющих байтов, за которой нет человека.
 */
const isPubB64 = isPubKeyB64;

export function encodeGroupCtlEnvelope(env: GroupCtlEnvelope): string {
  return GROUP_CTL_PREFIX + JSON.stringify(env);
}

/** Разбирает и валидирует управляющий конверт. null — не наш конверт либо мусор. */
export function decodeGroupCtlEnvelope(text: string): GroupCtlEnvelope | null {
  // Почти все ctl-конверты — сотни байт; исключение 'invite', который несёт
  // список участников (до 200 × ~110 байт). 64 КБ — потолок DM-транспорта.
  const env = readEnvelopeBody<GroupCtlEnvelope>(text, GROUP_CTL_PREFIX, 64 * 1024);
  if (!env) return null;
  if (typeof env.groupId !== 'string' || !env.groupId || env.groupId.length > 128) return null;
  if (typeof env.op !== 'string' || !CTL_OPS.has(env.op)) return null;
  if (typeof env.ts !== 'number' || !Number.isFinite(env.ts)) return null;
  if (env.actorName != null) {
    const name = sanitizeName(env.actorName);
    if (name == null) return null;
    env.actorName = name;
  }
  if (env.op === 'meta') {
    if (env.name != null) {
      const name = sanitizeName(env.name, OWN_GROUP_NAME_MAX);
      if (name == null) return null;
      // v4.32.379: название, от которого после чистки ничего не осталось, —
      // это «названия в конверте нет», а не «сотрите название». Пустая строка
      // проходила дальше как обычное значение, и применение переименовывало
      // группу в ничто у всех участников: в списке групп оставалась строка без
      // подписи, а в историю писалось «Группа переименована в «»». Своим
      // редактором такое не набрать — он на пустом названии просто закрывается,
      // — так что операции «стереть название» в приложении нет вовсе.
      if (!name) delete (env as { name?: unknown }).name;
      else env.name = name;
    }
    if (env.description != null) {
      if (typeof env.description !== 'string') return null;
      // v4.32.373: единственное поле конверта, проходившее мимо очистки, —
      // рядом стоящее имя группы её проходило с самого начала. Описание
      // рисуется обычным <Text> в карточке группы, то есть мимо отрисовщика
      // тела сообщения: U+202E разворачивал его на экране у всех участников,
      // а пятьсот переводов строки растягивали карточку на весь экран.
      // Пустое описание — это «описание убрали», и таким оно и остаётся.
      env.description = sanitizeParagraphText(env.description, OWN_GROUP_DESC_MAX) ?? '';
    }
    if (env.avatarCid != null) {
      // Аватар грузится САМ при отрисовке списка групп, поэтому «CID» из сети —
      // такой же маяк, как ссылка в предпросмотре: подставленный чужой адрес
      // выдаёт IP получателя. Пускаем только обычный CID и `nb:`-дескриптор.
      if (!isSafeMediaCid(env.avatarCid)) return null;
    }
    if (env.adminOnlyPosting != null && typeof env.adminOnlyPosting !== 'boolean') return null;
    if (env.adminOnlyPinning != null && typeof env.adminOnlyPinning !== 'boolean') return null;
    if (env.requireApproval != null && typeof env.requireApproval !== 'boolean') return null;
    if (env.anonymousPosting != null && typeof env.anonymousPosting !== 'boolean') return null;
    // v4.32.303: токен — то, чем группа отзывает свои ссылки. Мусор в этом поле
    // отбрасывает конверт целиком: записать его себе значило бы отказывать по
    // ссылкам, выданным собственным администратором, пока он не сбросит их ещё
    // раз. Форму проверяет тот же модуль, что её и задаёт.
    if (env.inviteToken != null && !isInviteToken(env.inviteToken)) return null;
    if (env.slowModeSeconds != null) {
      if (typeof env.slowModeSeconds !== 'number' || !Number.isFinite(env.slowModeSeconds)) return null;
      env.slowModeSeconds = Math.max(0, Math.min(MAX_SLOWMODE_SECONDS, Math.floor(env.slowModeSeconds)));
    }
    if (env.disappearMs != null) {
      // Мусорное значение здесь означает удаление чужой переписки, поэтому
      // конверт отбрасывается целиком, а не «подрезается» до границы: таймер в
      // одну миллисекунду от чужого клиента — это команда «сотри всё сейчас».
      if (typeof env.disappearMs !== 'number' || !Number.isInteger(env.disappearMs)) return null;
      if (env.disappearMs !== 0 && (env.disappearMs < MIN_AUTO_DELETE_MS || env.disappearMs > MAX_AUTO_DELETE_MS)) return null;
    }
    return env;
  }
  if (env.op === 'edit' || env.op === 'del' || env.op === 'pin') {
    if (typeof env.msgId !== 'string' || !env.msgId || env.msgId.length > 128) return null;
    if (env.op === 'edit') {
      if (typeof env.text !== 'string') return null;
      // v4.32.530: потолок — тот же, что у обычного сообщения группы, и живёт
      // он в messageTextLimit, а не отдельным числом здесь. Прежде правка молча
      // обрезалась на четырёх тысячах символов: отправить сообщение длиннее
      // было можно, а исправить в нём опечатку — уже нет, у всех получателей
      // от текста оставалась часть, и никакой ошибки при этом не показывалось.
      // Отбрасывается конверт целиком: подрезанная правка — это подмена
      // содержимого чужого сообщения, а не «слишком длинный текст».
      if (!withinMessageTextLimit(env.text)) return null;
      // Тот же запрет на подделку системной строки: иначе правкой своего
      // сообщения участник выдавал бы себя за приложение (см. sysLineGuard).
      env.text = stripSpoofedSysPrefix(env.text);
    }
    if (env.op === 'pin') {
      if (typeof (env as { on?: unknown }).on !== 'boolean') return null;
      // Текст баннера в конверте не передаём: получатель берёт его из своей же
      // строки group_messages. Лишнее поле вырезаем здесь, чтобы оно физически
      // не дожило до применения — иначе закрепление стало бы способом показать
      // всей группе произвольный текст от чужого имени.
      delete (env as { text?: unknown }).text;
    }
    return env;
  }
  if (env.op === 'invite') {
    const name = sanitizeName(env.groupName);
    if (!name || !name.trim()) return null;
    env.groupName = name;
    // v4.32.513: правило «что такое вид группы» — одно на конверт и на
    // пригласительную ссылку (см. isGroupType).
    if (env.groupType != null && !isGroupType(env.groupType)) return null;
    // Аватар приходит вместе с приглашением, иначе новый участник видел бы
    // кружок с буквой до первой правки настроек. Проверка формы — та же.
    if (env.avatarCid != null && !isSafeMediaCid(env.avatarCid)) return null;
    if (!Array.isArray(env.members)) return null;
    // Сначала режем количество, потом фильтруем: иначе валидация 100k
    // «правильных по форме» записей сама становится точкой отказа.
    env.members = env.members
      .slice(0, MAX_INVITE_MEMBERS)
      .filter((m): m is GroupCtlMember => !!m && typeof m === 'object' && isPubB64((m as GroupCtlMember).pub))
      .map((m) => ({ pub: m.pub, name: sanitizeName(m.name) }));
    return env;
  }
  // Все остальные операции адресные: target — base64 Ed25519-ключ (43–48 симв.).
  if (!isPubB64(env.target)) return null;
  if (env.targetName != null) {
    const name = sanitizeName(env.targetName);
    if (name == null) return null;
    env.targetName = name;
  }
  // Токен из ссылки — недоверенный ввод: сюда он приходит от того, кого ещё
  // только предстоит впустить. Мусор вырезается, а не отвергает конверт: без
  // токена 'join' остаётся законным (ссылки старых версий его не несут), и
  // решение принимает groupInviteToken на стороне получателя.
  if (env.op === 'join' && env.inviteToken != null && !isInviteToken(env.inviteToken)) {
    delete (env as { inviteToken?: unknown }).inviteToken;
  }
  if (env.op === 'role' && !isAssignableRole(env.role)) return null;
  // v4.32.303: 'revoked' — «ссылка, по которой вы вошли, больше не действует».
  // Сборки до этой версии такой статус не знают и отбросят конверт целиком —
  // то есть увидят ровно то же, что видели раньше: ничего.
  if (env.op === 'joinres' && env.status !== 'pending' && env.status !== 'rejected' && env.status !== 'revoked') return null;
  return env;
}
