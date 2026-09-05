/**
 * Адреса серверов на границе конфига (v4.32.381).
 *
 * Правило разбора адреса проверено отдельно (core/net/__tests__). Здесь
 * проверяется другое: что оно применяется на КАЖДОМ пути сборки конфига.
 * Путей четыре — с бандлом, без бандла, синхронный и после сохранения
 * переопределения, — и раньше шаг подстановки писался на каждом заново.
 * Значения из Documents/airchat-config.json до правила не доходили вовсе.
 *
 * expo-file-system — фейк в памяти, диск не трогается.
 */
jest.mock('expo-file-system/legacy', () => {
  const files: Record<string, string> = {};
  return {
    __files: files,
    documentDirectory: '/doc/',
    getInfoAsync: jest.fn(async (uri: string) => ({ exists: uri in files, size: (files[uri] ?? '').length })),
    readAsStringAsync: jest.fn(async (uri: string) => files[uri] ?? ''),
    writeAsStringAsync: jest.fn(async (uri: string, data: string) => { files[uri] = data; }),
  };
});
jest.mock('../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));
jest.mock('../transport/ipfs/resolveLoopback', () => ({
  resolveIpfsLoopbackForAndroid: (u: string) => u,
}));

import type { AppConfig } from '../config';

const fsMock = jest.requireMock('expo-file-system/legacy') as { __files: Record<string, string> };
const OVERRIDE_URI = '/doc/airchat-config.json';

type ConfigModule = typeof import('../config');

/** Свежий модуль на каждый вызов: эффективный конфиг кэшируется в модуле. */
function freshConfig(): ConfigModule {
  let mod!: ConfigModule;
  jest.isolateModules(() => {
    mod = require('../config') as ConfigModule;
  });
  return mod;
}

/** Положить переопределение и загрузить конфиг тем же путём, что и приложение. */
async function loadWithOverride(override: Partial<AppConfig>): Promise<AppConfig> {
  fsMock.__files[OVERRIDE_URI] = JSON.stringify(override);
  return freshConfig().loadConfig();
}

beforeEach(() => {
  for (const k of Object.keys(fsMock.__files)) delete fsMock.__files[k];
});

describe('адреса ретранслятора из конфига', () => {
  it('хвостовой слэш снимается — иначе `${relayBase}/${topic}` даёт двойной', async () => {
    const cfg = await loadWithOverride({
      internet: { enabled: true, relayBase: 'https://ntfy.example.com/', wsBase: 'wss://ntfy.example.com/' },
    });
    expect(cfg.internet?.relayBase).toBe('https://ntfy.example.com');
    expect(cfg.internet?.wsBase).toBe('wss://ntfy.example.com');
  });

  it('пустая строка заменяется значением по умолчанию, а не пролезает дальше', async () => {
    // Самый вредный случай: `opts.relayBase ?? DEFAULT` пустую строку НЕ
    // ловит (она не nullish), и транспорт собирает относительный '/<тема>'.
    const cfg = await loadWithOverride({ internet: { enabled: true, relayBase: '', wsBase: '' } });
    expect(cfg.internet?.relayBase).toBe('https://ntfy.sh');
    expect(cfg.internet?.wsBase).toBe('wss://ntfy.sh');
  });

  it('мусор вместо адреса заменяется значением по умолчанию', async () => {
    const cfg = await loadWithOverride({
      internet: { enabled: true, relayBase: 'file:///etc/passwd', wsBase: 'не адрес' },
    });
    expect(cfg.internet?.relayBase).toBe('https://ntfy.sh');
    expect(cfg.internet?.wsBase).toBe('wss://ntfy.sh');
  });

  it('переопределён только HTTP-адрес — WebSocket идёт следом, а не остаётся на ntfy.sh', async () => {
    // В airchat-config.json достаточно написать один relayBase; вторая
    // половина пары остаётся заводской и молча уводит подписку на чужой
    // сервер. Выглядит это как «сообщения уходят, но не приходят».
    const cfg = await loadWithOverride({ internet: { enabled: true, relayBase: 'https://ntfy.example.com' } });
    expect(cfg.internet?.wsBase).toBe('wss://ntfy.example.com');
  });

  it('переопределён только WebSocket-адрес — HTTP идёт следом', async () => {
    const cfg = await loadWithOverride({ internet: { enabled: true, wsBase: 'wss://ntfy.example.com/ntfy' } });
    expect(cfg.internet?.relayBase).toBe('https://ntfy.example.com/ntfy');
  });

  it('но два разных СВОИХ сервера остаются как есть — это осознанная настройка', async () => {
    // Уступает только заводская половина пары. Если человек вписал оба адреса
    // сам, догадываться за него нельзя.
    const cfg = await loadWithOverride({
      internet: { enabled: true, relayBase: 'https://post.example.com', wsBase: 'wss://listen.example.com' },
    });
    expect(cfg.internet?.relayBase).toBe('https://post.example.com');
    expect(cfg.internet?.wsBase).toBe('wss://listen.example.com');
  });

  it('остальные поля секции не теряются', async () => {
    const cfg = await loadWithOverride({ internet: { enabled: false, relayBase: 'ntfy.example.com' } });
    expect(cfg.internet?.enabled).toBe(false);
  });

  it('значения по умолчанию уже нормализованы — правило их не меняет', async () => {
    const cfg = await freshConfig().loadConfig();
    expect(cfg.internet?.relayBase).toBe('https://ntfy.sh');
    expect(cfg.internet?.wsBase).toBe('wss://ntfy.sh');
  });
});

describe('адрес сигнального сервера из конфига', () => {
  it('wss:// приводится к https:// — по этому же адресу ходит fetch', async () => {
    // socket.io принимает wss://, а fetch на `${base}/register-token` — нет:
    // звонки работали, регистрация пуш-токена молча не работала.
    const cfg = await loadWithOverride({ webrtc: { signalingUrl: 'wss://sig.example.com' } as never });
    expect(cfg.webrtc.signalingUrl).toBe('https://sig.example.com');
  });

  it('хвостовой слэш снимается', async () => {
    const cfg = await loadWithOverride({ webrtc: { signalingUrl: 'https://sig.example.com/' } as never });
    expect(cfg.webrtc.signalingUrl).toBe('https://sig.example.com');
  });

  it('негодный адрес выключает функцию, а не уезжает в fetch', async () => {
    for (const raw of ['file:///etc/passwd', 'javascript:alert(1)', '   ', 'нет']) {
      const cfg = await loadWithOverride({ webrtc: { signalingUrl: raw } as never });
      expect([raw, cfg.webrtc.signalingUrl]).toEqual([raw, undefined]);
    }
  });

  it('production endpoint из bundled config сохраняется', async () => {
    const cfg = await freshConfig().loadConfig();
    expect(cfg.webrtc.signalingUrl).toBe('https://signaling.dobropalm.tech');
  });
});

describe('адрес облачной копии из конфига', () => {
  it('нормализует HTTPS и включает функцию', async () => {
    const cfg = await loadWithOverride({
      cloudBackup: { enabled: true, baseUrl: 'https://cloud.example.com/' },
    });
    expect(cfg.cloudBackup).toEqual({ enabled: true, baseUrl: 'https://cloud.example.com' });
  });

  it('отклоняет HTTP, чтобы облачный запрос нельзя было перехватить', async () => {
    const cfg = await loadWithOverride({
      cloudBackup: { enabled: true, baseUrl: 'http://cloud.example.com' },
    });
    expect(cfg.cloudBackup?.enabled).toBe(false);
    expect(cfg.cloudBackup?.baseUrl).toBe('');
  });
});

describe('нормализация на всех путях сборки конфига', () => {
  it('синхронный путь тоже нормализует', () => {
    const cfg = freshConfig().getConfigSync();
    expect(cfg.internet?.relayBase).toBe('https://ntfy.sh');
    expect(cfg.webrtc.signalingUrl).toBe('https://signaling.dobropalm.tech');
  });

  it('после сохранения переопределения адрес нормализован сразу, без перезапуска', async () => {
    const mod = freshConfig();
    const cfg = await mod.saveConfigOverride({
      internet: { enabled: true, relayBase: 'ntfy.example.com/' } as never,
      webrtc: { signalingUrl: 'wss://sig.example.com/' } as never,
    });
    expect(cfg.internet?.relayBase).toBe('https://ntfy.example.com');
    expect(cfg.internet?.wsBase).toBe('wss://ntfy.example.com');
    expect(cfg.webrtc.signalingUrl).toBe('https://sig.example.com');
    // В самом файле переопределения остаётся то, что ввёл человек, — правило
    // применяется к эффективному конфигу, а не переписывает пользователю файл.
    expect(mod.getConfigSync().internet?.relayBase).toBe('https://ntfy.example.com');
  });
});

describe('адрес облачной копии из переменной сборки', () => {
  // v4.32.541: в git на месте адреса лежит заглушка, и именно она уезжала в
  // сборку — восстановление из облака молча не работало. Настоящий адрес
  // приходит переменной сборки; проверяется, что она доходит до эффективного
  // конфига на обоих путях и что порядок старшинства не перевёрнут.
  const ENV = 'EXPO_PUBLIC_CLOUD_VAULT_URL';
  afterEach(() => {
    delete process.env[ENV];
  });

  it('без переменной облако выключено, а не указывает на заглушку', async () => {
    // v4.32.596. Раньше заглушка из git доезжала до эффективного конфига:
    // она разбирается, она https, общее правило её пропускало — и
    // isCloudVaultConfigured() отвечал «настроено» про хост, которого нет.
    // Виднее всего это было в веб-сборке: восстановление секретными словами
    // обещало облако и отдавало пустой аккаунт с правильным DID.
    const cfg = await freshConfig().loadConfig();
    expect(cfg.cloudBackup).toEqual({ enabled: false, baseUrl: '' });
  });

  it('заглушку гасит только заводское значение — свой адрес человека остаётся', async () => {
    // Правило про зарезервированные имена живёт в bundledConfig и к
    // переопределению из Documents не применяется: там example.com пишут
    // осознанно, и подменять человеку его выбор нечем.
    const cfg = await loadWithOverride({
      cloudBackup: { enabled: true, baseUrl: 'https://cloud.example.com' },
    });
    expect(cfg.cloudBackup).toEqual({ enabled: true, baseUrl: 'https://cloud.example.com' });
  });

  it('переменная сборки заменяет заглушку', async () => {
    process.env[ENV] = 'https://cloud.example.com';
    const cfg = await freshConfig().loadConfig();
    expect(cfg.cloudBackup).toEqual({ enabled: true, baseUrl: 'https://cloud.example.com' });
  });

  it('на синхронном пути тоже — иначе половина приложения ходила бы на заглушку', () => {
    process.env[ENV] = 'https://cloud.example.com/';
    expect(freshConfig().getConfigSync().cloudBackup?.baseUrl).toBe('https://cloud.example.com');
  });

  it('переопределение из Documents сильнее переменной сборки', async () => {
    // Переменная — заводское значение конкретной сборки, а не приказ. Свой
    // сервер, вписанный человеком, должен оставаться его выбором.
    process.env[ENV] = 'https://cloud.example.com';
    const cfg = await loadWithOverride({
      cloudBackup: { enabled: true, baseUrl: 'https://mine.example.com' },
    });
    expect(cfg.cloudBackup?.baseUrl).toBe('https://mine.example.com');
  });

  it('негодное значение переменной выключает функцию, а не подставляет заглушку', async () => {
    // Подставить обратно заглушку было бы хуже: она так же нерабочая, но
    // выглядит настроенной, и ошибку сборки никто бы не заметил.
    process.env[ENV] = 'http://cloud.example.com';
    const cfg = await freshConfig().loadConfig();
    expect(cfg.cloudBackup).toEqual({ enabled: false, baseUrl: '' });
  });
});
