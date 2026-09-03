/**
 * Проверяется не текст ради текста, а то, что отказы различимы: человек,
 * получивший «имя занято», и человек, получивший «имя короткое», должны идти
 * в разные стороны, а не перечитывать одну и ту же фразу.
 */
import {
  PRONOUNS_MAX,
  PROFILE_LINK_MAX,
  profileCompletionPct,
  usernameClaimErrorText,
  usernameSaveErrorText,
  usernameSavedText,
  type ProfileFilled,
} from '../ownProfileEditModel';
import { USERNAME_MIN_SELF_SERVICE } from '../../../../../core/identity/reservedUsernames';

const EMPTY: ProfileFilled = {
  name: '',
  bio: '',
  avatar: false,
  handle: '',
  status: '',
  pronouns: '',
  links: '',
};

describe('пределы полей', () => {
  it('местоимения короче ссылки: это подпись, а не второе «О себе»', () => {
    expect(PRONOUNS_MAX).toBeLessThan(PROFILE_LINK_MAX);
  });
});

describe('отказ по юзернейму', () => {
  const reasons = ['empty', 'charset', 'too_long', 'too_short', 'reserved'] as const;

  it('каждая причина объясняется своей фразой', () => {
    const texts = reasons.map((r) => usernameClaimErrorText(r));
    expect(new Set(texts).size).toBe(reasons.length);
    texts.forEach((t) => expect(t.length).toBeGreaterThan(0));
  });

  it('слишком короткий юзернейм называет порог числом', () => {
    expect(usernameClaimErrorText('too_short')).toContain(String(USERNAME_MIN_SELF_SERVICE));
  });

  it('«занято» и «зарезервировано» — разные ответы: во втором случае имя не освободится', () => {
    expect(usernameSaveErrorText('taken')).not.toBe(usernameClaimErrorText('reserved'));
  });

  it('отказы реестра тоже различимы', () => {
    const texts = (['taken', 'rejected', 'local'] as const).map((r) => usernameSaveErrorText(r));
    expect(new Set(texts).size).toBe(3);
  });
});

describe('удачная запись', () => {
  it('локальная запись не обещает закрепления', () => {
    expect(usernameSavedText('local')).not.toBe(usernameSavedText('global'));
    expect(usernameSavedText('global')).toContain('закреплён');
  });
});

describe('полоса заполненности', () => {
  it('пустой профиль — ноль', () => {
    expect(profileCompletionPct(EMPTY)).toBe(0);
  });

  it('заполненный профиль — сто', () => {
    expect(profileCompletionPct({
      name: 'Алекс',
      bio: 'о себе',
      avatar: true,
      handle: 'alex',
      status: 'на связи',
      pronouns: 'он/его',
      links: 'example.com',
    })).toBe(100);
  });

  it('пробелы не считаются за заполненное поле', () => {
    expect(profileCompletionPct({ ...EMPTY, name: '   ', bio: '\n' })).toBe(0);
  });

  it('каждое поле двигает счётчик', () => {
    const keys: Array<keyof ProfileFilled> = ['name', 'bio', 'avatar', 'handle', 'status', 'pronouns', 'links'];
    keys.forEach((k) => {
      const one = { ...EMPTY, [k]: k === 'avatar' ? true : 'x' } as ProfileFilled;
      expect(profileCompletionPct(one)).toBeGreaterThan(0);
    });
  });

  it('счётчик растёт монотонно и не выходит за сто', () => {
    let prev = -1;
    const filled: ProfileFilled = { ...EMPTY };
    const keys: Array<keyof ProfileFilled> = ['name', 'bio', 'avatar', 'handle', 'status', 'pronouns', 'links'];
    keys.forEach((k) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (filled as any)[k] = k === 'avatar' ? true : 'x';
      const pct = profileCompletionPct(filled);
      expect(pct).toBeGreaterThan(prev);
      expect(pct).toBeLessThanOrEqual(100);
      prev = pct;
    });
    expect(prev).toBe(100);
  });
});
