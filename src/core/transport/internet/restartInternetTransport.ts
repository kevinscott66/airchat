/**
 * Переподнять интернет-транспорт после того, как сменился путь трафика
 * (v4.32.723).
 *
 * Подмена маршрута — включение или выключение туннеля OpenFlux, смена адреса
 * ретранслятора — действует только на НОВЫЕ соединения. Веб-сокет ntfy,
 * главный канал приложения, к этому моменту уже открыт и продолжит идти
 * прежним путём, пока его не закроют. Без перезапуска включение туннеля
 * выглядит как «нажал, и ничего не изменилось», а выключение оставляет
 * трафик в уже погашенном SOCKS5.
 *
 * Сначала остановить, потом поднять заново — иначе координатор помнит, что
 * уже запущен, и старт молча выходит.
 *
 * Отдельным модулем, а не методом экрана: то же самое понадобилось мосту
 * внешнего агента (`core/bridge`), который переключает туннель без участия
 * интерфейса. Две копии этих семи строк разошлись бы на первой же правке, и
 * разошлись бы тихо — на одном из двух путей канал просто остался бы старым.
 */
import { loadKeyPair } from '../../crypto/keyManager';
import type { AppConfig } from '../../config';
import { startInternetTransportIfEnabled, stopInternetTransportStack } from './internetCoordinator';

export async function restartInternetTransport(cfg: AppConfig): Promise<void> {
  stopInternetTransportStack();
  if (cfg.internet?.enabled === false) return;
  const pair = await loadKeyPair();
  // Ключей ещё нет — значит, транспорт и не стартовал: поднимать нечего.
  if (!pair) return;
  await startInternetTransportIfEnabled(pair, cfg);
}
