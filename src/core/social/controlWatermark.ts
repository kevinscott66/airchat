/**
 * Монотонная отметка времени для служебных конвертов переписки и групп.
 *
 * v4.32.615. Задача: не дать повтору старого кадра откатить настройку.
 *
 * Окно приёма конверта — тридцать суток (`ENVELOPE_MAX_AGE_MS` в messaging.ts,
 * ровно срок хранения на relay). Всё это время кадр остаётся валидным: он
 * подписан, он не протух, и повторно принять его мешает только `seenMessageIds`
 * — множество в памяти, которое обнуляется при перезапуске приложения. У
 * служебных конвертов нет и второй линии: они возвращают управление раньше,
 * чем в базе появится строка с их `messageId`, поэтому `chatMessageExists` их
 * тоже не ловит. Темы relay выводятся из открытых DID, писать в них может
 * любой — значит перехваченный кадр можно послать заново хоть через месяц.
 *
 * Последствия предметные: снятый запрет копирования включается обратно,
 * «последний раз в сети» снова прячется, автоудаление возвращается на старый
 * срок, снятое закрепление возвращается.
 *
 * Лечение то же, что уже применено к профилю контакта (contacts.ts:650) —
 * сравнение с предыдущим `ts`. Здесь оно вынесено в общий модуль, потому что
 * состояний четыре и у каждого свой обработчик.
 *
 * Тем же приёмом закрыты управляющие конверты группы — см. `acceptGroupControlTs`.
 *
 * Отметка хранится через profileScopedKv, а не через голые kvGet/kvSet: те не
 * разделены по профилям (обычный `SELECT v FROM kv WHERE k = ?`), и аккаунты
 * делили бы один водяной знак. Заодно ключ попадает под уборку `p<id>:%` при
 * удалении профиля и отличает «не читается база» от «ещё ничего не было».
 */
import { scopedKvSetCheckedFor, scopedKvTryGetFor } from '../storage/profileScopedKv';
import { log } from '../logger';

export const WATERMARK_PREFIX = 'ctl_ts_v1:';

/**
 * Тот же допуск на расхождение часов, что и у внешней проверки конверта
 * (`ENVELOPE_MAX_SKEW_MS` в messaging.ts). Держать его здесь отдельной
 * константой намеренно: модуль не должен зависеть от службы переписки —
 * иначе получится цикл импортов через контроль-фанаут.
 */
export const CONTROL_TS_MAX_SKEW_MS = 5 * 60 * 1000;

/**
 * Виды состояний, у каждого свой водяной знак.
 *
 * Здесь только СКАЛЯРНЫЕ состояния пары: одно значение на собеседника. Для
 * них «пришло старее уже применённого» и означает откат — отвергнуть верно.
 *
 * Закрепления в личке и реакции сюда намеренно не входят: их состояние
 * привязано к конкретному сообщению, и один водяной знак на собеседника
 * выбросил бы законное закрепление сообщения B, если конверт про A с большей
 * меткой пришёл раньше (relay отдаёт накопленное пачкой, порядок не гарантирован).
 * Им нужна отметка на элемент, а не на пару, — это отдельная работа.
 *
 * `dmpin_clear` — исключение из этого исключения и потому здесь (v4.32.622):
 * «открепить всё» не называет сообщения, оно относится ко всей паре и потому
 * скалярно. Своя ячейка, отдельная от закреплений отдельных сообщений: она их
 * не отвергает и ими не двигается. Без неё повтор одного такого конверта
 * (relay хранит накопленное 30 суток) стирал весь список закреплений заново.
 */
export type ControlKind = 'disappear' | 'copyguard' | 'presence' | 'dmpin_clear';

/** Имя ключа ДО добавления префикса профиля (его дописывает profileScopedKv). */
export function watermarkKey(kind: ControlKind, peerPubB64: string): string {
  return `${WATERMARK_PREFIX}${kind}:${peerPubB64}`;
}

/**
 * Принять решение по метке времени служебного конверта.
 *
 * Возвращает true, если конверт свежее всего, что уже применено к этой паре
 * (профиль, вид состояния, собеседник), и отметка сдвинута вперёд. false —
 * если это повтор, откат или заведомо испорченная метка.
 *
 * Метку из будущего дальше допуска на часы отвергаем: честный отправитель
 * такую не поставит (внешняя проверка конверта отсекает его же по
 * `em.timestamp` с тем же допуском), а принять её значило бы навсегда закрыть
 * приём — все последующие законные конверты оказались бы «старыми».
 *
 * Ошибка чтения или записи kv трактуется как «пропустить»: приложение без
 * доступа к базе не должно молча переставать применять настройки собеседника.
 * Отказ здесь стоил бы больше, чем окно для повтора, который и так требует
 * перехваченного кадра.
 */
export async function acceptControlTs(
  kind: ControlKind,
  peerPubB64: string,
  pid: number,
  ts: number
): Promise<boolean> {
  return acceptTs(watermarkKey(kind, peerPubB64), kind, pid, ts);
}

/**
 * Та же проверка для личной переписки, но БЕЗ сдвига отметки (v4.32.655).
 *
 * Ровно та же пара, что `groupControlTsFresh` и `commitGroupControlTs` в
 * группе, и заведена по той же причине: `acceptControlTs` двигает знак ДО
 * применения, а применение умеет не удаться. Тогда изменение не применено, но
 * знак уже стоит, и повторная присылка того же конверта отвергается как
 * повтор — отказ становится вечным. Пара «проверить свежесть → применить →
 * сдвинуть» оставляет отправителю возможность повторить.
 *
 * Пара к ней — {@link commitControlTs}; её вызывают ровно тогда, когда
 * изменение действительно применено.
 */
export async function controlTsFresh(
  kind: ControlKind,
  peerPubB64: string,
  pid: number,
  ts: number
): Promise<boolean> {
  return freshTs(watermarkKey(kind, peerPubB64), kind, pid, ts);
}

/** Сдвинуть отметку личной переписки — после того, как изменение применено. */
export async function commitControlTs(
  kind: ControlKind,
  peerPubB64: string,
  pid: number,
  ts: number
): Promise<void> {
  await commitTs(watermarkKey(kind, peerPubB64), kind, pid, ts);
}

/**
 * Слоты водяного знака внутри группы (v4.32.615).
 *
 * `m:<ключ участника>` — состав и роль ЭТОГО человека: один скаляр, который
 * меняют ban, unban, kick, add, role и «вышел сам». Все они спорят за одно
 * значение, поэтому и знак у них общий: пришедшее старее применённого — откат.
 *
 * `meta:<поле>` — по знаку НА КАЖДОЕ поле настроек, а не один на группу.
 * Настройки группы — не скаляр, их десяток и меняют их независимо; relay
 * отдаёт накопленное пачкой без гарантии порядка, и общий знак выбросил бы
 * законное переименование, пришедшее следом за более поздней сменой аватара.
 */
export type GroupControlSlot = `m:${string}` | `meta:${string}`;

/**
 * Идентификатор группы идёт ПОСЛЕДНИМ, и это не косметика: кодек ограничивает
 * его только длиной (128 символов), двоеточие в нём допустимо. Стой он в
 * середине — группа с именем вида «A:m:<ключ>» подобрала бы себе ключ чужого
 * слота. Слот же формы не выбирает: это либо `m:` с ключом в base64 (двоеточий
 * не бывает), либо `meta:` с полем из закрытого списка.
 */
export function groupWatermarkKey(slot: GroupControlSlot, groupId: string): string {
  return `${WATERMARK_PREFIX}grp:${slot}:${groupId}`;
}

/**
 * То же решение, что и `acceptControlTs`, но для управляющих конвертов группы.
 *
 * Повтор здесь стоит дороже, чем в личной переписке: конверт применяется от
 * имени того, кто подписал ОРИГИНАЛ, а его права проверяются по текущему
 * составу. Разжалованный администратор, чей конверт «назначить админом» кто-то
 * перехватил, возвращает себе права у каждого участника — отправитель-то
 * остался администратором. Тем же приёмом снимается бан, возвращается
 * исключённый, отменяется отзыв пригласительной ссылки и включается обратно
 * автоудаление переписки.
 *
 * Хуже того, повтор проходил молча: идентификатор системной строки собирается
 * из `ts` операции, при повторе он тот же, INSERT OR IGNORE ничего не пишет —
 * роль менялась, а строки «X назначен(а) администратором» на экране не было.
 */
export async function acceptGroupControlTs(
  slot: GroupControlSlot,
  groupId: string,
  pid: number,
  ts: number
): Promise<boolean> {
  return acceptTs(groupWatermarkKey(slot, groupId), groupKindLabel(slot), pid, ts);
}

/**
 * Та же проверка, но БЕЗ сдвига отметки (v4.32.618).
 *
 * Нужна там, где решение «применить» принимается уже после проверки прав и
 * может кончиться ничем: ban по уже забаненному, role с той же ролью, add по
 * уже состоящему — все эти ветки возвращают управление, ничего не изменив.
 * Сдвинутая отметка при этом оставалась бы навсегда, и следующий конверт с
 * меньшей меткой отвергался бы как повтор, хотя применить его было надо.
 *
 * Пример, который это ломало: `add` (ts=T1) и `role` (ts=T2 > T1) пришли
 * пачкой в обратном порядке. `role` не нашёл участника и вышел, но знак уже
 * стоял на T2 — и `add` с T1 отвергался. Человек исчезал из группы навсегда.
 *
 * Пара к ней — `commitGroupControlTs`, её вызывают ровно тогда, когда
 * изменение действительно применено.
 */
export async function groupControlTsFresh(
  slot: GroupControlSlot,
  groupId: string,
  pid: number,
  ts: number
): Promise<boolean> {
  return freshTs(groupWatermarkKey(slot, groupId), groupKindLabel(slot), pid, ts);
}

/** Сдвинуть отметку слота вперёд — после того, как изменение применено. */
export async function commitGroupControlTs(
  slot: GroupControlSlot,
  groupId: string,
  pid: number,
  ts: number
): Promise<void> {
  await commitTs(groupWatermarkKey(slot, groupId), groupKindLabel(slot), pid, ts);
}

/**
 * Слот ОДНОГО сообщения группы — правка и удаление (v4.32.628).
 *
 * Стоит отдельно от {@link groupWatermarkKey}, и идентификатор сообщения здесь
 * последний по той же причине, по которой там последним стоит идентификатор
 * группы: кодек ограничивает и то и другое только длиной, двоеточие внутри
 * допустимо. Две неограниченные части в одном имени подобрали бы друг другу
 * чужую ячейку, поэтому имя группы сюда не входит вовсе — оно и не нужно:
 * сообщение уже найдено в своей группе (`getGroupMessageTarget`), а
 * идентификатор сообщения в базе уникален сам по себе.
 *
 * Знак именно на сообщение, а не на отправителя: правки разных сообщений
 * приходят пачкой без гарантии порядка, и общий знак выбросил бы законную
 * правку сообщения A, пришедшую следом за более поздней правкой B.
 */
export function groupMessageWatermarkKey(msgId: string): string {
  return `${WATERMARK_PREFIX}grp:msg:${msgId}`;
}

/** Свежесть правки сообщения — без сдвига отметки (см. groupControlTsFresh). */
export async function groupMessageTsFresh(msgId: string, pid: number, ts: number): Promise<boolean> {
  return freshTs(groupMessageWatermarkKey(msgId), 'grp:msg', pid, ts);
}

/** Сдвинуть отметку сообщения — после того, как правка или удаление применены. */
export async function commitGroupMessageTs(msgId: string, pid: number, ts: number): Promise<void> {
  await commitTs(groupMessageWatermarkKey(msgId), 'grp:msg', pid, ts);
}

function groupKindLabel(slot: GroupControlSlot): string {
  return `grp:${slot.split(':')[0]}`;
}

async function acceptTs(key: string, kind: string, pid: number, ts: number): Promise<boolean> {
  if (!(await freshTs(key, kind, pid, ts))) return false;
  await commitTs(key, kind, pid, ts);
  return true;
}

async function freshTs(key: string, kind: string, pid: number, ts: number): Promise<boolean> {
  if (!Number.isFinite(ts) || ts <= 0) {
    log.warn('control_ts_malformed', { kind, ts });
    return false;
  }
  if (ts > Date.now() + CONTROL_TS_MAX_SKEW_MS) {
    log.warn('control_ts_future', { kind, ts });
    return false;
  }
  let prev = 0;
  try {
    const got = await scopedKvTryGetFor(pid, key);
    if (got === null) {
      log.warn('control_ts_read_failed', { kind });
      return true;
    }
    const n = got.value === null ? NaN : Number(got.value);
    if (Number.isFinite(n)) prev = n;
  } catch (e) {
    log.warn('control_ts_read_failed', { kind, err: e instanceof Error ? e.message : String(e) });
    return true;
  }
  if (ts <= prev) {
    log.warn('control_ts_replay_rejected', { kind, ts, prev });
    return false;
  }
  return true;
}

/**
 * Сдвиг отметки. Пишет проверенной формой (v4.32.655).
 *
 * Раньше здесь стоял scopedKvSetFor внутри try/catch. Та форма отдаёт void и
 * гасит отказ базы внутри, так что catch не срабатывал ни разу и строки
 * control_ts_write_failed не было в журнале никогда: неудавшийся сдвиг
 * выглядел точно как удавшийся. Само поведение остаётся прежним — пропустить,
 * а не отвергнуть (см. заголовок файла): без доступа к базе приложение не
 * должно переставать применять настройки собеседника. Меняется только то, что
 * причина теперь видна.
 */
async function commitTs(key: string, kind: string, pid: number, ts: number): Promise<void> {
  if (!(await scopedKvSetCheckedFor(pid, key, String(Math.floor(ts))))) {
    log.warn('control_ts_write_failed', { kind });
  }
}
