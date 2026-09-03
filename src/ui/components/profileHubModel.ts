/**
 * profileHubModel — что показывать в карточке профиля (v4.32.568).
 *
 * Карточка перестала быть «имя и три кнопки»: в ней теперь быстрые действия
 * (переписка, звонок, видео, звук, поиск), разделы содержимого (публикации,
 * медиа, избранное, файлы, музыка, голосовые, ссылки, у себя — архив
 * публикаций) и настройки переписки (обои, поделиться контактом,
 * автоудаление, запрет на копирование, удалить переписку, заблокировать,
 * пожаловаться).
 *
 * Решения «какие пункты есть сейчас» и «как они подписаны» живут здесь, без
 * React: их видно проверкам, и ни один пункт не может тихо пропасть из-за
 * условия, размазанного по разметке. Значки остались во вьюхе — модель про
 * состав и слова, а не про оформление.
 *
 * v4.32.572: карточка разложена по-другому, и разложена она здесь же.
 *
 * Верхний ряд — ровно пять кнопок, и последняя из них «Ещё». Пять — это
 * ширина телефона: шестая подпись начинает переноситься, а ряд из кнопок
 * разной высоты читается как сбой вёрстки. Всё, что в пятёрку не влезло,
 * уходит не «куда-нибудь ниже», а в один названный список за «Ещё» — иначе
 * получается то, что было: половина действий кнопкой сверху, половина
 * строкой внизу, и никакого правила, по которому человек мог бы угадать, где
 * искать нужное.
 *
 * Разделы содержимого из вертикального списка стали горизонтальной лентой
 * плашек. Список из восьми строк — это восемь экранов прокрутки до настроек;
 * лента занимает одну строку и не отодвигает ничего.
 *
 * У владельца аккаунта лента начинается с публикаций, архива и избранного:
 * это то, что человек открывает у себя, а медиа и файлы он ищет в переписке
 * с кем-то, а не у себя в профиле.
 */

export type HubFacts = {
  /** Это моя собственная карточка. */
  isSelf: boolean;
  /** Есть ли в адресной книге (implicit-строка контактом не считается). */
  inContacts: boolean;
  /**
   * Есть ли вообще строка в адресной книге — включая implicit (v4.32.572).
   * Переименовать можно и её: имя ляжет туда же, куда легло бы у добавленного
   * руками. А вот удалять нечего — вместе со строкой ушёл бы ключ переписки.
   */
  hasContactRecord: boolean;
  blocked: boolean;
  muted: boolean;
  /** Запрет на копирование в этой переписке включён мной. */
  copyGuard: boolean;
  /**
   * …а этот — включён собеседником (v4.32.571). Два поля, а не одно, потому
   * что строка обязана называть, чьё это решение: снять чужое своей рукой
   * нельзя, и «Вкл» без объяснения читалось бы как заевший переключатель.
   */
  copyGuardByPeer: boolean;
  /** Таймер самоуничтожения, мс. null / 0 — выключен. */
  disappearMs: number | null;
  /** Жалоба на этого человека уже записана. */
  reported: boolean;
  /**
   * Умеет ли вызывающий экран открыть переписку. Карточка живёт и в ленте, и
   * в сторис, и не в каждом месте есть куда переходить: пункт, который никуда
   * не ведёт, честнее не рисовать вовсе.
   */
  canOpenChat: boolean;
};

export type QuickActionId =
  | 'message' | 'call' | 'video' | 'mute' | 'search' | 'edit' | 'more';
export type SectionId =
  | 'posts' | 'media' | 'starred' | 'files' | 'music' | 'voice' | 'links' | 'archive';
export type SettingId =
  | 'wallpaper' | 'share_contact' | 'disappear' | 'copy_guard'
  | 'clear_history' | 'block' | 'report';
/**
 * Что лежит за «Ещё» (v4.32.572): настройки переписки и всё про адресную
 * книгу. Отдельный тип, а не «SettingId и что-нибудь ещё»: список за кнопкой
 * должен быть перечислимым целиком, иначе проверить «ничего не пропало» можно
 * только глазами по разметке.
 */
export type MoreId =
  | SettingId | 'search' | 'add_contact' | 'rename_contact' | 'delete_contact';

export type HubItem<Id> = {
  id: Id;
  label: string;
  /** Пункт виден, но нажатие ничего не даст — и это сказано словами. */
  disabled?: boolean;
  /** Правая подпись: текущее значение настройки. */
  value?: string;
  /** Разрушающее действие — красным. */
  danger?: boolean;
};

/** Человеческая подпись таймера самоуничтожения. */
export function disappearLabel(ms: number | null): string {
  if (!ms || ms <= 0) return 'Выключено';
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60_000)} мин`;
  if (h < 24) return `${Math.round(h)} ч`;
  const d = Math.round(h / 24);
  return `${d} дн`;
}

export function hubQuickActions(f: HubFacts): Array<HubItem<QuickActionId>> {
  const out: Array<HubItem<QuickActionId>> = [];
  // Своя карточка ведёт в «Заметки для себя»: это настоящая переписка с самим
  // собой, и подписать её «Написать сообщение» было бы враньём про адресата.
  out.push({
    id: 'message',
    label: f.isSelf ? 'Заметки' : 'Сообщение',
    disabled: !f.canOpenChat,
  });
  if (f.isSelf) {
    // v4.32.572: своё имя, юзернейм, «О себе» и ссылки правятся в одном месте
    // — отдельным разделом, а не карандашами вдоль каждой строки.
    out.push({ id: 'edit', label: 'Изменить' });
    out.push({ id: 'search', label: 'Поиск', disabled: !f.canOpenChat });
  } else {
    // Звонок заблокированному не пойдёт: блокировка рвёт канал в обе стороны.
    out.push({ id: 'call', label: 'Звонок', disabled: f.blocked });
    out.push({ id: 'video', label: 'Видео', disabled: f.blocked });
    out.push({ id: 'mute', label: f.muted ? 'Со звуком' : 'Без звука' });
  }
  // Всегда последняя и всегда есть: за ней лежит остальное, и место у неё в
  // ряду одно и то же в обеих карточках.
  out.push({ id: 'more', label: 'Ещё' });
  return out;
}

export function hubSections(f: HubFacts): Array<HubItem<SectionId>> {
  // Архив — локальный и только свой: он хранит то, что человек убрал из своей
  // ленты. Чужого архива не существует, и показывать его плашкой нечего.
  if (f.isSelf) {
    return [
      { id: 'posts', label: 'Публикации' },
      { id: 'archive', label: 'Архив публикаций' },
      { id: 'starred', label: 'Избранное' },
      { id: 'media', label: 'Медиа' },
      { id: 'files', label: 'Файлы' },
      { id: 'music', label: 'Музыка' },
      { id: 'voice', label: 'Голосовые' },
      { id: 'links', label: 'Ссылки' },
    ];
  }
  return [
    { id: 'posts', label: 'Публикации' },
    { id: 'media', label: 'Медиа' },
    { id: 'starred', label: 'Избранное' },
    { id: 'files', label: 'Файлы' },
    { id: 'music', label: 'Музыка' },
    { id: 'voice', label: 'Голосовые' },
    { id: 'links', label: 'Ссылки' },
  ];
}

export function hubSettings(f: HubFacts): Array<HubItem<SettingId>> {
  const out: Array<HubItem<SettingId>> = [];
  out.push({ id: 'wallpaper', label: 'Изменить обои' });
  out.push({ id: 'share_contact', label: 'Поделиться этим контактом' });
  if (!f.isSelf) {
    out.push({ id: 'disappear', label: 'Автоудаление', value: disappearLabel(f.disappearMs) });
    out.push({
      id: 'copy_guard',
      label: 'Запрет копирования и пересылки',
      value: f.copyGuard ? 'Вкл' : f.copyGuardByPeer ? 'Вкл собеседником' : 'Выкл',
    });
  }
  out.push({ id: 'clear_history', label: 'Удалить переписку', danger: true });
  if (!f.isSelf) {
    out.push({ id: 'block', label: f.blocked ? 'Разблокировать' : 'Заблокировать', danger: !f.blocked });
    out.push({ id: 'report', label: f.reported ? 'Жалоба записана' : 'Пожаловаться', danger: !f.reported });
  }
  return out;
}

/**
 * Список за кнопкой «Ещё» (v4.32.572).
 *
 * Сначала поиск по переписке — он вышел из ряда кнопок, освободив место
 * «Ещё», и должен лежать первым, а не потеряться среди настроек. Дальше
 * настройки переписки, дальше адресная книга: добавить, переименовать,
 * удалить. Порядок ровно такой, потому что первое человек делает часто,
 * последнее — один раз.
 */
export function hubMore(f: HubFacts): Array<HubItem<MoreId>> {
  const out: Array<HubItem<MoreId>> = [];
  // У себя поиск остался кнопкой в ряду: там для него хватило места.
  if (!f.isSelf) out.push({ id: 'search', label: 'Поиск по переписке', disabled: !f.canOpenChat });
  for (const s of hubSettings(f)) out.push(s as HubItem<MoreId>);
  if (!f.isSelf) {
    if (!f.inContacts) out.push({ id: 'add_contact', label: 'Добавить в контакты' });
    if (f.hasContactRecord) out.push({ id: 'rename_contact', label: 'Переименовать' });
    if (f.inContacts) out.push({ id: 'delete_contact', label: 'Удалить контакт', danger: true });
  }
  return out;
}
