/**
 * Чем именно открыли AirChat в браузере (v4.32.848).
 *
 * «Активные сессии» — экран безопасности: человек смотрит на него, чтобы
 * решить, свой перед ним вход или чужой. Про телефон там написано «iPhone 16
 * Plus», а про браузер было написано «Web browser» и «Web 0.0.0» — то есть не
 * названо ни одно из двух, о чём он спрашивает («какой браузер?», «какая
 * система?»), зато выдумана версия: нули в `Platform.Version` на вебе означают
 * ровно «здесь этого не знают».
 *
 * Разбор строки агента вынесен сюда отдельной чистой функцией: он весь состоит
 * из порядка проверок (Edge притворяется Chrome, Chrome — Safari), и проверить
 * этот порядок можно только тестом, а не глазами в чужом браузере.
 */

export type BrowserAgent = {
  /** «Safari», «Chrome», «Firefox» — как человек его называет. */
  name: string;
  /** Версия браузера без хвоста нулей; пустая строка — не назвалась. */
  version: string;
  /** Система под браузером: «macOS 14.6», «Windows 10», «Android 14». */
  os: string;
};

/**
 * Порядок важен и неслучаен: каждый следующий браузер представляется
 * предыдущим, чтобы сайты не отсекали его по имени. Edge пишет в строку и
 * `Chrome`, и `Safari`; Chrome пишет `Safari`; Safari не пишет ничего чужого.
 * Поэтому список идёт от самого «маскирующегося» к самому честному, и первое
 * совпадение — ответ.
 */
const BROWSERS: readonly { name: string; re: RegExp }[] = [
  { name: 'Edge', re: /\bEdg(?:e|A|iOS)?\/([\d.]+)/ },
  { name: 'Opera', re: /\bOPR\/([\d.]+)/ },
  { name: 'Opera', re: /\bOpera[/ ]([\d.]+)/ },
  { name: 'Яндекс.Браузер', re: /\bYaBrowser\/([\d.]+)/ },
  { name: 'Samsung Internet', re: /\bSamsungBrowser\/([\d.]+)/ },
  { name: 'Firefox', re: /\b(?:Firefox|FxiOS)\/([\d.]+)/ },
  { name: 'Chrome', re: /\b(?:Chrome|CriOS|Chromium)\/([\d.]+)/ },
  // У Safari своя версия лежит в `Version/`, а `Safari/` несёт версию движка
  // (605.1.15) — показывать её человеку значило бы снова назвать не то число.
  { name: 'Safari', re: /\bVersion\/([\d.]+).*\bSafari\// },
];

/**
 * «131.0.0.0» → «131», «18.6» → «18.6». Хвост нулей в версии браузера не
 * значит ничего: его дописывает сам браузер до четырёх разрядов.
 */
function trimVersion(raw: string): string {
  const parts = raw.split('.').slice(0, 4);
  while (parts.length > 1 && parts[parts.length - 1] === '0') parts.pop();
  return parts.join('.');
}

/** «10_15_7» → «10.15.7». В строке агента разделитель системы — подчёркивание. */
function dotted(raw: string): string {
  return raw.replace(/_/g, '.');
}

function osFromUserAgent(ua: string): string {
  const windows = /Windows NT ([\d.]+)/.exec(ua);
  if (windows) {
    // Windows 11 в строке агента неотличима от 10 — Microsoft сознательно
    // оставила там «10.0». Писать «Windows 11» было бы догадкой.
    const named: Record<string, string> = {
      '10.0': 'Windows 10',
      '6.3': 'Windows 8.1',
      '6.2': 'Windows 8',
      '6.1': 'Windows 7',
    };
    return named[windows[1]] ?? 'Windows';
  }
  const android = /Android ([\d.]+)/.exec(ua);
  if (android) return `Android ${trimVersion(android[1])}`;
  const ios = /(?:iPhone|iPad|CPU) OS ([\d_]+)/.exec(ua);
  if (ios) return `iOS ${trimVersion(dotted(ios[1]))}`;
  const mac = /Mac OS X ([\d_.]+)/.exec(ua);
  if (mac) return `macOS ${trimVersion(dotted(mac[1]))}`;
  if (/\bMacintosh\b/.test(ua)) return 'macOS';
  if (/\bCrOS\b/.test(ua)) return 'ChromeOS';
  if (/\bLinux\b/.test(ua)) return 'Linux';
  return '';
}

/**
 * Разобрать строку агента. `null` — ни один известный браузер не узнан: тогда
 * лучше не писать ничего, чем писать «Web 0.0.0».
 */
export function parseBrowserAgent(ua: string | null | undefined): BrowserAgent | null {
  if (typeof ua !== 'string') return null;
  const line = ua.trim();
  if (!line) return null;
  for (const { name, re } of BROWSERS) {
    const hit = re.exec(line);
    if (!hit) continue;
    return { name, version: hit[1] ? trimVersion(hit[1]) : '', os: osFromUserAgent(line) };
  }
  return null;
}

/** Строка агента текущего браузера. Вне браузера её нет — это не ошибка. */
function currentUserAgent(): string | null {
  const nav = (globalThis as { navigator?: { userAgent?: unknown } }).navigator;
  return typeof nav?.userAgent === 'string' ? nav.userAgent : null;
}

/**
 * Название браузера с версией для списка сессий: «Safari 18.6».
 *
 * Запасной вариант — прежнее «Web browser»: сессии с ним уже лежат на сервере,
 * и заводить для неузнанного браузера второе имя незачем.
 */
export function browserDeviceModel(ua: string | null | undefined = currentUserAgent()): string {
  const agent = parseBrowserAgent(ua);
  if (!agent) return 'Web browser';
  return agent.version ? `${agent.name} ${agent.version}` : agent.name;
}

/** Система под браузером для той же строки. Пустая строка — неизвестна. */
export function browserOsVersion(ua: string | null | undefined = currentUserAgent()): string {
  return parseBrowserAgent(ua)?.os ?? '';
}
