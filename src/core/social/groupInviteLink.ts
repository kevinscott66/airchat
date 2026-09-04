/**
 * groupInviteLink — одна ссылка-приглашение: один сборщик, один разборщик.
 *
 * v4.32.260. Ссылку собирали в четырёх местах, и все четыре собирали её
 * по-разному:
 *
 *  1. «Пригласительная ссылка» в меню группы (основной путь) не клала
 *     members — а App.tsx требует Array.isArray(payload.members) и без него
 *     отвечает «Недействительная ссылка приглашения». То есть главная кнопка
 *     приглашения выдавала заведомо нерабочую ссылку.
 *  2. QR клал 20 участников и requireApproval.
 *  3. Кнопка «поделиться» в шапке карточки группы клала ВЕСЬ список
 *     участников без ограничения и без requireApproval, и показывалась не
 *     только администраторам.
 *  4. «Пригласительная ссылка» в контекстном меню списка групп клала 20
 *     участников, отфильтровав забаненных.
 *
 * Разбор недоверенной ссылки тоже жил в одном экземпляре — внутри обработчика
 * deep link в App.tsx, — и проверить его тестами было нечем.
 *
 * Модуль чистый (без БД, сети и RN): и сборка, и разбор проверяются целиком.
 *
 * v4.32.303: в ссылке появился token — секрет, по которому её и отзывают.
 * Поле необязательное: ссылки, выданные до этой версии, его не несут, и
 * приложение обязано их прочитать (решение «пускать или нет» принимает
 * приёмник — см. groupInviteToken).
 *
 * v4.32.513: в ссылке появился вид группы. Без него канал, в который вошли по
 * ссылке, заводился у вошедшего ОБЫЧНОЙ ГРУППОЙ — App.tsx подставлял 'group'
 * литералом, — и это уже не исправлялось ничем: createGroup это INSERT OR
 * IGNORE, ветка 'invite' на известной группе выходит сразу, а конверт 'meta'
 * вида не несёт. Дальше подписчик видел у себя поле ввода, писал в канал и
 * получал своё сообщение в своей же истории, а на каждом чужом устройстве оно
 * отбрасывалось (`group_msg_denied_drop`: в канале публикуют только
 * администраторы). Поле необязательное на входе — ссылки прежних версий его не
 * несут и читаются как раньше.
 *
 * Про участников в полезной нагрузке. Это не удобство, а таблица маршрутизации:
 * вступивший рассылает конверт 'join' по тем, кого знает, а входящие от
 * незнакомцев отбрасывает анти-спуф-фильтр. Пустой список означает, что о
 * новичке узнает только администратор, а для остальных участников группы его
 * сообщения молча исчезают (ровно баг, закрытый в 4.32.231). Поэтому список
 * остаётся, но ограничен сверху и всегда без забаненных: тот, кто вступит,
 * не должен получить забаненного в свой список рассылки как обычного.
 */

import { publicKeyFromB64 } from '../crypto/pubKeyFormat';
import { isInviteToken } from './groupInviteToken';
import { FALLBACK_GROUP_NAME } from './groupNameRule';
import { isGroupType, type SendGroupType } from './groupSendPolicy';
import { sanitizeDisplayName } from './sysLineGuard';

/** Схема deep link: airchat://join-group/<base64(JSON)>. */
export const INVITE_LINK_PREFIX = 'airchat://join-group/';

/** Сколько участников кладём в ссылку. Больше — ради пересылки лишний повод. */
export const INVITE_MEMBERS_CAP = 20;

/** Потолок длины base64 — защита от подсунутой гигантской ссылки. */
export const INVITE_B64_MAX = 8192;

export interface InviteMember {
  pub: string;
  name: string | null;
}

export interface GroupInvitePayload {
  id: string;
  name: string;
  /**
   * v4.32.513: вид группы. У разобранной ссылки поле есть всегда: ссылки,
   * выданные до этой версии, читаются как 'group' — ровно то, чем всё и
   * заканчивалось раньше для любой ссылки.
   */
  type: SendGroupType;
  adminPub: string;
  requireApproval: boolean;
  members: InviteMember[];
  /** v4.32.303: секрет ссылки; отсутствует у ссылок старых версий. */
  token?: string;
}

/** Участник в том виде, в каком он лежит у нас в таблице. */
export interface InviteSourceMember {
  peerPubB64: string;
  displayName: string | null;
  role?: string;
}

// v4.32.427: своя копия правила «строка — это открытый ключ» уехала в
// pubKeyFormat. Копия здесь запрещала base64url (`-` и `_`), хотя ключ
// приезжает из ссылки, где именно эта форма и уместна, — то есть законная
// ссылка отвергалась как поддельная.
const isB64_32 = (s: unknown): s is string => publicKeyFromB64(s) !== null;

/**
 * Имя из недоверенной ссылки: чистка та же, что у всех имён из сети.
 *
 * v4.32.369: здесь стояла своя копия правила — только C0 и DEL. Написана она
 * в 4.32.260, через двадцать версий после stripBidiControls, и не знала ни про
 * метки направления письма, ни про U+2028. А имя группы из ссылки идёт прямо
 * в Alert.alert: U+202E переворачивает текст диалога, U+2028 дописывает к
 * нему вторую строку. Правило теперь одно на всех — sanitizeDisplayName.
 */
function sanitizeName(v: unknown, max = 64): string | null {
  const cleaned = (sanitizeDisplayName(v, max) ?? '').trim();
  return cleaned.length ? cleaned : null;
}

export function buildGroupInviteLink(params: {
  id: string;
  name: string;
  /** Вид группы; обязателен, чтобы забыть его было нечем. */
  type: SendGroupType;
  adminPub: string;
  requireApproval: boolean;
  members: InviteSourceMember[];
  /** Токен группы; без него ссылка соберётся, но отозвать её будет нечем. */
  token?: string | null;
}): string {
  const members: InviteMember[] = params.members
    .filter((m) => m.role !== 'banned' && isB64_32(m.peerPubB64))
    .slice(0, INVITE_MEMBERS_CAP)
    .map((m) => ({ pub: m.peerPubB64, name: sanitizeName(m.displayName) }));
  const payload: GroupInvitePayload = {
    id: params.id,
    // v4.32.379: сборка чистит название тем же правилом, что и разбор. Раньше
    // здесь стояло голое .slice(0, 64) — то есть у сборщика и разборщика ссылки
    // правила были разные, и это давало ссылку, которую отвергал собственный же
    // разборщик: название, от которого после чистки ничего не остаётся,
    // проверку `if (!name) return null` не проходит. Нажавший «Пригласительная
    // ссылка» получал её молча, а «Недействительная ссылка приглашения» видел
    // тот, кому он её отправил.
    name: sanitizeName(params.name) ?? FALLBACK_GROUP_NAME,
    type: params.type,
    adminPub: params.adminPub,
    requireApproval: params.requireApproval,
    members,
    // Мусор в поле token хуже пустого места: получатель сверил бы с ним свой
    // токен и отказал бы по ссылке, которую сам же и выдал.
    ...(isInviteToken(params.token) ? { token: params.token } : {}),
  };
  // v4.32.581: алфавит base64url, а не обычный base64. Обычный содержит '/',
  // а обработчик ссылки в App.tsx режет путь по '/' и берёт только первый
  // кусок — то есть каждая ссылка приходила получателю обрезанной и падала на
  // JSON.parse с «Недействительная ссылка приглашения». Проверил на пятистах
  // правдоподобных приглашениях: '/' был во всех пятистах, так что не работало
  // не «иногда», а всегда. В алфавите base64url '/' и '+' заменены на '_' и
  // '-', разбор принимает оба алфавита, и старые ссылки (те, что дошли целыми)
  // читаются по-прежнему.
  return INVITE_LINK_PREFIX + toBase64Url(Buffer.from(JSON.stringify(payload)).toString('base64'));
}

/** Обычный base64 → base64url: '+/'→'-_', хвостовые '=' не нужны. */
function toBase64Url(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Разбирает недоверенную ссылку. null — ссылка не наша или не проходит проверку
 * формы; вызывающему остаётся показать «Недействительная ссылка приглашения».
 *
 * Принимает и полную ссылку, и только base64-хвост (deep link приходит уже
 * разрезанным по '/').
 */
export function parseGroupInviteLink(input: string): GroupInvitePayload | null {
  const b64 = input.startsWith(INVITE_LINK_PREFIX)
    ? input.slice(INVITE_LINK_PREFIX.length)
    : input;
  if (!b64 || b64.length > INVITE_B64_MAX) return null;

  let raw: unknown;
  try {
    // Оба алфавита сразу: свои новые ссылки приходят в base64url, свои старые —
    // в обычном base64, и разбор не должен зависеть от того, какая версия
    // приложения ссылку выдала.
    raw = JSON.parse(Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Partial<GroupInvitePayload>;

  if (typeof p.id !== 'string' || p.id.length === 0 || p.id.length > 64) return null;
  if (!isB64_32(p.adminPub)) return null;
  const name = sanitizeName(p.name);
  if (!name) return null;

  // v4.32.513: вида нет у ссылок прежних версий — для них ответ прежний,
  // 'group'. Мусор в поле тоже даёт 'group', а не отказ от ссылки целиком: то
  // же решение, что у token, и по той же причине — отказ здесь означал бы
  // «Недействительная ссылка приглашения» там, где разобрать можно всё
  // остальное. Вид из ссылки, как и requireApproval, остаётся подсказкой:
  // ссылку правит кто угодно, а решение принимает принимающая сторона.
  const type: SendGroupType = isGroupType(p.type) ? p.type : 'group';

  // v4.32.260: members стал необязательным. Ссылки, выданные основной кнопкой
  // до этой правки, поля не несут вовсе — раньше они отвергались целиком,
  // теперь читаются как приглашение с пустым списком.
  const rawMembers = Array.isArray(p.members) ? p.members : [];
  if (rawMembers.length > 512) return null;
  const members: InviteMember[] = [];
  for (const m of rawMembers) {
    if (!m || typeof m !== 'object') continue;
    const pub = (m as InviteMember).pub;
    if (!isB64_32(pub)) continue;
    if (members.some((x) => x.pub === pub)) continue;
    members.push({ pub, name: sanitizeName((m as InviteMember).name) });
    if (members.length >= INVITE_MEMBERS_CAP) break;
  }

  // v4.32.303: битый токен вырезается, а не отвергает ссылку целиком. Отказ
  // здесь означал бы «Недействительная ссылка приглашения» вместо честного
  // разбора, а решение о допуске всё равно принимает не эта функция: ссылка без
  // токена доедет до приёмника и получит там 'revoked', если токен у него есть.
  const token = isInviteToken(p.token) ? p.token : undefined;

  return {
    id: p.id,
    name,
    type,
    adminPub: p.adminPub,
    requireApproval: !!p.requireApproval,
    members,
    ...(token ? { token } : {}),
  };
}
