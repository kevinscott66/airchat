/**
 * v4.32.570. Явное добавление контакта собирало его строку заново из литерала
 * с четырьмя полями и стирало профиль собеседника: имя, фотографию, «О себе».
 */
import fs from 'fs';
import path from 'path';

import { mergeExplicitContactRow } from '../contactRowMerge';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const CONTACTS = (): string => read('core', 'social', 'contacts.ts');
const MODULE = (): string => read('core', 'social', 'contactRowMerge.ts');

const withProfile = JSON.stringify({
  displayName: 'Аня',
  symKey: 'old-key',
  implicit: true,
  peerName: 'Анна Каренина',
  peerUsername: 'anna',
  bio: 'Живу в Петербурге',
  avatarCid: 'nb:avatar',
  profileTs: 1700000000,
});

const merged = (prev: string | null, patch?: Partial<{ displayName: string; symKeyB64: string; profileCid: string }>) =>
  JSON.parse(
    mergeExplicitContactRow(prev, {
      displayName: patch?.displayName ?? '',
      symKeyB64: patch?.symKeyB64 ?? 'new-key',
      ...(patch?.profileCid !== undefined ? { profileCid: patch.profileCid } : {}),
    })
  ) as Record<string, unknown>;

describe('mergeExplicitContactRow', () => {
  it('профиль собеседника переживает добавление в контакты', () => {
    const j = merged(withProfile);
    expect(j.peerName).toBe('Анна Каренина');
    expect(j.peerUsername).toBe('anna');
    expect(j.bio).toBe('Живу в Петербурге');
    expect(j.avatarCid).toBe('nb:avatar');
    expect(j.profileTs).toBe(1700000000);
  });

  it('отметка «добавлен вручную» снимается, а ключ обновляется', () => {
    const j = merged(withProfile);
    expect(j.implicit).toBe(false);
    expect(j.symKey).toBe('new-key');
  });

  it('пустое имя не затирает прежнее', () => {
    expect(merged(withProfile).displayName).toBe('Аня');
  });

  it('переданное имя побеждает прежнее', () => {
    expect(merged(withProfile, { displayName: 'Аннушка' }).displayName).toBe('Аннушка');
  });

  it('карточка профиля берётся из прежней строки, если новой не дали', () => {
    const prev = JSON.stringify({ displayName: '', symKey: 'k', profileCid: 'bafyOld' });
    expect(merged(prev).profileCid).toBe('bafyOld');
    expect(merged(prev, { profileCid: 'bafyNew' }).profileCid).toBe('bafyNew');
  });

  it('пустой карточки в строке не появляется', () => {
    const j = merged(JSON.stringify({ displayName: 'Б', symKey: 'k' }));
    expect('profileCid' in j).toBe(false);
  });

  it('нового контакта строит с нуля', () => {
    expect(merged(null, { displayName: 'Новый' })).toEqual({
      displayName: 'Новый',
      symKey: 'new-key',
      implicit: false,
    });
    expect(merged(undefined as unknown as null, { displayName: 'Н' }).implicit).toBe(false);
  });

  it('испорченная строка не роняет добавление', () => {
    for (const raw of ['', '{не json', 'null', '[]', '"строка"', '42']) {
      const j = merged(raw, { displayName: 'В' });
      expect(j).toEqual({ displayName: 'В', symKey: 'new-key', implicit: false });
    }
  });

  it('нестроковые поля прежней строки не подставляются как имя', () => {
    const prev = JSON.stringify({ displayName: 42, profileCid: { a: 1 }, peerName: 'Ц' });
    const j = merged(prev);
    expect(j.displayName).toBe('');
    expect('profileCid' in j).toBe(false);
    expect(j.peerName).toBe('Ц');
  });

  it('повторное добавление ничего не теряет', () => {
    const once = mergeExplicitContactRow(withProfile, { displayName: '', symKeyB64: 'k1' });
    const twice = mergeExplicitContactRow(once, { displayName: '', symKeyB64: 'k1' });
    expect(JSON.parse(twice)).toEqual(JSON.parse(once));
  });
});

const addContactBody = (): string => {
  const s = CONTACTS();
  const at = s.indexOf('export async function addContact');
  expect(at).toBeGreaterThan(-1);
  const end = s.indexOf('\n}\n', at);
  expect(end).toBeGreaterThan(at);
  return s.slice(at, end);
};

describe('addContact пользуется слиянием, а не литералом', () => {
  it('строка контакта складывается слиянием', () => {
    expect(addContactBody()).toContain('mergeExplicitContactRow(existing, {');
  });

  it('внутри addContact не осталось сборки строки с нуля', () => {
    expect(addContactBody()).not.toContain('JSON.stringify({');
  });

  it('ручного разбора прежней строки в addContact больше нет', () => {
    const body = addContactBody();
    expect(body).not.toContain('mergedName');
    expect(body).not.toContain('mergedProfileCid');
    expect(body).not.toContain('JSON.parse(existing)');
  });

  it('соседи по-прежнему сохраняют незнакомые поля', () => {
    expect(CONTACTS()).toContain('JSON.stringify({ ...j, ...next })');
  });
});

describe('форма модуля', () => {
  it('модуль без импортов — слияние проверяется отдельно от базы и ECDH', () => {
    expect(MODULE()).not.toMatch(/^import /m);
  });
});
