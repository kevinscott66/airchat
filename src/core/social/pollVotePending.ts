/**
 * Голоса, пришедшие раньше самого опроса.
 *
 * v4.32.573. Голос едет отдельным служебным конвертом, а опрос — обычным
 * сообщением: разные размеры, разные пути доставки, разная скорость. Порядок
 * между ними не гарантирован ничем. Приёмная сторона с v4.32.342 сверяет голос
 * с самим опросом (иначе строка в poll_votes писалась по любому названному
 * id), и голос, для которого сообщения-опроса ещё нет, отбрасывался с кодом
 * `unknown_message` — навсегда. Через секунду опрос доезжал, но повторить свой
 * голос отправителю уже нечем: переспрашивать голоса никто не умеет.
 *
 * Итог был виден пользователю: у голосовавшего его выбор отмечен, у остальных
 * этого голоса нет вовсе, и счётчики опроса у разных людей расходились
 * навсегда. Чем больше группа, тем вероятнее: конверт голоса рассылается всем
 * участникам сразу, и достаточно одного, до кого опрос доехал позже.
 *
 * Здесь — короткая полка для таких голосов. Голос кладётся на неё, если
 * причина отказа — «сообщения нет», и снимается, когда сообщение с этим id
 * появляется в базе. Все проверки прав при снятии проходят заново: полка
 * хранит конверт, а не разрешение.
 *
 * Полка живёт только в памяти процесса и намеренно: голос — недоверенный
 * конверт из сети, и складывать его в базу до того, как он признан годным,
 * значит дать любому желающему писать в неё что угодно. Перезапуск приложения
 * полку теряет — это ровно то же, что было до этой версии, хуже не станет.
 *
 * Границы. Не больше PENDING_VOTE_MAX записей всего и не дольше
 * PENDING_VOTE_TTL_MS каждая: иначе поток голосов с выдуманными id занимал бы
 * память процесса без всякого предела. Переполнение вытесняет самую старую
 * запись. Повторный голос того же человека по тому же варианту заменяет
 * прежний, а не ложится второй строкой, — иначе передумавший («поставил,
 * снял») дважды применялся бы в неизвестном порядке.
 *
 * v4.32.764: рядом — такая же полка для конвертов завершения опроса, см.
 * {@link ParkedClose}. Границы и правила у неё те же самые.
 *
 * Модуль без импортов: полка проверяется без базы, сети и часов.
 */

/** Сколько голосов ждут своего опроса. Дальше вытесняется самый старый. */
export const PENDING_VOTE_MAX = 200;

/** Сколько голос ждёт опроса. Дольше — опрос уже не придёт. */
export const PENDING_VOTE_TTL_MS = 5 * 60 * 1000;

/** Отложенный голос: конверт как пришёл, плюс профиль-владелец и время. */
export type ParkedVote = {
  readonly pid: number;
  readonly msgId: string;
  readonly senderPubB64: string;
  readonly idx: number;
  readonly on: boolean;
  readonly groupId?: string;
  readonly ts: number;
};

/**
 * Стоит ли откладывать голос с таким отказом.
 *
 * Откладывается ровно один случай: сообщения-опроса ещё нет. Все остальные
 * отказы — чужая группа, не тот диалог, не опрос, вариант вне списка — со
 * временем не меняются, и полка превратилась бы в склад заведомо негодных
 * конвертов. Нечитаемая своя копия (v4.32.574) тоже не откладывается: строка
 * уже лежит в базе и сама собой не расшифруется, ждать нечего.
 */
export function isRetriablePollVoteCode(code: string): boolean {
  return code === 'unknown_message';
}

/**
 * Отложенное завершение: конверт как пришёл, плюс профиль-владелец и время.
 *
 * v4.32.764. У голоса полка есть с v4.32.573, а у завершения не было, хотя
 * обгоняет оно свой опрос по той же самой причине и с теми же шансами: оба
 * едут служебным конвертом, сам опрос — обычным сообщением, и порядок между
 * этими двумя дорогами не гарантирован ничем.
 *
 * Цена пропажи у завершения выше, чем у голоса. Потерянный голос — одна
 * строка, разошедшиеся счётчики. Потерянное завершение оставляет опрос
 * открытым НАВСЕГДА: второй посылки у этого конверта нет (закрыть опрос можно
 * один раз), повторить его автору нечем. Получатель продолжает голосовать в
 * опросе, который для всех остальных давно закрыт, а его голоса на той стороне
 * отбрасываются как «в закрытый опрос» — расход, которого не видит ни одна из
 * сторон.
 *
 * Дедупликация по паре «сообщение + отправитель»: второй конверт завершения от
 * того же человека — это повтор, а не второе событие.
 */
export type ParkedClose = {
  readonly pid: number;
  readonly msgId: string;
  readonly senderPubB64: string;
  readonly groupId?: string;
  readonly ts: number;
};

export type PendingPollCloses = {
  /** Отложить завершение. false — полка отказалась (негодный конверт). */
  park(close: ParkedClose): boolean;
  /** Снять все завершения по этому сообщению; просроченные не отдаются. */
  take(msgId: string, pid: number, now: number): ParkedClose[];
  size(): number;
};

export function createPendingPollCloses(
  max: number = PENDING_VOTE_MAX,
  ttlMs: number = PENDING_VOTE_TTL_MS
): PendingPollCloses {
  const cap = typeof max === 'number' && Number.isFinite(max) && max >= 1 ? Math.floor(max) : PENDING_VOTE_MAX;
  const ttl =
    typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : PENDING_VOTE_TTL_MS;
  let parked: ParkedClose[] = [];
  const same = (a: ParkedClose, b: ParkedClose): boolean =>
    a.pid === b.pid && a.msgId === b.msgId && a.senderPubB64 === b.senderPubB64;
  return {
    park(close: ParkedClose): boolean {
      if (!close || typeof close.msgId !== 'string' || close.msgId.length === 0) return false;
      if (typeof close.senderPubB64 !== 'string' || close.senderPubB64.length === 0) return false;
      if (!Number.isFinite(close.ts)) return false;
      parked = parked.filter((p) => !same(p, close));
      parked.push(close);
      while (parked.length > cap) parked.shift();
      return true;
    },
    take(msgId: string, pid: number, now: number): ParkedClose[] {
      const fresh = parked.filter((p) => now - p.ts <= ttl);
      const mine = fresh.filter((p) => p.msgId === msgId && p.pid === pid);
      parked = fresh.filter((p) => !(p.msgId === msgId && p.pid === pid));
      return mine;
    },
    size(): number {
      return parked.length;
    },
  };
}

export type PendingPollVotes = {
  /** Отложить голос. false — полка отказалась (негодный конверт). */
  park(vote: ParkedVote): boolean;
  /** Снять все голоса по этому сообщению; просроченные не отдаются. */
  take(msgId: string, pid: number, now: number): ParkedVote[];
  size(): number;
};

export function createPendingPollVotes(
  max: number = PENDING_VOTE_MAX,
  ttlMs: number = PENDING_VOTE_TTL_MS
): PendingPollVotes {
  const cap = typeof max === 'number' && Number.isFinite(max) && max >= 1 ? Math.floor(max) : PENDING_VOTE_MAX;
  const ttl =
    typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : PENDING_VOTE_TTL_MS;
  let parked: ParkedVote[] = [];
  const sameChoice = (a: ParkedVote, b: ParkedVote): boolean =>
    a.pid === b.pid && a.msgId === b.msgId && a.senderPubB64 === b.senderPubB64 && a.idx === b.idx;
  return {
    park(vote: ParkedVote): boolean {
      if (!vote || typeof vote.msgId !== 'string' || vote.msgId.length === 0) return false;
      if (typeof vote.senderPubB64 !== 'string' || vote.senderPubB64.length === 0) return false;
      if (!Number.isInteger(vote.idx) || vote.idx < 0) return false;
      if (!Number.isFinite(vote.ts)) return false;
      parked = parked.filter((p) => !sameChoice(p, vote));
      parked.push(vote);
      while (parked.length > cap) parked.shift();
      return true;
    },
    take(msgId: string, pid: number, now: number): ParkedVote[] {
      const fresh = parked.filter((p) => now - p.ts <= ttl);
      const mine = fresh.filter((p) => p.msgId === msgId && p.pid === pid);
      // Просроченные не возвращаются, но и не остаются: та же уборка.
      parked = fresh.filter((p) => !(p.msgId === msgId && p.pid === pid));
      return mine;
    },
    size(): number {
      return parked.length;
    },
  };
}
