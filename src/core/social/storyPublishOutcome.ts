/**
 * Что сказать автору после публикации сторис (v4.32.360).
 *
 * Чистый модуль: ни файловой системы, ни сети, ни React. Публикация сторис
 * успешна почти всегда — строка в базе создаётся до рассылки, — поэтому автор
 * видит свою сторис даже тогда, когда её не получил никто. Единственный
 * признак, что что-то пошло не так, — это сообщение, которое строится здесь.
 */

import { formatLimit } from '../media/uploadRoute';

/** Медиа выбрали, но оно не уехало: либо больше предела, либо загрузка сорвалась. */
export type StoryMediaFailure = { reason: 'oversize' | 'failed'; limitBytes: number };

/** Та часть результата публикации, от которой зависит текст для автора. */
export type StoryPublishOutcome = {
  mediaFailure: StoryMediaFailure | null;
  /** Сколько контактов было в списке рассылки. */
  contacts: number;
  /** Скольким конверт удалось отправить. */
  delivered: number;
};

/**
 * Одна фраза о том, чего автор не увидит сам, или null — если всё в порядке.
 *
 * Порядок важен: несостоявшаяся рассылка перекрывает разговор о медиа. Сказать
 * «сторис ушла без видео», когда она вообще никуда не ушла, — значит соврать в
 * главном ради подробности.
 */
export function storyPublishProblem(
  res: StoryPublishOutcome,
  mediaType: 'image' | 'video'
): string | null {
  if (res.contacts > 0 && res.delivered === 0) {
    return 'Сторис сохранена, но не ушла ни одному контакту — нет связи. Попробуйте опубликовать снова';
  }
  const fail = res.mediaFailure;
  if (!fail) return null;
  const noun = mediaType === 'video' ? 'Видео' : 'Изображение';
  if (fail.reason === 'oversize') {
    return `${noun} больше ${formatLimit(fail.limitBytes)} — сторис ушла без него`;
  }
  return `${noun} не загрузилось — сторис ушла без него`;
}
