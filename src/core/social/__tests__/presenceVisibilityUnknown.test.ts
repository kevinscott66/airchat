/**
 * v4.32.475: «ещё не прочитали» — не «показывать всем».
 *
 * Настройка «кто видит, когда я был в сети» лежит в той же базе, что и
 * переписка. Заминка при старте приходила сюда неотличимо от «человек ничего
 * не выбирал», и присутствие начинало рассылаться именно тогда, когда про
 * запрет узнать было неоткуда. Пока ответа нет — действует 'nobody', и первое
 * же удачное чтение возвращает настоящее решение.
 */
jest.mock('../../transport/ipfs/pubsub', () => ({ pubsubPublish: jest.fn(), pubsubSubscribe: jest.fn() }));
jest.mock('../../transport/ipfs/heliaNode', () => ({ isIpfsEnabled: () => false }));
jest.mock('../contacts', () => ({ listContacts: jest.fn(async () => []) }));
jest.mock('../../identity/ownProfile', () => ({ ownFieldGet: jest.fn(async () => '') }));

let mockPrefRead: { value: string | null } | null = null;
jest.mock('../../settings/privacyPrefs', () => ({
  privacyPrefTryGet: jest.fn(async () => mockPrefRead),
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import {
  effectiveMyLastSeenVisibility,
  getMyLastSeenVisibility,
  loadMyLastSeenVisibility,
  setMyLastSeenVisibility,
  loadPersistedPresence,
} from '../presenceService';

const CORE = join(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(CORE, rel), 'utf8');

beforeEach(() => {
  mockPrefRead = { value: null };
});

describe('проверка не пустая', () => {
  it('прочитанное решение отдаётся как есть', async () => {
    mockPrefRead = { value: 'contacts' };
    expect(await loadMyLastSeenVisibility()).toBe(true);
    expect(effectiveMyLastSeenVisibility()).toBe('contacts');
  });

  it('нетронутый переключатель — это «всем»', async () => {
    mockPrefRead = { value: null };
    expect(await loadMyLastSeenVisibility()).toBe(true);
    expect(effectiveMyLastSeenVisibility()).toBe('everybody');
  });
});

describe('пока настройка не прочитана, присутствие не рассылается', () => {
  it('база не ответила — действует «никому»', async () => {
    mockPrefRead = null;
    expect(await loadMyLastSeenVisibility()).toBe(false);
    expect(effectiveMyLastSeenVisibility()).toBe('nobody');
  });

  it('прошлый удачный ответ не считается вечным', async () => {
    mockPrefRead = { value: 'everybody' };
    await loadMyLastSeenVisibility();
    expect(effectiveMyLastSeenVisibility()).toBe('everybody');
    // Решение могли поменять как раз тогда, когда база перестала отвечать.
    mockPrefRead = null;
    expect(await loadMyLastSeenVisibility()).toBe(false);
    expect(effectiveMyLastSeenVisibility()).toBe('nobody');
  });

  it('и загрузка при старте этого не меняет', async () => {
    mockPrefRead = null;
    // v4.32.482: профиль-владелец называется явно.
    await loadPersistedPresence([], 1);
    expect(effectiveMyLastSeenVisibility()).toBe('nobody');
  });

  it('первое удачное чтение возвращает настоящее решение', async () => {
    mockPrefRead = null;
    await loadMyLastSeenVisibility();
    expect(effectiveMyLastSeenVisibility()).toBe('nobody');
    mockPrefRead = { value: 'everybody' };
    expect(await loadMyLastSeenVisibility()).toBe(true);
    expect(effectiveMyLastSeenVisibility()).toBe('everybody');
  });

  it('решение, поставленное из настроек, считается известным', () => {
    setMyLastSeenVisibility('nobody');
    expect(getMyLastSeenVisibility()).toBe('nobody');
    setMyLastSeenVisibility('everybody');
    expect(effectiveMyLastSeenVisibility()).toBe('everybody');
  });

  it('мусор вместо решения читается как «всем», но известным', async () => {
    mockPrefRead = { value: 'чепуха' };
    expect(await loadMyLastSeenVisibility()).toBe(true);
    expect(effectiveMyLastSeenVisibility()).toBe('everybody');
  });
});

describe('осторожное решение применяется во всех трёх местах', () => {
  const src = read('social/presenceService.ts');

  it('рассылка своего присутствия', () => {
    expect(src).toContain('if (!myVisibilityKnown) await loadMyLastSeenVisibility().catch(() => false);');
    expect(src).toContain("if (effectiveMyLastSeenVisibility() === 'nobody') return true;");
    expect(src).not.toContain("if (myVisibility === 'nobody') return true;");
  });

  it('взаимность «скрыл своё — не видишь чужое»', () => {
    expect(src).toContain('myVisibility: effectiveMyLastSeenVisibility(),');
  });

  it('рассылка решения собеседникам', () => {
    const sync = read('social/presencePrefSync.ts');
    // v4.32.479: тот же вызов, но с явным номером профиля (см. sentMap).
    expect(sync).toContain('const read = await privacyPrefTryGetFor(pid, ');
    expect(sync).toContain('if (read === null) return effectiveMyLastSeenVisibility();');
    expect(sync).not.toContain("privacyPrefGet('privacy_last_seen_visibility')");
  });

  it('загрузка при старте читает через отличимый отказ', () => {
    expect(src).toContain('await loadMyLastSeenVisibility();');
    expect(src).not.toContain("privacyPrefGet('privacy_last_seen_visibility')");
  });
});
