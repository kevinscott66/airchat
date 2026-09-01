/**
 * liveLocSelect — какая сессия живой геолокации относится к этому экрану и
 * когда пора убрать полосу «остановить».
 *
 * v4.32.524. Реестр запущенных сессий живёт в модуле liveLocationService и
 * переживает размонтирование экрана, а номер сессии хранился только в
 * состоянии React. ChatThreadView пересоздаётся на каждого собеседника, так
 * что стоило выйти из переписки или переключиться на другую — и полоса
 * «Живая геолокация активна — нажмите, чтобы остановить» исчезала навсегда,
 * а сама сессия продолжала снимать координаты каждые полминуты и отправлять
 * их собеседнику до восьми часов. Единственной кнопки остановки у человека
 * больше не было: оставалось закрыть приложение целиком.
 *
 * Чтобы экран мог спросить реестр при входе, выбор сессии вынесен сюда — в
 * модуль без единого импорта. В liveLocationService лежат uuid,
 * expo-location и профили, и проверить сам выбор отдельно от них было
 * нельзя, а именно в нём была тонкость: у сессии в группе поле peerPubB64
 * пустое, и поиск по собеседнику с пустым ключом натыкался бы на групповую
 * сессию. Ветки разделены явно.
 *
 * Время передаётся аргументом, а не читается из часов: у истечения сессии
 * ровно один смысл — «expireAt уже позади», и проверять его надо на любой
 * заданный момент, а не только на текущий.
 */

/** То, что нужно знать о сессии, чтобы её выбрать. Реальная запись шире. */
export type LiveLocSessionView = {
  liveId: string;
  /** Ключ собеседника для личной переписки; у групповой сессии пустой. */
  peerPubB64: string;
  /** Идентификатор группы либо null для личной переписки. */
  groupId: string | null;
  expireAt: number;
};

export type LiveLocTarget = {
  peerPubB64: string;
  groupId?: string | null;
};

/**
 * Найти живую (не истёкшую) сессию для переписки или группы.
 *
 * Возвращает первую подходящую: сессий на один адрес больше одной быть не
 * должно — startLiveLocSession останавливает предыдущую, — но если реестр
 * всё-таки разъехался, показать одну лучше, чем не показать ни одной.
 */
export function pickLiveLocSession<T extends LiveLocSessionView>(
  sessions: Iterable<T>,
  target: LiveLocTarget,
  now: number,
): T | null {
  const groupId = target.groupId ?? null;
  if (groupId) {
    for (const s of sessions) {
      if (s.groupId === groupId && s.expireAt > now) return s;
    }
    return null;
  }
  // Пустой ключ собеседника — не адрес, а отсутствие адреса: под него
  // подходила бы любая групповая сессия.
  if (!target.peerPubB64) return null;
  for (const s of sessions) {
    if (s.groupId === null && s.peerPubB64 === target.peerPubB64 && s.expireAt > now) return s;
  }
  return null;
}

export type LiveLocBanner = {
  liveId: string;
  /** Через сколько миллисекунд полосу пора убрать. Всегда больше нуля. */
  clearAfterMs: number;
};

/**
 * Что показать в шапке переписки и когда это убрать.
 *
 * Экран не может положиться на onExpire: тот замкнут на монтирование, при
 * котором сессию завели, и после переоткрытия переписки убирает полосу уже у
 * несуществующего экрана. Поэтому вошедший заново заводит свой таймер.
 */
export function liveLocBannerFor(
  session: LiveLocSessionView | null | undefined,
  now: number,
): LiveLocBanner | null {
  if (!session) return null;
  const clearAfterMs = session.expireAt - now;
  if (clearAfterMs <= 0) return null;
  return { liveId: session.liveId, clearAfterMs };
}
