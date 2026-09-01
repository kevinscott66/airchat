/**
 * Кнопка-микрофон: что происходит между нажатием и отпусканием (v4.32.493).
 *
 * Рекордер заводится не мгновенно: между нажатием и работающей записью стоят
 * два ожидания — переключение звукового режима и подготовка рекордера. Ссылка
 * на него до v4.32.493 присваивалась только ПОСЛЕ них, а отпускание проверяло
 * именно эту ссылку и при пустой молча выходило. Короткое нажатие целиком
 * помещается в это окно: отпускание терялось, запись начиналась уже никем не
 * ожидаемая и шла дальше без конца — вместе с двумя таймерами. Повторное
 * нажатие заводило второй рекордер поверх первого, а первый продолжал держать
 * микрофон до перезапуска приложения.
 *
 * Здесь это сведено к трём состояниям и одному номеру нажатия. Номер нужен,
 * потому что решение «оставлять ли запись» принимается ПОСЛЕ ожиданий, когда
 * нажатие может быть уже не то же самое.
 *
 * Модуль намеренно без импортов: его можно проверить без микрофона и без
 * отрисовки экрана.
 */

export type RecorderPhase = 'idle' | 'starting' | 'recording';

export type RecorderGate = {
  phase: RecorderPhase;
  /** Номер текущего нажатия; растёт с каждым принятым нажатием. */
  token: number;
};

export const IDLE_GATE: RecorderGate = { phase: 'idle', token: 0 };

/**
 * Палец опустился. `start` — заводить ли рекордер; `false` означает, что
 * предыдущее нажатие ещё не отработало и второй рекордер заводить нельзя.
 */
export function pressIn(g: RecorderGate): { gate: RecorderGate; start: boolean; token: number } {
  if (g.phase !== 'idle') return { gate: g, start: false, token: g.token };
  const token = g.token + 1;
  return { gate: { phase: 'starting', token }, start: true, token };
}

/**
 * Рекордер готов. `keep` — оставлять ли запись. `false` означает, что нажатие
 * уже отпущено (или сменилось другим), и подготовленную запись надо свернуть
 * тут же, не показывая её на экране.
 */
export function ready(g: RecorderGate, token: number): { gate: RecorderGate; keep: boolean } {
  if (g.phase !== 'starting' || g.token !== token) return { gate: g, keep: false };
  return { gate: { phase: 'recording', token }, keep: true };
}

/**
 * Палец поднялся — или экран уходит. `stop` — есть ли что останавливать прямо
 * сейчас; если запись ещё готовится, её свернёт `ready`, увидев чужое
 * состояние.
 */
export function pressOut(g: RecorderGate): { gate: RecorderGate; stop: boolean } {
  return { gate: { phase: 'idle', token: g.token }, stop: g.phase === 'recording' };
}

/**
 * Запуск не удался. Возврат в исходное — но только если это всё ещё то же
 * нажатие: иначе ошибка старого запуска заблокировала бы новый.
 */
export function failed(g: RecorderGate, token: number): RecorderGate {
  return g.token === token ? { phase: 'idle', token } : g;
}
