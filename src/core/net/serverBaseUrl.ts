/**
 * serverBaseUrl — адрес чужого сервера, приведённый к пригодному для запроса виду.
 *
 * v4.32.381. Правило это уже было написано — внутри parseRelayInput, для поля
 * «свой сервер» в настройках (v4.32.330). Но применялось оно ровно в одном
 * месте: на экране. Всё, что попадало в конфиг мимо экрана — правкой
 * Documents/airchat-config.json, значением из assets/config.json, записью
 * старой версии приложения, — до правила не доходило и уезжало в запрос как
 * есть. Отсюда набор поломок, каждая из которых выглядит как «сервер не
 * отвечает»:
 *
 *   'https://ntfy.example.com/'  → `${base}/${topic}` даёт двойной слэш;
 *   ' https://ntfy.example.com'  → пробел внутри адреса запроса;
 *   ''                           → `?? DEFAULT` не срабатывает (пустая строка
 *                                  не nullish), и запрос уходит на '/topic';
 *   'ntfy.example.com'           → без схемы запрос не соберётся вовсе.
 *
 * Отдельно про signalingUrl: одно и то же значение читают socket.io (ему
 * годится и wss://) и fetch на `${base}/register-token` (ему — нет). Человек,
 * написавший 'wss://sig.example.com', получал работающие звонки и молча
 * мёртвую регистрацию пуш-токена. Поэтому ws-схема здесь приводится к http, а
 * пара «http для запросов, ws для подписки» отдаётся сразу обеими.
 *
 * Модуль без единого импорта: разбор недоверенного ввода проверяется тестами
 * без React, сети и транспорта.
 */

/** Схема в начале строки: «https://», «wss://» и любая другая. */
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
/** Логин с паролем перед хостом — их сервер принимает заголовком, а не в адресе. */
const HAS_CREDENTIALS = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/@]*@/;

export type ServerBase = {
  /** Адрес для HTTP-запросов: без хвостового слэша, без «?» и «#». */
  httpBase: string;
  /** Тот же сервер для WebSocket-подписки. */
  wsBase: string;
  /** true — схема http://, то есть путь до сервера не зашифрован. */
  insecure: boolean;
};

export type ServerBaseResult =
  | { ok: true; base: ServerBase }
  | { ok: false; error: string };

/**
 * Разбирает адрес сервера в пару «HTTP для запросов, WebSocket для подписки».
 *
 * Схему можно не писать — подставляется https. Можно ввести и «wss://…»: за
 * обратным прокси человек чаще всего видит именно этот адрес, и требовать от
 * него мысленно переводить его в https значит собирать ошибки на ровном месте.
 *
 * Путь сохраняется: ntfy за прокси часто живёт не в корне, а на /ntfy, и тема
 * дописывается к адресу как есть (`${httpBase}/${topic}`).
 *
 * Тексты ошибок конечные: их показывают человеку в настройках.
 */
export function parseServerBase(raw: unknown): ServerBaseResult {
  if (typeof raw !== 'string') return { ok: false, error: 'Введите адрес сервера' };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'Введите адрес сервера' };
  if (/\s/.test(trimmed)) return { ok: false, error: 'В адресе не должно быть пробелов' };
  if (HAS_CREDENTIALS.test(trimmed)) {
    return { ok: false, error: 'Логин и пароль в адресе не поддерживаются' };
  }

  const withScheme = HAS_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`;
  // wss/ws — это тот же сервер; для разбора приводим к http-схеме, обратно
  // разводим уже в конце.
  const normalizedScheme = withScheme
    .replace(/^wss:\/\//i, 'https://')
    .replace(/^ws:\/\//i, 'http://');

  let url: URL;
  try {
    url = new URL(normalizedScheme);
  } catch {
    return { ok: false, error: 'Не похоже на адрес сервера' };
  }

  const protocol = url.protocol.toLowerCase();
  if (protocol !== 'https:' && protocol !== 'http:') {
    return { ok: false, error: 'Поддерживаются только https:// и http://' };
  }
  const host = url.host.toLowerCase();
  if (!host || !url.hostname) return { ok: false, error: 'Не указан адрес сервера' };
  // Точка или скобки IPv6 обязательны: «localhost» на телефоне указывает на
  // сам телефон, а «myserver» без домена не разрешится ни в одной сети.
  if (!url.hostname.includes('.') && !url.hostname.includes(':') && url.hostname !== 'localhost') {
    return { ok: false, error: 'Укажите полное имя сервера или IP-адрес' };
  }
  if (url.search || url.hash) {
    return { ok: false, error: 'Адрес не должен содержать «?» и «#»' };
  }

  const path = url.pathname.replace(/\/+$/, '');
  const insecure = protocol === 'http:';
  return {
    ok: true,
    base: {
      httpBase: `${protocol}//${host}${path}`,
      wsBase: `${insecure ? 'ws:' : 'wss:'}//${host}${path}`,
      insecure,
    },
  };
}

/**
 * То же правило для значения, пришедшего не от человека, а из конфига: без
 * текста ошибки, просто «годится» или «нет».
 *
 * null здесь означает «подставьте значение по умолчанию», а не «оставьте как
 * было»: оставить как было — это и есть тот самый запрос на '/topic'.
 */
export function normalizeServerBase(v: unknown): ServerBase | null {
  const res = parseServerBase(v);
  return res.ok ? res.base : null;
}
