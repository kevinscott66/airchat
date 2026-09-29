/**
 * Непрочитанные фото, имя и @имя выдавались за незаполненные (v4.32.1065).
 *
 * ДЕФЕКТ. Окно «Редактировать профиль» наполняется одним `Promise.all`.
 * Восемь полей в нём читаются исходом — пять ссылок с v4.32.994, три
 * текстовых с v4.32.1040. Оставшиеся три читались собирающей формой:
 * `getOwnDisplayName()`, `getOwnUsername()`, `ownAvatarUri()`. У всех трёх
 * есть форма с исходом, и заведена она ровно затем, чтобы из отказа не
 * делали вывода (`getOwnUsernameTryFor` v4.32.705, `getOwnDisplayNameTryFor`
 * v4.32.779, `ownAvatarUriTryFor` v4.32.1039). Ячейки шифрованные: занятый
 * SQLite или недоступный ключ отвечают тем же, чем и пустая запись.
 *
 * ЦЕНА. У каждого поля своя, и все три дороже текстовых.
 *
 * Фото: кружок пуст, под ним «Добавить фото». Нажатие ведёт в `saveOwnAvatar`,
 * а тот кладёт новый файл и удаляет прежний — ту самую фотографию, которую не
 * прочитали, — после чего она уезжает контактам рассылкой карточки.
 *
 * @имя: поле пусто, и `saved.handle` тоже пусто. Любое набранное имя проходит
 * сравнение `wanted !== saved.handle` как «имени не было, а теперь есть», и
 * сохранение идёт занимать НОВОЕ имя в общем реестре. Прежнее — то, по
 * которому человека находят, — остаётся ничьим и достаётся любому. Это
 * единственный человекочитаемый адрес в приложении.
 *
 * Имя: пустое имя сохранять запрещено, и окно отвечало «Имя не может быть
 * пустым» — обвиняло человека в том, чего он не делал, и заодно не давало
 * сохранить ничего остального: ни «О себе», ни ссылки.
 *
 * ПРАВКА. Все три читаются исходом и попадают в ту же отметку, что и
 * текстовые поля. Фото и имя — как текст: назвать над формой и не мешать.
 * @имя строже: пока прежнее не прочиталось, новое не занимается вовсе.
 * Разница в том, что теряется при ошибке: текст человек напишет заново, а
 * отпущенное @имя заберут. Доля заполненности при непрочитанных полях не
 * показывается: она считается по тому, чего, как ИЗВЕСТНО, нет.
 *
 * ГРАНИЦЫ. Нетронутое поле @имени не ругается и при отказе чтения: пустое
 * равно пустому, менять нечего, и человек, пришедший поправить «О себе», ни в
 * чём не виноват. Прочитанные поля ведут себя ровно как прежде — и пустые
 * тоже: пустота без отказа чтения остаётся обычной пустотой.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  decideUsernameRename,
  ownCardFieldsUnreadText,
  ownNameEmptyText,
} from '../ownCardFieldsUnread';

/** Только код: пояснения не должны сами удовлетворять проверку. */
const codeOnly = (src: string): string =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const SRC = join(__dirname, '..', '..', '..');
const MODAL = (): string =>
  codeOnly(
    readFileSync(join(SRC, 'ui', 'components', 'modals', 'profile', 'ProfileEditModal.tsx'), 'utf8')
  );
const AVATAR = (): string => codeOnly(readFileSync(join(SRC, 'core', 'identity', 'ownAvatar.ts'), 'utf8'));

describe('три новых поля названы над формой', () => {
  it('непрочитанное фото названо', () => {
    const t = ownCardFieldsUnreadText(['avatar']) ?? '';
    expect(t).toContain('фото');
    expect(t).toContain('Поле показано пустым');
  });

  it('непрочитанное имя названо', () => {
    expect(ownCardFieldsUnreadText(['name']) ?? '').toContain('Прочитать не удалось: имя.');
  });

  it('перечисление идёт сверху вниз по форме, а не по порядку аргумента', () => {
    // Фото — самое верхнее, «О себе» — самое нижнее.
    const t = ownCardFieldsUnreadText(['bio', 'handle', 'avatar']) ?? '';
    expect(t).toContain('фото, @имя и «О себе»');
  });

  it('про @имя сказано отдельно: оно не заменится, даже если набрать', () => {
    // Общего обещания «заменится, только если задать новое здесь» тут мало:
    // для @имени оно неверно, его правка отклоняется целиком.
    const t = ownCardFieldsUnreadText(['handle']) ?? '';
    expect(t).toContain('@имя до тех пор не меняется вовсе');
    expect(t).toContain('прежнее досталось бы кому угодно');
  });

  it('ГРАНИЦА: без @имени лишней приписки нет', () => {
    const t = ownCardFieldsUnreadText(['avatar', 'bio']) ?? '';
    expect(t).not.toContain('не меняется вовсе');
  });
});

describe('занимать ли новое @имя', () => {
  it('поле не трогали — в реестр не идём', () => {
    expect(decideUsernameRename('kevin', 'kevin', false)).toEqual({ act: 'keep' });
  });

  it('ГРАНИЦА: непрочитанное и нетронутое поле не ругается', () => {
    // Пустое равно пустому: человек пришёл поправить «О себе» и @имени не
    // касался. Ругань здесь стоила бы ему всего сохранения.
    expect(decideUsernameRename('', '', true)).toEqual({ act: 'keep' });
  });

  it('прежнее не прочиталось, а новое набрано — отказ', () => {
    // Ровно тот случай, ради которого правка: сравнивать не с чем, а путь
    // ниже занял бы набранное как первое имя.
    expect(decideUsernameRename('kevin', '', true)).toEqual({ act: 'refuse' });
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: обычное переименование идёт как шло', () => {
    expect(decideUsernameRename('kevin', 'kev', false)).toEqual({ act: 'claim' });
  });

  it('ГРАНИЦА: первое имя у того, у кого его не было, занимается', () => {
    expect(decideUsernameRename('kevin', '', false)).toEqual({ act: 'claim' });
  });
});

describe('почему не сохраняется пустое имя', () => {
  it('имя не прочиталось — так и сказано', () => {
    expect(ownNameEmptyText(true)).toContain('не прочиталось');
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: человек и правда стёр имя — прежние слова', () => {
    expect(ownNameEmptyText(false)).toBe('Имя не может быть пустым');
  });
});

describe('форма исходников', () => {
  it('все три поля читаются исходом, собирающих форм в окне не осталось', () => {
    const m = MODAL();
    expect(m).toContain('getOwnDisplayNameTry(),');
    expect(m).toContain('getOwnUsernameTry(),');
    expect(m).toContain('ownAvatarUriTry(),');
    // Собирающие формы сводят «нет» и «не открылось» — в этом окне их быть не
    // должно ни у одного поля.
    expect(m).not.toContain('getOwnDisplayName(');
    expect(m).not.toContain('getOwnUsername(');
    expect(m).not.toContain('ownAvatarUri(');
  });

  it('исход чтения попадает в отметку', () => {
    const m = MODAL();
    expect(m).toContain('avatar: face === null,');
    expect(m).toContain('name: name === null,');
    expect(m).toContain('handle: handle === null,');
  });

  it('отказ по @имени останавливает сохранение', () => {
    const m = MODAL();
    expect(m).toContain('const rename = decideUsernameRename(wanted, saved.handle, cardUnread.handle);');
    const at = m.indexOf("if (rename.act === 'refuse')");
    expect(at).toBeGreaterThan(0);
    const block = m.slice(at, at + 400);
    expect(block).toContain('@имя не прочиталось');
    expect(block).toContain('return;');
    // Занятие имени идёт только по третьему исходу, а не по «не равно».
    expect(m).toContain("if (rename.act === 'claim') {");
    expect(m).not.toContain('if (wanted !== saved.handle) {');
  });

  it('заглушка под кружком не обещает, что добавлять не поверх чего', () => {
    const m = MODAL();
    expect(m).toContain(
      "{cardUnread.avatar ? 'Выбрать фото' : avatar ? 'Изменить фото' : 'Добавить фото'}"
    );
  });

  it('доля заполненности при непрочитанных полях не показывается', () => {
    const m = MODAL();
    const at = m.indexOf('unreadFields.length === 0 ?');
    expect(at).toBeGreaterThan(0);
    // Число живёт в ветке «всё прочиталось», а во второй — честная строка.
    const pct = m.indexOf('Профиль заполнен на {completion}%');
    expect(pct).toBeGreaterThan(at);
    expect(m).toContain('Заполненность не считаем: часть полей не прочиталась');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('выбор нового снимка и правда удаляет прежний файл', () => {
    // Если однажды прежний снимок перестанут удалять, цена у непрочитанного
    // фото станет другой, и эту проверку придётся ставить заново.
    const a = AVATAR();
    const at = a.indexOf('export async function saveOwnAvatar(');
    expect(at).toBeGreaterThan(0);
    const body = a.slice(at, a.indexOf('\nexport ', at + 10));
    expect(body).toContain('if (prev && prev !== dst) {');
    expect(body).toContain('FileSystem.deleteAsync(prev');
  });

  it('собирающая форма фото по-прежнему существует — и по-прежнему сводит два ответа', () => {
    const a = AVATAR();
    expect(a).toContain('export async function ownAvatarUriFor(pid: number): Promise<string | null> {');
    expect(a).toContain('return (await ownAvatarUriTryFor(pid))?.uri ?? null;');
  });

  it('соседние поля того же окна давно читаются исходом', () => {
    const m = MODAL();
    expect(m).toContain("ownFieldTryGet('user_bio'),");
    expect(m).toContain('bio: bio === null,');
  });
});

describe('ЗАКРЕПКА', () => {
  it('правило лежит отдельно от экрана и без импортов', () => {
    const rule = readFileSync(join(SRC, 'core', 'identity', 'ownCardFieldsUnread.ts'), 'utf8');
    expect(codeOnly(rule)).not.toContain('import ');
  });
});
