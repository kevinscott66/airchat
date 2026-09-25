/**
 * Непрочитанная запись «без звука» больше не выдаётся за снятую (v4.32.959).
 *
 * Дефект. `getMuteState` и `listMuted` читали общей `scopedKvGet`, а та гасит
 * отказ базы и отдаёт `null` — неотличимо от «записи нет». `parseMuteValue`
 * отвечает на него `{ muted: false }`, и дальше этот ответ расходился в два
 * места, где он значил не «тихо», а «наверняка».
 *
 * Цена. Первое место — переключатель «без звука» у публикации
 * (`FeedScreen.toggleMutePost`): он читал состояние и по нему ВЫБИРАЛ ветку.
 * На занятой базе человек, просивший уведомления вернуть, получал вызов
 * `setMuted` без срока, то есть бессрочное глушение — да ещё поверх отсрочки,
 * которую сам ставил до утра. Второе — список «Заглушённые» в настройках:
 * непрочитанная запись молча выпадала из него, а экран писал «Список пуст —
 * уведомления включены везде». Снять глушение можно ТОЛЬКО оттуда, так что
 * пропавшая строка — это замолчавший навсегда собеседник без единой кнопки,
 * чтобы его вернуть.
 *
 * Правка. Оба чтения стали тройственными. `getMuteState` отвечает `null` —
 * «не знаем», и переключатель на нём отказывается вслух, ничего не записав.
 * `listMuted` считает непрочитанные записи отдельным числом, а на отказе
 * самого перечня имён отвечает `null`; экран настроек говорит об этом словами
 * вместо «список пуст».
 *
 * Границы. `isMuted` на непрочитанной записи по-прежнему отвечает `false`, и
 * это осознанно: его зовут только заслонки уведомлений, а у них лишний звук
 * дешевле беззвучно потерянного сообщения. Правка трогает тех, кто по ответу
 * ПИШЕТ или ПОКАЗЫВАЕТ список.
 */
const mockKv = new Map<string, string>();
/** Ключи, чтение которых обязано сорваться. */
const mockReadFail = new Set<string>();
/** Скан имён обязан сорваться целиком. */
let mockListFails = false;

jest.mock('../../storage/local', () => ({
  kvTryGet: async (k: string) => (mockReadFail.has(k) ? null : { value: mockKv.get(k) ?? null }),
  kvSet: async (k: string, v: string) => { mockKv.set(k, v); },
  kvSetChecked: async (k: string, v: string) => { mockKv.set(k, v); return true; },
  kvDelete: async (k: string) => { mockKv.delete(k); },
  kvDeleteChecked: async (k: string) => { mockKv.delete(k); },
  kvTryListKeysByPrefix: async (p: string) =>
    (mockListFails ? null : [...mockKv.keys()].filter((k) => k.startsWith(p))),
  kvListKeysByPrefix: async (p: string) => [...mockKv.keys()].filter((k) => k.startsWith(p)),
}));
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1 }) },
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { getMuteState, isMuted, listMuted, setMuted } from '../muteStore';
import { canonicalMuteId } from '../muteChatId';

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const FEED_SRC = codeOnly(
  readFileSync(join(__dirname, '..', '..', '..', 'ui', 'screens', 'FeedScreen.tsx'), 'utf8'),
);
const SETTINGS_SRC = codeOnly(
  readFileSync(join(__dirname, '..', '..', '..', 'ui', 'screens', 'SettingsScreen.tsx'), 'utf8'),
);

const PEER = 'W'.repeat(43);
const DID = canonicalMuteId('chat', PEER);
const CHAT_KEY = `p1:mute:chat:${DID}`;
const POST = 'post-42';
const POST_KEY = `p1:mute:post:${POST}`;
const HOUR = 60 * 60 * 1000;

/**
 * Записи списка — независимо от того, обёрнуты ли они числом непрочитанных.
 *
 * Нужен только контрольным проверкам: они обязаны проходить и на коде ДО
 * правки, а там `listMuted` отдавала голый массив. Проверки поведения выше
 * зовут `listMuted` напрямую — им обёртка и важна.
 */
async function mutedEntries(kind?: 'chat' | 'group' | 'channel' | 'post'): Promise<Record<string, unknown>[] | null> {
  const res: unknown = await listMuted(kind);
  if (res === null || res === undefined) return null;
  if (Array.isArray(res)) return res as Record<string, unknown>[];
  return (res as { entries: Record<string, unknown>[] }).entries;
}

beforeEach(() => {
  mockKv.clear();
  mockReadFail.clear();
  mockListFails = false;
});

describe('непрочитанная запись не выдаётся за снятую', () => {
  it('getMuteState отвечает «не знаем», а не «не заглушено»', async () => {
    await setMuted('chat', PEER);
    mockReadFail.add(CHAT_KEY);
    expect(await getMuteState('chat', PEER)).toBeNull();
  });

  it('и не трогает саму запись — вернуться есть куда', async () => {
    await setMuted('chat', PEER, { untilMs: Date.now() + HOUR });
    const before = mockKv.get(CHAT_KEY);
    mockReadFail.add(CHAT_KEY);
    expect(await getMuteState('chat', PEER)).toBeNull();
    mockReadFail.clear();
    expect(mockKv.get(CHAT_KEY)).toBe(before);
    expect((await getMuteState('chat', PEER))?.muted).toBe(true);
  });

  it('список «Заглушённые» считает непрочитанные, а не теряет их', async () => {
    await setMuted('post', POST);
    mockReadFail.add(POST_KEY);
    expect(await listMuted('post')).toEqual({ entries: [], unreadable: 1 });
  });

  it('непрочитанный перечень имён — это не пустой список', async () => {
    await setMuted('chat', PEER);
    mockListFails = true;
    expect(await listMuted()).toBeNull();
  });

  it('прочитанные соседи в списке остаются, беда названа числом', async () => {
    await setMuted('post', POST);
    await setMuted('post', 'post-7');
    mockReadFail.add(POST_KEY);
    const res = await listMuted('post');
    expect(res?.entries.map((e) => e.id)).toEqual(['post-7']);
    expect(res?.unreadable).toBe(1);
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Тройственное чтение легко превратить в отказ на ровном месте: ответ `null`
 * есть у обеих функций, и спутать «не прочитали» с «записи нет» можно и в
 * обратную сторону. Исправная база обязана работать ровно как прежде — иначе
 * заглушение перестало бы ставиться вовсе.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: исправная база отвечает как раньше', () => {
  it('поставленное глушение читается', async () => {
    await setMuted('chat', PEER);
    expect(await isMuted('chat', PEER)).toBe(true);
    expect(await getMuteState('chat', PEER)).toEqual({ muted: true, untilMs: null });
  });

  it('отсутствие записи — это не отказ чтения', async () => {
    expect(await getMuteState('chat', PEER)).toEqual({ muted: false, untilMs: null });
    expect(await mutedEntries()).toEqual([]);
  });

  it('истёкшая отсрочка по-прежнему снимается лениво', async () => {
    mockKv.set(CHAT_KEY, `until:${Date.now() - 1}`);
    expect(await getMuteState('chat', PEER)).toEqual({ muted: false, untilMs: null });
    expect(mockKv.has(CHAT_KEY)).toBe(false);
  });

  it('список отдаёт срок вместе с записью', async () => {
    const until = Date.now() + HOUR;
    await setMuted('post', POST, { untilMs: until });
    expect(await mutedEntries('post')).toEqual([{ kind: 'post', id: POST, untilMs: until }]);
  });
});

/**
 * ГРАНИЦА, ОСТАВЛЕННАЯ НАРОЧНО.
 *
 * Заслонки уведомлений гадать обязаны: у них выбор не «писать или нет», а
 * «показать лишнее или проглотить чужое сообщение». Если однажды и здесь
 * захочется честности, менять придётся вместе с App.tsx и pushNotifications —
 * эта проверка напомнит, что решение было принято, а не забыто.
 */
describe('ГРАНИЦА: заслонке уведомлений догадка позволена', () => {
  it('isMuted на непрочитанной записи отвечает «не заглушено»', async () => {
    await setMuted('chat', PEER);
    mockReadFail.add(CHAT_KEY);
    expect(await isMuted('chat', PEER)).toBe(false);
  });
});

describe('форма экранов: ответ читают там, где по нему пишут', () => {
  it('переключатель у публикации спрашивает состояние и молча не пишет', () => {
    const at = FEED_SRC.indexOf('const toggleMutePost =');
    expect(at).toBeGreaterThan(0);
    const body = FEED_SRC.slice(at, FEED_SRC.indexOf('const toggleMuteAuthor =', at));
    expect(body).toContain("const state = await getMuteState('post', postId);");
    expect(body).toContain('if (state === null)');
    // Догадка `isMuted`, с которой ветка записи выбиралась вслепую, ушла.
    expect(body).not.toContain("await isMuted('post', postId)");
    // Отказ виден человеку, а не только журналу.
    const refuse = body.indexOf('if (state === null)');
    expect(body.slice(refuse, refuse + 160)).toContain('showError(');
  });

  it('экран «Заглушённые» не называет непрочитанный список пустым', () => {
    expect(SETTINGS_SRC).toContain("const res = await listMuted();");
    expect(SETTINGS_SRC).toContain("setMutedRead('all')");
    expect(SETTINGS_SRC).toContain("res.unreadable > 0 ? 'partial' : 'no'");
    const at = SETTINGS_SRC.indexOf('Список пуст — уведомления включены везде.');
    expect(at).toBeGreaterThan(0);
    // Пустая строка показывается только при полностью прочитанном списке.
    expect(SETTINGS_SRC.slice(at - 260, at)).toContain("mutedRead === 'no'");
  });
});
