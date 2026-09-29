/**
 * Непрочитанная «Автозагрузка медиа» открывала ворота настежь (v4.32.1027).
 *
 * ДЕФЕКТ. `useAutoDownloadGate` читал настройку через `kvGet`, а тот сводит
 * отказ базы и отсутствие записи к одному `null` — и дальше стоял
 * `?? 'always'`. То есть занятый SQLite отвечал самым разрешительным из трёх
 * вариантов, какие человек мог выбрать. Там же, ниже, отказ `NetInfo.fetch()`
 * в режиме «только Wi-Fi» давал `setGated(false)`: не узнали сеть — качаем.
 *
 * ЦЕНА. Выбор «Никогда» делают ровно затем, чтобы устройство не ходило в сеть
 * само. При подмене на «всегда» пузырь GIF отдаёт Tenor (это Google) свой
 * IP-адрес и точное время, когда открыли переписку, а `MediaStrip` и
 * `GroupPhotoGrid` идут за вложением на шлюз IPFS. Запустить это может любой
 * собеседник — достаточно прислать GIF. Отменить нельзя ничем: картинка на
 * экране и ЕСТЬ доказательство, что запрос уже ушёл. Хук поднимается на
 * появление КАЖДОГО медиа-пузыря, то есть десятками разом — ровно в ту
 * секунду, когда база и занята: открытие чата читает историю. Экран настроек
 * ту же запись спрашивает через `kvTryGet` и на отказ не молчит
 * (`settings_unreadable:`), так что человек видит в настройках «Никогда»,
 * пока переписка ведёт себя как «Всегда».
 *
 * ПРАВКА. Настройка спрашивается тремя состояниями: `null` — «не прочитали»,
 * и ворота закрываются. Отказ `NetInfo.fetch()` в режиме Wi-Fi закрывает их
 * так же. Цена ошибки несимметрична: закрытые ворота стоят одного нажатия на
 * «нажмите, чтобы загрузить», открытые — необратимого похода в сеть.
 *
 * ГРАНИЦЫ. Отсутствие записи по-прежнему значит «всегда»: это первый запуск,
 * а не беда, и так же читает её экран настроек (v4.32.248). Незнакомое
 * значение тоже остаётся «всегда» — разбор здесь не меняется.
 */
import React, { act } from 'react';

// react-test-renderer приходит с jest-expo; деклараций типов в проекте нет.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TestRenderer = require('react-test-renderer') as {
  create: (element: React.ReactElement) => { unmount: () => void };
};

/** Что лежит в записи; `null` — записи нет. */
let mockValue: string | null = null;
/** Чтение отказывает: `kvTryGet` отвечает `null`, `kvGet` — тоже. */
let mockReadFails = false;

jest.mock('../../../../core/storage/local', () => ({
  kvTryGet: jest.fn(async () => (mockReadFails ? null : { value: mockValue })),
  kvGet: jest.fn(async () => (mockReadFails ? null : mockValue)),
}));

/** Тип сети для `NetInfo.fetch()`; `null` — вызов бросает. */
let mockNetType: string | null = 'wifi';

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    fetch: jest.fn(async () => {
      if (mockNetType === null) throw new Error('netinfo_unavailable');
      return { type: mockNetType };
    }),
  },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { useAutoDownloadGate } from '../useAutoDownloadGate';

const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

/** Только код: докблок не должен сам удовлетворять закрепку. */
const codeOnly = (s: string): string =>
  s
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const GATE = (): string => codeOnly(read('src/ui/screens/chat-components/useAutoDownloadGate.ts'));
const STRIP = (): string => codeOnly(read('src/ui/screens/chat-components/MediaStrip.tsx'));
const GRID = (): string => codeOnly(read('src/ui/screens/chat-components/GroupPhotoGrid.tsx'));
const PICKER = (): string => codeOnly(read('src/ui/components/GifPicker.tsx'));
const SETTINGS = (): string => codeOnly(read('src/ui/screens/SettingsScreen.tsx'));
const LOCAL = (): string => codeOnly(read('src/core/storage/local.ts'));

/** Ответ хука наружу. */
let gated = false;

function Harness(): null {
  gated = useAutoDownloadGate();
  return null;
}

let mounted: Array<{ unmount: () => void }> = [];

/** Поднять хук и дождаться, пока асинхронное чтение осядет в состоянии. */
async function ask(): Promise<boolean> {
  let tree!: { unmount: () => void };
  await act(async () => {
    tree = TestRenderer.create(<Harness />);
  });
  mounted.push(tree);
  return gated;
}

afterEach(async () => {
  const trees = mounted;
  mounted = [];
  await act(async () => {
    trees.forEach((t) => t.unmount());
  });
});

beforeEach(() => {
  mockValue = null;
  mockReadFails = false;
  mockNetType = 'wifi';
  gated = false;
});

describe('отказ базы — не разрешение качать', () => {
  it('базу не прочитали — ворота закрыты, а не открыты настежь', async () => {
    mockReadFails = true;

    await expect(ask()).resolves.toBe(true);
  });

  it('в базе стоит «никогда» — и отказ чтения этого не отменяет', async () => {
    // Самый дорогой случай: человек запретил, база не ответила, и запрет
    // молча превращался в разрешение. Вернуть ушедший запрос нечем.
    mockValue = 'never';
    mockReadFails = true;

    await expect(ask()).resolves.toBe(true);
  });

  it('режим Wi-Fi, а сеть не назвалась — тоже придерживаем', async () => {
    mockValue = 'wifi';
    mockNetType = null;

    await expect(ask()).resolves.toBe(true);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: исправная база решает как решала', () => {
  it('«всегда» — качаем без нажатия', async () => {
    mockValue = 'always';

    await expect(ask()).resolves.toBe(false);
  });

  it('«никогда» — придерживаем', async () => {
    mockValue = 'never';

    await expect(ask()).resolves.toBe(true);
  });

  it('«только Wi-Fi» на Wi-Fi — качаем', async () => {
    mockValue = 'wifi';
    mockNetType = 'wifi';

    await expect(ask()).resolves.toBe(false);
  });

  it('«только Wi-Fi» на мобильном — придерживаем', async () => {
    mockValue = 'wifi';
    mockNetType = 'cellular';

    await expect(ask()).resolves.toBe(true);
  });

  it('ГРАНИЦА: записи нет — это первый запуск, а не беда', async () => {
    // Значение по умолчанию тут «всегда», и таким же его показывает экран
    // настроек (v4.32.248). Правка не имеет права трогать этот случай.
    mockValue = null;

    await expect(ask()).resolves.toBe(false);
  });

  it('ГРАНИЦА: незнакомое значение по-прежнему читается как «всегда»', async () => {
    mockValue = 'мусор';

    await expect(ask()).resolves.toBe(false);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('kvGet и правда сводит отказ с отсутствием записи в один null', () => {
    const at = LOCAL().indexOf('export async function kvGet(key: string)');
    expect(at).toBeGreaterThan(0);
    expect(LOCAL().slice(at, at + 160)).toContain('(await kvTryGet(key))?.value ?? null');
  });

  it('закрытые ворота человеку не стоят ничего, кроме нажатия', () => {
    for (const [name, src] of Object.entries({ переписка: STRIP(), группа: GRID() })) {
      expect([name, src.includes('const holdBack = gated && !wanted;')]).toEqual([name, true]);
      expect([name, src.includes('onPress={() => setWanted(true)}')]).toEqual([name, true]);
    }
    expect(PICKER()).toContain('if (gated && !wanted)');
    expect(PICKER()).toContain('GIF — нажмите, чтобы загрузить');
  });

  it('открытые ворота человеку стоят похода в сеть', () => {
    // Пока ворота открыты, адреса уходят в разбор, а он идёт на шлюз; пузырь
    // GIF грузит картинку прямо с чужого сервера. Если однажды это перестанет
    // быть так, проверка упадёт и потребует пересмотреть саму постановку.
    for (const [name, src] of Object.entries({ переписка: STRIP(), группа: GRID() })) {
      expect([name, src.includes('useResolvedMediaSlots(')]).toEqual([name, true]);
      expect([name, src.includes('holdBack ? [] : entries')]).toEqual([name, true]);
    }
    expect(PICKER()).toContain('source={{ uri: url }}');
  });

  it('экран настроек ту же запись спрашивает честно — и говорит об отказе', () => {
    expect(SETTINGS()).toContain("kvRead('auto_download_media')");
    const at = SETTINGS().indexOf('const kvRead = async (key: string)');
    expect(at).toBeGreaterThan(0);
    expect(SETTINGS().slice(at, at + 220)).toContain('got === null ? unreadable(key)');
    expect(SETTINGS()).toContain('throw new Error(`settings_unreadable:${key}`)');
  });
});

describe('ЗАКРЕПКА', () => {
  it('настройка спрашивается тремя состояниями, а не kvGet', () => {
    const src = GATE();
    expect(src).toContain("await kvTryGet('auto_download_media')");
    expect(src).not.toContain("kvGet('auto_download_media')");
    // «Всегда» осталось значением по умолчанию — но теперь оно берётся из
    // прочитанного ответа, а не подставляется вместо непрочитанного.
    expect(src).toContain("const mode = got.value ?? 'always';");
  });

  it('обе развилки отказа закрывают ворота, а не открывают', () => {
    const src = GATE();
    // Отказ базы и отказ NetInfo — два разных места, и оба обязаны вести к
    // одному и тому же придержанному пузырю.
    const at = src.indexOf('} catch {');
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 90)).toContain('setGated(true)');
    expect(src.match(/setGated\(true\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});
