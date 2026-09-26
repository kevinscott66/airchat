/**
 * Дефект. Окно «Редактировать профиль» читало сайт, имена на 𝕏 и GitHub и две
 * бумаги к ним строчным `ownFieldGet`, где «поля нет» и «поле не открылось» —
 * один и тот же `null`. Не открывшееся поле приезжало в окно пустым, и кнопка
 * «Сохранить» писала эту пустоту обратно: сайт и имена — по общему условию
 * (правка любого из трёх пишет все три), обе бумаги — вообще без условия, на
 * каждое сохранение, даже когда человек правил одно «О себе».
 *
 * Цена. Имя на площадке пропадает из карточки — и у себя, и у всех, кому она
 * потом уедет: `ownLinks` собирает конверт из тех же полей. Бумага дороже —
 * её не вернуть внутри приложения: подтверждение получают публикацией записи
 * со своей подписью на самой площадке. Галочка пропадала молча, а запись
 * при этом удавалась, и окно закрывалось словами «Профиль сохранён».
 *
 * Правка. Чтение тремя состояниями, а на запись — то же правило, что у
 * описания группы (v4.32.579): пустое поверх непрочитанного не пишем.
 * Осмысленная замена, написанная руками, проходит по-прежнему.
 *
 * Границы. Пустое поверх прочитанной пустоты и поверх прочитанного значения
 * пишется как раньше — это человек стёр поле, и стирать надо.
 *
 * Модуль правки подтягивается внутри проверок, а не сверху файла: иначе на
 * коде до правки падал бы весь набор, включая контрольные.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..', '..');
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');

/** Пины ищут вызов, а не слово: собственный пояснительный комментарий их бы устроил. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const MODAL = read('ui/components/modals/profile/ProfileEditModal.tsx');
const OWN = read('core/identity/ownProfile.ts');
const LINKS = read('core/identity/ownLinks.ts');
const GROUP_RULE = read('core/social/groupMetaEvents.ts');

describe('пустое поверх непрочитанного не пишем', () => {
  it('непрочитанное поле запрещает пустую запись', async () => {
    const { decideLinkFieldWrite } = await import('../linkFieldWrite');
    expect(decideLinkFieldWrite('', true)).toEqual({ write: false, reason: 'emptyOverUnreadable' });
  });

  it('написанное руками значение проходит и поверх непрочитанного', async () => {
    const { decideLinkFieldWrite } = await import('../linkFieldWrite');
    expect(decideLinkFieldWrite('octocat', true)).toEqual({ write: true, reason: 'ok' });
  });

  it('правило — то же, что у описания группы, слово в слово', async () => {
    const { decideLinkFieldWrite } = await import('../linkFieldWrite');
    const { decideOwnDescriptionWrite } = await import('../../social/groupMetaEvents');
    for (const [next, unread] of [['', true], ['', false], ['x', true], ['x', false]] as const) {
      expect(decideLinkFieldWrite(next, unread)).toEqual(decideOwnDescriptionWrite(next, unread));
    }
  });

  it('окно читает все пять полей тремя состояниями', () => {
    const body = codeOnly(MODAL);
    for (const key of ['user_website', 'user_twitter', 'user_github',
                       'user_twitter_proof', 'user_github_proof']) {
      expect(body).toContain(`ownFieldTryGet('${key}')`);
      expect(body).not.toContain(`ownFieldGet('${key}')`);
    }
  });

  it('обе бумаги пишутся через правило, а не мимо него', () => {
    const body = codeOnly(MODAL);
    expect(body).toContain("write('twitter_proof', 'user_twitter_proof'");
    expect(body).toContain("write('github_proof', 'user_github_proof'");
    expect(body).not.toContain("put('user_twitter_proof'");
    expect(body).not.toContain("put('user_github_proof'");
  });

  it('сайт и два имени — тоже', () => {
    const body = codeOnly(MODAL);
    for (const [field, key] of [['website', 'user_website'], ['twitter', 'user_twitter'],
                                ['github', 'user_github']] as const) {
      expect(body).toContain(`write('${field}', '${key}'`);
      expect(body).not.toContain(`put('${key}'`);
    }
  });

  it('о несохранённом сказано, и сказано про расхождение', async () => {
    const { linkFieldsKeptText } = await import('../linkFieldWrite');
    const text = linkFieldsKeptText(['twitter_proof']);
    expect(text).toContain('остались прежними');
    expect(text).toContain('Откройте окно ещё раз');
    expect(text).not.toContain('Ошибка');
    expect(text).not.toContain('не удалось');
  });

  it('про бумагу сказано отдельно: её возвращают снаружи приложения', async () => {
    const { linkFieldsKeptText } = await import('../linkFieldWrite');
    expect(linkFieldsKeptText(['github_proof'])).toContain('публикацией на площадке');
    expect(linkFieldsKeptText(['website'])).not.toContain('публикацией на площадке');
  });

  it('молчание остаётся молчанием, когда пропускать нечего', async () => {
    const { linkFieldsKeptText } = await import('../linkFieldWrite');
    expect(linkFieldsKeptText([])).toBeNull();
  });

  it('окно не объявляет «Профиль сохранён», когда часть полей не писалась', () => {
    expect(MODAL).toContain('if (kept) showError(kept);');
    expect(MODAL).toContain("else if (!handle || handle === saved.handle) showSuccess('Профиль сохранён');");
  });

  it('пропущенное поле не запоминается окном как сохранённое', () => {
    const body = codeOnly(MODAL);
    expect(body).toContain("website: skipped.includes('website') ? saved.website : website,");
    expect(body).toContain("twitter: skipped.includes('twitter') ? saved.twitter : twitter,");
    expect(body).toContain("github: skipped.includes('github') ? saved.github : github,");
  });
});

// Блок ниже — тоже про новый модуль, а не про границу: до правки его не на
// чем было выполнить. Сама же граница проверяется там, где она и живёт, — в
// последней проверке блока «ПОВОД»: правило группы, с которого это списано,
// прочитанную пустоту стирает и стирало.
describe('прочитанную пустоту стираем как раньше', () => {
  it('пустое поверх прочитанного пишется', async () => {
    const { decideLinkFieldWrite } = await import('../linkFieldWrite');
    expect(decideLinkFieldWrite('', false)).toEqual({ write: true, reason: 'ok' });
  });

  it('модуль правила ни от чего не зависит: ни базы, ни ключей, ни сети', () => {
    expect(read('core/identity/linkFieldWrite.ts')).not.toContain('import ');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('строчное чтение по-прежнему сводит «нет» и «не открылось» к одному null', () => {
    expect(OWN).toContain('return (await ownFieldTryGetFor(pid, key))?.text ?? null;');
  });

  it('трёхсоставное чтение по-прежнему отвечает null на нечитаемую ячейку', () => {
    expect(OWN).toContain("if (own.state === 'unreadable') return null;");
  });

  it('запись по-прежнему кладёт что дали, не заглядывая в прежнее', () => {
    expect(OWN).toContain('if (!(await kvSetSecretScoped(pid, key, value)))');
  });

  it('конверт контактам по-прежнему собирается из этих же полей', () => {
    expect(LINKS).toContain("{ p: 'x' as const, handle: 'user_twitter' as const, proof: 'user_twitter_proof' as const }");
  });

  it('правило группы, с которого списано, по-прежнему на месте', () => {
    expect(GROUP_RULE).toContain("if (ownUnreadable === true && next === '') return { write: false, reason: 'emptyOverUnreadable' };");
  });
});
