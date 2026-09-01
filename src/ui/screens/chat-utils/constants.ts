import { SYS_LINE_PREFIX } from '../../../core/social/sysLineGuard';

/**
 * ChatScreen shared constants (D.3.1 extract).
 */
export const PAGE = 40;

/**
 * Системная строка личного чата: «Вы включили исчезающие сообщения: 1 день».
 * Тот же префикс, что и у системных строк групп (GROUP_SYS_PREFIX), и та же
 * строка, которую снимает с сетевого текста stripSpoofedSysPrefix — поэтому
 * не литерал, а константа sysLineGuard. Разойдись копии, экран рисовал бы
 * серым по центру, «как приложение», текст, который защита системным уже не
 * считает (v4.32.263).
 */
export const DM_SYS_PREFIX = SYS_LINE_PREFIX;
