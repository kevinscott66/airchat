/**
 * Отказ записи переключателя приватности доходит до экрана (v4.32.694).
 *
 * `privacyPrefSet` возвращал `void`. Ответ `kvSetChecked` — «легло/не легло» —
 * гасился внутри `scopedKvSet`, промис резолвился успешно, и вызывающий не мог
 * отличить одно от другого. Экран настроек при этом переставляет переключатель
 * ДО записи, чтобы он не залипал на время обращения к базе.
 *
 * Складывалось это в худшую сторону: человек выбирает «Никто» или «только
 * контакты», видит выбранное положение, запись не ложится — и при следующем
 * запуске возвращается прежнее, разрешающее значение. Запрет, которого никто
 * не отменял, пропадает молча.
 */
import fs from 'fs';
import path from 'path';

const mockKv = new Map<string, string>();
/** Ключи, запись которых база не выполняет (kvSetChecked отвечает false). */
const mockFailWrites = new Set<string>();
let mockPid = 2;

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
import { setAvatarVisibility } from '../avatarVisibility';
import { setCloudTranslateAllowed } from '../../social/translateConsent';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

beforeEach(() => {
  mockKv.clear();
  mockFailWrites.clear();
  mockPid = 2;
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: обычная запись работает', () => {
  // Здесь намеренно не проверяется ответ: этот блок должен проходить и до
  // правки — иначе он не отличает сломанную обвязку от настоящей находки.
  it('значение ложится и читается обратно', async () => {
    await privacyPrefSet('privacy_only_contacts_msg', 'true');
    expect(await privacyPrefGet('privacy_only_contacts_msg')).toBe('true');
  });

  it('обёртки пишут туда же, куда читают', async () => {
    await setAvatarVisibility('nobody');
    await setCloudTranslateAllowed(false);
    expect(await privacyPrefGet('privacy_avatar_visibility')).toBe('nobody');
    expect(await privacyPrefGet('privacy_allow_cloud_translate')).toBe('false');
  });
});

describe('удачная запись отвечает утвердительно', () => {
  it('и сама, и через обёртки', async () => {
    expect(await privacyPrefSet('privacy_only_contacts_msg', 'true')).toBe(true);
    expect(await setAvatarVisibility('nobody')).toBe(true);
    expect(await setCloudTranslateAllowed(false)).toBe(true);
  });
});

describe('база отказала — об этом говорят, а не молчат', () => {
  it('privacyPrefSet отвечает false', async () => {
    mockFailWrites.add('p2:privacy_disable_read_receipts');
    expect(await privacyPrefSet('privacy_disable_read_receipts', 'true')).toBe(false);
    expect(await privacyPrefGet('privacy_disable_read_receipts')).toBeNull();
  });

  it('фотография профиля: отказ доходит до вызывающего', async () => {
    mockFailWrites.add('p2:privacy_avatar_visibility');
    expect(await setAvatarVisibility('nobody')).toBe(false);
  });

  it('облачный перевод: отказ доходит до вызывающего', async () => {
    mockFailWrites.add('p2:privacy_allow_cloud_translate');
    expect(await setCloudTranslateAllowed(true)).toBe(false);
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: несостоявшийся запрет не отменяет прежнее значение', async () => {
    // Первый профиль: у него есть ещё и запись без префикса, из времён одного
    // аккаунта. Снимать её после неудачной записи нельзя — иначе не осталось бы
    // вообще ничего.
    mockPid = 1;
    mockKv.set('privacy_only_contacts_group', 'true');
    mockFailWrites.add('p1:privacy_only_contacts_group');
    expect(await privacyPrefSet('privacy_only_contacts_group', 'false')).toBe(false);
    expect(await privacyPrefGet('privacy_only_contacts_group')).toBe('true');
  });
});

describe('исходники: запись объявлена отвечающей', () => {
  it('privacyPrefs пишет проверяемо', () => {
    const s = read('core/settings/privacyPrefs.ts');
    expect(s).toContain(
      'export async function privacyPrefSet(key: PrivacyPrefKey, value: string): Promise<boolean> {',
    );
    expect(s).toContain('const ok = await scopedKvSetChecked(key, value);');
    expect(s).toContain("log.warn('privacy_pref_write_failed', { key });");
    expect(s).not.toContain('await scopedKvSet(key, value);');
  });

  it('обёртки не глотают ответ', () => {
    expect(read('core/settings/avatarVisibility.ts')).toContain(
      'export async function setAvatarVisibility(value: AvatarVisibility): Promise<boolean> {\n  return privacyPrefSet(KEY, value);',
    );
    expect(read('core/social/translateConsent.ts')).toContain(
      'export async function setCloudTranslateAllowed(allowed: boolean): Promise<boolean> {\n  return privacyPrefSet(CLOUD_TRANSLATE_KEY, String(allowed));',
    );
  });
});

describe('экран настроек: переключатель возвращается на место', () => {
  const screen = (): string => read('ui/screens/SettingsScreen.tsx');

  it('есть общее правило с откатом и сообщением', () => {
    const s = screen();
    expect(s).toContain('const applyPrivacyPref = useCallback(');
    expect(s).toContain('        revert();');
    expect(s).toContain("        showError('Настройка не сохранилась. Попробуйте ещё раз.');");
  });

  it('все шесть переключателей идут через него', () => {
    const s = screen();
    expect((s.match(/applyPrivacyPref\(/g) ?? []).length).toBe(6);
    for (const gone of [
      "void privacyPrefSet('privacy_only_contacts_msg', String(v)); }",
      "void privacyPrefSet('privacy_only_contacts_group', String(v)); }",
      "void privacyPrefSet('privacy_disable_read_receipts', String(v)); }",
      'void setCloudTranslateAllowed(v); }',
      "void privacyPrefSet('privacy_last_seen_visibility', val).then(",
      'void setAvatarVisibility(val).then(',
    ]) {
      expect(s).not.toContain(gone);
    }
  });

  it('рассылка идёт только после успешной записи', () => {
    const s = screen();
    expect(s).toContain(').then((ok) => { if (ok) return broadcastLastSeenPref(); });');
    expect(s).toContain(').then((ok) => { if (ok) return broadcastMyProfile(); });');
  });

  it('откат возвращает именно прежнее значение, а не значение по умолчанию', () => {
    const s = screen();
    expect(s).toContain('const prev = lastSeenVisibility;');
    expect(s).toContain('() => { setLastSeenVisibility(prev); setMyLastSeenVisibility(prev); },');
    expect(s).toContain('const prev = avatarVisibility;');
    expect(s).toContain('() => setAvatarVisibilityState(prev),');
  });
});
