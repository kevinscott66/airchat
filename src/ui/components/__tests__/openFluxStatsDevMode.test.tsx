/**
 * Счётчик соединений туннеля — только в режиме разработчика.
 *
 * Проверяется не косметика, а последствие: кнопка «Считать соединения»
 * включает в ядре режим, который до перезапуска приложения не выключить и
 * который пишет в журнал адрес каждого соединения. Пока она была на общем
 * экране, любой, кто зашёл включить обход блокировок, мог нажать её, не поняв
 * цены. Плюс надпись «Ни одного соединения» рядом с «Включён» без
 * пояснения читается как поломка.
 */
import React from 'react';

import { queryByTestId, render, textOf, unmount } from '../../__tests__/support/renderA11y';
import { OpenFluxSettingsSection } from '../OpenFluxSettingsSection';
import { getOpenFluxHttpLayerActive } from '../../../core/vpn/openFluxController';

jest.mock('../../../core/config', () => ({
  loadConfig: jest.fn(async () => ({ openflux: { enabled: true } })),
  getConfigSync: jest.fn(() => ({ openflux: { enabled: true } })),
  saveConfigOverride: jest.fn(async () => ({ openflux: { enabled: true } })),
}));

jest.mock('../../../core/vpn/openFluxController', () => ({
  getOpenFluxRunning: jest.fn(async () => true),
  getOpenFluxSocksAddr: jest.fn(async () => '127.0.0.1:1080'),
  // Счётчик на платформе есть: именно поэтому без режима разработчика его
  // отсутствие на экране — решение, а не следствие «считать нечем».
  getOpenFluxTunnelStats: jest.fn(async () => ({
    counting: false,
    connections: 0,
    failures: 0,
    lastTarget: null,
    lastAt: null,
    systemProxy: true,
    httpProxy: true,
  })),
  enableOpenFluxTunnelStats: jest.fn(async () => true),
  getOpenFluxHttpLayerActive: jest.fn(() => true),
  retryOpenFlux: jest.fn(async () => 'on'),
  stopOpenFlux: jest.fn(async () => undefined),
}));

jest.mock('../../../core/vpn/openFluxNetworkGuard', () => ({
  addOpenFluxReviveListener: jest.fn(() => () => undefined),
}));

jest.mock('../../../core/transport/internet/restartInternetTransport', () => ({
  restartInternetTransport: jest.fn(async () => undefined),
}));

describe('OpenFluxSettingsSection: счётчик за режимом разработчика', () => {
  it('без режима разработчика кнопки «Считать соединения» нет, а переключатель есть', async () => {
    const r = await render(<OpenFluxSettingsSection />);
    expect(queryByTestId(r.root, 'openflux_count')).toBeNull();
    expect(queryByTestId(r.root, 'openflux_switch')).toBeTruthy();
    await unmount(r);
  });

  it('в режиме разработчика кнопка появляется', async () => {
    const r = await render(<OpenFluxSettingsSection devMode />);
    expect(queryByTestId(r.root, 'openflux_count')).toBeTruthy();
    await unmount(r);
  });
});

/**
 * Перехват HTTP мог не встать, хотя ядро поднялось, — и сказать об этом надо
 * всем, а не только тому, кто семь раз нажал по номеру версии.
 *
 * На iOS перехват сетевого стека ставится один раз за процесс и на заранее
 * зарезервированный порт; занял его кто-то другой — ядро поднимается на любом
 * свободном, а перехват остаётся нацелен в пустоту. Failover у него включён
 * намеренно, поэтому запросы не падают, а тихо уходят напрямую. Человек при
 * этом читает «Включён» и включал туннель ровно затем, чтобы прямого
 * трафика не было.
 */
describe('OpenFluxSettingsSection: перехват не встал', () => {
  const layer = getOpenFluxHttpLayerActive as unknown as jest.Mock;

  /**
   * Опознаватель предупреждения. v4.32.953: надпись переписана — она говорит
   * теперь следствие и действие, а не причину («их порт заняли раньше нас»).
   * Предмет проверки прежний: три состояния перехвата и то, что предупреждение
   * стоит вне режима разработчика.
   */
  const BYPASS = 'идут мимо него';

  afterEach(() => layer.mockReturnValue(true));

  it('молчит, пока перехват на месте', async () => {
    const r = await render(<OpenFluxSettingsSection />);
    expect(textOf(r.root)).not.toContain(BYPASS);
    await unmount(r);
  });

  it('предупреждает без всякого режима разработчика', async () => {
    layer.mockReturnValue(false);
    const r = await render(<OpenFluxSettingsSection />);
    expect(textOf(r.root)).toContain(BYPASS);
    await unmount(r);
  });

  it('на платформе без ответа не выдумывает предупреждение', async () => {
    // `null` — «не спрашивали или спрашивать некому» (Android, web, старая
    // iOS). Показать здесь предупреждение значило бы пугать прямым трафиком
    // там, где его нет.
    layer.mockReturnValue(null);
    const r = await render(<OpenFluxSettingsSection />);
    expect(textOf(r.root)).not.toContain(BYPASS);
    await unmount(r);
  });
});
