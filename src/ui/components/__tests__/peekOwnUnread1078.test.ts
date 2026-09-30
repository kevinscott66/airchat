/**
 * ДЕФЕКТ (v4.32.1078). Своя карточка выдавала непрочитанный профиль за пустой.
 *
 * Карточка человека, открытая на самом себе, читает семь полей: имя, @имя,
 * «О себе», местоимения, статус, бумагу на галочку и ряд привязанных учётных
 * записей. Шесть из семи читались собирающими формами — `getOwnDisplayName`,
 * `getOwnUsername`, `ownFieldGet`, `ownLinks`, — а каждая из них сводит «поля
 * нет» и «поле не открылось» к одному `null`. Ячейки шифрованные: занятый
 * SQLite или недоступный ключ дают ровно тот же ответ, что пустая запись.
 *
 * ЦЕНА. Карточка — единственное место, куда приходят посмотреть, каким тебя
 * видят контакты: так и написано в ней самой, и ради этого в v4.32.616 в неё
 * добавили местоимения со статусом. На отказе чтения она отвечала на этот
 * вопрос неправильно, и ответ выглядел как факт: ни @имени, ни «О себе», ни
 * ссылок, ни галочки — профиль пуст.
 *
 * Галочка тут хуже прочего. Она считается сравнением бумаги с @именем, а
 * непрочитанное @имя приходит как отсутствующее: галочка гаснет даже тогда,
 * когда бумага прочиталась целиком. Пропавшая галочка в этом приложении
 * значит «аккаунт переименовался после выдачи» — то есть человек видит
 * сообщение о СВОЁМ действии там, где просто занята база.
 *
 * ПРАВКА. Те же поля читаются формами с исходом (`getOwnDisplayNameTry`,
 * `getOwnUsernameTry`, `ownFieldTryGet`, новый `ownLinksTry`), и то, что не
 * открылось, названо прямо в карточке — там же и тем же янтарём, что и
 * несверенный ключ строкой выше (v4.32.1033). Названия полей общие с окном
 * правки: одно поле — одно слово на всё приложение.
 *
 * ГРАНИЦЫ. Обещание не такое, как в окне правки. Там речь о записи: «заменится,
 * только если задать новое здесь». Здесь писать нечем, и речь о показе: пусто
 * только в этой карточке и только сейчас. Чужой карточки это не касается — её
 * поля приезжают конвертом, а не читаются с диска. Фото тоже не касается:
 * кружок берётся из общего реестра лиц.
 */
import fs from 'fs';
import path from 'path';

import {
  ownCardFieldsUnreadText,
  ownPeekFieldsUnreadText,
  type OwnPeekFieldName,
} from '../../../core/identity/ownCardFieldsUnread';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8');

/** Только код: пояснения не должны сами удовлетворять проверку. */
const codeOnly = (src: string): string =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const PEEK = codeOnly(read('ui', 'components', 'UserProfilePeek.tsx'));
const OWN = codeOnly(read('core', 'identity', 'ownProfile.ts'));
const LINKS = codeOnly(read('core', 'identity', 'ownLinks.ts'));
const MODEL = codeOnly(read('ui', 'components', 'profilePeekModel.ts'));

function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  if (a < 0) throw new Error(`не нашли начало: ${from}`);
  const b = src.indexOf(to, a);
  if (b < 0) throw new Error(`не нашли конец: ${to}`);
  return src.slice(a, b);
}

describe('непрочитанное поле своей карточки названо своим именем', () => {
  it('всё прочиталось — говорить нечего', () => {
    expect(ownPeekFieldsUnreadText([])).toBeNull();
  });

  it('одно поле названо в единственном числе', () => {
    const t = ownPeekFieldsUnreadText(['bio']);
    expect(t).toContain('Прочитать не удалось: «О себе».');
    expect(t).toContain('Здесь поле показано пустым');
    expect(t).not.toContain('показаны пустыми');
  });

  it('несколько полей перечислены сверху вниз по карточке, а не как пришли', () => {
    const t = ownPeekFieldsUnreadText(['links', 'bio', 'name']);
    expect(t).toContain('Прочитать не удалось: имя, «О себе» и привязанные учётные записи.');
    expect(t).toContain('Здесь поля показаны пустыми');
  });

  it('обещание — про показ, а не про запись: карточка ничего не пишет', () => {
    const t = ownPeekFieldsUnreadText(['status']);
    expect(t).toContain('пусто только в этой карточке и только сейчас');
    expect(t).toContain('Закройте её и откройте снова.');
    // Обещание окна правки сюда не переехало: там оно про то, что набранное
    // заменит записанное, а здесь набирать негде.
    expect(t).not.toContain('задать новое здесь');
  });

  it('о погасшей галочке сказано ровно тогда, когда не прочиталось @имя', () => {
    expect(ownPeekFieldsUnreadText(['handle'])).toContain(
      'Галочки подтверждения тоже нет: её сверяют с @именем.'
    );
    expect(ownPeekFieldsUnreadText(['bio', 'status'])).not.toContain('Галочки подтверждения');
  });

  it('ГРАНИЦА: поля называются теми же словами, что в окне правки', () => {
    for (const f of ['name', 'handle', 'pronouns', 'status', 'bio'] as const) {
      const here = ownPeekFieldsUnreadText([f]) ?? '';
      const there = ownCardFieldsUnreadText([f]) ?? '';
      const word = here.slice(
        'Прочитать не удалось: '.length,
        here.indexOf('.', 'Прочитать не удалось: '.length)
      );
      expect(word.length).toBeGreaterThan(0);
      expect(there).toContain(`Прочитать не удалось: ${word}.`);
    }
  });

  it('ГРАНИЦА: два текста всё же разные — обещания у них не совпадают', () => {
    expect(ownPeekFieldsUnreadText(['bio'])).not.toBe(ownCardFieldsUnreadText(['bio']));
  });

  it('ГРАНИЦА: фото в перечень не входит — кружок берётся не отсюда', () => {
    const names: readonly OwnPeekFieldName[] = ['name', 'handle', 'pronouns', 'status', 'bio', 'links'];
    const all = ownPeekFieldsUnreadText(names) ?? '';
    expect(all).not.toContain('фото');
    expect(ownCardFieldsUnreadText(['avatar'])).toContain('фото');
  });
});

describe('форма правки в карточке', () => {
  it('семь полей читаются формами с исходом, а не собирающими', () => {
    const body = slice(PEEK, 'const [name, username, bio, pronouns, status, claim, links]', 'if (cancelled) return;');
    expect(body).toContain('getOwnDisplayNameTry(),');
    expect(body).toContain('getOwnUsernameTry(),');
    expect(body).toContain("ownFieldTryGet('user_bio'),");
    expect(body).toContain("ownFieldTryGet('user_pronouns'),");
    expect(body).toContain("ownFieldTryGet('user_custom_status'),");
    expect(body).toContain('ownLinksTry(),');
    // Собирающих форм на карточке не осталось: незанятая дверь однажды снова
    // откроется.
    expect(PEEK).not.toContain('getOwnDisplayName(),');
    expect(PEEK).not.toContain('getOwnUsername(),');
    expect(PEEK).not.toContain("ownFieldGet('");
    expect(PEEK).not.toContain('ownLinks(),');
  });

  it('каждое непрочитанное поле попадает в перечень под своим именем', () => {
    const body = slice(PEEK, 'const unread: OwnPeekFieldName[] = [];', 'setOwnUnread(unread);');
    expect(body).toContain("if (name === null) unread.push('name');");
    expect(body).toContain("if (username === null) unread.push('handle');");
    expect(body).toContain("if (pronouns === null) unread.push('pronouns');");
    expect(body).toContain("if (status === null) unread.push('status');");
    expect(body).toContain("if (bio === null) unread.push('bio');");
    expect(body).toContain("if (links === 'unreadable') unread.push('links');");
    // Непрочитанный ряд ссылок не становится пустым рядом.
    expect(PEEK).toContain("links: links === 'unreadable' ? null : links,");
  });

  it('перечень сбрасывается на смену карточки вместе с остальным', () => {
    expect(PEEK).toContain('setOwnUnread([]);');
    expect(PEEK).toContain('const [ownUnread, setOwnUnread] = useState<OwnPeekFieldName[]>([]);');
  });

  it('строка показывается только у себя и звучит тревогой', () => {
    expect(PEEK).toContain(
      'const ownUnreadNote = useMemo(() => ownPeekFieldsUnreadText(ownUnread), [ownUnread]);'
    );
    const at = PEEK.indexOf('{isSelf && ownUnreadNote ? (');
    expect(at).toBeGreaterThan(0);
    const block = PEEK.slice(at, PEEK.indexOf(') : null}', at));
    expect(block).toContain('accessibilityRole="alert"');
    // Тот же янтарь, что у несверенного ключа: увиденного плохого нет.
    expect(block).toContain('colors.warning');
    expect(block).toContain('{ownUnreadNote}');
  });

  it('строка стоит выше полей, о которых говорит', () => {
    const note = PEEK.indexOf('{isSelf && ownUnreadNote ? (');
    expect(note).toBeGreaterThan(0);
    expect(note).toBeLessThan(PEEK.indexOf('{identity.pronouns ? ('));
    expect(note).toBeLessThan(PEEK.indexOf('{identity.bio ? ('));
    expect(note).toBeLessThan(PEEK.indexOf('<ProfileLinksRow'));
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежние правила своей карточки целы', () => {
  it('своё читается только у себя, а бумага — прежней формой', () => {
    expect(PEEK).toContain('if (mine) {');
    expect(PEEK).toContain('ownBadgeClaim(),');
  });

  it('галочка по-прежнему требует совпадения бумаги с @именем', () => {
    expect(PEEK).toContain('claim.username ===');
  });

  it('поля по-прежнему проходят через свои нормализаторы', () => {
    expect(PEEK).toContain('normalizeOwnBio(');
    expect(PEEK).toContain('normalizeOwnPronouns(');
    expect(PEEK).toContain('normalizeOwnStatus(');
  });

  it('ЗАКРЕПКА: сбор привязок по-прежнему останавливается на первой закрытой ячейке', () => {
    expect(LINKS).toContain("if (handle === null) return 'unreadable';");
    expect(LINKS).toContain("if (proof === null) return 'unreadable';");
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('собирающие формы и правда сводят отказ к пустоте', () => {
    expect(OWN).toContain("if (own.state === 'unreadable') return null;");
    expect(OWN).toContain('return (await ownFieldTryGetFor(pid, key))?.text ?? null;');
  });

  it('карточка утверждает, что показывает именно ваш профиль', () => {
    expect(MODEL).toContain("? 'Это ваш профиль'");
    // …и что галочку с «О себе» она берёт у себя, а не у собеседника.
    expect(MODEL).toContain('verified: isSelf ? !!own?.verified : contact?.verified === true,');
    expect(MODEL).toContain("bio: (own?.bio || contact?.bio || '').trim() || null,");
  });

  it('пустой перечень и пустая карточка — разные вещи, и текст это знает', () => {
    expect(ownPeekFieldsUnreadText([])).toBeNull();
    expect(ownPeekFieldsUnreadText(['name'])).not.toBeNull();
  });
});
