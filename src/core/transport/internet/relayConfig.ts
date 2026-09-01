/**
 * Адрес своего сервера-ретранслятора (v4.32.330).
 *
 * Интернет-транспорт умеет работать с любым ntfy-совместимым сервером: и
 * relayBase, и wsBase читаются из конфигурации (см. internetCoordinator). Но
 * задать их можно было только правкой airchat-config.json в файловой системе
 * устройства — то есть на телефоне никак. По умолчанию приложение ходит на
 * публичный ntfy.sh: темы там видны кому угодно, ограничения там чужие, и
 * доступность тоже чужая.
 *
 * v4.32.381: сам разбор адреса переехал в core/net/serverBaseUrl — правило
 * оказалось нужно не только этому экрану, но и всякому другому адресу сервера
 * в конфиге (см. там шапку). Здесь остался только слой имён, знакомых
 * транспорту: relayBase/wsBase вместо httpBase/wsBase и текст предупреждения
 * про http, который осмыслен именно для ретранслятора.
 */

import { parseServerBase } from '../../net/serverBaseUrl';

/** То же, что стоит по умолчанию в config.ts. Дублируется намеренно: этот
 *  модуль читают и тесты, и экран настроек, а config тянет за собой storage. */
export const DEFAULT_RELAY_BASE = 'https://ntfy.sh';
export const DEFAULT_WS_BASE = 'wss://ntfy.sh';

export type RelayEndpoints = { relayBase: string; wsBase: string };

export type RelayParseResult =
  | { ok: true; endpoints: RelayEndpoints; warning?: string }
  | { ok: false; error: string };

/**
 * Разбирает введённый адрес сервера в пару «HTTP для отправки, WebSocket для
 * приёма».
 *
 * Схему можно не писать — подставляется https. Можно ввести и «wss://…»: за
 * обратным прокси человек чаще всего видит именно этот адрес, и требовать от
 * него мысленно переводить его в https значит собирать ошибки на ровном месте.
 *
 * Путь сохраняется: ntfy за прокси часто живёт не в корне, а на /ntfy, и тема
 * дописывается к адресу как есть (`${relayBase}/${topic}`).
 */
export function parseRelayInput(raw: string): RelayParseResult {
  const res = parseServerBase(raw);
  if (!res.ok) return res;
  const endpoints: RelayEndpoints = { relayBase: res.base.httpBase, wsBase: res.base.wsBase };
  // Предупреждение живёт здесь, а не в общем разборе: смысл у него ровно
  // «через этот сервер видно, кто с кем и когда», и он про ретранслятор.
  return res.base.insecure
    ? {
        ok: true,
        endpoints,
        warning:
          'Без https адрес темы и время отправки видны сети по пути. Сами сообщения зашифрованы в любом случае.',
      }
    : { ok: true, endpoints };
}

/** Стоит ли считать адрес «своим сервером», а не публичным ntfy.sh. */
export function isCustomRelay(relayBase: string | undefined): boolean {
  return !!relayBase && relayBase !== DEFAULT_RELAY_BASE;
}
