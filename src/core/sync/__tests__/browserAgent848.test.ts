/**
 * Какой браузер и какой версии держит вход в аккаунт (v4.32.848).
 *
 * Дефект. В «Активных сессиях» веб-вход подписывался «Web browser», а строкой
 * ниже — «Web 0.0.0 · AirChat 4.32.614». Ни одного ответа на два вопроса, ради
 * которых на этот экран и заходят («какой это браузер?», «моя ли это машина?»),
 * зато посередине стоит версия 0.0.0. Взялась она из `Platform.Version`, а на
 * вебе это поле означает ровно «здесь такого не знают»; приложение печатало
 * незнание в виде точного числа.
 *
 * Цена. Список сессий — орган безопасности: по нему решают, свой перед ними
 * вход или чужой, и по нему же нажимают «завершить». Строка, одинаковая у
 * любого веб-входа, отличить свой от чужого не даёт вовсе — а выглядит как
 * сведения об устройстве, то есть выглядит достаточной.
 *
 * Правка. Браузер и система читаются из строки агента (`browserAgent.ts`), и
 * в сессию идёт «Safari 18.6» вместо «Web browser». Разбор — чистая функция,
 * потому что весь он состоит из порядка проверок: Edge представляется Chrome,
 * Chrome — Safari, и ошибиться здесь можно только порядком. Старые сессии
 * задним числом не исправить — их писало то устройство, которое входило, —
 * поэтому подписи «Web browser» и версии «0.0.0» экран теперь не показывает
 * как сведения, а называет незнанием.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { browserDeviceModel, browserOsVersion, parseBrowserAgent } from '../browserAgent';
import { sessionDeviceName, sessionSystemLine } from '../../../ui/screens/settings/settingsLabels';
import type { SyncDevice } from '../syncApi';

const SRC = join(__dirname, '..', '..', '..');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

/** Только код: пояснения не должны сами удовлетворять проверку. */
const codeOnly = (src: string): string =>
  src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

const device = (p: Partial<SyncDevice>): SyncDevice => ({ deviceId: 'd1', ...p }) as SyncDevice;

const UA = {
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  chromeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  edgeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.86',
  operaWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 OPR/114.0.0.0',
  yandexWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 YaBrowser/24.7.0.0 Safari/537.36',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
  chromeIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1',
  samsungAndroid:
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/117.0.0.0 Mobile Safari/537.36',
};

describe('разбор строки агента', () => {
  it('Safari называет себя и свою систему, а не движок', () => {
    // 605.1.15 — версия WebKit, она стоит в той же строке и соблазнительно
    // похожа на ответ. Человеку нужна та, что он видит в «О программе».
    expect(parseBrowserAgent(UA.safariMac)).toEqual({
      name: 'Safari',
      version: '18.6',
      os: 'macOS 10.15.7',
    });
  });

  it('Chrome: хвост нулей в версии не показывается', () => {
    expect(parseBrowserAgent(UA.chromeWin)).toEqual({
      name: 'Chrome',
      version: '131',
      os: 'Windows 10',
    });
  });

  it('Edge не выдаётся за Chrome, хотя пишет в строку и его, и Safari', () => {
    expect(parseBrowserAgent(UA.edgeWin)?.name).toBe('Edge');
    expect(parseBrowserAgent(UA.edgeWin)?.version).toBe('131.0.2903.86');
  });

  it('Opera и Яндекс.Браузер — тоже не Chrome', () => {
    expect(parseBrowserAgent(UA.operaWin)?.name).toBe('Opera');
    expect(parseBrowserAgent(UA.yandexWin)?.name).toBe('Яндекс.Браузер');
    expect(parseBrowserAgent(UA.yandexWin)?.version).toBe('24.7');
  });

  it('Firefox на Linux', () => {
    expect(parseBrowserAgent(UA.firefoxLinux)).toEqual({
      name: 'Firefox',
      version: '130',
      os: 'Linux',
    });
  });

  it('Chrome на iPhone: система читается как iOS, а не как macOS', () => {
    // В этой строке есть слова «like Mac OS X» — приманка ровно для того
    // разбора, который смотрит на первое совпадение по всей строке.
    expect(parseBrowserAgent(UA.chromeIos)).toEqual({
      name: 'Chrome',
      version: '131.0.6778.73',
      os: 'iOS 18.6',
    });
  });

  it('Samsung Internet на Android', () => {
    expect(parseBrowserAgent(UA.samsungAndroid)).toEqual({
      name: 'Samsung Internet',
      version: '26',
      os: 'Android 14',
    });
  });

  it('неузнанная строка — это null, а не выдуманное имя', () => {
    expect(parseBrowserAgent('curl/8.4.0')).toBeNull();
    expect(parseBrowserAgent('')).toBeNull();
    expect(parseBrowserAgent(null)).toBeNull();
    expect(parseBrowserAgent(undefined)).toBeNull();
  });

  it('подпись сессии собирается из имени и версии', () => {
    expect(browserDeviceModel(UA.safariMac)).toBe('Safari 18.6');
    expect(browserOsVersion(UA.safariMac)).toBe('macOS 10.15.7');
  });

  it('неузнанный браузер оставляет прежнюю подпись и пустую систему', () => {
    // Второго имени для «не знаем» не заводим: сессии с этим уже лежат на
    // сервере, и различать два вида незнания человеку незачем.
    expect(browserDeviceModel('curl/8.4.0')).toBe('Web browser');
    expect(browserOsVersion('curl/8.4.0')).toBe('');
  });
});

describe('как это читается в списке сессий', () => {
  it('новый веб-вход называет браузер и систему', () => {
    const d = device({
      platform: 'web',
      deviceModel: 'Safari 18.6',
      osVersion: 'macOS 10.15.7',
      appVersion: '4.32.848',
    });

    expect(sessionDeviceName(d)).toBe('Safari 18.6');
    expect(sessionSystemLine(d)).toBe('Браузер · macOS 10.15.7 · AirChat 4.32.848');
  });

  it('старая сессия не притворяется знающей: ни «Web browser», ни «0.0.0»', () => {
    const d = device({
      platform: 'web',
      deviceModel: 'Web browser',
      osVersion: '0.0.0',
      appVersion: '4.32.614',
    });

    expect(sessionDeviceName(d)).toBe('Неизвестный браузер');
    expect(sessionSystemLine(d)).toBe('Браузер · AirChat 4.32.614');
  });

  it('данная человеком подпись важнее слова «неизвестный»', () => {
    const d = device({ platform: 'web', deviceModel: 'Web browser', label: 'рабочий ноутбук' });

    expect(sessionDeviceName(d)).toBe('рабочий ноутбук');
  });

  it('телефон подписан как раньше: голое число прирастает к платформе', () => {
    expect(sessionSystemLine(device({ platform: 'ios', osVersion: '26.0', appVersion: '4.32.848' })))
      .toBe('iOS 26.0 · AirChat 4.32.848');
    expect(sessionSystemLine(device({ platform: 'android', osVersion: '14', appVersion: '4.32.848' })))
      .toBe('Android 14 · AirChat 4.32.848');
  });

  it('о чём сервер молчит, о том молчит и строка', () => {
    expect(sessionSystemLine(device({}))).toBe('');
    expect(sessionSystemLine(device({ platform: 'ios' }))).toBe('iOS');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: известное не выбрасывается', () => {
  it('настоящая версия системы остаётся на месте', () => {
    expect(sessionSystemLine(device({ platform: 'ios', osVersion: '18.6' }))).toContain('18.6');
  });

  it('модель телефона по-прежнему называет себя сама', () => {
    expect(sessionDeviceName(device({ platform: 'ios', deviceModel: 'iPhone 16 Plus' })))
      .toBe('iPhone 16 Plus');
  });

  it('устройство без единого признака называется неизвестным, а не браузером', () => {
    expect(sessionDeviceName(device({}))).toBe('Неизвестное устройство');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('«0.0.0» из строки сессии исчезает целиком, а не заменяется похожим', () => {
    const d = device({ platform: 'web', osVersion: '0.0.0', appVersion: '4.32.614' });

    expect(sessionSystemLine(d)).not.toContain('0.0.0');
    expect(sessionSystemLine(d)).not.toContain('Web');
  });

  it('прочие способы платформы сказать «не знаю» тоже не печатаются', () => {
    for (const unknown of ['unknown', 'undefined', 'null', '0', '']) {
      expect(sessionSystemLine(device({ platform: 'web', osVersion: unknown }))).toBe('Браузер');
    }
  });
});

describe('форма исходников', () => {
  it('сессия веба берёт имя браузера у разбора, а не строку «Web browser»', () => {
    const api = codeOnly(read('core/sync/syncApi.ts'));

    expect(api).toContain("? browserDeviceModel() : platform;");
    expect(api).toContain('? browserOsVersion()');
    expect(api).not.toContain("'Web browser'");
  });

  it('на вебе пустая версия остаётся пустой, а не становится «unknown»', () => {
    const api = codeOnly(read('core/sync/syncApi.ts'));

    expect(api).toContain("osVersion: osVersion.slice(0, 32) || (platform === 'web' ? '' : 'unknown'),");
  });

  it('экран собирает строку одной функцией, а не склейкой на месте', () => {
    const screen = codeOnly(read('ui/screens/SettingsScreen.tsx'));

    expect(screen).toContain('{sessionSystemLine(device)}');
    // Прежняя склейка и была тем местом, где «Web» встречался с «0.0.0».
    expect(screen).not.toContain('const platformLabel =');
    expect(screen).not.toContain('AirChat ${device.appVersion}');
  });
});
