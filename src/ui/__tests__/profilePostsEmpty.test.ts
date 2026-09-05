/**
 * Подписи под пустыми разделами профиля (v4.32.600).
 *
 * Сторожим ровно то, ради чего подписи переписывали: они больше не обещают,
 * что содержимое видно «только на этом телефоне», — лента уезжает в облачную
 * копию аккаунта и открывается на любом устройстве владельца. И сторожим то,
 * что осталось правдой: чужая пустая стена не значит «он ничего не публиковал»,
 * а история живёт сутки и пропущенную не догнать.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import {
  profilePostsEmptyNote,
  type ProfilePostsEmptyInput,
} from '../components/modals/profile/profilePostsEmpty';

const SRC = join(__dirname, '..', '..');

const ALL: ProfilePostsEmptyInput[] = [
  { mode: 'wall', isSelf: true, accountSync: true },
  { mode: 'wall', isSelf: true, accountSync: false },
  { mode: 'wall', isSelf: false, accountSync: true },
  { mode: 'wall', isSelf: false, accountSync: false },
  { mode: 'stories', isSelf: true, accountSync: true },
  { mode: 'stories', isSelf: false, accountSync: true },
  { mode: 'archive', isSelf: true, accountSync: true },
];

describe('подписи под пустыми разделами профиля', () => {
  it('ни одна не привязывает содержимое к этому телефону', () => {
    for (const input of ALL) {
      const note = profilePostsEmptyNote(input);
      expect(note).not.toMatch(/этого телефона|этом телефоне|этого устройства|этом устройстве/);
      expect(note).not.toContain('хранится на устройстве');
    }
  });

  it('своя стена зовёт опубликовать, а не объясняет охват', () => {
    const note = profilePostsEmptyNote({ mode: 'wall', isSelf: true, accountSync: true });
    expect(note).toContain('на любом вашем устройстве');
    expect(note).toContain('опубликуйте первую');
  });

  it('без облачной копии своя стена ничего про другие устройства не обещает', () => {
    const note = profilePostsEmptyNote({ mode: 'wall', isSelf: true, accountSync: false });
    expect(note).not.toContain('устройстве');
    expect(note).not.toContain('аккаунте');
  });

  it('чужая пустая стена не читается как «он ничего не публиковал»', () => {
    for (const accountSync of [true, false]) {
      const note = profilePostsEmptyNote({ mode: 'wall', isSelf: false, accountSync });
      expect(note).toContain('Либо автор ничего не публиковал');
      expect(note).toContain('пока не пришли');
    }
  });

  it('истории остаются суточными, и чужую пропущенную не догнать', () => {
    expect(profilePostsEmptyNote({ mode: 'stories', isSelf: true, accountSync: true }))
      .toContain('живёт сутки');
    const alien = profilePostsEmptyNote({ mode: 'stories', isSelf: false, accountSync: true });
    expect(alien).toContain('живут сутки');
    expect(alien).toContain('не догнать');
  });

  it('архив говорит про свои убранные записи и не зависит от остального', () => {
    const note = profilePostsEmptyNote({ mode: 'archive', isSelf: true, accountSync: true });
    expect(note).toContain('убрали из своей ленты');
    expect(profilePostsEmptyNote({ mode: 'archive', isSelf: false, accountSync: false })).toBe(note);
  });

  it('все семь случаев дают непустую подпись, и разделы не путаются', () => {
    const notes = ALL.map(profilePostsEmptyNote);
    for (const n of notes) expect(n.length).toBeGreaterThan(20);
    expect(new Set(notes).size).toBe(6);
  });
});

describe('проверка не пустая', () => {
  /** Подпись, какой она была до 600-го: охват мерился телефоном. */
  const BEFORE = 'видно только те записи автора, которые дошли до этого телефона';

  it('прежняя подпись поймалась бы запретом на «этот телефон»', () => {
    expect(BEFORE).toMatch(/этого телефона/);
    for (const input of ALL) expect(profilePostsEmptyNote(input)).not.toContain(BEFORE);
  });

  it('экран берёт подпись отсюда, а не пишет свою', () => {
    const modal = readFileSync(
      join(SRC, 'ui/components/modals/profile/ProfilePostsModal.tsx'),
      'utf8'
    );
    expect(modal).toContain('profilePostsEmptyNote({');
    expect(modal).toContain("accountSync: !!getConfigSync().cloudBackup?.enabled,");
    expect(modal).not.toContain('до этого телефона');
  });
});
