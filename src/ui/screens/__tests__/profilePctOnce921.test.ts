/**
 * Заполненность профиля считали дважды, и два счёта разошлись (v4.32.921).
 *
 * Дефект. Полоса «Заполненность профиля» на экране своего профиля и такая же
 * доля в редакторе профиля считались разными кусками кода. В
 * `ownProfileEditModel` живёт `profileCompletionPct` — там же записано, что
 * вообще считается профилем, и в его docblock прямо сказано, зачем: состав
 * редактора и счётчик надо менять вместе. `ProfileScreen` этого счёта не
 * звал, а держал свой — те же семь полей, набранные заново.
 *
 * Цена. Списки успели разойтись. Ссылки экран проверял так:
 *
 *     !!(website || twitterHandle || githubHandle)
 *
 * то есть без `trim`. Строка из одних пробелов — а она попадает в поле при
 * вставке из буфера — для экрана «ссылка есть», для редактора «ссылки нет».
 * Поле одно из семи, поэтому полоса на экране показывала на 14 % больше, чем
 * та же полоса в редакторе, куда по ней и идут дозаполнять: 86 % снаружи,
 * 71 % внутри. Человек видит, что заполнил больше, открывает редактор — и там
 * меньше, причём непонятно, какое поле «потерялось».
 *
 * Правка. Счёт один и тот же, из `ownProfileEditModel`. Экран отдаёт ему свои
 * поля и склеенные ссылки, а что считать заполненным, решает функция.
 *
 * Границы. Одна разница осталась и закрывается не здесь: имя экран берёт с
 * запасным вариантом из `profileManager`, редактор — только из
 * `getOwnDisplayName`. Это вопрос о том, какое имя считается именем профиля,
 * и место ему там, где имя сохраняется.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { profileCompletionPct } from '../../components/modals/profile/ownProfileEditModel';

const SCREEN = readFileSync(join(__dirname, '..', 'ProfileScreen.tsx'), 'utf8');
const MODAL = readFileSync(
  join(__dirname, '..', '..', 'components', 'modals', 'profile', 'ProfileEditModal.tsx'),
  'utf8'
);

/** Строки кода без комментариев — пояснение не должно сходить за вызов. */
const codeOnly = (source: string): string =>
  source
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('{/*');
    })
    .join('\n');

const CODE = codeOnly(SCREEN);

const EMPTY = { name: '', bio: '', avatar: false, handle: '', status: '', pronouns: '', links: '' };
/** Шесть полей из семи — всё, кроме ссылок. */
const SIX = { name: 'Ким', bio: 'о себе', avatar: true, handle: 'kim', status: '💬 тут', pronouns: 'они', links: '' };

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('оба исходника прочитались', () => {
    expect(CODE.length).toBeGreaterThan(20_000);
    expect(MODAL.length).toBeGreaterThan(5_000);
  });

  it('полей ровно семь, и это видно по шагу счёта', () => {
    expect(profileCompletionPct(EMPTY)).toBe(0);
    expect(profileCompletionPct(SIX)).toBe(86);
    expect(profileCompletionPct({ ...SIX, links: 'example.org' })).toBe(100);
  });

  it('расхождение было настоящим, а не выдуманным', () => {
    // Слева — как считал экран до правки, справа — как считает общий счёт.
    const blank = '   ';
    const screenSaidFilled = !!(blank || '' || '');
    expect(screenSaidFilled).toBe(true);
    expect(profileCompletionPct({ ...SIX, links: blank })).toBe(86);
    // Те же данные: экран насчитал бы седьмое поле, общий счёт — нет.
    expect(profileCompletionPct({ ...SIX, links: 'example.org' })).toBe(100);
  });
});

describe('счёт один на экран и редактор', () => {
  it('экран зовёт общий счёт', () => {
    expect(CODE).toContain(
      "import { profileCompletionPct } from '../components/modals/profile/ownProfileEditModel';"
    );
    expect(CODE).toContain('profileCompletionPct({');
  });

  it('второго набора полей на экране не осталось', () => {
    expect(CODE).not.toContain('!!(website || twitterHandle || githubHandle)');
    expect(CODE).not.toContain('Math.round((fields.filter(Boolean).length / fields.length) * 100)');
  });

  it('экран отдаёт счёту все семь своих полей', () => {
    const at = CODE.indexOf('profileCompletionPct({');
    expect(at).toBeGreaterThan(-1);
    const call = CODE.slice(at, CODE.indexOf('})', at));
    for (const field of ['name:', 'bio,', 'avatar:', 'handle,', 'status:', 'pronouns,', 'links:']) {
      expect(call).toContain(field);
    }
    expect(call).toContain('`${website}${twitterHandle}${githubHandle}`');
  });

});

describe('до правки было верно и осталось верно', () => {
  it('редактор по-прежнему на том же счёте', () => {
    expect(MODAL).toContain('profileCompletionPct({');
    expect(MODAL).toContain('links: `${draft.website}${draft.twitter}${draft.github}`,');
  });

  it('полоса по-прежнему прячется на сотне', () => {
    expect(CODE).toContain('{completionPct < 100 ? (');
  });

  it('полоса по-прежнему рисуется той же долей', () => {
    expect(CODE).toContain('{completionPct}%');
    expect(CODE).toContain('width: `${completionPct}%`');
  });

  it('общий счёт и до правки отвечал про пробелы правильно', () => {
    // Он и не ошибался — ошибался экран, который его не звал. Проверка стоит
    // ради того, что правка не должна была тронуть, и верна с обеих сторон.
    expect(profileCompletionPct({ ...SIX, links: '   ' })).toBe(86);
    expect(profileCompletionPct({ ...SIX, links: '\n\t' })).toBe(86);
  });

  it('сам общий счёт не менялся', () => {
    expect(profileCompletionPct(EMPTY)).toBe(0);
    expect(profileCompletionPct({ ...EMPTY, name: '  ', bio: '\n' })).toBe(0);
    expect(profileCompletionPct({ ...EMPTY, avatar: true })).toBe(14);
  });
});
