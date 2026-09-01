/**
 * Итог отправки закрепления собеседнику — на экран (v4.32.454).
 *
 * Отдельный модуль, а не строка в экране чата: экран чата уже самый большой в
 * приложении, и правило показа в нём немедленно обзавелось бы вторым видом.
 */

import type { DmPinOutcome } from '../core/social/dmPinOutcome';
import { dmPinProblem } from '../core/social/dmPinOutcome';
import { announceLater } from './announceOutcome';

/** При успехе молчит; при отказе называет, что теперь по-разному у нас двоих. */
export function announceDmPin(sending: Promise<DmPinOutcome>): void {
  announceLater(sending, dmPinProblem);
}
