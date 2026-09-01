/**
 * Системная строка группы — единственное место, где живут её префикс и разбор.
 *
 * v4.32.258. Один и тот же префикс '\x0bsys:' был выписан ТРИЖДЫ: в
 * ui/screens/GroupsScreen.tsx (GROUP_SYS_PREFIX — им строки создаются и по
 * нему же рисуются серым по центру), в core/social/groupMessaging.ts
 * (CTL_SYS_PREFIX — им подписываются строки, рождённые из управляющего
 * конверта) и в core/social/sysLineGuard.ts (SYS_LINE_PREFIX — им же
 * снимается подделка с недоверенного текста).
 *
 * Комментарий у второй копии объяснял её тем, что core не должен импортировать
 * UI. Это верно, но вывод был неверный: общее значение надо было положить в
 * core, а не размножить. Цена расхождения несимметрична — если разойдутся
 * префикс отрисовки и префикс защиты, то stripSpoofedSysPrefix перестанет
 * узнавать то, что экран всё ещё рисует от имени приложения, и участник снова
 * сможет прислать поддельное «вы заблокированы».
 *
 * Модуль без побочных эффектов: импортирует только sysLineGuard (тоже без
 * импортов), поэтому его видно и из core, и из UI без риска цикла.
 */
import { SYS_LINE_PREFIX } from './sysLineGuard';

/**
 * Префикс системной строки группы. Это тот же SYS_LINE_PREFIX — псевдоним
 * оставлен, потому что имя GROUP_SYS_PREFIX уже разошлось по экранам.
 */
export const GROUP_SYS_PREFIX = SYS_LINE_PREFIX;

/** Системная ли это строка (её рисуют серым по центру, без автора). */
export function isGroupSysMessage(text: string): boolean {
  return text.startsWith(GROUP_SYS_PREFIX);
}

/** Пометить событие как системную строку. Только для своего устройства. */
export function makeGroupSysText(event: string): string {
  return GROUP_SYS_PREFIX + event;
}

/** Достать текст события из системной строки. */
export function parseGroupSysText(text: string): string {
  return text.slice(GROUP_SYS_PREFIX.length);
}
