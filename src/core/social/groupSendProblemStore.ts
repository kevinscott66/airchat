/**
 * След несостоявшейся рассылки группового сообщения (v4.32.951).
 *
 * Своя строка в группе пишется в базу ДО рассылки — иначе собственное
 * сообщение не появилось бы на собственном экране. Исход рассылки с v4.32.450
 * разбирается и называется вслух (`announceGroupSend`), но живёт этот ответ
 * ровно столько, сколько висит всплывающая плашка. Дальше сообщение остаётся
 * в переписке неотличимым от дошедшего: под ним стоит галочка, а в окне
 * сведений написано «Отправлено» — при том, что не ушло оно никому.
 *
 * Для группы это не поправимо повтором: `groupSendProblemText` так и говорит —
 * «повтора у групповых сообщений нет». Тем важнее, чтобы отметка не исчезала
 * вместе с плашкой: человек, вернувшийся в группу через час, обязан видеть,
 * какие из его сообщений остались только у него.
 *
 * Отдельная запись, а не столбец в `group_messages`: столбец пришлось бы
 * заводить миграцией, проводить через разбор строки и через резервную копию,
 * тогда как сведения эти — сугубо местные (у другого устройства того же
 * человека исход рассылки был свой) и в копию как раз не просятся.
 *
 * Шифртекстом: в записи лежат id сообщений и числа участников, то есть размер
 * группы и частота отказов — то же самое, ради чего шифруется `seen_by`.
 */

import { log } from '../logger';
import { createSerialRunner } from '../../notifications/lifecycleQueue';
import {
  scopedKvTryGetSecretFor,
  scopedKvSetSecretCheckedFor,
} from '../storage/profileScopedKv';
import { notifyChatStorageChanged } from '../storage/local';
import type { GroupSendProblem } from './groupSendOutcome';

const SEND_PROBLEMS_KEY = 'groups:send_problems';

/**
 * Сколько отметок держим. Отказы редки, но у застрявшего без сети телефона их
 * может накопиться сотнями, а запись читается целиком при каждом заходе в
 * группу. Лишние — самые старые: свежий отказ человеку нужнее прошлогоднего.
 */
const SEND_PROBLEMS_MAX = 200;

/** Отметка: что не так и когда это выяснилось. */
export type GroupSendProblemMark = { at: number; problem: GroupSendProblem };

/** Карта «id сообщения → отметка». */
export type GroupSendProblemMap = Record<string, GroupSendProblemMark>;

/** Разбор одной отметки. Чужое и битое отбрасывается молча, а не роняет карту. */
function parseMark(raw: unknown): GroupSendProblemMark | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as { at?: unknown; problem?: unknown };
  if (typeof rec.at !== 'number' || !Number.isFinite(rec.at)) return null;
  const p = rec.problem;
  if (typeof p !== 'object' || p === null) return null;
  const kind = (p as { kind?: unknown }).kind;
  if (kind !== 'denied' && kind !== 'undelivered' && kind !== 'partial') return null;
  return { at: rec.at, problem: p as GroupSendProblem };
}

/** Разбор всей карты. Чужой формат — пустая карта, а не отказ чтения. */
function parseMap(raw: string | null): GroupSendProblemMap {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn('group_send_problems_unparsable', {});
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const out: GroupSendProblemMap = {};
  for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
    const mark = parseMark(v);
    if (mark) out[id] = mark;
  }
  return out;
}

/**
 * Прочитать карту отметок профиля.
 *
 * `null` — «не знаем»: база не ответила либо шифртекст не открылся. Писать
 * поверх такого ответа нельзя (то же правило и по той же причине, что у карты
 * «кому уже сказано» в presencePrefSync), а показывать по нему «всё дошло» —
 * тем более.
 */
export async function loadGroupSendProblemsFor(pid: number): Promise<GroupSendProblemMap | null> {
  const read = await scopedKvTryGetSecretFor(pid, SEND_PROBLEMS_KEY);
  return read === null ? null : parseMap(read.value);
}

/**
 * Оставить самые свежие SEND_PROBLEMS_MAX отметок.
 *
 * При равном времени старшинство решает порядок в записи: новые ключи
 * добавляются в конец, и он единственный отличает отметки, сделанные в одну и
 * ту же миллисекунду. Без этой оговорки устойчивая сортировка оставляла бы при
 * массовом отказе (потеряна связь, двести сообщений подряд) ровно самые старые.
 */
function trim(map: GroupSendProblemMap): GroupSendProblemMap {
  const ids = Object.keys(map);
  if (ids.length <= SEND_PROBLEMS_MAX) return map;
  const keep = ids
    .map((id, i) => ({ id, i }))
    .sort((a, b) => map[b.id].at - map[a.id].at || b.i - a.i)
    .slice(0, SEND_PROBLEMS_MAX);
  const out: GroupSendProblemMap = {};
  for (const { id } of keep) out[id] = map[id];
  return out;
}

/**
 * Дорожка записи (v4.32.988).
 *
 * Карта читается перед КАЖДОЙ записью и пишется целиком, а между чтением и
 * записью стоит await. Пишущих же много и друг о друге они не знают: обе
 * отметки ставятся из `announceGroupSend` через `void`, то есть по одной на
 * каждое разосланное сообщение, и приходят они тогда, когда ответила
 * рассылка. Ровно в тот момент, ради которого вся запись и заведена — сеть
 * пропала, и подряд не уходит десяток сообщений, — ответы приходят пачкой.
 *
 * Второй пишущий успевал прочитать карту до того, как первый её записал, и
 * ложился поверх: оставалась одна отметка из нескольких. Пропажа молчаливая,
 * а стоит она того же, что и в v4.32.951: сообщение, не ушедшее никому,
 * снова выглядит отправленным — с галочкой и словом «Отправлено».
 *
 * Правило и дорожка те же, что у закреплений (groupPinSync, v4.32.675):
 * следующая запись начинается после того, как предыдущая закончилась.
 * Дорожка одна на модуль — запись местная и короткая, а карта дорожек по
 * профилю росла бы без потолка. Стирание отметок идёт по той же дорожке: оно
 * читает и пишет ту же самую карту.
 */
const problemWrites = createSerialRunner();

/**
 * Отметить сообщение как не дошедшее. Отвечает, легла ли отметка.
 *
 * Не прочитали — не пишем: иначе одна свежая отметка заменила бы собой всю
 * карту, и прежние несостоявшиеся сообщения снова выглядели бы отправленными.
 */
export async function recordGroupSendProblemFor(
  pid: number,
  msgId: string,
  problem: GroupSendProblem,
): Promise<boolean> {
  return problemWrites(() => recordGroupSendProblemSerial(pid, msgId, problem));
}

async function recordGroupSendProblemSerial(
  pid: number,
  msgId: string,
  problem: GroupSendProblem,
): Promise<boolean> {
  const stored = await loadGroupSendProblemsFor(pid);
  if (stored === null) {
    log.warn('group_send_problem_not_recorded', { id: msgId.slice(0, 8) });
    return false;
  }
  const merged = trim({ ...stored, [msgId]: { at: Date.now(), problem } });
  const ok = await scopedKvSetSecretCheckedFor(pid, SEND_PROBLEMS_KEY, JSON.stringify(merged));
  if (!ok) {
    log.warn('group_send_problem_write_failed', { id: msgId.slice(0, 8) });
    return false;
  }
  // Экран группы перечитывает сообщения по этой же шине — отметка появляется
  // под сообщением сразу, а не при следующем заходе.
  notifyChatStorageChanged();
  return true;
}

/**
 * Забыть отметки удалённых сообщений.
 *
 * Отметка пережила бы своё сообщение и всплыла бы на чужом: id групповых
 * сообщений приходят из конвертов, и у другого профиля того же телефона они
 * свои, но карта — профиля, а не группы. Вызывается там же, где строка
 * вычёркивается из базы.
 */
export async function forgetGroupSendProblemsFor(pid: number, msgIds: string[]): Promise<void> {
  if (msgIds.length === 0) return;
  return problemWrites(() => forgetGroupSendProblemsSerial(pid, msgIds));
}

async function forgetGroupSendProblemsSerial(pid: number, msgIds: string[]): Promise<void> {
  const stored = await loadGroupSendProblemsFor(pid);
  if (stored === null) return;
  let changed = false;
  const out: GroupSendProblemMap = { ...stored };
  for (const id of msgIds) {
    if (id in out) {
      delete out[id];
      changed = true;
    }
  }
  if (!changed) return;
  await scopedKvSetSecretCheckedFor(pid, SEND_PROBLEMS_KEY, JSON.stringify(out));
}
