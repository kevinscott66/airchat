/**
 * Что смена пароля приложения делает с копиями секретных слов (v4.32.869).
 *
 * Копий две, и обе заперты паролем: конверт у Apple ID
 * (`encryptSeedBinding(mnemonic, password)`) и архив в облаке
 * (`deriveCloudKey(mnemonic, password, …)`). Перешифровать их молча нечем —
 * первому нужен свежий вход через Apple, второму секретные слова и заново
 * набранный пароль. Значит, единственное честное действие после смены
 * пароля — пометить обе устаревшими и сказать об этом, пока человек ещё за
 * телефоном и может сделать копию заново.
 *
 * Модуль существует затем, чтобы третья такая копия, если заведётся, не была
 * забыта: у смены пароля один адрес, и закреп в тестах требует, чтобы каждый
 * путь смены звал именно его. В v4.32.868 пометку звал один экран из двух
 * ровно потому, что общего адреса не было.
 *
 * Исход возвращается по копиям отдельно: «неизвестно» разрешается свидетелем
 * на экране, а он есть только у настроек.
 */
import { APPLE_BINDING_STALE_TEXT, markAppleBindingStale } from './appleBindingStale';
import type { StaleMark } from './staleMark';
import { CLOUD_VAULT_STALE_TEXT, markCloudVaultCopyStale } from '../backup/cloudVaultCopy';

/** Что вышло с каждой из копий. */
export type PasswordChangeAftermath = { apple: StaleMark; cloud: StaleMark };

/**
 * Пометить устаревшими все копии, запертые прежним паролем.
 *
 * Обе пометки независимы, и отказ одной не отменяет другую: ни один из вызовов
 * не бросает — каждый отвечает словом.
 */
export async function markPasswordBoundCopiesStale(): Promise<PasswordChangeAftermath> {
  const [apple, cloud] = await Promise.all([markAppleBindingStale(), markCloudVaultCopyStale()]);
  return { apple, cloud };
}

/**
 * Что показать человеку. `null` — показывать нечего: копий не было.
 *
 * Две строки вместо одной склеенной фразы: новости разные, и каждая называет
 * своё действие — привязать заново и отправить заново.
 */
export function passwordChangeAftermathText(r: PasswordChangeAftermath): string | null {
  const lines: string[] = [];
  if (r.apple === 'marked' || r.apple === 'unwritten') lines.push(APPLE_BINDING_STALE_TEXT[r.apple]);
  if (r.cloud === 'marked' || r.cloud === 'unwritten') lines.push(CLOUD_VAULT_STALE_TEXT[r.cloud]);
  return lines.length > 0 ? lines.join('\n\n') : null;
}
