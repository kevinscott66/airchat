/**
 * groupProfileModel — шапка группы и канала как профиль (v4.32.682).
 *
 * До этой версии шапка была строкой в две колонки: слева снимок, справа
 * столбик из названия, описания, счётчика и постоянного идентификатора,
 * набранный прямо в разметке экрана. Три следствия.
 *
 * Первое — состав шапки нигде не был записан. Что в ней показывается, в каком
 * порядке, что видит участник и чего не видит, какими словами названо пустое
 * место — всё это существовало только в виде вложенных тернарных операторов
 * посреди экрана на шесть тысяч строк. Проверить состав можно было лишь
 * запустив приложение.
 *
 * Второе — канал назывался группой. Счётчик звал `membersLabel` без разбора
 * вида, и подписчики канала считались участниками, хотя `subscribersLabel`
 * лежал рядом с самого начала. То же с пустым описанием: «Добавить описание»
 * предлагалось и там, где описание принадлежит каналу.
 *
 * Третье — непрочитанные ячейки молчали. Название, описание и адрес лежат
 * шифртекстом; если ключ данных их не открыл, экран показывал пустое место,
 * неотличимое от «здесь ничего не задано», и администратор, нажав «добавить»,
 * затирал бы непрочитанное чужое значение.
 *
 * Здесь — состав, порядок и слова, без React. Кто рисует стекло и кто
 * обрабатывает нажатие — дело экрана.
 */

import { membersLabel, subscribersLabel } from '../utils/plural';

/** Строки карточки идут именно в этом порядке. */
export type GroupProfileRowId = 'handle' | 'description' | 'public_id';

export type GroupProfileRow = {
  id: GroupProfileRowId;
  /** Значение для показа. null — значения нет (см. `placeholder`). */
  value: string | null;
  /**
   * Что писать вместо значения. Появляется только тогда, когда строку есть
   * смысл показать пустой: администратору — приглашение заполнить, всем —
   * предупреждение о непрочитанной ячейке.
   */
  placeholder?: string;
  /** Строку можно открыть на правку — только администратору. */
  editable?: boolean;
  /** Значение копируется по нажатию. */
  copyable?: boolean;
  /** Ячейка не открылась ключом данных: значение есть, но его не видно. */
  unreadable?: boolean;
  /** Подпись для голосового доступа. */
  a11y: string;
};

export type GroupProfileFacts = {
  type: 'group' | 'channel';
  amAdmin: boolean;
  /** Название. Пустая строка — названия нет. */
  name: string;
  nameUnreadable?: boolean;
  /** Публичный адрес без собачки. null — адреса нет. */
  handle: string | null;
  handleUnreadable?: boolean;
  description: string;
  descriptionUnreadable?: boolean;
  /** Постоянный идентификатор GR…/CH…. Пустая строка — вывести не удалось. */
  publicId: string;
  memberCount: number;
};

/** «канала» или «группы» — в родительном падеже, для подсказок. */
export function groupKindGenitive(type: 'group' | 'channel'): string {
  return type === 'channel' ? 'канала' : 'группы';
}

/**
 * Название для шапки. Непрочитанное название не притворяется отсутствующим:
 * «Без названия» здесь было бы враньём — название есть, его не видно.
 */
export function groupProfileTitle(f: GroupProfileFacts): string {
  if (f.nameUnreadable === true) return 'Название не удалось прочитать';
  return f.name || (f.type === 'channel' ? 'Канал без названия' : 'Группа без названия');
}

/** «Канал · 1 подписчик» / «Группа · 12 участников». */
export function groupProfileSubtitle(f: GroupProfileFacts): string {
  const kind = f.type === 'channel' ? 'Канал' : 'Группа';
  const who = f.type === 'channel' ? subscribersLabel(f.memberCount) : membersLabel(f.memberCount);
  return `${kind} · ${who}`;
}

/**
 * Строки карточки. Пустых строк не бывает: строка, у которой нет ни значения,
 * ни повода показать пустое место, не возвращается вовсе — иначе у участника
 * карточка состояла бы из трёх пустых мест.
 */
export function groupProfileRows(f: GroupProfileFacts): GroupProfileRow[] {
  const what = groupKindGenitive(f.type);
  const out: GroupProfileRow[] = [];

  if (f.handleUnreadable === true) {
    out.push({
      id: 'handle',
      value: null,
      placeholder: 'Адрес не удалось прочитать',
      editable: f.amAdmin,
      unreadable: true,
      a11y: `Публичный адрес ${what} не удалось прочитать`,
    });
  } else if (f.handle) {
    out.push({
      id: 'handle',
      value: `@${f.handle}`,
      editable: f.amAdmin,
      copyable: true,
      a11y: `Публичный адрес: @${f.handle}`,
    });
  } else if (f.amAdmin) {
    out.push({
      id: 'handle',
      value: null,
      placeholder: 'Добавить публичный адрес',
      editable: true,
      a11y: `Добавить публичный адрес ${what}`,
    });
  }

  if (f.descriptionUnreadable === true) {
    out.push({
      id: 'description',
      value: null,
      placeholder: 'Описание не удалось прочитать',
      editable: f.amAdmin,
      unreadable: true,
      a11y: `Описание ${what} не удалось прочитать`,
    });
  } else if (f.description) {
    out.push({ id: 'description', value: f.description, editable: f.amAdmin, a11y: `Описание: ${f.description}` });
  } else if (f.amAdmin) {
    out.push({
      id: 'description',
      value: null,
      placeholder: `Добавить описание ${what}`,
      editable: true,
      a11y: `Добавить описание ${what}`,
    });
  }

  // Постоянный идентификатор показывается всегда, когда он выведен: название и
  // снимок меняет любой администратор, а адрес — ярлык без реестра, и две
  // разные группы вправе выбрать одну строку. Опознают группу по нему.
  if (f.publicId) {
    out.push({ id: 'public_id', value: f.publicId, copyable: true, a11y: `Постоянный идентификатор: ${f.publicId}` });
  }

  return out;
}
