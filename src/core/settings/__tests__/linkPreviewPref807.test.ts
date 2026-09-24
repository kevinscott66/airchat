/**
 * Предпросмотр входящих ссылок — решение аккаунта, а не телефона (v4.32.807).
 *
 * Дефект. Две поломки в одном переключателе. Первая: писался он через
 * `void kvSet(...)` — то есть мимо `applyPrivacyPref`, общего правила с
 * откатом, и мимо ответа базы. Вторая тяжелее: имя ключа начиналось с
 * `privacy_`, а лежал он БЕЗ префикса профиля — один на устройство, — хотя
 * список `PRIVACY_PREF_KEYS` и уборка удалённого профиля идут именно по нему.
 *
 * Цена. Предпросмотр входящей ссылки — это маяк: приложение само идёт по
 * чужому адресу и отдаёт IP, провайдера, часовой пояс и факт прочтения тому,
 * кто ссылку прислал, а ссылка может быть уникальной для получателя. Второй
 * аккаунт заводят ровно затем, чтобы его не связали с первым, — и он молча
 * наследовал разрешение отвечать на такой маяк. Хуже того, у этого
 * переключателя опасное положение — то, которое переживает перезапуск:
 * человек выключает, запись не ложится, переключатель стоит как надо, а при
 * следующем запуске возвращается «включено». Уборка профиля запись тоже не
 * забирала: она ходит по `p<id>:%`, и разрешение доставалось следующему
 * аккаунту с тем же номером.
 *
 * Правка. Ключ встал в `PRIVACY_PREF_KEYS`, чтение в обоих местах (экран
 * настроек и сама карточка) идёт через `privacyPrefGet`, запись — через
 * `applyPrivacyPref` с откатом. Переезд бесплатный: прежняя общая запись
 * достаётся первому профилю и переносится в его namespace при первом чтении,
 * остальным достаётся умолчание — а оно «выключено».
 */
import fs from 'fs';
import path from 'path';

const mockKv = new Map<string, string>();
/** Ключи, запись которых база не выполняет (kvSetChecked отвечает false). */
const mockFailWrites = new Set<string>();
let mockPid = 1;

jest.mock('../../storage/local', () => ({
  kvGet: async (k: string) => mockKv.get(k) ?? null,
  kvTryGet: async (k: string) => ({ value: mockKv.get(k) ?? null }),
  kvSetChecked: async (k: string, v: string) => {
    if (mockFailWrites.has(k)) return false;
    mockKv.set(k, v);
    return true;
  },
  kvDelete: async (k: string) => {
    mockKv.delete(k);
  },
  kvDeleteChecked: async (k: string) => {
    mockKv.delete(k);
    return true;
  },
  kvListKeysByPrefix: async () => [],
}));
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: mockPid }) },
}));
jest.mock('../../logger', () => ({
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { privacyPrefGet, privacyPrefSet } from '../privacyPrefs';
import { PRIVACY_PREF_KEYS } from '../../storage/kvKeys';
import {
  LINK_PREVIEW_INCOMING_KEY,
  parseIncomingLinkPreviewPref,
  shouldLoadLinkPreview,
} from '../../social/linkPreviewPolicy';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const SETTINGS = codeOnly(read('ui/screens/SettingsScreen.tsx'));
const CARD = codeOnly(read('ui/screens/chat-components/LinkPreview.tsx'));

beforeEach(() => {
  mockKv.clear();
  mockFailWrites.clear();
  mockPid = 1;
});

describe('разрешение на маяк — решение аккаунта', () => {
  it('ключ в списке решений аккаунта — по нему идёт и уборка профиля, и перенос', () => {
    expect(PRIVACY_PREF_KEYS).toContain(LINK_PREVIEW_INCOMING_KEY);
    const store = codeOnly(read('core/storage/local.ts'));
    // Уборка удалённого профиля ходит по этому же списку; пока ключа в нём не
    // было, разрешение оставалось на устройстве и доставалось следующему
    // аккаунту с тем же номером.
    expect(store).toContain('|| (PRIVACY_PREF_KEYS as readonly string[]).includes(entityId)) {');
  });
});

/**
 * Ниже — то, что работало и до правки. Namespace профиля, перенос старой
 * записи и ответ об отказе написаны давно и ни в чём не виноваты: этот ключ
 * просто ходил мимо них. Блок держится затем, чтобы находка отличалась от
 * сломанной обвязки, и затем, чтобы было видно, что именно правка включила.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: namespace аккаунта делает ровно обещанное', () => {
  it('включил один профиль — у второго по-прежнему выключено', async () => {
    mockPid = 1;
    expect(await privacyPrefSet(LINK_PREVIEW_INCOMING_KEY, 'true')).toBe(true);
    mockPid = 2;
    expect(await privacyPrefGet(LINK_PREVIEW_INCOMING_KEY)).toBeNull();
    expect(parseIncomingLinkPreviewPref(await privacyPrefGet(LINK_PREVIEW_INCOMING_KEY))).toBe(false);
  });

  it('и наоборот: второй профиль решает за себя', async () => {
    mockPid = 2;
    await privacyPrefSet(LINK_PREVIEW_INCOMING_KEY, 'true');
    mockPid = 1;
    expect(await privacyPrefGet(LINK_PREVIEW_INCOMING_KEY)).toBeNull();
    expect(mockKv.has(LINK_PREVIEW_INCOMING_KEY)).toBe(false);
  });

  it('запись уходит под именем профиля, а не общим', async () => {
    mockPid = 3;
    await privacyPrefSet(LINK_PREVIEW_INCOMING_KEY, 'true');
    expect([...mockKv.keys()]).toEqual([`p3:${LINK_PREVIEW_INCOMING_KEY}`]);
  });

  it('прежняя общая запись достаётся первому профилю и переезжает к нему', async () => {
    // Переезд обязан быть: человек уже выбирал это положение, и терять его
    // молча нельзя — тем более что умолчание строже выбранного.
    mockKv.set(LINK_PREVIEW_INCOMING_KEY, 'true');
    mockPid = 1;
    expect(await privacyPrefGet(LINK_PREVIEW_INCOMING_KEY)).toBe('true');
    expect(mockKv.get(`p1:${LINK_PREVIEW_INCOMING_KEY}`)).toBe('true');
    expect(mockKv.has(LINK_PREVIEW_INCOMING_KEY)).toBe(false);
  });

  it('прежняя общая запись не достаётся никому, кроме первого', async () => {
    mockKv.set(LINK_PREVIEW_INCOMING_KEY, 'true');
    mockPid = 2;
    expect(await privacyPrefGet(LINK_PREVIEW_INCOMING_KEY)).toBeNull();
    // И читавший её чужой профиль ничего с ней не сделал.
    expect(mockKv.get(LINK_PREVIEW_INCOMING_KEY)).toBe('true');
  });

  it('база отказала — ответ отрицательный, прежнее значение цело', async () => {
    mockPid = 2;
    mockKv.set(`p2:${LINK_PREVIEW_INCOMING_KEY}`, 'false');
    mockFailWrites.add(`p2:${LINK_PREVIEW_INCOMING_KEY}`);
    expect(await privacyPrefSet(LINK_PREVIEW_INCOMING_KEY, 'true')).toBe(false);
    expect(await privacyPrefGet(LINK_PREVIEW_INCOMING_KEY)).toBe('false');
  });

  it('выключение, которое не легло, тоже отвечает отказом', async () => {
    // Для этого переключателя это и есть опасная сторона: невыключенным он
    // переживает перезапуск, а человек уверен, что маяк больше не отвечает.
    mockPid = 2;
    mockKv.set(`p2:${LINK_PREVIEW_INCOMING_KEY}`, 'true');
    mockFailWrites.add(`p2:${LINK_PREVIEW_INCOMING_KEY}`);
    expect(await privacyPrefSet(LINK_PREVIEW_INCOMING_KEY, 'false')).toBe(false);
    expect(parseIncomingLinkPreviewPref(await privacyPrefGet(LINK_PREVIEW_INCOMING_KEY))).toBe(true);
  });

  it('имя ключа не менялось — иначе выбор человека потерялся бы', () => {
    expect(LINK_PREVIEW_INCOMING_KEY).toBe('privacy_link_preview_incoming');
  });

  it('умолчание по-прежнему «не ходить»', () => {
    expect(parseIncomingLinkPreviewPref(null)).toBe(false);
    expect(parseIncomingLinkPreviewPref(undefined)).toBe(false);
    expect(parseIncomingLinkPreviewPref('')).toBe(false);
    expect(parseIncomingLinkPreviewPref('1')).toBe(false);
    expect(parseIncomingLinkPreviewPref('true')).toBe(true);
  });

  it('своя ссылка грузится всегда, чужая — только с разрешения', () => {
    expect(shouldLoadLinkPreview(false, false)).toBe(true);
    expect(shouldLoadLinkPreview(true, false)).toBe(false);
    expect(shouldLoadLinkPreview(true, true)).toBe(true);
  });

  it('запись включённого положения читается обратно тем же профилем', async () => {
    mockPid = 2;
    await privacyPrefSet(LINK_PREVIEW_INCOMING_KEY, 'true');
    expect(await privacyPrefGet(LINK_PREVIEW_INCOMING_KEY)).toBe('true');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('карточка действительно ходит по чужому адресу сама', () => {
    // Иначе всё вышесказанное — разговор ни о чём: маяк существует ровно
    // потому, что запрос делает устройство получателя, и делает его до того,
    // как человек по ссылке нажал.
    expect(CARD).toContain("const res = await fetch(url, { method: 'GET', headers: { 'Accept': 'text/html' }, signal: ctrl.signal });");
    expect(CARD).toContain('if (!previewStore.shouldFetch(url)) {');
  });

  it('решение принимается до запроса, а не после', () => {
    const guard = CARD.indexOf('shouldLoadLinkPreview(');
    const call = CARD.indexOf('await fetch(url,');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(call);
  });
});

describe('форма исходников: обе поломки закрыты там, где стояли', () => {
  it('ключ объявлен решением аккаунта', () => {
    const keys = codeOnly(read('core/storage/kvKeys.ts'));
    expect(keys).toContain("  'privacy_link_preview_incoming',\n] as const;");
  });

  it('экран настроек читает через privacyPrefs', () => {
    expect(SETTINGS).toContain('privacyPrefGet(LINK_PREVIEW_INCOMING_KEY),');
    expect(SETTINGS).not.toContain('kvGet(LINK_PREVIEW_INCOMING_KEY)');
  });

  it('экран настроек пишет общим правилом с откатом', () => {
    expect(SETTINGS).toContain(
      'void applyPref(() => privacyPrefSet(LINK_PREVIEW_INCOMING_KEY, String(v)), () => setIncomingLinkPreview(!v));',
    );
    expect(SETTINGS).not.toContain('void kvSet(LINK_PREVIEW_INCOMING_KEY');
  });

  it('карточка читает оттуда же, куда пишет экран', () => {
    // Две разные двери к одному решению — это ровно та развилка, из-за
    // которой ключ с именем `privacy_` и оказался общим на устройство.
    expect(CARD).toContain("import { privacyPrefGet } from '../../../core/settings/privacyPrefs';");
    expect(CARD).toContain('parseIncomingLinkPreviewPref(await privacyPrefGet(LINK_PREVIEW_INCOMING_KEY))');
    expect(CARD).not.toContain('kvGet');
  });

  it('никто больше не ходит к этому ключу мимо privacyPrefs', () => {
    for (const rel of ['ui/screens/SettingsScreen.tsx', 'ui/screens/chat-components/LinkPreview.tsx']) {
      const body = codeOnly(read(rel));
      const hits = body.match(/LINK_PREVIEW_INCOMING_KEY/g) ?? [];
      const viaPrefs = body.match(/privacyPref(Get|Set)\(LINK_PREVIEW_INCOMING_KEY/g) ?? [];
      // Одно упоминание — импорт, остальные обязаны быть через privacyPrefs.
      expect(hits.length - 1).toBe(viaPrefs.length);
    }
  });
});
