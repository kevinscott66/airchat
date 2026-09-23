/**
 * Согласие на удаление профиля дают под верным описанием, а ответ на удаление
 * читают.
 *
 * v4.32.731. Окно подтверждения обещало обратное тому, что происходит:
 * «локальные данные этого аккаунта останутся в базе, но ключ сменится». На
 * деле ключ как раз и остаётся — он выводится из seed-фразы по номеру профиля
 * и вернётся, если завести профиль снова, — а данные удаляются все: строки
 * базы профиля, копия диалогов, файлы аватара и историй, черновик поста.
 * Согласие, полученное под неверным описанием, — не согласие, а на необратимом
 * действии это стоит человеку всей его переписки.
 *
 * Второе: `deleteProfile` отвечает `boolean`, и ответ выбрасывался. `false`
 * значит «не удалил» — список профилей недоступен либо этой строки в нём уже
 * нет, — и в обоих случаях показывалось «Профиль удалён».
 *
 * Пин по исходнику: окно подтверждения — нативный Alert, в jest его не
 * поднять.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, '..', 'ProfileSelector.tsx'), 'utf8');

/** Только код: объяснения в комментариях повторяют прежний текст дословно. */
const CODE = SRC.split('\n')
  .filter((l) => {
    const t = l.trim();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  })
  .join('\n');

/** Тело одного обработчика: якоря — его объявление и следующее за ним. */
function confirmDelete(): string {
  const a = CODE.indexOf('const confirmDelete = (profile: Profile): void => {');
  expect(a).toBeGreaterThan(0);
  const b = CODE.indexOf('const openRename = (p: Profile): void => {', a);
  expect(b).toBeGreaterThan(a);
  return CODE.slice(a, b);
}

describe('окно подтверждения говорит правду', () => {
  it('прежнего обещания «данные останутся» больше нет', () => {
    expect(confirmDelete()).not.toContain('останутся в базе');
  });

  it('и обещания смены ключа тоже: ключ как раз остаётся', () => {
    expect(confirmDelete()).not.toContain('ключ сменится');
  });

  it('сказано, что данные уйдут и вернуть их нельзя', () => {
    const body = confirmDelete();
    expect(body).toContain('все его данные на этом устройстве');
    expect(body).toContain('Вернуть их будет нельзя');
  });

  it('имя профиля в тексте осталось: удаляют не «профиль вообще»', () => {
    expect(confirmDelete()).toContain('${profile.name}');
  });
});

describe('ответ на удаление читают', () => {
  it('результат забирают в переменную, а не выбрасывают', () => {
    expect(confirmDelete()).toContain(
      'const removed = await profileManager.deleteProfile(profile.id);',
    );
  });

  it('«Профиль удалён» показывают только после проверки ответа', () => {
    const body = confirmDelete();
    const checked = body.indexOf('if (!removed) {');
    const success = body.indexOf("showSuccess('Профиль удалён')");
    expect(checked).toBeGreaterThan(0);
    expect(success).toBeGreaterThan(checked);
  });

  it('на отказ говорят, что данные на месте, — иначе человек решит, что их нет', () => {
    expect(confirmDelete()).toContain('Данные остались на месте');
  });
});
