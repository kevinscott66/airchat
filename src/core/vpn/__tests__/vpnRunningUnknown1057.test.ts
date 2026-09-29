/**
 * ДЕФЕКТ (v4.32.1057). Живой туннель показывался как «Отключён».
 *
 * `getEmbeddedVpnRunning` перехватывала отказ нативного модуля и возвращала
 * `false` — тот же ответ, что и у честно опущенного канала. Раздел настроек
 * на этом оставлял `status` в `off`: серая лампочка и слово «Отключён».
 * Диагностика писала «Туннель не запущен».
 *
 * ЦЕНА. Это утверждение о том, куда сейчас идёт трафик. Спрашивают его как
 * раз тогда, когда ответ важен: зашли в банк, сменилась сеть, сервер
 * разонравился. Неправда здесь несимметрична — «канал поднят, а сказали, что
 * опущен» отправляет запросы через чужой сервер под честное слово экрана.
 * Хуже того, кнопка «Отключить» показывается только при поднятом канале
 * (`running = status === 'on' || status === 'starting'`), то есть опустить
 * туннель на непрочитанном состоянии было нечем: единственная кнопка, которая
 * это делает, не рисовалась. Следа в журнале тоже не оставалось: `catch` в
 * разделе стоял вокруг обёртки, которая свой отказ гасит внутри себя, и
 * срабатывал никогда.
 *
 * ПРАВКА. Третий ответ `null` — «спросить не удалось». Раздел держит
 * `statusUnknown`, пишет «Состояние не удалось прочитать», зажигает жёлтую
 * лампочку вместо серой и показывает отдельную кнопку «Отключить на всякий
 * случай». Диагностика говорит то же самое своими словами. Отказ уходит в
 * журнал.
 *
 * ГРАНИЦЫ. Тихий `false` остаётся там, где туннеля нет по устройству: не
 * Android или нет нативного модуля — это не отказ, а отсутствие туннеля, и
 * говорить про него «не знаем» было бы новой неправдой. Тип
 * `AirChatVpnUiStatus` не трогали: он описывает исход запуска и остановки, а
 * полоска наверху экрана неизвестное значение сочла бы включённым каналом.
 * Обратная половина той же правды сделана в v4.32.840 — там сорвавшийся стоп
 * уходит броском.
 */

import fs from 'fs';
import path from 'path';

const mockPlatform = { OS: 'android' };
jest.mock('react-native', () => ({ Platform: mockPlatform }));

const mockWarn = jest.fn();
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: mockWarn, error: jest.fn(), debug: jest.fn() },
}));

let mockRunningFails = false;
let mockRunningResult = true;
const mockIsRunning = jest.fn(async () => {
  if (mockRunningFails) throw new Error('VpnService.isRunning: binder transaction failed');
  return mockRunningResult;
});

let mockModuleMissing = false;
jest.mock('airchat-vpn', () => ({
  __esModule: true,
  get default() {
    return mockModuleMissing
      ? null
      : {
          isSupported: jest.fn(async () => true),
          start: jest.fn(async () => true),
          stop: jest.fn(async () => true),
          isRunning: () => mockIsRunning(),
        };
  },
}));

/** Контроллер берут через `require`: `import` поднимается выше стенда. */
type Ctrl = typeof import('../airChatVpnController');
const ctrl = (): Ctrl => require('../airChatVpnController') as Ctrl;

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

const bodyAt = (s: string, needle: string, len: number): string => {
  const at = s.indexOf(needle);
  expect(at).toBeGreaterThan(0);
  return s.slice(at, at + len);
};

beforeEach(() => {
  mockPlatform.OS = 'android';
  mockRunningFails = false;
  mockRunningResult = true;
  mockModuleMissing = false;
  mockIsRunning.mockClear();
  mockWarn.mockClear();
});

describe('«не знаем» не выдаётся за «выключен»', () => {
  it('отказ нативного модуля — это null, а не false', async () => {
    mockRunningFails = true;
    await expect(ctrl().getEmbeddedVpnRunning()).resolves.toBeNull();
    // ПРОВЕРКА НЕ ПУСТАЯ: до модуля дошли, отказ пришёл именно от него.
    expect(mockIsRunning).toHaveBeenCalledTimes(1);
  });

  it('отказ виден в журнале — раньше не оставалось даже следа', async () => {
    mockRunningFails = true;
    await ctrl().getEmbeddedVpnRunning();
    expect(mockWarn).toHaveBeenCalledWith('airchat_vpn_running_unknown', expect.anything());
  });

  it('три исхода — три разных ответа', async () => {
    mockRunningResult = true;
    const up = await ctrl().getEmbeddedVpnRunning();
    mockRunningResult = false;
    const down = await ctrl().getEmbeddedVpnRunning();
    mockRunningFails = true;
    const unknown = await ctrl().getEmbeddedVpnRunning();
    expect([up, down, unknown]).toEqual([true, false, null]);
  });
});

describe('ГРАНИЦА: где туннеля нет по устройству — не «не знаем»', () => {
  it('не Android: false, и до модуля не ходим', async () => {
    mockPlatform.OS = 'ios';
    await expect(ctrl().getEmbeddedVpnRunning()).resolves.toBe(false);
    expect(mockIsRunning).not.toHaveBeenCalled();
  });

  it('нет нативного модуля: тоже false', async () => {
    mockModuleMissing = true;
    await expect(ctrl().getEmbeddedVpnRunning()).resolves.toBe(false);
  });

  it('поднятый туннель по-прежнему называется поднятым', async () => {
    mockRunningResult = true;
    await expect(ctrl().getEmbeddedVpnRunning()).resolves.toBe(true);
  });
});

describe('что человек видит и чем может ответить', () => {
  const SEC = codeOnly(read('ui', 'components', 'VpnSettingsSection.tsx'));

  it('раздел отличает null от опущенного канала', () => {
    const body = bodyAt(SEC, 'const live = await getEmbeddedVpnRunning();', 200);
    expect(body).toContain('setStatusUnknown(live === null);');
    expect(body).toContain("if (live === true) setStatus('on');");
  });

  it('мёртвый catch вокруг чтения убран', () => {
    expect(SEC).not.toContain('/* статус останется off */');
    expect(SEC).not.toContain('if (await getEmbeddedVpnRunning())');
  });

  it('непрочитанное состояние названо своим словом, а не «Отключён»', () => {
    expect(SEC).toContain(
      "const statusText = statusUnknown ? 'Состояние не удалось прочитать' : STATUS_LABEL[status];",
    );
    expect(SEC).toContain('{statusText}</Text>');
    expect(SEC).not.toContain('{STATUS_LABEL[status]}</Text>');
  });

  it('лампочка на незнании жёлтая, а не серая', () => {
    const body = bodyAt(SEC, 'const statusStyle = statusUnknown', 120);
    expect(body).toContain('{ text: styles.statusColorWarn, dot: styles.dotWarn }');
  });

  it('опустить канал есть чем: отдельная кнопка на непрочитанном состоянии', () => {
    const at = SEC.indexOf('{statusUnknown && (');
    expect(at).toBeGreaterThan(0);
    const block = SEC.slice(at, at + 1200);
    expect(block).toContain('onPress={disconnectBtn.onPress}');
    expect(block).toContain('Отключить на всякий случай');
    expect(block).toContain('accessibilityLabel="Отключить канал на всякий случай"');
  });

  it('узнали — отметку снимаем: и на подключении, и на обоих исходах отключения', () => {
    expect(SEC.match(/setStatusUnknown\(false\);/g)?.length).toBe(3);
    const off = bodyAt(SEC, "setStatus('off');\n    setStatusUnknown(false);", 110);
    expect(off).toContain("showSuccess('VPN отключён')");
  });

  it('диагностика говорит то же самое своими словами', () => {
    const DIAG = codeOnly(read('ui', 'screens', 'DiagnosticScreen.tsx'));
    const body = bodyAt(DIAG, 'const running = await getEmbeddedVpnRunning();', 400);
    expect(body).toContain("running === null");
    expect(body).toContain("'Состояние туннеля не удалось прочитать'");
    expect(body).toContain("'Туннель не запущен'");
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  const SEC = codeOnly(read('ui', 'components', 'VpnSettingsSection.tsx'));

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: серая лампочка подписана словом «Отключён»', () => {
    expect(SEC).toContain("off: 'Отключён',");
  });

  it('ПОВОД ЖИВ: «Отключить» в основном ряду по-прежнему только у поднятого канала', () => {
    expect(SEC).toContain("const running = status === 'on' || status === 'starting';");
    expect(SEC).toContain('{running ? (');
    // Отсюда и цена: при `status === 'off'` основной ряд предлагает подключить,
    // а не отключить, — поэтому отдельная кнопка выше и понадобилась.
  });

  it('ЗАКРЕПКА: тип исходов запуска неизвестного значения не завёл', () => {
    const CTRL = codeOnly(read('core', 'vpn', 'airChatVpnController.ts'));
    expect(CTRL).toContain(
      "export type AirChatVpnUiStatus = 'off' | 'starting' | 'on' | 'unsupported' | 'failed';",
    );
  });

  it('ЗАКРЕПКА: полоска наверху всё ещё считает нераспознанное включённым каналом', () => {
    // Ради этого неизвестность и держат отдельным признаком: попади она в
    // `AirChatVpnUiStatus`, полоска объявила бы её «Защищённый канал включён».
    const BAN = read('ui', 'components', 'VpnStatusBanner.tsx');
    const tail = BAN.slice(BAN.indexOf('accessibilityLabel="Повторить подключение'));
    expect(tail).toContain('Защищённый канал включён.');
    // Хвост без единой проверки: сюда падает всё, чего полоска не знает.
    expect(tail).not.toContain('status ===');
  });

  it('ЗАКРЕПКА: читателей состояния ровно двое, и оба разобраны выше', () => {
    const hits: string[] = [];
    for (const f of [
      ['ui', 'components', 'VpnSettingsSection.tsx'],
      ['ui', 'screens', 'DiagnosticScreen.tsx'],
      ['core', 'vpn', 'airChatVpnController.ts'],
    ]) {
      if (read(...f).includes('getEmbeddedVpnRunning(')) hits.push(f[f.length - 1]);
    }
    expect(hits).toEqual([
      'VpnSettingsSection.tsx',
      'DiagnosticScreen.tsx',
      'airChatVpnController.ts',
    ]);
  });
});
