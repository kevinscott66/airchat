/**
 * Инженерные разделы настроек не показываются обычному человеку.
 *
 * Проверяется не оформление, а два последствия. Первое: мост для внешнего
 * агента выдаёт ключ, которым можно сменить сервер доставки, — на экране
 * «Обход блокировок» такая кнопка стояла рядом с обычным переключателем.
 * Второе: пункт меню не должен вести в пустоту, если единственная секция за
 * ним скрыта.
 */
import { settingsVisibility } from '../settingsVisibility';

const BOTH = { openFluxAvailable: true, embeddedVpnAvailable: true };

describe('settingsVisibility', () => {
  it('без режима разработчика инженерного не видно', () => {
    const v = settingsVisibility({ devMode: false, ...BOTH });
    expect(v.relayRow).toBe(false);
    expect(v.bridgeSection).toBe(false);
    expect(v.vpnSection).toBe(false);
    expect(v.tunnelStats).toBe(false);
    expect(v.diagnosticsRow).toBe(false);
    expect(v.developerSection).toBe(false);
  });

  it('обход блокировок остаётся: это и есть то, ради чего человек сюда идёт', () => {
    expect(settingsVisibility({ devMode: false, ...BOTH }).bypassRow).toBe(true);
  });

  it('в режиме разработчика видно всё, что есть на платформе', () => {
    const v = settingsVisibility({ devMode: true, ...BOTH });
    expect(v.relayRow).toBe(true);
    expect(v.bridgeSection).toBe(true);
    expect(v.vpnSection).toBe(true);
    expect(v.tunnelStats).toBe(true);
    expect(v.diagnosticsRow).toBe(true);
    expect(v.developerSection).toBe(true);
  });

  it('мост показывается и там, где ядра OpenFlux нет: состояние туннеля он отдаёт и оттуда', () => {
    const v = settingsVisibility({
      devMode: true,
      openFluxAvailable: false,
      embeddedVpnAvailable: false,
    });
    expect(v.bridgeSection).toBe(true);
  });

  it('пункт «Обход блокировок» не ведёт в пустой экран', () => {
    // Ядра OpenFlux нет, свой VPN есть, но он скрыт — за пунктом ничего нет.
    const hidden = settingsVisibility({
      devMode: false,
      openFluxAvailable: false,
      embeddedVpnAvailable: true,
    });
    expect(hidden.bypassRow).toBe(false);

    // Тот же случай в режиме разработчика: секция VPN появилась — появился и пункт.
    const shown = settingsVisibility({
      devMode: true,
      openFluxAvailable: false,
      embeddedVpnAvailable: true,
    });
    expect(shown.vpnSection).toBe(true);
    expect(shown.bypassRow).toBe(true);
  });
});
