/**
 * Web Push в браузере (v4.32.560).
 *
 * До этой версии шим отвечал «токена не будет» и веб-версия оставалась без
 * единого уведомления при закрытой вкладке. Теперь он подписывает браузер
 * по-настоящему, и проверять надо ровно то, что отличает работающую подписку
 * от видимости работы: что ключ VAPID берётся у нашего сервера, что подписка
 * уходит на сервер той самой строкой, которую отдал браузер, и что при любом
 * отказе (нет разрешения, нет Push API, нет ключей на сервере) `getToken`
 * кидает, а не возвращает пустую строку — пустую строку вызывающий записал бы
 * на сервер как рабочий токен.
 */

import fs from 'fs';
import path from 'path';

const mockLoadConfig = jest.fn();
jest.mock('../../../src/core/config', () => ({ loadConfig: () => mockLoadConfig() }));

const SIGNALING = 'https://signaling.example';
const ENDPOINT = 'https://updates.push.services.mozilla.com/wpush/v2/fake-id';
const SUBSCRIPTION = { endpoint: ENDPOINT, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } };
/** Открытый ключ VAPID: несжатая точка P-256 — 65 байт, первый 0x04. */
const RAW_KEY = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 7)]);
const VAPID_KEY = RAW_KEY.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

type Harness = {
  register: jest.Mock;
  subscribe: jest.Mock;
  getSubscription: jest.Mock;
  unsubscribe: jest.Mock;
  fetchMock: jest.Mock;
  requestPermission: jest.Mock;
};

const originals = new Map<string, PropertyDescriptor | undefined>();

/** Подменить глобальную переменную так, чтобы её можно было вернуть назад. */
function define(name: string, value: unknown): void {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function setupBrowser(opts: {
  permission?: NotificationPermission;
  existing?: unknown;
  keyStatus?: number;
  noPushApi?: boolean;
} = {}): Harness {
  const unsubscribe = jest.fn(async () => true);
  const subscribe = jest.fn(async () => ({ toJSON: () => SUBSCRIPTION, unsubscribe }));
  const existing = opts.existing === undefined
    ? null
    : { toJSON: () => SUBSCRIPTION, unsubscribe };
  const getSubscription = jest.fn(async () => existing);
  const registration = { pushManager: { getSubscription, subscribe } };
  const register = jest.fn(async () => registration);
  const requestPermission = jest.fn(async () => opts.permission ?? 'granted');
  const fetchMock = jest.fn(async () => ({
    ok: (opts.keyStatus ?? 200) < 400,
    status: opts.keyStatus ?? 200,
    json: async () => ({ key: VAPID_KEY }),
  }));

  define('window', globalThis);
  define('Notification', { permission: opts.permission ?? 'granted', requestPermission });
  define('navigator', { serviceWorker: { register, ready: Promise.resolve(registration) } });
  if (opts.noPushApi) {
    // Именно удаление, а не undefined: шим спрашивает `'PushManager' in window`,
    // и объявленное со значением undefined имя такую проверку проходит.
    if (!originals.has('PushManager')) {
      originals.set('PushManager', Object.getOwnPropertyDescriptor(globalThis, 'PushManager'));
    }
    delete (globalThis as Record<string, unknown>).PushManager;
  } else {
    define('PushManager', function PushManager() { /* только наличие имени и важно */ });
  }
  define('fetch', fetchMock);
  mockLoadConfig.mockResolvedValue({ webrtc: { signalingUrl: SIGNALING } });
  return { register, subscribe, getSubscription, unsubscribe, fetchMock, requestPermission };
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const messaging = () => require('../firebase-messaging').default();

afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  originals.clear();
  jest.clearAllMocks();
});

describe('подписка браузера', () => {
  it('уходит на сервер той самой строкой, которую отдал браузер', async () => {
    const h = setupBrowser();
    const token = await messaging().getToken();
    expect(JSON.parse(token)).toEqual(SUBSCRIPTION);
    expect(h.register).toHaveBeenCalledWith('/sw.js');
    expect(h.fetchMock.mock.calls[0][0]).toBe(`${SIGNALING}/webpush-key`);
  });

  it('просит у браузера видимое уведомление и наш ключ', async () => {
    const h = setupBrowser();
    await messaging().getToken();
    const options = h.subscribe.mock.calls[0][0];
    // Браузер не даёт подписки тому, кто обещает молчать.
    expect(options.userVisibleOnly).toBe(true);
    const key = Buffer.from(options.applicationServerKey);
    expect(key.length).toBe(65);
    expect(key[0]).toBe(0x04);
    expect(key.equals(RAW_KEY)).toBe(true);
  });

  it('не пересоздаётся, если она уже есть', async () => {
    const h = setupBrowser({ existing: SUBSCRIPTION });
    const token = await messaging().getToken();
    expect(JSON.parse(token)).toEqual(SUBSCRIPTION);
    expect(h.subscribe).not.toHaveBeenCalled();
    // За ключом ходить тоже незачем: подписка уже подписана им.
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('снимается вместе с токеном', async () => {
    const h = setupBrowser({ existing: SUBSCRIPTION });
    await messaging().deleteToken();
    expect(h.unsubscribe).toHaveBeenCalled();
  });
});

describe('отказ виден, а не превращается в пустой токен', () => {
  it('без разрешения', async () => {
    const h = setupBrowser({ permission: 'denied' });
    await expect(messaging().getToken()).rejects.toThrow('webpush_permission_denied');
    expect(h.subscribe).not.toHaveBeenCalled();
  });

  it('без Push API в браузере', async () => {
    setupBrowser({ noPushApi: true });
    await expect(messaging().getToken()).rejects.toThrow('webpush_unsupported');
  });

  it('без ключей VAPID на сервере', async () => {
    // 404 — web-push на сервере просто выключен; подписываться нечем.
    const h = setupBrowser({ keyStatus: 404 });
    await expect(messaging().getToken()).rejects.toThrow('webpush_key_unavailable_404');
    expect(h.subscribe).not.toHaveBeenCalled();
  });

  it('без адреса сигналинга', async () => {
    const h = setupBrowser();
    mockLoadConfig.mockResolvedValue({ webrtc: {} });
    await expect(messaging().getToken()).rejects.toThrow('webpush_no_signaling_url');
    expect(h.subscribe).not.toHaveBeenCalled();
  });
});

describe('разрешение', () => {
  it('спрашивается у браузера и переводится в статус', async () => {
    const granted = setupBrowser();
    expect(await messaging().requestPermission()).toBe(1);
    expect(granted.requestPermission).toHaveBeenCalled();
    setupBrowser({ permission: 'denied' });
    expect(await messaging().requestPermission()).toBe(0);
  });

  it('в браузере без Push API всегда отказ', async () => {
    setupBrowser({ noPushApi: true });
    expect(await messaging().requestPermission()).toBe(0);
    expect(await messaging().hasPermission()).toBe(0);
  });
});

describe('страница, которую ставят на домашний экран', () => {
  const ROOT = path.join(__dirname, '..', '..', '..');
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  it('объявляет манифест и иконку — иначе Safari не даст Push API', () => {
    const html = read(path.join('public', 'index.html'));
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('apple-touch-icon');
    // Точка монтирования приложения обязана пережить наш шаблон.
    expect(html).toContain('id="root"');
  });

  it('манифест описывает установку, а не украшение', () => {
    const manifest = JSON.parse(read(path.join('public', 'manifest.webmanifest')));
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    for (const icon of manifest.icons as { src: string }[]) {
      expect(fs.existsSync(path.join(ROOT, 'public', icon.src.replace(/^\//, '')))).toBe(true);
    }
  });

  it('Service Worker показывает баннер и не читает содержимого push', () => {
    const sw = read(path.join('public', 'sw.js'));
    expect(sw).toContain("addEventListener('push'");
    expect(sw).toContain('showNotification');
    // Содержимого в push нет вовсе — читать event.data нечего и незачем.
    expect(sw).not.toContain('event.data');
    expect(sw).toContain("addEventListener('notificationclick'");
  });
});
