/**
 * Что сказать, когда вложение не доехало до записи в ленте (v4.32.843).
 *
 * До этой версии чтение фото и документов отвечало одним словом — `null`, — и
 * это слово означало сразу три разных исхода: файла нет на месте, файл тяжелее
 * предела, чтение сорвалось исключением. Наверху их считали одним счётчиком и
 * объявляли превышением размера: «Не удалось отправить N фото: размер превышает
 * лимит». Человеку с пропавшим файлом советовали уменьшить файл, который был ни
 * при чём. Документы же не считались вовсе — они исчезали молча.
 *
 * Здесь только счёт и слова: ни файловой системы, ни сети, ни шифрования —
 * иначе это нельзя проверить без стенда на пол-приложения. Ср. `batchSendReport`
 * в `core/media/mediaSendReport.ts`: то же правило для личных сообщений.
 */
import { ruPlural } from '../text/ruPlural';

export type FeedAttachLoss = {
  /** Фото тяжелее предела на одно вложение. */
  photoOversize: number;
  /** Фото не прочиталось: файла нет на месте или чтение сорвалось. */
  photoFailed: number;
  docOversize: number;
  docFailed: number;
  /**
   * Документы сверх предела на одну запись (FEED_DOC_MAX_PER_POST).
   *
   * v4.32.843: их отбрасывал `slice(0, 3)` — без счёта и без слова. Человек
   * прикреплял пять файлов, два не доезжали, и узнать об этом было неоткуда.
   */
  docTooMany: number;
};

export const NO_ATTACH_LOSS: FeedAttachLoss = {
  photoOversize: 0,
  photoFailed: 0,
  docOversize: 0,
  docFailed: 0,
  docTooMany: 0,
};

export function attachLostCount(l: FeedAttachLoss): number {
  return l.photoOversize + l.photoFailed + l.docOversize + l.docFailed + l.docTooMany;
}

/** «2 фото и 1 документ» — то, чего человек не найдёт в своей записи. */
function lostSubject(l: FeedAttachLoss): string {
  const said: string[] = [];
  const photo = l.photoOversize + l.photoFailed;
  const doc = l.docOversize + l.docFailed + l.docTooMany;
  // «фото» не склоняется, поэтому число перед ним и так читается.
  if (photo > 0) said.push(`${photo} фото`);
  if (doc > 0) said.push(`${doc} ${ruPlural(doc, ['документ', 'документа', 'документов'])}`);
  return said.join(' и ');
}

/**
 * Все причины, которые вправду случились, — и ни одной лишней.
 *
 * Средний род множественного числа годится и «фото», и «документам»: говорить
 * приходится сразу про обоих, а согласовывать по первому — врать про второе.
 */
function lostCause(l: FeedAttachLoss): string {
  const said: string[] = [];
  if (l.photoOversize + l.docOversize > 0) said.push('слишком большие');
  if (l.photoFailed + l.docFailed > 0) said.push('не прочитались');
  if (l.docTooMany > 0) said.push('сверх предела на одну запись');
  if (said.length > 0) return said.join(' или ');
  // Счёт не сошёлся: причину выдумывать не за что, но промолчать нельзя —
  // молчание и есть дефект, ради которого всё это писалось.
  return 'не отправлены';
}

/**
 * Текст для человека. `null` — терять было нечего.
 *
 * `saved` — состоялась ли сама запись. Если состоялась, надо сказать об этом:
 * иначе человек напишет её заново и получит в ленте две. Слово выбрано именно
 * «создана», а не «опубликована»: запись сохраняется локально до рассылки и
 * может ждать в очереди отправки — обещать ей ленту контактов тут не за что.
 */
export function feedAttachLossText(l: FeedAttachLoss, saved: boolean): string | null {
  if (attachLostCount(l) === 0) return null;
  const head = `${lostSubject(l)} — ${lostCause(l)}.`;
  if (!saved) return head;
  return `${head} Запись уже создана — публиковать заново не нужно.`;
}
