/**
 * Закрепление сообщений в группе: локальная запись + рассылка остальным.
 *
 * v4.32.233. До этой версии «Закрепить» писало ТОЛЬКО в свой kv
 * (`group_pinned_list_<id>`) и в свою строку groups.pinned_message_id —
 * баннер появлялся у одного человека, у остальных не менялось ничего. Тот же
 * класс бага, что уже закрыт для приглашений, реакций, правки и удаления.
 *
 * Заодно изменён формат kv: раньше рядом с id лежала КОПИЯ текста сообщения
 * открытым текстом, хотя сами сообщения и groups.pinned_message_text
 * шифруются at-rest (CRIT-4). Теперь в kv только id, текст всегда читается из
 * group_messages — и не расходится с оригиналом после правки. Старый формат
 * (массив объектов) на чтении понимается.
 */
import { setGroupPinnedMessage, listGroupMembers, getGroup, getGroupMessageTexts } from '../storage/local';
import { scopedKvSetFor, scopedKvTryGetFor } from '../storage/profileScopedKv';
import { profileManager } from '../identity/profileManager';
import { canPinInGroup, type PinRole } from './groupPinPolicy';
import { createSerialRunner } from '../../notifications/lifecycleQueue';
import type { GroupControlOutcome } from './groupControlOutcome';
import { log } from '../logger';

/**
 * Закреплённое сообщение так, как его показывают.
 *
 * v4.32.576: `unreadable` — своя копия сообщения есть, но ключом данных не
 * открывается. Текст в таком случае остаётся пустым: пометка живёт РЯДОМ с
 * текстом, а не вместо него (см. unreadableText) — подменённая строка ушла бы
 * дальше как настоящая.
 */
export type PinnedEntry = { id: string; text: string; unreadable: boolean };

/** Сколько закреплённых держим на группу. */
const MAX_PINNED = 50;

function pinListKey(groupId: string): string {
  return `group_pinned_list_${groupId}`;
}

/**
 * id закреплённых, свежие первыми. Понимает и старый формат `{id, text}`.
 *
 * v4.32.484: запись живёт в namespace профиля. До этого имя ключа состояло из
 * одного id группы — а в одной группе человек может состоять двумя аккаунтами
 * сразу, и id сообщений там общие. Список закреплений у них был один: то, что
 * один аккаунт открепил, исчезало и у второго, а уборка удалённого профиля
 * (`p<id>:%`) под общее имя не подпадала.
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
async function readPinnedIds(groupId: string, ownerProfileId: number): Promise<string[] | null> {
  const read = await scopedKvTryGetFor(ownerProfileId, pinListKey(groupId));
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
export async function loadPinnedIds(groupId: string, ownerProfileId: number): Promise<string[]> {
  return (await readPinnedIds(groupId, ownerProfileId)) ?? [];
}

/**
 * Закреплённые с актуальным текстом. Сообщения, которых уже нет (удалены),
 * из списка выпадают — иначе баннер показывал бы фантом.
 *
 * v4.32.576: `null` от getGroupMessageTexts значит «строка есть, но не
 * открылась». Раньше `?? ''` равняло её с пустым текстом, и закрепление
 * показывалось пустой полоской в шапке — ровно как объявление без текста.
 * Отсутствие ключа по-прежнему выбрасывает id из списка: сообщения нет.
 */
export async function resolvePinned(groupId: string, ownerProfileId: number): Promise<PinnedEntry[]> {
  const ids = await loadPinnedIds(groupId, ownerProfileId);
  if (!ids.length) return [];
  const texts = await getGroupMessageTexts(ids, groupId, ownerProfileId);
  const out: PinnedEntry[] = [];
  for (const id of ids) {
    if (!texts.has(id)) continue;
    const text = texts.get(id) ?? null;
    out.push({ id, text: text === null ? '' : text.slice(0, 120), unreadable: text === null });
  }
  return out;
}

/**
 * Дорожка записи закреплений (v4.32.675).
 *
 * Список читается перед КАЖДОЙ записью и пишется целиком. Пишущих же двое и
 * они друг о друге не знают: своё нажатие «Закрепить» и входящий конверт `pin`
 * от другого участника (groupMessaging). Между чтением списка и записью стоит
 * await, и второй успевает прочитать тот же список до того, как первый его
 * записал: одно из двух закреплений пропадает молча — ни ошибки, ни повтора,
 * а у остальных участников оно есть, потому что конверт уже разошёлся.
 *
 * Правило то же, что у службы уведомлений (lifecycleQueue): следующая запись
 * начинается только после того, как предыдущая закончилась. Дорожка одна на
 * модуль, а не на группу: запись местная и короткая, а карта дорожек по id
 * группы росла бы без потолка.
 */
const pinWrites = createSerialRunner();

/** Пишет закрепление в kv + groups.pinned_message_id/text. */
export async function applyLocalPin(params: {
  groupId: string;
  ownerProfileId: number;
  msgId: string;
  on: boolean;
}): Promise<PinnedEntry[] | null> {
  return pinWrites(() => applyLocalPinSerial(params));
}

async function applyLocalPinSerial(params: {
  groupId: string;
  ownerProfileId: number;
  msgId: string;
  on: boolean;
}): Promise<PinnedEntry[] | null> {
  const { groupId, ownerProfileId, msgId, on } = params;
  // v4.32.643: список не прочитался — не пишем ничего. Прежде сюда приходил
  // пустой массив, и объявление группы сводило все закрепления к одному.
  const current = await readPinnedIds(groupId, ownerProfileId);
  if (current === null) {
    log.warn('group_pin_list_read_failed', { gid: groupId.slice(0, 8), pid: ownerProfileId });
    return null;
  }
  const nextIds = on
    ? [msgId, ...current.filter((id) => id !== msgId)].slice(0, MAX_PINNED)
    : current.filter((id) => id !== msgId);
  await scopedKvSetFor(ownerProfileId, pinListKey(groupId), JSON.stringify(nextIds));
  const entries = await resolvePinned(groupId, ownerProfileId);
  // v4.32.576: непрочитанное закрепление не записываем текстом. Раньше сюда
  // уходила пустая строка, groups.pinned_message_text шифровался ею поверх
  // прежнего значения — и «не открылось» превращалось в «пусто» уже насовсем,
  // без обратного хода. Пишем null: id закрепления остаётся, текста нет.
  const top = entries[0] ?? null;
  await setGroupPinnedMessage(
    groupId,
    ownerProfileId,
    top?.id ?? null,
    top && !top.unreadable ? top.text : null
  );
  return entries;
}

/**
 * Убирает из закреплённых всё (кнопка «Открепить все»).
 *
 * Тоже по очереди: иначе «открепить всё» и одновременное закрепление могли
 * закончиться пустым списком в kv и живым id в groups.pinned_message_id.
 */
export async function clearPinned(groupId: string, ownerProfileId: number): Promise<void> {
  await pinWrites(async () => {
    await scopedKvSetFor(ownerProfileId, pinListKey(groupId), '[]');
    await setGroupPinnedMessage(groupId, ownerProfileId, null, null);
  });
}

/** Роль в группе по собственному публичному ключу. */
async function myRoleIn(groupId: string, myPubB64: string, ownerProfileId: number): Promise<PinRole> {
  const members = await listGroupMembers(groupId, ownerProfileId);
  const me = members.find((m) => m.peerPubB64 === myPubB64);
  return (me?.role as PinRole | undefined) ?? 'member';
}

/**
 * Почему закрепление не состоялось (v4.32.453).
 *
 * Раньше все три случая сливались в один null, и экран на любой из них
 * говорил «Нет прав … только администраторы». Двум из трёх это неправда: у
 * человека могли просто не догрузиться ключи профиля или пропасть строка
 * группы. Совет «попросите администратора» в таком положении бесполезен, а
 * настоящая причина не называется никогда.
 */
export type GroupPinRefusal = 'no_identity' | 'no_group' | 'denied' | 'read_failed';

/**
 * Итог закрепления.
 *
 * `sync` — обещание рассылки, а не её результат: баннер рисуется по entries
 * сразу, ждать сети ему незачем. Но выбросить это обещание вызывающий уже не
 * может — закрепление, не ушедшее остальным, не уйдёт никогда: повторной
 * отправки у служебного конверта нет, и «объявление для группы» остаётся
 * висеть в шапке у одного человека.
 */
export type GroupPinResult =
  | { ok: true; entries: PinnedEntry[]; sync: Promise<GroupControlOutcome> }
  | { ok: false; reason: GroupPinRefusal };

/** Record по всем причинам: новая не соберётся, пока ей не написали фразу. */
const REFUSAL: Record<GroupPinRefusal, string> = {
  no_identity: 'Профиль ещё загружается — попробуйте снова через несколько секунд.',
  no_group: 'Группа не найдена — возможно, её только что удалили.',
  denied: 'Закреплять и откреплять сообщения в этой группе могут только администраторы.',
  read_failed: 'Не удалось прочитать закреплённые в этой группе — попробуйте ещё раз.',
};

/** Текст отказа для человека. */
export function groupPinRefusalText(reason: GroupPinRefusal): string {
  return REFUSAL[reason];
}

/**
 * Закрепляет/открепляет и рассылает решение остальным участникам.
 */
export async function togglePinAndSync(params: {
  groupId: string;
  msgId: string;
  on: boolean;
  actorName?: string | null;
}): Promise<GroupPinResult> {
  const { groupId, msgId, on } = params;
  // v4.32.480: номер профиля и свой открытый ключ — одним чтением. Раньше
  // номер брался у profileManager, а ключ у устройства (loadKeyPair), и между
  // двумя чтениями помещалось переключение аккаунта: закрепление уходило под
  // номером одного профиля и ключом другого — связывало два аккаунта одного
  // человека на глазах у участников, а у них же его отбрасывал анти-спуф.
  const me = profileManager.getActiveIdentity();
  if (!me) return { ok: false, reason: 'no_identity' };
  const { pid, myPubB64: myPub } = me;

  const group = await getGroup(groupId, pid);
  if (!group) return { ok: false, reason: 'no_group' };
  const role = await myRoleIn(groupId, myPub, pid);
  // Та же функция, что и на приёме: расхождение здесь означало бы, что своё
  // же закрепление у остальных молча отбрасывается.
  if (!canPinInGroup({ role, adminOnlyPinning: group.adminOnlyPinning, type: group.type })) {
    log.warn('group_pin_denied_local', { gid: groupId.slice(0, 8), role });
    return { ok: false, reason: 'denied' };
  }

  const entries = await applyLocalPin({ groupId, ownerProfileId: pid, msgId, on });
  // Ничего не записано — и рассылать нечего: у остальных закрепление
  // появилось бы, а у себя нет.
  if (entries === null) return { ok: false, reason: 'read_failed' };
  const { fanoutGroupControl } = await import('./groupMessaging');
  const sync = fanoutGroupControl(groupId, pid, myPub, { op: 'pin', msgId, on }, params.actorName ?? undefined);
  return { ok: true, entries, sync };
}
