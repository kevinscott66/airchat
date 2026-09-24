/**
 * «VPN отключён» говорят только после того, как он отключился (v4.32.840).
 *
 * Дефект. `stopEmbeddedVpn` перехватывала отказ нативного модуля и молча
 * возвращалась: `log.warn('airchat_vpn_stop_failed')` — и всё. Кнопка
 * «Отключить» на этом безусловно ставила статус `off` и показывала «VPN
 * отключён». То есть на сорвавшемся отключении экран говорил ровно обратное
 * тому, что на устройстве.
 *
 * Цена. Туннель остался поднят, а человек уверен, что трафик пошёл напрямую.
 * Это не то же самое, что «не подключилось»: отключают обычно затем, чтобы
 * перестать гонять трафик через чужой сервер — потому что зашли в банк, или
 * сеть не та, или сервер разонравился. Ошибка старта так себя не вела никогда:
 * у неё с самого начала есть `failed`, и человеку про неё говорят.
 *
 * Правка. Отказ стопа уходит наверх. Экран на нём возвращает лампочку в
 * «Подключён» и говорит, что туннель остался. Тихий выход остался там, где
 * останавливать нечего (не Android, нет нативного модуля), и в
 * переподключении, где стоп — первый шаг, а итог сообщает старт.
 *
 * Рядом — вторая правка того же экрана: текст отказа при пустых полях звал
 * заполнить «publicKey и shortId», которых на экране нет; поля подписаны
 * «Public key (pbk)» и «Short ID (sid)».
 */

import fs from 'fs';
import path from 'path';

const mockPlatform = { OS: 'android' };
jest.mock('react-native', () => ({ Platform: mockPlatform }));

const mockWarn = jest.fn();
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: mockWarn, error: jest.fn(), debug: jest.fn() },
}));

let mockStopFails = false;
const mockStop = jest.fn(async () => {
  if (mockStopFails) throw new Error('VpnService.stop: binder transaction failed');
  return true;
});
let mockStartResult = true;
const mockStart = jest.fn(async () => mockStartResult);

jest.mock('airchat-vpn', () => ({
  __esModule: true,
  default: {
    isSupported: jest.fn(async () => true),
    start: (...a: unknown[]) => (mockStart as unknown as (...x: unknown[]) => Promise<boolean>)(...a),
    stop: () => mockStop(),
    isRunning: jest.fn(async () => true),
  },
}));

import type { AppConfig } from '../../config';

/**
 * Модуль берут через `require`, а не импортом.
 *
 * `import` поднимается выше объявлений стенда, и к моменту загрузки
 * контроллера `mockPlatform` ещё не создан: фабрика мока падает в TDZ, а
 * дальше падает всё, что её зовёт.
 */
type Ctrl = typeof import('../airChatVpnController');
const ctrl = (): Ctrl => require('../airChatVpnController') as Ctrl;

/** Полностью заполненная настройка: пустых полей тут быть не должно. */
const CFG = {
  vpn: {
    enabled: true,
    autoStart: true,
    address: 'vps.example.org',
    port: 443,
    uuid: '00000000-0000-4000-8000-000000000000',
    publicKey: 'pbk-example',
    shortId: 'abcd1234',
    sni: 'microsoft.com',
    flow: 'xtls-rprx-vision',
    fingerprint: 'chrome',
    localSocksPort: 10809,
    startRetries: 2,
    retryDelayMs: 0,
  },
} as unknown as AppConfig;

beforeEach(() => {
  mockPlatform.OS = 'android';
  mockStopFails = false;
  mockStartResult = true;
  mockStop.mockClear();
  mockStart.mockClear();
  mockWarn.mockClear();
});

describe('отключение либо состоялось, либо об этом сказали', () => {
  it('сорвавшийся стоп — отказ, а не тишина', async () => {
    mockStopFails = true;
    await expect(ctrl().stopEmbeddedVpn()).rejects.toThrow();
    // ПРОВЕРКА НЕ ПУСТАЯ: до модуля дошли, отказ пришёл именно от него.
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it('удавшийся стоп по-прежнему проходит молча', async () => {
    await expect(ctrl().stopEmbeddedVpn()).resolves.toBeUndefined();
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it('отказ всё так же попадает в журнал — его не подменили выбросом', async () => {
    mockStopFails = true;
    await expect(ctrl().stopEmbeddedVpn()).rejects.toThrow();
    expect(mockWarn).toHaveBeenCalledWith('airchat_vpn_stop_failed', expect.anything());
  });

  it('там, где останавливать нечего, отказа нет', async () => {
    mockPlatform.OS = 'ios';
    await expect(ctrl().stopEmbeddedVpn()).resolves.toBeUndefined();
    expect(mockStop).not.toHaveBeenCalled();
  });
});

describe('переподключение от этого не ломается', () => {
  it('стоп сорвался — «Повторить» всё равно поднимает туннель', async () => {
    mockStopFails = true;
    await expect(ctrl().retryEmbeddedVpn(CFG)).resolves.toBe('on');
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalled();
  });

  it('итог переподключения — итог старта, а не стопа', async () => {
    mockStopFails = true;
    mockStartResult = false;
    await expect(ctrl().retryEmbeddedVpn(CFG)).resolves.toBe('failed');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  const read = (...parts: string[]): string =>
    fs.readFileSync(path.join(__dirname, '..', '..', '..', ...parts), 'utf8');

  it('у старта отказ был исходом с самого начала — у стопа не было', async () => {
    mockStartResult = false;
    await expect(ctrl().maybeStartEmbeddedVpn(CFG, { force: true })).resolves.toBe('failed');
    // Несимметрия и есть дефект: про неудачное подключение человеку говорили,
    // про неудачное отключение — нет.
  });

  it('неполная настройка до нативного модуля не доходит', async () => {
    const half = { vpn: { ...CFG.vpn, publicKey: '' } } as unknown as AppConfig;
    await expect(ctrl().maybeStartEmbeddedVpn(half, { force: true })).resolves.toBe('failed');
    expect(mockStart).not.toHaveBeenCalled();
    // Отсюда и код-спик в отказе экрана: `publicKey`/`shortId` — имена полей
    // настройки, а не подписи на экране.
  });

  it('на экране те же поля подписаны иначе', () => {
    const sec = read('ui', 'components', 'VpnSettingsSection.tsx');
    expect(sec).toContain('Public key (pbk)');
    expect(sec).toContain('Short ID (sid)');
  });

  it('раздел — единственный, кто зовёт стоп из кнопки', () => {
    const sec = read('ui', 'components', 'VpnSettingsSection.tsx');
    expect(sec).toContain('stopEmbeddedVpn()');
    expect(sec).toContain("showSuccess('VPN отключён')");
  });
});

describe('форма исходников', () => {
  const read = (...parts: string[]): string =>
    fs.readFileSync(path.join(__dirname, '..', '..', '..', ...parts), 'utf8');
  /** Только код: комментарий, где написано «как надо», за исходник не считается. */
  const codeOnly = (s: string): string =>
    s
      .split('\n')
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');
  /** Вырезать тело названной функции — пин не должен ловить однофамильца. */
  const bodyAt = (s: string, needle: string, len: number): string => {
    const at = s.indexOf(needle);
    expect(at).toBeGreaterThan(0);
    return s.slice(at, at + len);
  };

  const CTRL = codeOnly(read('core', 'vpn', 'airChatVpnController.ts'));
  const SEC = codeOnly(read('ui', 'components', 'VpnSettingsSection.tsx'));

  it('стоп отдаёт отказ наверх', () => {
    const body = bodyAt(CTRL, 'export async function stopEmbeddedVpn()', 400);
    const warn = body.indexOf("log.warn('airchat_vpn_stop_failed'");
    expect(warn).toBeGreaterThan(0);
    expect(body.indexOf('throw e;')).toBeGreaterThan(warn);
  });

  it('переподключение глотает отказ стопа намеренно и в одиночку', () => {
    const body = bodyAt(CTRL, 'export async function retryEmbeddedVpn(', 600);
    expect(body).toContain('try {\n    await stopEmbeddedVpn();\n  } catch {');
  });

  it('кнопка «Отключить» не объявляет успех до успеха', () => {
    const body = bodyAt(SEC, 'const disconnectBtn = useAsyncButton(async () => {', 800);
    const fail = body.indexOf("setStatus('on');");
    const ok = body.indexOf("setStatus('off');");
    expect(fail).toBeGreaterThan(0);
    expect(ok).toBeGreaterThan(fail);
    expect(body).toContain("userErrorText(e, 'VPN остался включённым: отключить не удалось')");
    // Выход из ловушки обязателен: иначе за отказом шло бы «VPN отключён».
    expect(body.slice(fail, ok)).toContain('return;');
  });

  it('отказ называет ровно пустые поля', () => {
    const body = bodyAt(SEC, 'const missing: string[] = [', 700);
    expect(body).toContain('.filter(([v]) => !v)');
    expect(body).toContain('`Заполните поле «${missing[0]}»`');
    expect(body).toContain('`Заполните поля: ${missing.join(\', \')}`');
    expect(SEC).not.toContain('Заполните адрес, UUID, publicKey и shortId');
  });

  it('подпись поля и жалоба на него берутся из одного места', () => {
    const at = SEC.indexOf('const REQUIRED_LABELS = {');
    expect(at).toBeGreaterThan(0);
    const decl = SEC.slice(at, SEC.indexOf('} as const;', at));
    const keys = [...decl.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
    expect(keys).toEqual(['address', 'uuid', 'publicKey', 'shortId']);
    // Каждое обязательное поле и подписано этим словарём, и проверяется им.
    for (const k of keys) {
      expect(SEC).toContain(`{field(REQUIRED_LABELS.${k},`);
      expect(SEC).toContain(`, REQUIRED_LABELS.${k}],`);
    }
  });
});
