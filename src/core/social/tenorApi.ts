/**
 * Подборщик GIF: запрос к Tenor и разбор ответа (v4.32.364).
 *
 * Ключ в коде был `LIVDSRZULELA` — общий демо-ключ старого Tenor v1. Запросы
 * идут в v2, и v2 его не принимает: `HTTP 400, API key not valid`. То есть
 * подборщик не работал вообще ни у кого, а сообщал об этом как о проблеме со
 * связью — «Проверьте подключение».
 *
 * Своего ключа у приложения нет и быть не может: Tenor выдаёт их поимённо.
 * Поэтому ключ переехал в конфиг (`publicServices.tenorKey`,
 * Documents/airchat-config.json), а без ключа вкладка GIF не показывается —
 * вместо кнопки, которая заведомо приведёт к ошибке.
 *
 * Модуль без React и без сети: строится адрес, разбирается ответ, называется
 * причина отказа.
 */

import { isTenorGifUrl } from './gifEnvelope';

export const TENOR_BASE = 'https://tenor.googleapis.com/v2';
export const TENOR_PAGE_LIMIT = 20;
/** Потолок на страницу — ответ приходит по сети и его размер нам не подвластен. */
const MAX_RESULTS_PER_PAGE = 60;

export type TenorGif = {
  id: string;
  title: string;
  /** Адрес для отправки собеседнику. */
  url: string;
  /** Мелкий предпросмотр для сетки. */
  previewUrl: string;
};

/** Ключ Tenor из конфига. Пустая строка — подборщик выключен. */
export function tenorKeyFrom(
  cfg: { publicServices?: { tenorKey?: string } } | null | undefined
): string {
  const k = cfg?.publicServices?.tenorKey;
  return typeof k === 'string' ? k.trim() : '';
}

export function buildTenorUrl(key: string, query: string, pos?: string): string {
  const q = query.trim();
  const parts = [
    `key=${encodeURIComponent(key)}`,
    `limit=${TENOR_PAGE_LIMIT}`,
    'media_filter=gif',
  ];
  // pos — непрозрачный курсор от самого Tenor; в адрес он всё равно обязан
  // попасть закодированным, иначе первый же '&' в нём оборвёт запрос.
  if (pos) parts.push(`pos=${encodeURIComponent(pos)}`);
  if (q) parts.unshift(`q=${encodeURIComponent(q)}`);
  return `${TENOR_BASE}/${q ? 'search' : 'featured'}?${parts.join('&')}`;
}

/**
 * Разбор ответа. Всё недоверенное: адреса уходят в <Image> и в сообщение
 * собеседнику, поэтому пропускаем только то, что примет и получатель
 * (isTenorGifUrl — тот же критерий, что на приёме).
 */
export function parseTenorPayload(json: unknown): { gifs: TenorGif[]; next: string } {
  const root = (json ?? {}) as { results?: unknown; next?: unknown };
  const results = Array.isArray(root.results) ? root.results : [];
  const gifs: TenorGif[] = [];
  for (const raw of results.slice(0, MAX_RESULTS_PER_PAGE)) {
    const r = (raw ?? {}) as {
      id?: unknown;
      title?: unknown;
      media_formats?: Record<string, { url?: unknown } | undefined>;
    };
    if (typeof r.id !== 'string' || !r.id) continue;
    const fmt = r.media_formats ?? {};
    const pick = (name: string): string => {
      const u = fmt[name]?.url;
      return typeof u === 'string' && isTenorGifUrl(u) ? u : '';
    };
    const url = pick('gif') || pick('mediumgif');
    if (!url) continue;
    gifs.push({
      id: r.id,
      title: typeof r.title === 'string' ? r.title.slice(0, 128) : '',
      url,
      previewUrl: pick('nanogif') || pick('tinygif') || url,
    });
  }
  return { gifs, next: typeof root.next === 'string' ? root.next : '' };
}

export type TenorFailure = 'key' | 'rate' | 'server' | 'network';

/** Отказ по коду ответа. */
export function classifyTenorStatus(status: number): TenorFailure {
  if (status === 400 || status === 401 || status === 403) return 'key';
  if (status === 429) return 'rate';
  if (status >= 500) return 'server';
  return 'network';
}

/**
 * Что показать человеку. Отдельная функция ровно затем, чтобы «ключ не принят»
 * больше никогда не выглядело как «у вас нет интернета»: пользователь час
 * проверял бы Wi-Fi там, где чинить нужно конфиг.
 */
export function tenorFailureMessage(kind: TenorFailure): string {
  switch (kind) {
    case 'key':
      return 'Tenor не принял ключ приложения — поиск GIF недоступен';
    case 'rate':
      return 'Слишком много запросов к Tenor. Попробуйте через минуту';
    case 'server':
      return 'Tenor сейчас не отвечает. Попробуйте позже';
    default:
      return 'Не удалось загрузить GIF. Проверьте подключение';
  }
}

/**
 * Дозагрузка страницы. Tenor повторяет одну и ту же картинку на границе
 * страниц, а FlatList требует уникальный ключ — иначе повторы либо не
 * отрисуются, либо будут пропадать при прокрутке.
 */
export function mergeGifPages(prev: TenorGif[], next: TenorGif[]): TenorGif[] {
  const seen = new Set(prev.map((g) => g.id));
  const out = prev.slice();
  for (const g of next) {
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    out.push(g);
  }
  return out;
}
