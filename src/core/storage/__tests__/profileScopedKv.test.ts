/**
 * kv в namespace активного профиля (v4.32.325).
 */
const kv: Record<string, string> = {};
/** true — записи в этот namespace база не принимает (диск полон, лок). */
let mockWriteFails = false;
jest.mock('../local', () => ({
  kvGet: jest.fn(async (k: string) => kv[k] ?? null),
  kvTryGet: jest.fn(async (k: string) => ({ value: kv[k] ?? null })),
  kvSetChecked: jest.fn(async (k: string, v: string) => {
    if (mockWriteFails) return false;
    kv[k] = v;
    return true;
  }),
  kvDelete: jest.fn(async (k: string) => { delete kv[k]; }),
  kvListKeysByPrefix: jest.fn(async (prefix: string) =>
    Object.keys(kv).filter((k) => k.startsWith(prefix))),
}));

let mockActiveProfileId = 1;
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: mockActiveProfileId }) },
}));

import { scopedKvGet, scopedKvListKeysByPrefix, scopedKvSet } from '../profileScopedKv';

beforeEach(() => {
  for (const k of Object.keys(kv)) delete kv[k];
  mockActiveProfileId = 1;
  mockWriteFails = false;
});

describe('запись и чтение', () => {
  it('пишется под префиксом профиля', async () => {
    mockActiveProfileId = 7;
    await scopedKvSet('profile:sent', '{"a":1}');
    expect(kv['p7:profile:sent']).toBe('{"a":1}');
    expect(kv['profile:sent']).toBeUndefined();
    expect(await scopedKvGet('profile:sent')).toBe('{"a":1}');
  });

  it('соседний профиль своего значения не видит', async () => {
    mockActiveProfileId = 2;
    await scopedKvSet('profile:sent', 'второй');
    mockActiveProfileId = 3;
    expect(await scopedKvGet('profile:sent')).toBeNull();
  });

  it('ничего не записано — null', async () => {
    expect(await scopedKvGet('presence:pref_sent')).toBeNull();
  });
});

describe('записи, сделанные когда профиль был один', () => {
  it('достаются первому профилю и переезжают под префикс', async () => {
    kv['profile:sent'] = 'старое';
    expect(await scopedKvGet('profile:sent')).toBe('старое');
    expect(kv['p1:profile:sent']).toBe('старое');
    // Общая запись снята: иначе она снова досталась бы всем.
    expect(kv['profile:sent']).toBeUndefined();
  });

  it('второму профилю не достаются', async () => {
    kv['profile:sent'] = 'старое';
    mockActiveProfileId = 2;
    expect(await scopedKvGet('profile:sent')).toBeNull();
    // И чужую запись при этом не трогаем — она принадлежит первому.
    expect(kv['profile:sent']).toBe('старое');
  });

  it('своя запись важнее общей', async () => {
    kv['profile:sent'] = 'старое';
    kv['p1:profile:sent'] = 'своё';
    expect(await scopedKvGet('profile:sent')).toBe('своё');
    expect(kv['profile:sent']).toBe('старое');
  });

  it('запись первым профилем снимает общую', async () => {
    kv['profile:sent'] = 'старое';
    await scopedKvSet('profile:sent', 'новое');
    expect(kv['p1:profile:sent']).toBe('новое');
    expect(kv['profile:sent']).toBeUndefined();
  });

  it('запись вторым профилем общую не трогает', async () => {
    kv['profile:sent'] = 'старое';
    mockActiveProfileId = 2;
    await scopedKvSet('profile:sent', 'новое');
    expect(kv['p2:profile:sent']).toBe('новое');
    expect(kv['profile:sent']).toBe('старое');
  });
});

/**
 * v4.32.615: kvSet гасил свою ошибку и возвращал void, поэтому переезд общей
 * записи под префикс шёл «скопировали (может быть) — удалили (точно)».
 */
describe('база не приняла запись', () => {
  it('общая запись переживает неудавшийся переезд', async () => {
    kv['profile:sent'] = 'старое';
    mockWriteFails = true;
    expect(await scopedKvGet('profile:sent')).toBe('старое');
    // Ничего не потеряно: значение цело под старым именем.
    expect(kv['profile:sent']).toBe('старое');
    expect(kv['p1:profile:sent']).toBeUndefined();
    // А когда база отпустит — переезд состоится.
    mockWriteFails = false;
    expect(await scopedKvGet('profile:sent')).toBe('старое');
    expect(kv['p1:profile:sent']).toBe('старое');
    expect(kv['profile:sent']).toBeUndefined();
  });

  it('неудавшаяся запись не стирает прежнее значение', async () => {
    kv['profile:sent'] = 'старое';
    mockWriteFails = true;
    await scopedKvSet('profile:sent', 'новое');
    // Новое не легло — но и старое на месте, а не сброс к умолчанию.
    expect(kv['p1:profile:sent']).toBeUndefined();
    expect(kv['profile:sent']).toBe('старое');
    expect(await scopedKvGet('profile:sent')).toBe('старое');
  });

  it('скан по префиксу не вычёркивает то, что не переехало', async () => {
    kv['mute:peer-a'] = '1';
    mockWriteFails = true;
    expect(await scopedKvListKeysByPrefix('mute:')).toEqual([]);
    expect(kv['mute:peer-a']).toBe('1');

    mockWriteFails = false;
    expect(await scopedKvListKeysByPrefix('mute:')).toEqual(['mute:peer-a']);
    expect(kv['p1:mute:peer-a']).toBe('1');
    expect(kv['mute:peer-a']).toBeUndefined();
  });
});
