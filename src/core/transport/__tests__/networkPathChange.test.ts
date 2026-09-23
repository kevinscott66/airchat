/**
 * Смена пути трафика: что наблюдатель считает переключением сети (v4.32.723).
 *
 * Проверяется не «функция позвала функцию», а различимость двух случаев,
 * которые для приложения выглядят одинаково, а для туннеля — по-разному.
 * Связь пропала и вернулась — это старый, уже работавший признак. Связь не
 * пропадала, но телефон переехал с Wi-Fi на мобильный интернет или поверх
 * всего встал чужой VPN — до этой правки ничего не происходило вовсе, и
 * именно так туннель и оставался лежать.
 *
 * Отдельно — про пачку. Одно переключение сети приходит четырьмя-пятью
 * событиями подряд; по каждому из них поднимать заново сетевое ядро значит
 * четыре раза подряд разорвать все соединения приложения. Поэтому важно не
 * только то, что подписчика позвали, но и то, что позвали ровно один раз и с
 * той сетью, куда приехали, а не с промежуточной.
 */
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../social/feedService', () => ({
  flushFeedPublishQueue: jest.fn(async () => {}),
  resumeCommentOutbox: jest.fn(),
}));
jest.mock('../../storage/sync', () => ({ runSyncIfOnline: jest.fn(async () => {}) }));

// Состояние заглушки держим в объекте с именем на `mock`: babel поднимает
// `jest.mock` выше объявлений, и обычную константу фабрика бы не увидела.
const mockNet: {
  initial: { isConnected?: boolean; type?: string };
  listener: ((ev: { isConnected?: boolean; type?: string }) => void) | null;
  removed: number;
} = { initial: { isConnected: true, type: 'WIFI' }, listener: null, removed: 0 };

jest.mock('expo-network', () => ({
  getNetworkStateAsync: jest.fn(async () => mockNet.initial),
  addNetworkStateListener: jest.fn((fn: (ev: { isConnected?: boolean; type?: string }) => void) => {
    mockNet.listener = fn;
    return {
      remove: () => {
        mockNet.removed += 1;
        mockNet.listener = null;
      },
    };
  }),
}));

import type { KeyPairBytes } from '../../crypto/keyManager';
import {
  addNetworkPathListener,
  startNetworkReconnectWatcher,
  stopNetworkReconnectWatcher,
  type NetworkPathChange,
} from '../networkReconnectWatcher';

const PAIR = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) } as KeyPairBytes;

/** Поднять наблюдатель и дождаться, пока сядет начальное состояние сети. */
async function startSeeded(initial: { isConnected?: boolean; type?: string }): Promise<void> {
  mockNet.initial = initial;
  startNetworkReconnectWatcher(PAIR);
  // Затравка читается асинхронно; без прокрутки микрозадач первое же событие
  // сравнивалось бы с `null` и выглядело как «связь вернулась».
  await Promise.resolve();
  await Promise.resolve();
}

function emit(ev: { isConnected?: boolean; type?: string }): void {
  if (!mockNet.listener) throw new Error('наблюдатель не подписался на события сети');
  mockNet.listener(ev);
}

const unsubs: Array<() => void> = [];
function listen(): NetworkPathChange[] {
  const seen: NetworkPathChange[] = [];
  unsubs.push(addNetworkPathListener((c) => seen.push(c)));
  return seen;
}

beforeEach(() => {
  jest.useFakeTimers();
  mockNet.listener = null;
  mockNet.removed = 0;
});

afterEach(() => {
  while (unsubs.length) unsubs.pop()?.();
  stopNetworkReconnectWatcher();
  jest.useRealTimers();
});

describe('смена пути трафика', () => {
  it('замечает переезд с Wi-Fi на мобильный интернет, хотя связь не пропадала', async () => {
    await startSeeded({ isConnected: true, type: 'WIFI' });
    const seen = listen();

    emit({ isConnected: true, type: 'CELLULAR' });
    jest.runOnlyPendingTimers();

    expect(seen).toEqual([{ reason: 'type', from: 'WIFI', to: 'CELLULAR' }]);
  });

  it('замечает включение постороннего VPN поверх текущей сети', async () => {
    await startSeeded({ isConnected: true, type: 'WIFI' });
    const seen = listen();

    emit({ isConnected: true, type: 'VPN' });
    jest.runOnlyPendingTimers();

    expect(seen).toEqual([{ reason: 'type', from: 'WIFI', to: 'VPN' }]);
  });

  it('возврат связи тоже считает сменой пути, и отличает его от переезда', async () => {
    await startSeeded({ isConnected: false, type: 'NONE' });
    const seen = listen();

    emit({ isConnected: true, type: 'CELLULAR' });
    jest.runOnlyPendingTimers();

    expect(seen).toEqual([{ reason: 'reconnect', from: 'NONE', to: 'CELLULAR' }]);
  });

  it('пачку событий за одно переключение сводит к одному вызову — по той сети, куда приехали', async () => {
    await startSeeded({ isConnected: true, type: 'WIFI' });
    const seen = listen();

    // Так это и приходит на телефоне: Wi-Fi отвалился, мелькнуло «связи нет»,
    // поднялся мобильный, дорасползлись ещё два уточняющих события.
    emit({ isConnected: false, type: 'NONE' });
    emit({ isConnected: true, type: 'CELLULAR' });
    emit({ isConnected: true, type: 'CELLULAR' });
    emit({ isConnected: true, type: 'WIFI' });
    jest.runOnlyPendingTimers();

    expect(seen).toHaveLength(1);
    expect(seen[0].to).toBe('WIFI');
  });

  it('молчит, пока связи нет: поднимать туннель некуда', async () => {
    await startSeeded({ isConnected: true, type: 'WIFI' });
    const seen = listen();

    emit({ isConnected: false, type: 'NONE' });
    jest.runOnlyPendingTimers();

    expect(seen).toEqual([]);
  });

  it('молчит, когда сеть та же самая', async () => {
    await startSeeded({ isConnected: true, type: 'WIFI' });
    const seen = listen();

    emit({ isConnected: true, type: 'WIFI' });
    emit({ isConnected: true, type: 'WIFI' });
    jest.runOnlyPendingTimers();

    expect(seen).toEqual([]);
  });

  it('падение одного подписчика не отменяет остальных', async () => {
    await startSeeded({ isConnected: true, type: 'WIFI' });
    unsubs.push(
      addNetworkPathListener(() => {
        throw new Error('подписчик споткнулся');
      }),
    );
    const seen = listen();

    emit({ isConnected: true, type: 'CELLULAR' });
    jest.runOnlyPendingTimers();

    expect(seen).toHaveLength(1);
  });

  it('отписка снимает вызов', async () => {
    await startSeeded({ isConnected: true, type: 'WIFI' });
    const seen: NetworkPathChange[] = [];
    const off = addNetworkPathListener((c) => seen.push(c));
    off();

    emit({ isConnected: true, type: 'CELLULAR' });
    jest.runOnlyPendingTimers();

    expect(seen).toEqual([]);
  });

  it('остановка наблюдателя гасит уже отложенное сообщение', async () => {
    await startSeeded({ isConnected: true, type: 'WIFI' });
    const seen = listen();

    emit({ isConnected: true, type: 'CELLULAR' });
    // Между событием и срабатыванием таймера человек успел сменить аккаунт.
    stopNetworkReconnectWatcher();
    jest.runOnlyPendingTimers();

    expect(seen).toEqual([]);
    expect(mockNet.removed).toBe(1);
  });

  it('подписка переживает перезапуск наблюдателя', async () => {
    await startSeeded({ isConnected: true, type: 'WIFI' });
    const seen = listen();
    stopNetworkReconnectWatcher();
    await startSeeded({ isConnected: true, type: 'WIFI' });

    emit({ isConnected: true, type: 'CELLULAR' });
    jest.runOnlyPendingTimers();

    expect(seen).toHaveLength(1);
  });
});
