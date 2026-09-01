import fs from 'fs';
import path from 'path';

import {
  LOCATION_FIX_TIMEOUT_MS,
  LOCATION_TIMEOUT_CODE,
  classifyLocationFailure,
  locationFailureText,
  locationFailureTextFor,
  withDeadline,
} from '../locationFailure';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

const HOME = read('core/social/locationFailure.ts');
const DEVICE = read('core/social/deviceLocation.ts');
const CHAT = read('ui/screens/ChatScreen.tsx');
const GROUPS = read('ui/screens/GroupsScreen.tsx');
const FEED = read('ui/screens/FeedScreen.tsx');

/**
 * Тело useCallback кончается не строкой `}` в нулевой колонке, а `  }, [...]`,
 * поэтому обычная нарезка по закрывающей скобке здесь не работает.
 * Вызывать ТОЛЬКО внутри теста: на исходном коде без нужного якоря expect
 * бросит при загрузке модуля, и набор отчитается нулём тестов.
 */
function callbackBody(src: string, head: string): string {
  const start = src.indexOf(head);
  expect(start).toBeGreaterThan(-1);
  const rest = src.slice(start);
  const end = rest.indexOf('\n  }, [');
  expect(end).toBeGreaterThan(-1);
  return rest.slice(0, end);
}

const SEND_LOC = (): string => callbackBody(CHAT, '  const handleSendLocationOnce = useCallback(async () => {');
const SHARE_CONTACT = (): string => callbackBody(CHAT, '  const handleShareContact = useCallback(async (c: {');
const LIVE_LOC = (): string => callbackBody(CHAT, '  const handleShareLiveLocation = useCallback(async (durationMinutes:');
const GROUP_LOC = (): string => callbackBody(GROUPS, '  const sendGroupLocation = useCallback(async () => {');

describe('classifyLocationFailure', () => {
  it('узнаёт выключенную геолокацию по коду expo', () => {
    expect(classifyLocationFailure('E_LOCATION_SERVICES_DISABLED')).toBe('disabled');
    expect(classifyLocationFailure('ERR_LOCATION_SETTINGS_UNSATISFIED')).toBe('disabled');
  });

  it('андроидное «provider is unavailable» — это выключенная геолокация, а не сбой приёмника', () => {
    // Слово unavailable в тексте есть, но повтор попытки не поможет никогда:
    // помогает только переключатель. Порядок проверок в модуле держится ровно
    // на этом случае.
    expect(
      classifyLocationFailure('Location provider is unavailable. Make sure that location services are enabled.'),
    ).toBe('disabled');
  });

  it('отличает нехватку разрешения', () => {
    expect(classifyLocationFailure('E_NO_PERMISSIONS')).toBe('denied');
    expect(classifyLocationFailure('Location permission was denied')).toBe('denied');
  });

  it('узнаёт наш собственный срок ожидания', () => {
    expect(classifyLocationFailure(LOCATION_TIMEOUT_CODE)).toBe('timeout');
    expect(classifyLocationFailure('request timed out')).toBe('timeout');
  });

  it('оставляет «приёмник есть, места нет» отдельной причиной', () => {
    expect(classifyLocationFailure('E_LOCATION_UNAVAILABLE')).toBe('unavailable');
  });

  it('читает код и текст настоящей ошибки expo, а не только строку', () => {
    const err = Object.assign(new Error('Location provider is unavailable.'), {
      code: 'E_LOCATION_SERVICES_DISABLED',
    });
    expect(classifyLocationFailure(err)).toBe('disabled');
  });

  it('код перевешивает общий текст', () => {
    const err = Object.assign(new Error('Something went wrong'), { code: 'E_LOCATION_TIMEOUT' });
    expect(classifyLocationFailure(err)).toBe('timeout');
  });

  it('пустота и мусор — это «неизвестно», а не падение', () => {
    expect(classifyLocationFailure('')).toBe('unknown');
    expect(classifyLocationFailure('   ')).toBe('unknown');
    expect(classifyLocationFailure(null)).toBe('unknown');
    expect(classifyLocationFailure(undefined)).toBe('unknown');
    expect(classifyLocationFailure({})).toBe('unknown');
    expect(classifyLocationFailure(new Error('boom'))).toBe('unknown');
  });
});

describe('locationFailureText', () => {
  const KINDS = ['denied', 'disabled', 'timeout', 'unavailable', 'unknown'] as const;

  it('у каждой причины свой текст — иначе разбор причины не нужен вовсе', () => {
    const texts = KINDS.map((k) => locationFailureText(k));
    expect(new Set(texts).size).toBe(KINDS.length);
  });

  it('все тексты русские: интерфейс приложения не знает второго языка', () => {
    for (const k of KINDS) expect(locationFailureText(k)).toMatch(/[А-Яа-яЁё]/);
  });

  it('чинимые причины называют действие, а не только беду', () => {
    expect(locationFailureText('disabled')).toMatch(/настройк/i);
    expect(locationFailureText('denied')).toMatch(/настройк/i);
    expect(locationFailureText('timeout')).toMatch(/окн|улиц/i);
  });

  it('короткий путь совпадает с разбором плюс текстом', () => {
    expect(locationFailureTextFor('E_LOCATION_SERVICES_DISABLED')).toBe(locationFailureText('disabled'));
  });
});

describe('withDeadline', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('успевший ответ проходит как есть', async () => {
    await expect(withDeadline(Promise.resolve(7), 1000)).resolves.toBe(7);
  });

  it('свой отказ проходит как есть', async () => {
    await expect(withDeadline(Promise.reject(new Error('nope')), 1000)).rejects.toThrow('nope');
  });

  it('по истечении срока отказывает опознаваемым кодом', async () => {
    const never = new Promise<number>(() => {});
    const p = withDeadline(never, 5000);
    const seen = p.catch((e: unknown) => (e as Error).message);
    jest.advanceTimersByTime(5000);
    await expect(seen).resolves.toBe(LOCATION_TIMEOUT_CODE);
  });

  it('опоздавший отказ не становится необработанным отклонением', async () => {
    let boom: (e: Error) => void = () => {};
    const late = new Promise<number>((_r, rej) => { boom = rej; });
    const p = withDeadline(late, 1000);
    const seen = p.catch((e: unknown) => (e as Error).message);
    jest.advanceTimersByTime(1000);
    await expect(seen).resolves.toBe(LOCATION_TIMEOUT_CODE);
    // Обработчик на опоздавшую работу навешен заранее — падения не будет.
    boom(new Error('too late'));
    await Promise.resolve();
  });

  it('успевший ответ снимает таймер: висящих счётчиков не остаётся', async () => {
    await withDeadline(Promise.resolve(1), 60_000);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('срок ожидания измерим и не бесконечен', () => {
    expect(LOCATION_FIX_TIMEOUT_MS).toBeGreaterThan(5_000);
    expect(LOCATION_FIX_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});

describe('дом причины отказа', () => {
  it('без единого импорта: его зовут и ядро, и три экрана', () => {
    expect(HOME).not.toMatch(/^import /m);
  });
});

describe('единственное место, где спрашивают координаты', () => {
  it('прямой вызов getCurrentPositionAsync остался только в deviceLocation', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(name)) continue;
        if (full.includes('__tests__')) continue;
        files.push(full);
      }
    };
    walk(SRC);
    const offenders = files.filter(
      (f) => /Location\.getCurrentPositionAsync\(/.test(fs.readFileSync(f, 'utf8'))
        && !f.endsWith(path.join('core', 'social', 'deviceLocation.ts')),
    );
    expect(offenders).toEqual([]);
  });

  it('deviceLocation отдаёт развилку, а не бросает', () => {
    expect(DEVICE).toMatch(/export type LocationRead\b/);
    expect(DEVICE).toMatch(/\{ ok: false; kind: LocationFailureKind \}/);
    expect(DEVICE).toMatch(/export async function readPlaceOnce\(\): Promise<LocationRead>/);
    expect(DEVICE).toContain("return { ok: false, kind: 'denied' };");
    expect(DEVICE).toContain('return { ok: false, kind: classifyLocationFailure(e) };');
  });

  it('оба чтения места ограничены сроком ожидания', () => {
    const uses = DEVICE.match(/withDeadline\(/g) ?? [];
    expect(uses.length).toBe(2);
    expect(DEVICE).toContain('LOCATION_FIX_TIMEOUT_MS,');
  });

  it('все три экрана берут место у общего места', () => {
    for (const src of [CHAT, GROUPS, FEED]) {
      expect(src).toContain("import { readPlaceOnce } from '../../core/social/deviceLocation';");
      expect(src).toContain("import { locationFailureText } from '../../core/social/locationFailure';");
    }
  });
});

describe('переписка: отправка места и карточки больше не молчит', () => {
  it('отправка места разбирает отказ приёмника и показывает причину', () => {
    const body = SEND_LOC();
    expect(body).toContain('await readPlaceOnce()');
    expect(body).toContain("read.kind === 'denied'");
    expect(body).toContain('showError(locationFailureText(read.kind))');
  });

  it('отправка места ловит отказ доставки, а не только разблокирует ввод', () => {
    const body = SEND_LOC();
    expect(body).toMatch(/\} catch \(e\) \{/);
    expect(body).toContain("log.error('chat_send_location_failed'");
    expect(body).toContain("userErrorText(e, 'Не удалось отправить местоположение')");
  });

  it('карточка контакта ловит отказ доставки', () => {
    const body = SHARE_CONTACT();
    expect(body).toMatch(/\} catch \(e\) \{/);
    expect(body).toContain("userErrorText(e, 'Не удалось отправить карточку контакта')");
  });

  it('живая геолокация проверяет приёмник до того, как обещать часы трансляции', () => {
    const body = LIVE_LOC();
    expect(body).toContain('await readPlaceOnce()');
    expect(body.indexOf('await readPlaceOnce()')).toBeLessThan(body.indexOf('startLiveLocSession({'));
  });

  it('ни один из трёх обработчиков не трогает состояние ушедшего экрана', () => {
    for (const body of [SEND_LOC(), SHARE_CONTACT(), LIVE_LOC()]) {
      expect(body).toContain('isMountedRef.current');
    }
    expect(SEND_LOC()).toContain('if (isMountedRef.current) { setSending(false); void appendNewMessages(); }');
    expect(SHARE_CONTACT()).toContain('if (isMountedRef.current) { setSending(false); void appendNewMessages(); }');
  });

  it('в переписке не осталось try/finally без catch на отправке места и карточки', () => {
    for (const body of [SEND_LOC(), SHARE_CONTACT()]) {
      expect(body).not.toMatch(/try \{ await svc\.sendMessage\([^)]*\); \} finally \{/);
    }
  });
});

describe('группа и лента: причина названа', () => {
  it('в группе поиск места вынесен из общего catch отправки', () => {
    const body = GROUP_LOC();
    const readAt = body.indexOf('await readPlaceOnce()');
    const sendingAt = body.indexOf('setSending(true)');
    expect(readAt).toBeGreaterThan(-1);
    expect(sendingAt).toBeGreaterThan(readAt);
    expect(body).toContain('showError(locationFailureText(read.kind))');
    // Общий catch остаётся тому, чем он и был: отказу отправки.
    expect(body).toContain("userErrorText(e, 'Не удалось отправить геопозицию')");
  });

  it('лента больше не сводит все причины к одному тексту', () => {
    expect(FEED).toContain('showError(locationFailureText(read.kind))');
    expect(FEED).not.toContain("catch { showError(t('feed.locationFailed')); }");
  });
});
