/**
 * v4.32.568: состав карточки профиля — не «как нарисовано», а «что человеку
 * вообще предлагают». Ошибка тут не рисуется криво, а тихо предлагает
 * невозможное: позвонить заблокированному, «Написать сообщение» там, где
 * писать некуда, или «Пожаловаться» на самого себя.
 *
 * Проверяем именно решения, а не подписи ради подписей: список пунктов — это
 * обещание, и оно должно совпадать с тем, что карточка умеет выполнить.
 */
import {
  disappearLabel,
  hubMore,
  hubQuickActions,
  hubSections,
  hubSettings,
  type HubFacts,
} from '../profileHubModel';

const base: HubFacts = {
  isSelf: false,
  inContacts: true,
  hasContactRecord: true,
  blocked: false,
  muted: false,
  copyGuard: false,
  copyGuardByPeer: false,
  disappearMs: null,
  reported: false,
  canOpenChat: true,
  inChat: false,
};

const ids = <T extends string>(items: ReadonlyArray<{ id: T }>): T[] => items.map((i) => i.id);

describe('быстрые действия', () => {
  // v4.32.572: ряд — ровно пять кнопок, и пятая всегда «Ещё». Шестая не
  // помещается по ширине телефона: подписи начинают переноситься и обрезаться.
  it('у чужого профиля пять кнопок, последняя — «Ещё»', () => {
    expect(ids(hubQuickActions(base))).toEqual(['message', 'call', 'video', 'mute', 'more']);
  });

  it('у своего профиля звонка и звука нет: позвонить себе некому', () => {
    expect(ids(hubQuickActions({ ...base, isSelf: true })))
      .toEqual(['message', 'edit', 'search', 'more']);
  });

  it('«Ещё» стоит последним в любом профиле — это не действие, а вход в список', () => {
    for (const f of [base, { ...base, isSelf: true }, { ...base, blocked: true }]) {
      const row = ids(hubQuickActions(f));
      expect(row[row.length - 1]).toBe('more');
      expect(row.length).toBeLessThanOrEqual(5);
    }
  });

  // v4.32.574: профиль собеседника стал один, и шапка диалога открывает его
  // же. Кнопка «Сообщение» там вела бы в ту переписку, из которой карточку и
  // открыли, — вместо неё поиск по этой переписке, и второй раз в «Ещё» он
  // уже не повторяется.
  it('из переписки первая кнопка — поиск, а не «Сообщение» в ту же переписку', () => {
    expect(ids(hubQuickActions({ ...base, inChat: true })))
      .toEqual(['search', 'call', 'video', 'mute', 'more']);
  });

  it('поиск не дублируется: он либо кнопкой, либо в «Ещё»', () => {
    expect(ids(hubMore({ ...base, inChat: true }))).not.toContain('search');
    expect(ids(hubMore(base))).toContain('search');
  });

  it('у своего профиля inChat ничего не меняет: «Заметки» и есть та переписка', () => {
    expect(ids(hubQuickActions({ ...base, isSelf: true, inChat: true })))
      .toEqual(['message', 'edit', 'search', 'more']);
  });

  it('«Изменить» — только у владельца аккаунта: чужое имя правят не здесь', () => {
    expect(ids(hubQuickActions(base))).not.toContain('edit');
    expect(ids(hubQuickActions({ ...base, isSelf: true }))).toContain('edit');
  });

  it('«Сообщение» у себя называется «Заметки» — это не переписка, а свой блокнот', () => {
    const self = hubQuickActions({ ...base, isSelf: true }).find((a) => a.id === 'message');
    expect(self?.label).toBe('Заметки');
    const other = hubQuickActions(base).find((a) => a.id === 'message');
    expect(other?.label).toBe('Сообщение');
  });

  it('заблокированному не предлагают позвонить: кнопка есть, но нажать нельзя', () => {
    const blocked = hubQuickActions({ ...base, blocked: true });
    expect(blocked.find((a) => a.id === 'call')?.disabled).toBe(true);
    expect(blocked.find((a) => a.id === 'video')?.disabled).toBe(true);
    // Писать заблокированному не запрещаем: блокировка — про входящее.
    expect(blocked.find((a) => a.id === 'message')?.disabled).toBeFalsy();
  });

  it('без способа открыть переписку письмо и поиск выключены, а не врут', () => {
    const noChat = hubQuickActions({ ...base, canOpenChat: false });
    expect(noChat.find((a) => a.id === 'message')?.disabled).toBe(true);
    expect(hubQuickActions({ ...base, isSelf: true, canOpenChat: false })
      .find((a) => a.id === 'search')?.disabled).toBe(true);
    expect(hubMore({ ...base, canOpenChat: false })
      .find((a) => a.id === 'search')?.disabled).toBe(true);
  });

  it('звук подписан тем, что произойдёт при нажатии', () => {
    expect(hubQuickActions(base).find((a) => a.id === 'mute')?.label).toBe('Без звука');
    expect(hubQuickActions({ ...base, muted: true }).find((a) => a.id === 'mute')?.label)
      .toBe('Со звуком');
  });
});

describe('разделы содержимого', () => {
  it('архив публикаций — только у владельца аккаунта', () => {
    expect(ids(hubSections(base))).not.toContain('archive');
    expect(ids(hubSections({ ...base, isSelf: true }))).toContain('archive');
  });

  it('состав разделов совпадает с тем, что карточка умеет открыть', () => {
    expect(ids(hubSections(base)))
      .toEqual(['posts', 'media', 'starred', 'files', 'music', 'voice', 'links']);
  });

  // v4.32.572: «плашки публикации, архив публикаций, избранное по
  // горизонтали» — у хозяина аккаунта эти три идут первыми, потому что
  // полосу листают слева направо, и дальше третьей плашки доходят не все.
  it('у владельца аккаунта полоса начинается с публикаций, архива и избранного', () => {
    expect(ids(hubSections({ ...base, isSelf: true })).slice(0, 3))
      .toEqual(['posts', 'archive', 'starred']);
  });
});

describe('лист «Ещё»', () => {
  it('содержит все настройки переписки: из карточки они ушли только сюда', () => {
    const more = ids(hubMore(base));
    for (const s of ids(hubSettings(base))) expect(more).toContain(s);
  });

  it('поиск по переписке у чужого профиля живёт здесь, а не в ряду кнопок', () => {
    expect(ids(hubMore(base))).toContain('search');
    // У себя поиск остался кнопкой — место в ряду освободили звонок и звук.
    expect(ids(hubMore({ ...base, isSelf: true }))).not.toContain('search');
  });

  it('в своём профиле нет действий с контактом: сам себе не контакт', () => {
    const self = ids(hubMore({ ...base, isSelf: true }));
    expect(self).not.toContain('add_contact');
    expect(self).not.toContain('rename_contact');
    expect(self).not.toContain('delete_contact');
  });

  it('«Добавить» показывается ровно тогда, когда человека в книге нет', () => {
    expect(ids(hubMore({ ...base, inContacts: false }))).toContain('add_contact');
    expect(ids(hubMore(base))).not.toContain('add_contact');
  });

  // Строка бывает неявной: переписка есть, а в адресную книгу человек не
  // попадал. Переименовать такую можно, удалить — нельзя: со строкой ушёл бы
  // ключ переписки.
  it('переименование — по наличию строки, удаление — по добавлению руками', () => {
    const implicit = ids(hubMore({ ...base, inContacts: false, hasContactRecord: true }));
    expect(implicit).toContain('rename_contact');
    expect(implicit).not.toContain('delete_contact');
    const none = ids(hubMore({ ...base, inContacts: false, hasContactRecord: false }));
    expect(none).not.toContain('rename_contact');
  });

  it('удаление контакта помечено опасным', () => {
    expect(hubMore(base).find((x) => x.id === 'delete_contact')?.danger).toBe(true);
  });
});

describe('настройки переписки', () => {
  it('у себя нет ни автоудаления, ни блокировки, ни жалобы на себя', () => {
    const self = ids(hubSettings({ ...base, isSelf: true }));
    expect(self).not.toContain('disappear');
    expect(self).not.toContain('block');
    expect(self).not.toContain('report');
    expect(self).not.toContain('copy_guard');
    // Обои и удаление своей переписки с собой остаются: они про этот телефон.
    expect(self).toContain('wallpaper');
    expect(self).toContain('clear_history');
  });

  it('блокировка подписана обратным действием, когда уже заблокирован', () => {
    expect(hubSettings(base).find((x) => x.id === 'block')?.label).toBe('Заблокировать');
    expect(hubSettings({ ...base, blocked: true }).find((x) => x.id === 'block')?.label)
      .toBe('Разблокировать');
  });

  it('жалоба не обещает отправки — ни до, ни после', () => {
    const labels = [
      hubSettings(base).find((x) => x.id === 'report')?.label,
      hubSettings({ ...base, reported: true }).find((x) => x.id === 'report')?.label,
    ];
    expect(labels).toEqual(['Пожаловаться', 'Жалоба записана']);
    for (const l of labels) expect(l).not.toMatch(/отправ/i);
  });

  it('удаление переписки помечено опасным', () => {
    expect(hubSettings(base).find((x) => x.id === 'clear_history')?.danger).toBe(true);
  });

  it('текущее значение видно, не открывая пункт', () => {
    const on = hubSettings({ ...base, copyGuard: true, disappearMs: 3_600_000 });
    expect(on.find((x) => x.id === 'copy_guard')?.value).toBe('Вкл');
    expect(on.find((x) => x.id === 'disappear')?.value).toBe('1 ч');
  });

  // v4.32.569: запрет закрывает и пересылку, поэтому слово «копирование» в
  // подписи в одиночку врало бы — пункт обещал бы меньше, чем делает.
  it('подпись запрета говорит и про пересылку', () => {
    const label = hubSettings({ ...base, copyGuard: false })
      .find((x) => x.id === 'copy_guard')?.label ?? '';
    expect(label).toMatch(/пересыл/i);
  });
});

describe('disappearLabel', () => {
  it('пишет время так, как его назвали при выборе', () => {
    expect(disappearLabel(null)).toBe('Выключено');
    expect(disappearLabel(0)).toBe('Выключено');
    expect(disappearLabel(60_000)).toBe('1 мин');
    expect(disappearLabel(3_600_000)).toBe('1 ч');
    expect(disappearLabel(86_400_000)).toBe('1 дн');
    expect(disappearLabel(7 * 86_400_000)).toBe('7 дн');
  });

  it('отрицательное и мусорное время не превращается в «-1 мин»', () => {
    expect(disappearLabel(-5)).toBe('Выключено');
    expect(disappearLabel(Number.NaN)).toBe('Выключено');
  });
});
