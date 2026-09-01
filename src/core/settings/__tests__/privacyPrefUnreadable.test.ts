/**
 * v4.32.474: «не смогли прочитать» — не то же самое, что «переключатель не трогали».
 *
 * Чтение kv гасило ошибку базы и отвечало null — тем же, чем отвечает
 * отсутствующая запись. Поэтому все решения о приватности при недоступной базе
 * выпадали в сторону «разрешено»: отметки о прочтении уходили, приглашение
 * незнакомца считалось доверенным. Написанные у вызывающих ветки «не смогли
 * прочитать» при этом выглядели рабочими — они ловили исключение, которого не
 * бывает.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const kv: Record<string, string> = {};
let mockKvBroken = false;
jest.mock('../../storage/local', () => ({
  kvGet: jest.fn(async (k: string) => (mockKvBroken ? null : kv[k] ?? null)),
  kvTryGet: jest.fn(async (k: string) => (mockKvBroken ? null : { value: kv[k] ?? null })),
  kvSet: jest.fn(async (k: string, v: string) => { kv[k] = v; }),
  kvDelete: jest.fn(async (k: string) => { delete kv[k]; }),
}));

let mockActiveProfileId = 1;
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: mockActiveProfileId }) },
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import {
  privacyPrefTryBoolFor,
  readReceiptsAllowed,
  readReceiptsAllowedFor,
} from '../privacyPrefs';

const CORE = join(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(CORE, rel), 'utf8');

beforeEach(() => {
  for (const k of Object.keys(kv)) delete kv[k];
  mockKvBroken = false;
  mockActiveProfileId = 1;
});

describe('проверка не пустая', () => {
  it('исправная база отвечает как раньше', async () => {
    expect(await privacyPrefTryBoolFor(2, 'privacy_only_contacts_msg')).toBe(false);
    kv['p2:privacy_only_contacts_msg'] = 'true';
    expect(await privacyPrefTryBoolFor(2, 'privacy_only_contacts_msg')).toBe(true);
  });
});

describe('переключатель, который не удалось прочитать', () => {
  it('отличим от нетронутого', async () => {
    expect(await privacyPrefTryBoolFor(2, 'privacy_only_contacts_group')).toBe(false);
    mockKvBroken = true;
    expect(await privacyPrefTryBoolFor(2, 'privacy_only_contacts_group')).toBeNull();
  });

  it('отказ базы не выдаётся за выбор человека и для первого профиля', async () => {
    mockKvBroken = true;
    expect(await privacyPrefTryBoolFor(1, 'privacy_only_contacts_msg')).toBeNull();
  });
});

describe('отметки о прочтении не уходят вслепую', () => {
  it('база недоступна — не отправляем', async () => {
    mockKvBroken = true;
    expect(await readReceiptsAllowedFor(2)).toBe(false);
    expect(await readReceiptsAllowed()).toBe(false);
  });

  it('переключатель не трогали — отправляем', async () => {
    expect(await readReceiptsAllowedFor(2)).toBe(true);
  });

  it('выключено человеком — не отправляем', async () => {
    kv['p2:privacy_disable_read_receipts'] = 'true';
    expect(await readReceiptsAllowedFor(2)).toBe(false);
  });
});

describe('решения при нечитаемой настройке приняты явно', () => {
  it('приглашение в группу без ответа базы не считается доверенным', () => {
    const gm = read('social/groupMessaging.ts');
    expect(gm).toContain(
      "return (await privacyPrefTryBoolFor(rcpt.pid, 'privacy_only_contacts_group')) === false;",
    );
    expect(gm).not.toContain("privacyPrefBoolFor(rcpt.pid, 'privacy_only_contacts_group')");
  });

  it('заявка на вступление без ответа базы проходит через фильтр', () => {
    const gm = read('social/groupMessaging.ts');
    expect(gm).toContain(
      "(await privacyPrefTryBoolFor(pid, 'privacy_only_contacts_group')) ?? true",
    );
    expect(gm).toContain('} catch { onlyContactsMayRequest = true; }');
  });

  it('личное сообщение при нечитаемой настройке принимается — и это видно в журнале', () => {
    const msg = read('social/messaging.ts');
    expect(msg).toContain('if (onlyContacts === null) {');
    expect(msg).toContain("log.warn('dm_contacts_filter_unreadable'");
    expect(msg).toContain('} else if (onlyContacts) {');
  });

  it('чтение kv единственное — kvGet считается через kvTryGet', () => {
    const local = read('storage/local.ts');
    expect(local).toContain('export async function kvTryGet(');
    expect(local).toContain('return (await kvTryGet(key))?.value ?? null;');
    const scoped = read('storage/profileScopedKv.ts');
    expect(scoped).toContain('export async function scopedKvTryGetFor(');
    expect(scoped).toContain('return (await scopedKvTryGetFor(pid, key))?.value ?? null;');
  });
});
