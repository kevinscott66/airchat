/**
 * Принятая галочка отвечает за свой исход (v4.32.896).
 *
 * Дефект: `applyOwnBadgeGrant` писал бумагу через `await ownFieldSet(...)` и
 * выбрасывал ответ, а `ownFieldSet` документирован как проверяемый — `false`
 * значит «не записалось». Окно после этого показывало «Аккаунт подтверждён».
 *
 * Цена: галочка нигде не берётся из состояния экрана. Своя карточка читает
 * `user_verify_grant` из базы при каждой отрисовке, контактам уезжает то же
 * поле. Человек считал себя подтверждённым, а видели его без галочки все,
 * включая его самого после перезапуска, — и вставить бумагу заново было уже
 * нечем: из буфера её к тому моменту обычно вытеснили.
 *
 * Правка: отказ записи бросается. `null` отсюда занят под «бумага чужая или
 * испорчена», и путать одно с другим нельзя. Ловушка на экране написана до
 * этой правки — `pasteBadge` разбирает исключение через `userErrorText`.
 */
const mockSetOk = { ok: true };
const mockWrites: { key: string; value: string }[] = [];

jest.mock('../ownProfile', () => ({
  ownFieldGetFor: jest.fn(async () => null),
  getOwnUsernameFor: jest.fn(async () => 'founder'),
  ownFieldSet: jest.fn(async (key: string, value: string) => {
    mockWrites.push({ key, value });
    return mockSetOk.ok;
  }),
}));

jest.mock('../profileManager', () => ({
  profileManager: {
    getActiveProfile: () => ({ id: 1, did: 'did:key:zMine' }),
    getAllProfiles: () => [{ id: 1, did: 'did:key:zMine' }],
  },
}));

const mockClaim = { badge: 'official' as const, username: 'founder' };
const mockGrantOk = { ok: true };
jest.mock('../verification', () => ({
  readGrant: jest.fn(async () => (mockGrantOk.ok ? mockClaim : null)),
}));

jest.mock('../../logger', () => ({ log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } }));

import { readFileSync } from 'fs';
import { join } from 'path';
import { applyOwnBadgeGrant, OWN_BADGE_KEY } from '../ownBadge';
import { isUserFacingMessage } from '../../../ui/components/userErrorText';

/** Файл без строк-комментариев: свой же разбор не должен себя подтверждать. */
const bare = (rel: string): string =>
  readFileSync(join(__dirname, '..', '..', '..', rel), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');

beforeEach(() => {
  mockWrites.length = 0;
  mockSetOk.ok = true;
  mockGrantOk.ok = true;
});

describe('отказ записи не выдаётся за подтверждённый аккаунт', () => {
  it('не записалось — исключение, а не «вот ваша галочка»', async () => {
    mockSetOk.ok = false;
    await expect(applyOwnBadgeGrant('grant-raw')).rejects.toThrow(
      'Подтверждение не сохранилось — попробуйте вставить его ещё раз',
    );
  });

  it('этот текст доходит до экрана как есть', () => {
    expect(isUserFacingMessage('Подтверждение не сохранилось — попробуйте вставить его ещё раз')).toBe(true);
  });

  it('экран разбирает исключение и не показывает успех', () => {
    const s = bare('ui/components/modals/profile/ProfileEditModal.tsx');
    const at = s.indexOf('const claim = await applyOwnBadgeGrant(raw);');
    expect(at).toBeGreaterThan(0);
    // Всё, что говорит «принято», стоит после ожидания — бросок туда не доходит.
    expect(s.indexOf('setBadge(claim);', at)).toBeGreaterThan(at);
    expect(s.indexOf('void broadcastMyProfile();', at)).toBeGreaterThan(at);
    expect(s).toContain("showError(userErrorText(e, 'Не удалось прочитать буфер обмена'));");
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежние два исхода не тронуты', () => {
  it('записалось — возвращается то, что бумага подтверждает', async () => {
    await expect(applyOwnBadgeGrant('  grant-raw  ')).resolves.toEqual(mockClaim);
    expect(mockWrites).toEqual([{ key: OWN_BADGE_KEY, value: 'grant-raw' }]);
  });

  it('бумага чужая или испорчена — по-прежнему `null` и ни одной записи', async () => {
    mockGrantOk.ok = false;
    await expect(applyOwnBadgeGrant('grant-raw')).resolves.toBeNull();
    expect(mockWrites).toEqual([]);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('галочка читается из базы, а не из состояния экрана', () => {
    const s = bare('core/identity/ownBadge.ts');
    expect(s).toContain('return (await ownFieldGetFor(pid, OWN_BADGE_KEY))?.trim() || null;');
    expect(s).toContain('return await readGrant(await ownBadgeGrantFor(pid), didForProfile(pid));');
  });

  it('`ownFieldSet` так и отвечает `false` на непрошедшую запись', () => {
    const s = bare('core/identity/ownProfile.ts');
    expect(s).toContain('export async function ownFieldSetFor(pid: number, key: OwnProfileKey, value: string): Promise<boolean> {');
    expect(s).toContain('if (!(await kvSetSecretScoped(pid, key, value))) {');
  });

  it('мимо проверки в файле не осталось ни одной записи бумаги', () => {
    const s = bare('core/identity/ownBadge.ts');
    // Единственный вызов на весь файл — внутри проверки.
    expect(s.split('ownFieldSet(').length - 1).toBe(1);
    expect(s).toContain("if (!(await ownFieldSet(OWN_BADGE_KEY, typeof raw === 'string' ? raw.trim() : ''))) {");
  });
});
