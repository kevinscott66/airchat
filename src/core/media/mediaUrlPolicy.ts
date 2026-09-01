/**
 * mediaUrlPolicy — куда приложению позволено ходить за вложением и какие
 * локальные файлы позволено стирать.
 *
 * v4.32.354. Оба адреса — и http(s) в дескрипторе вложения, и file:// в строке
 * сообщения — приходят ОТ СОБЕСЕДНИКА. Проверка их формы (`isBlobRef`) говорит
 * только, что строка похожа на адрес; куда именно она ведёт, до этого раунда не
 * спрашивал никто.
 *
 * Ни сети, ни файлов, ни платформенных модулей: политика должна проверяться
 * тестом отдельно от транспорта, который её применяет.
 */

/**
 * Схема + хост + порт в каноническом виде, `null` — адрес непригоден.
 *
 * Порт подставляется по схеме, чтобы `https://ntfy.sh` и `https://ntfy.sh:443`
 * не считались разными адресами, а `http://ntfy.sh` — тем же самым.
 *
 * Что отвергается и почему:
 *  - `https://ntfy.sh@evil.example/f` — userinfo: хост здесь evil.example, а
 *    глазами (и любой проверкой через `startsWith`) читается как ntfy.sh;
 *  - `https://ntfy.sh\.evil.example` и прочее вне [a-z0-9.-] в авторитете —
 *    поле, где разные разборщики расходятся, а расхождение и есть подмена;
 *  - непечатные символы и пробелы в любом месте адреса;
 *  - схемы, кроме http/https.
 */
export function httpOrigin(raw: string): string | null {
  const p = parseHttpUrl(raw);
  return p ? `${p.scheme}://${p.host}:${p.port}` : null;
}

type ParsedHttpUrl = { scheme: 'http' | 'https'; host: string; port: number };

function parseHttpUrl(raw: string): ParsedHttpUrl | null {
  if (raw.length === 0 || raw.length > 2048) return null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c <= 0x20 || c >= 0x7f) return null;
  }
  const m = raw.match(/^([a-zA-Z]+):\/\/([^/?#]*)/);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return null;
  const auth = m[2].toLowerCase().match(/^([a-z0-9.-]+)(?::(\d{1,5}))?$/);
  if (!auth) return null;
  const host = auth[1];
  if (host.length > 253 || host.startsWith('.') || host.endsWith('.') || host.includes('..')) return null;
  const port = auth[2] ? parseInt(auth[2], 10) : scheme === 'https' ? 443 : 80;
  if (!(port > 0 && port <= 65535)) return null;
  return { scheme, host, port };
}

/**
 * Разрешён ли адрес вложения: он обязан вести на один из наших релеев.
 *
 * Смысл ограничения. Дескриптор вложения приходит внутри сообщения, а
 * приложение открывает его САМО, при отрисовке чата — то есть отправитель
 * выбирает адрес, по которому устройство получателя сходит без его ведома.
 * Без проверки хоста это готовый маячок: `https://счётчик.отправителя/img`
 * отдаёт ему IP-адрес получателя и точную минуту открытия переписки, а
 * `http://192.168.1.1/...` превращает чужой телефон в сканер домашней сети.
 * Ровно от этого в v4.32.243 закрыли ссылки на IPFS-шлюзы — в дескрипторе
 * вложения дыра оставалась открытой.
 *
 * Почему список релеев не ломает доставку: чтобы получить сообщение с
 * дескриптором по интернету, оба уже подписаны на один и тот же релей, а
 * вложения ntfy живут около трёх часов — адреса с чужого релея не «перестают
 * открываться», их и открывать нечего.
 */
export function isAllowedBlobUrl(url: string, allowedBases: readonly string[]): boolean {
  const origin = httpOrigin(url);
  if (!origin) return false;
  return allowedBases.some((base) => httpOrigin(base) === origin);
}

/** Суффиксы, за которыми имя ведёт внутрь сети получателя, а не наружу. */
const LOCAL_HOST_SUFFIXES = ['.local', '.localhost', '.internal', '.intranet', '.home', '.lan'];

/**
 * Ведёт ли имя хоста наружу, в публичную сеть.
 *
 * Односоставное имя (`localhost`, `printer`, `router`) отвергается целиком: у
 * публичного хоста точка есть всегда, а из intranet-имён по одному их не
 * перечислить.
 *
 * Числовые адреса разбираются строго по четырём частям без ведущих нулей —
 * `0177.0.0.1` для Android это 127.0.0.1 (восьмеричная запись), а для проверки
 * «начинается ли на 127.» — нет. Всё остальное числовое (`2130706433`,
 * `127.1`) отвергается: у него столько же прочтений, сколько разборщиков.
 */
export function isPublicHost(host: string): boolean {
  const h = host.toLowerCase();
  if (!h.includes('.')) return false;
  if (LOCAL_HOST_SUFFIXES.some((s) => h.endsWith(s))) return false;
  if (!/^[0-9.]+$/.test(h)) return true;
  const parts = h.split('.');
  if (parts.length !== 4) return false;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return false;
    const n = parseInt(p, 10);
    if (n > 255) return false;
    octets.push(n);
  }
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // свои, петля, multicast и зарезервированные
  if (a === 169 && b === 254) return false; // link-local, включая метаданные облаков
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || b === 0)) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT — сеть оператора
  if (a === 198 && (b === 18 || b === 19)) return false;
  return true;
}

/** Почему адрес нельзя скачивать ради «Поделиться». */
export type ShareUrlVerdict = 'ok' | 'malformed' | 'insecure' | 'private';

/**
 * Можно ли скачать по адресу файл, который пользователь собрался переслать.
 *
 * Адрес приходит из сообщения: в просмотрщик попадает то, что прислал
 * собеседник. Раньше проверка стояла на месте, регуляркой по `new URL().hostname`,
 * и перечисляла частные диапазоны через `|` — то есть держалась на том, что
 * разбор адреса в React Native совпадёт с разбором в системном загрузчике, а
 * список диапазонов полон. Ни того, ни другого не было: `100.64/10` (сеть
 * оператора), `192.0.0/24`, восьмеричная запись и односоставные intranet-имена
 * в список не входили.
 */
export function classifyShareUrl(raw: string): ShareUrlVerdict {
  const p = parseHttpUrl(raw);
  if (!p) return 'malformed';
  if (p.scheme !== 'https') return 'insecure';
  return isPublicHost(p.host) ? 'ok' : 'private';
}

/**
 * Лежит ли `uri` внутри каталога `dir` — по-настоящему, а не по началу строки.
 *
 * `uri.startsWith(dir)` эту задачу не решает: `<кэш>/../../databases/airchat.db`
 * начинается с каталога кэша и при этом указывает на базу переписки, а
 * `<кэш>/..%2f..%2fdatabases` — на неё же, только записанное так, чтобы проверку
 * по строке пройти наверняка. Адрес приходит из сообщения, и функция, которая
 * его получает, файлы удаляет.
 *
 * Подкаталоги разрешены намеренно: голосовые expo-av пишет в `<кэш>/Audio/`,
 * ради них всё и затевалось.
 */
export function isInsideCacheDir(uri: string, dir: string): boolean {
  if (dir.length === 0) return false;
  const base = dir.endsWith('/') ? dir : `${dir}/`;
  if (!uri.startsWith(base)) return false;
  const rest = uri.slice(base.length);
  if (rest.length === 0) return false;
  let decoded: string;
  try {
    // Двойное декодирование не нужно: fetch/FileSystem раскрывают ровно один
    // слой, а лишний проход отверг бы файл с честным '%2e' в имени.
    decoded = decodeURIComponent(rest);
  } catch {
    // Битая escape-последовательность — сам по себе повод не трогать файл.
    return false;
  }
  return !decoded.split(/[/\\]/).includes('..');
}
