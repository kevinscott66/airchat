/**
 * Веб-уведомление может вызываться сетевым событием, а не нажатием пользователя.
 * Браузеры считают такой вызов поводом для отказа в разрешении, поэтому баннер
 * не должен сам открывать системный запрос.
 */

const originals = new Map<string, PropertyDescriptor | undefined>();

function define(name: string, value: unknown): void {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  originals.clear();
  jest.resetModules();
});

function setup(permission: NotificationPermission = 'default') {
  const requestPermission = jest.fn(async () => 'granted');
  const NotificationMock = jest.fn();
  Object.assign(NotificationMock, { permission, requestPermission });
  define('window', globalThis);
  define('Notification', NotificationMock);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return { notifee: require('../notifee').default, requestPermission, NotificationMock };
}

describe('веб-обёртка notifee', () => {
  it('не спрашивает разрешение при показе баннера от сетевого события', async () => {
    const h = setup();
    await h.notifee.displayNotification({ title: 'AirChat', body: 'Новое сообщение' });
    expect(h.requestPermission).not.toHaveBeenCalled();
    expect(h.NotificationMock).not.toHaveBeenCalled();
  });

  it('запрашивает разрешение только явным API настроек', async () => {
    const h = setup();
    await expect(h.notifee.requestPermission()).resolves.toEqual({ authorizationStatus: 1 });
    expect(h.requestPermission).toHaveBeenCalledTimes(1);
  });
});
