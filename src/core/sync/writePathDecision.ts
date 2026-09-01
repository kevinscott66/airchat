/**
 * Есть ли куда отправлять — и вправе ли мы отказать, не попробовав.
 *
 * v4.32.550. Перед каждой отправкой приложение спрашивало у системы, есть ли
 * интернет, и по одному этому ответу решало, отправлять ли вообще. Два разных
 * дефекта росли из этого места.
 *
 * Первый. Сообщения ходят не только через интернет: LAN — транспорт первого
 * приоритета, он доставляет двум телефонам в одной Wi‑Fi сети напрямую через
 * mDNS. Wi‑Fi без выхода наружу — обычное дело: роутер без аплинка, гостиничная
 * сеть, офис за упавшим провайдером. В такой сети `isInternetReachable` — ложь,
 * и отправка отказывалась даже начинать, хотя пир был найден и доставка заняла
 * бы миллисекунды. Транспортный слой умел это, а до него не доходило.
 *
 * Второй. Если сам опрос сети падал (нативный модуль не ответил, разрешение
 * отозвано), это записывалось как «интернета нет». Над тем кодом стоял
 * комментарий, что провалившийся опрос не должен превращать отправку в отказ, —
 * а результат делал ровно это. Незнание выдавалось за факт, и человек читал
 * «Нет интернет‑соединения» при работающей сети.
 *
 * Правило: отказываем, только когда сеть сама сказала «нет» И локального пути
 * тоже нет. Незнание — не отказ: пусть отправка попробует и провалится честно.
 *
 * Модуль намеренно без импортов.
 */

/** Что мы узнали у системы про сеть. */
export type NetworkProbe = {
  /** Опрос не удался — ответа нет вообще (это НЕ то же самое, что «нет сети»). */
  failed: boolean;
  /** Подключены ли к какой-либо сети. `null` — система не сказала. */
  connected: boolean | null;
  /** Виден ли интернет за этой сетью. `null` — система не сказала. */
  internetReachable: boolean | null;
};

/** Ответ системы, приведённый к четырём различимым случаям. */
export type WriteReachability = 'probe-failed' | 'unknown' | 'disconnected' | 'no-internet' | 'online';

/** Что делать с отправкой. */
export type WritePath = 'allow' | 'allow-local-only' | 'block-offline';

/**
 * Текст отказа. Говорит про обе дороги сразу, потому что отказ теперь значит,
 * что не нашлось ни одной, — а не только что «нет интернета».
 */
export const NO_WRITE_PATH_TEXT =
  'Нет сети: ни интернета, ни устройств поблизости. Данные доступны из кэша.';

/**
 * Разобрать ответ системы.
 *
 * `probe-failed` и `unknown` намеренно разные: в первом случае спросить не
 * получилось, во втором система ответила «не знаю». Решение у них совпадает,
 * но в журнале это две разные истории.
 */
export function classifyReachability(probe: NetworkProbe): WriteReachability {
  if (probe.failed) return 'probe-failed';
  if (probe.connected === false) return 'disconnected';
  if (probe.internetReachable === false) return 'no-internet';
  if (probe.connected === null && probe.internetReachable === null) return 'unknown';
  return 'online';
}

/** Знает ли система вообще, что сети нет. Незнание сюда не входит. */
export function isDefiniteNoInternet(reach: WriteReachability): boolean {
  return reach === 'disconnected' || reach === 'no-internet';
}

/**
 * Решить, отправлять ли.
 *
 * `localPathAvailable` — виден ли получатель по локальному транспорту (LAN,
 * Wi‑Fi Direct). Он и есть та дорога, которую прежний код не замечал.
 */
export function decideWritePath(reach: WriteReachability, localPathAvailable: boolean): WritePath {
  if (!isDefiniteNoInternet(reach)) return 'allow';
  return localPathAvailable ? 'allow-local-only' : 'block-offline';
}

/** Отказ — единственное состояние, при котором отправка не начинается. */
export function isWriteBlocked(path: WritePath): boolean {
  return path === 'block-offline';
}
