/**
 * Раунд 460: решения о приватности спрашивают у того аккаунта, к которому
 * относится разговор.
 *
 * Служба приёма личных сообщений живёт по одной на пару ключей и переживает
 * переключение профиля (см. v4.32.457). Расшифровка ждёт сеть секундами, и к
 * моменту, когда код добирался до переключателя, активным мог быть уже другой
 * аккаунт: к чужому разговору применялись чужие решения. «Сообщения только от
 * контактов», выключённое в рабочем профиле, отбрасывало письмо незнакомца,
 * пришедшее в личный, — и наоборот, отметки о прочтении уходили из аккаунта,
 * где человек их выключил.
 */
import * as fs from 'fs';
import * as path from 'path';

const kv: Record<string, string> = {};
jest.mock('../../storage/local', () => ({
  kvGet: jest.fn(async (k: string) => kv[k] ?? null),
  // v4.32.474: чтение, у которого провал отличим от «ключа нет».
  kvTryGet: jest.fn(async (k: string) => ({ value: kv[k] ?? null })),
  kvSet: jest.fn(async (k: string, v: string) => { kv[k] = v; }),
  kvDelete: jest.fn(async (k: string) => { delete kv[k]; }),
}));

let mockActiveId = 1;
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: mockActiveId }) },
}));

import {
  privacyPrefBool,
  privacyPrefBoolFor,
  readReceiptsAllowed,
  readReceiptsAllowedFor,
} from '../privacyPrefs';

beforeEach(() => {
  for (const k of Object.keys(kv)) delete kv[k];
  mockActiveId = 1;
});

describe('переключатель читают у названного аккаунта', () => {
  it('активен другой профиль — берём всё равно свой', async () => {
    kv['p2:privacy_only_contacts_msg'] = 'true';
    kv['p3:privacy_only_contacts_msg'] = 'false';
    mockActiveId = 3;
    expect(await privacyPrefBoolFor(2, 'privacy_only_contacts_msg')).toBe(true);
    // Ровно тот случай, из-за которого правка: «активный» ответил бы иначе.
    expect(await privacyPrefBool('privacy_only_contacts_msg')).toBe(false);
  });

  it('у аккаунта ничего не выбрано — значение по умолчанию, а не соседское', async () => {
    kv['p1:privacy_only_contacts_msg'] = 'true';
    expect(await privacyPrefBoolFor(2, 'privacy_only_contacts_msg')).toBe(false);
  });

  it('запись, сделанная когда профиль был один, принадлежит первому', async () => {
    kv['privacy_only_contacts_msg'] = 'true';
    expect(await privacyPrefBoolFor(2, 'privacy_only_contacts_msg')).toBe(false);
    expect(await privacyPrefBoolFor(1, 'privacy_only_contacts_msg')).toBe(true);
  });
});

describe('отметки о прочтении', () => {
  it('выключены у своего аккаунта — не уходят, что бы ни было у активного', async () => {
    kv['p2:privacy_disable_read_receipts'] = 'true';
    mockActiveId = 1;
    expect(await readReceiptsAllowedFor(2)).toBe(false);
    expect(await readReceiptsAllowed()).toBe(true);
  });

  it('по умолчанию уходят', async () => {
    expect(await readReceiptsAllowedFor(5)).toBe(true);
  });
});

describe('приём личных сообщений спрашивает за себя', () => {
  const MSG = fs.readFileSync(
    path.join(__dirname, '..', '..', 'social', 'messaging.ts'), 'utf8',
  );

  it('фильтр «только от контактов» — по своему номеру профиля', () => {
    expect(MSG).toContain(
      "await privacyPrefTryBoolFor(\n          await this.ownerProfileId(),\n          'privacy_only_contacts_msg',\n        )",
    );
  });

  it('отметка о прочтении — по своему номеру профиля', () => {
    expect(MSG).toContain('await readReceiptsAllowedFor(await this.ownerProfileId())');
  });

  it('вариантов «у активного» в приёме не осталось', () => {
    expect(MSG).not.toContain('privacyPrefBool(');
    expect(MSG).not.toContain('readReceiptsAllowed(');
    expect(MSG).toContain(
      "import { privacyPrefTryBoolFor, readReceiptsAllowedFor } from '../settings/privacyPrefs';",
    );
  });
});

describe('проверка не пустая', () => {
  it('старое правило вернуло бы ответ активного профиля', async () => {
    kv['p2:privacy_disable_read_receipts'] = 'true';
    mockActiveId = 1;
    const before = await readReceiptsAllowed(); // как читали до 460-го
    expect(before).toBe(true);
    expect(await readReceiptsAllowedFor(2)).toBe(false);
  });
});
