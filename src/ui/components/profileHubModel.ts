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
 */

export type HubFacts = {
  /** Это моя собственная карточка. */
  isSelf: boolean;
  /** Есть ли в адресной книге (implicit-строка контактом не считается). */
  inContacts: boolean;
  blocked: boolean;
  muted: boolean;
  /** Запрет на копирование в этой переписке. */
  copyGuard: boolean;
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

export type QuickActionId = 'message' | 'call' | 'video' | 'mute' | 'search';
export type SectionId =
  | 'posts' | 'media' | 'starred' | 'files' | 'music' | 'voice' | 'links' | 'archive';
export type SettingId =
  | 'wallpaper' | 'share_contact' | 'disappear' | 'copy_guard'
  | 'clear_history' | 'block' | 'report';

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
  if (!f.isSelf) {
    // Звонок заблокированному не пойдёт: блокировка рвёт канал в обе стороны.
    out.push({ id: 'call', label: 'Звонок', disabled: f.blocked });
    out.push({ id: 'video', label: 'Видео', disabled: f.blocked });
    out.push({ id: 'mute', label: f.muted ? 'Со звуком' : 'Без звука' });
  }
  out.push({ id: 'search', label: 'Поиск', disabled: !f.canOpenChat });
  return out;
}

export function hubSections(f: HubFacts): Array<HubItem<SectionId>> {
  const out: Array<HubItem<SectionId>> = [
    { id: 'posts', label: 'Публикации' },
    { id: 'media', label: 'Медиа' },
    { id: 'starred', label: 'Избранное' },
    { id: 'files', label: 'Файлы' },
    { id: 'music', label: 'Музыка' },
    { id: 'voice', label: 'Голосовые' },
    { id: 'links', label: 'Ссылки' },
  ];
  // Архив — локальный и только свой: он хранит то, что человек убрал из своей
  // ленты. Чужого архива не существует, и показывать его строкой нечего.
  if (f.isSelf) out.push({ id: 'archive', label: 'Архив публикаций' });
  return out;
}

export function hubSettings(f: HubFacts): Array<HubItem<SettingId>> {
  const out: Array<HubItem<SettingId>> = [];
  out.push({ id: 'wallpaper', label: 'Изменить обои' });
  out.push({ id: 'share_contact', label: 'Поделиться этим контактом' });
  if (!f.isSelf) {
    out.push({ id: 'disappear', label: 'Автоудаление', value: disappearLabel(f.disappearMs) });
    out.push({ id: 'copy_guard', label: 'Запрет на копирование', value: f.copyGuard ? 'Вкл' : 'Выкл' });
  }
  out.push({ id: 'clear_history', label: 'Удалить переписку', danger: true });
  if (!f.isSelf) {
    out.push({ id: 'block', label: f.blocked ? 'Разблокировать' : 'Заблокировать', danger: !f.blocked });
    out.push({ id: 'report', label: f.reported ? 'Жалоба записана' : 'Пожаловаться', danger: !f.reported });
  }
  return out;
}
