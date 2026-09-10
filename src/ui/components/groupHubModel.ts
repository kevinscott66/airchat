/**
 * groupHubModel — что показывать в окне группы и канала (v4.32.680).
 *
 * До этой версии настройки группы жили в общем списке пунктов: два разных
 * вызова `openSheet(...)` — «Настройки группы» с семнадцатью строками у
 * администратора и «Параметры чата» с восемью у участника. Три беды сразу.
 *
 * Первая — меню было два. Одни и те же пункты (уведомления с подменю отсрочки,
 * автоперевод, фон, кегль, медиа, избранное) стояли в обеих ветках дословной
 * копией, и любая правка требовалась дважды; забыть вторую было проще, чем
 * вспомнить. Своего окна у настроек не было вовсе — они лежали вперемешку с
 * действиями над перепиской в безымянном столбце.
 *
 * Вторая — семнадцать строк подряд без единого заголовка. «Медленный режим»,
 * «Фон чата», «Статистика» и «Очистить историю» стояли в одном столбце, будто
 * это вещи одного порядка: настройка группы, настройка своего экрана, справка и
 * необратимое удаление. Найти нужное можно было только перечитав список
 * целиком.
 *
 * Третья — переключатели притворялись командами. Четыре флага группы
 * показывались строкой «Режим только для админов: вкл», и строка называла
 * ДЕЙСТВИЕ, а не состояние: человек читал её как «сейчас включено» и нажимал,
 * чтобы убедиться. Состояние флага в списке не было видно вовсе.
 *
 * Здесь — состав, слова и текущие значения, без React. Разложено по названным
 * разделам, флаги объявлены переключателями и названы состоянием, а не
 * действием. Кто рисует и кто обрабатывает нажатие — дело экрана.
 *
 * Порядок разделов — от того, что человек меняет часто и только у себя, к
 * тому, что меняет редко и для всех, и дальше к необратимому.
 */

import { formatDisappearLabel } from '../../core/social/disappearEnvelope';
import { formatSlowMode } from '../../core/social/groupSendPolicy';

export type GroupSettingId =
  // Своё, локальное — видит и меняет только владелец устройства.
  | 'mute' | 'auto_translate' | 'wallpaper' | 'font_size'
  // Содержимое переписки.
  | 'media' | 'starred' | 'recently_deleted'
  // Общее для всех участников — только администратор.
  | 'slow_mode' | 'disappear' | 'invite_link' | 'stats'
  // Права участников — четыре флага.
  | 'admin_only_posting' | 'admin_only_pinning' | 'require_approval' | 'anonymous_posting'
  // Необратимое.
  | 'export' | 'clear_history';

export type GroupSettingItem = {
  id: GroupSettingId;
  /** Подпись строки: у переключателя — состояние, у остальных — действие. */
  label: string;
  /** Правая подпись: текущее значение. У переключателя её не бывает. */
  value?: string;
  /**
   * Строка — переключатель, и вот его положение. `undefined` значит «обычная
   * строка»: `false` здесь пришлось бы отличать от «нет переключателя», а это
   * ровно та проверка, которую забывают написать.
   */
  toggle?: boolean;
  /** Разрушающее действие — красным. */
  danger?: boolean;
};

export type GroupSettingSection = {
  title: string;
  /** Пояснение под заголовком: чьё это решение и на кого действует. */
  note?: string;
  items: GroupSettingItem[];
};

export type GroupHubFacts = {
  type: 'group' | 'channel';
  /** Я администратор этой группы. */
  amAdmin: boolean;
  /** Уведомления этой переписки выключены. */
  muted: boolean;
  autoTranslate: boolean;
  /** Кегль переписки, выбранный руками. null — общий по приложению. */
  fontSizePt: number | null;
  /** Задержка между сообщениями, секунды. 0 — выключено. */
  slowModeSeconds: number;
  /** Таймер самоуничтожения, мс. null / 0 — выключен. */
  disappearMs: number | null;
  adminOnlyPosting: boolean;
  adminOnlyPinning: boolean;
  requireApproval: boolean;
  anonymousPosting: boolean;
};

/** «Канал» или «Группа» — в заголовках и подсказках. */
export function groupKindWord(type: 'group' | 'channel'): string {
  return type === 'channel' ? 'Канал' : 'Группа';
}

/** Заголовок окна настроек. */
export function groupSettingsTitle(f: GroupHubFacts): string {
  return f.type === 'channel' ? 'Настройки канала' : 'Настройки группы';
}

/**
 * Разделы окна настроек.
 *
 * Пустых разделов не бывает: раздел, из которого выпали все пункты, не
 * рисуется вовсе — иначе у участника оставались бы три заголовка без строк.
 */
export function groupSettingsSections(f: GroupHubFacts): GroupSettingSection[] {
  const out: GroupSettingSection[] = [];

  out.push({
    title: 'На этом устройстве',
    note: 'Видите и меняете только вы — остальным участникам это не передаётся.',
    items: [
      { id: 'mute', label: 'Уведомления', value: f.muted ? 'Выключены' : 'Включены' },
      { id: 'auto_translate', label: 'Автоперевод сообщений', toggle: f.autoTranslate },
      { id: 'wallpaper', label: 'Фон переписки' },
      {
        id: 'font_size',
        label: 'Размер текста',
        value: f.fontSizePt ? `${f.fontSizePt} пт` : 'Как в приложении',
      },
      // У участника общего таймера нет: свой он всё равно может поставить, и
      // здесь это единственное место, где о нём сказано.
      ...(f.amAdmin
        ? []
        : [{
            id: 'disappear' as const,
            label: 'Исчезающие сообщения',
            value: formatDisappearLabel(f.disappearMs),
          }]),
    ],
  });

  out.push({
    title: 'Содержимое',
    items: [
      { id: 'media', label: 'Медиафайлы' },
      { id: 'starred', label: 'Избранные сообщения' },
      { id: 'recently_deleted', label: 'Недавно удалённые' },
    ],
  });

  if (f.amAdmin) {
    out.push({
      title: groupKindWord(f.type),
      note: 'Действует у всех участников.',
      items: [
        // В канале пишут только администраторы — задержка между сообщениями
        // там регулировала бы их самих.
        ...(f.type === 'channel'
          ? []
          : [{ id: 'slow_mode' as const, label: 'Медленный режим', value: formatSlowMode(f.slowModeSeconds) }]),
        { id: 'disappear', label: 'Исчезающие сообщения', value: formatDisappearLabel(f.disappearMs) },
        { id: 'invite_link', label: 'Пригласительная ссылка' },
        { id: 'stats', label: 'Статистика' },
      ],
    });

    out.push({
      title: 'Права участников',
      items: [
        // Подписи называют состояние, а не действие: строка стоит рядом с
        // переключателем, и «включить» под включённым переключателем читается
        // как заевшая кнопка. В канале писать и закреплять и так может только
        // администратор — переключать нечего.
        ...(f.type === 'channel'
          ? []
          : [
              { id: 'admin_only_posting' as const, label: 'Писать могут только администраторы', toggle: f.adminOnlyPosting },
              { id: 'admin_only_pinning' as const, label: 'Закреплять могут только администраторы', toggle: f.adminOnlyPinning },
            ]),
        { id: 'require_approval', label: 'Вход по ссылке — с одобрением', toggle: f.requireApproval },
        { id: 'anonymous_posting', label: 'Скрывать имена отправителей', toggle: f.anonymousPosting },
      ],
    });

    out.push({
      title: 'Переписка целиком',
      items: [
        { id: 'export', label: 'Выгрузить переписку в файл' },
        { id: 'clear_history', label: 'Очистить историю', danger: true },
      ],
    });
  }

  return out.filter((s) => s.items.length > 0);
}

/** Плоский список — для проверок «ничего не пропало» и для поиска по id. */
export function groupSettingIds(f: GroupHubFacts): GroupSettingId[] {
  return groupSettingsSections(f).flatMap((s) => s.items.map((i) => i.id));
}
