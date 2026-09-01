// Русская плюрализация. forms = [одна (1), две-четыре (2-4), пять+ (0/5-20)].
// Пример: ruPlural(1, ['участник','участника','участников']) → 'участник'.
//
// v4.32.421: само правило живёт в core/text/ruPlural — его же зовут подписи в
// ядре, а третья, написанная заново копия склоняла «22 часов».
export { ruPlural } from '../../core/text/ruPlural';
import { ruPlural } from '../../core/text/ruPlural';

/** «5 участников» / «1 участник». */
export function membersLabel(n: number): string {
  return `${n} ${ruPlural(n, ['участник', 'участника', 'участников'])}`;
}

/** «5 голосов» / «2 голоса» / «1 голос». */
export function votesLabel(n: number): string {
  return `${n} ${ruPlural(n, ['голос', 'голоса', 'голосов'])}`;
}

/** «5 подписчиков» / «1 подписчик». */
export function subscribersLabel(n: number): string {
  return `${n} ${ruPlural(n, ['подписчик', 'подписчика', 'подписчиков'])}`;
}
