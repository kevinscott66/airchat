/**
 * Соединение с сигнальным сервером считается готовым только после рукопожатия.
 *
 * v4.32.551. Подключение к сигнальному серверу состоит из двух шагов: сокет
 * подключается, а затем сервер присылает `registration_challenge`, без которого
 * зарегистрироваться нельзя. Первый шаг убирал за собой аккуратно: при
 * `connect_error` сокет отключался и снимался с поля. Второй — нет. Если
 * challenge не приходил за пять секунд, ожидание падало с ошибкой, а сокет
 * оставался подключённым и присвоенным.
 *
 * Дальше начиналось непоправимое. `connect()` начинался словами «если сокет
 * подключён — возвращаемся», поэтому КАЖДЫЙ следующий вызов немедленно
 * сообщал об успехе, ничего не проверив, а `register()` сразу за ним падал с
 * `registration_challenge_missing`, потому что challenge так и не было.
 * Одна медленная секунда на старте сервера навсегда переводила приложение в
 * состояние «соединён и бесполезен»: звонки не проходили до перезапуска, и
 * починить это было нечем — переподключаться никто уже не пытался.
 *
 * Половинчатое состояние здесь названо своим именем — `half-open` — и оно
 * НЕ считается пригодным для работы, а требует разрыва и новой попытки.
 *
 * Модуль намеренно без импортов.
 */

/** Что мы знаем про текущий сокет. */
export type SocketFacts = {
  /** Сокет вообще создан и присвоен. */
  hasSocket: boolean;
  /** Транспорт поднят. */
  connected: boolean;
  /** Сервер прислал challenge — рукопожатие завершено. */
  challengeReceived: boolean;
};

/**
 * Состояние рукопожатия.
 *
 * `half-open` — сокет подключён, а challenge не пришёл. Именно его прежний код
 * принимал за готовое соединение.
 */
export type HandshakeState = 'absent' | 'connecting' | 'half-open' | 'ready';

/** Сколько ждём challenge, прежде чем признать соединение несостоявшимся. */
export const CHALLENGE_TIMEOUT_MS = 5000;

/** Причина: сервер не прислал challenge за отведённое время. */
export const CHALLENGE_TIMEOUT_REASON = 'registration_challenge_timeout';

/** Причина: сокет отвалился, пока мы ждали challenge. */
export const CHALLENGE_ABORTED_REASON = 'registration_challenge_aborted';

export function classifyHandshake(facts: SocketFacts): HandshakeState {
  if (!facts.hasSocket) return 'absent';
  if (!facts.connected) return 'connecting';
  return facts.challengeReceived ? 'ready' : 'half-open';
}

/**
 * Можно ли переиспользовать соединение как есть.
 *
 * Только `ready`. Раньше на этом месте стояло «сокет подключён», из-за чего
 * `half-open` возвращался как успех и больше никогда не чинился.
 */
export function isReusableConnection(state: HandshakeState): boolean {
  return state === 'ready';
}

/**
 * Нужно ли разорвать соединение перед новой попыткой.
 *
 * `connecting` не трогаем: там socket.io ещё работает сам. Рвём только
 * подключённый сокет без рукопожатия — он занимает место и никуда не ведёт.
 */
export function needsTeardown(state: HandshakeState): boolean {
  return state === 'half-open';
}
