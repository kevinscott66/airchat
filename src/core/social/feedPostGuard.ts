/**
 * Запись ленты, которую ключ этого устройства не открывает (v4.32.587).
 *
 * Текст поста, список вложений и список документов читались двумя
 * состояниями: строка либо пустота. Столбец, не открывшийся ключом, приходил
 * пустотой — и запись рисовалась карточкой с именем автора, временем и
 * ничем внутри. Отличить её от поста, состоящего из одного снимка, на экране
 * было нечем.
 *
 * Хуже показа — повторное использование. Репост берёт исходную запись и
 * публикует её заново от своего имени: у непрочитанной записи он опубликует
 * пустоту, подписанную чужим автором, и это уйдёт всем контактам. То же с
 * «поделиться» наружу и с цитатой в репосте с комментарием. Пустая строка —
 * не содержимое, и выдавать её за содержимое второй раз, теперь уже наружу,
 * нельзя.
 *
 * Правило то же, что у сообщений (storage/unreadableText): признак живёт
 * рядом со значением, а не подменяет его. Модуль намеренно чистый: ни React,
 * ни хранилища, ни сети.
 */

/** Ровно те поля записи, которые нужны решению. */
export interface MaybeUnreadablePost {
  textUnreadable?: boolean;
  mediaUnreadable?: boolean;
  documentsUnreadable?: boolean;
  /** v4.32.589: имя автора есть в базе, но ключ его не открывает. */
  nameUnreadable?: boolean;
  /** v4.32.589: то же про имя автора оригинала у репоста. */
  repostNameUnreadable?: boolean;
}

/** Не открылась ли хоть одна из зашифрованных половин записи. */
export function feedPostIsUnreadable(post: MaybeUnreadablePost | null | undefined): boolean {
  if (!post) return false;
  return post.textUnreadable === true || post.mediaUnreadable === true || post.documentsUnreadable === true;
}

/**
 * Можно ли отдать запись наружу: репост, репост с комментарием, «поделиться».
 *
 * Отказ здесь строже показа: показать пометку — честно, а опубликовать
 * пустоту от чужого имени необратимо.
 */
export function mayRepublishFeedPost(post: MaybeUnreadablePost | null | undefined): boolean {
  return !feedPostIsUnreadable(post);
}

/** Можно ли пользоваться текстом записи: копировать, переводить, править. */
export function mayReuseFeedText(post: MaybeUnreadablePost | null | undefined): boolean {
  return post?.textUnreadable !== true;
}

/** Ровно те поля комментария, которые нужны решению. */
export interface MaybeUnreadableComment {
  textUnreadable?: boolean;
  /** v4.32.589: имя автора комментария есть в базе, но ключ его не открывает. */
  nameUnreadable?: boolean;
}

/**
 * Не открылся ли текст комментария (v4.32.588).
 *
 * У комментария зашифрована одна половина — текст, — поэтому и правило одно.
 * Отдельное имя нужно затем, что решают по нему разные вещи: показ пометки
 * вместо пустого пузыря и придержанная выгрузка в синхронизации.
 */
export function feedCommentIsUnreadable(comment: MaybeUnreadableComment | null | undefined): boolean {
  return comment?.textUnreadable === true;
}

/**
 * Стоит ли придержать запись при выгрузке наверх (v4.32.589).
 *
 * Шире показа намеренно. Показ решает, чем заменить содержимое карточки, и
 * нечитаемое имя туда не относится: текст рядом может быть цел, и прятать его
 * не за что. А выгрузка отдаёт строку целиком — с именем, — поэтому придержать
 * её должно любое непрочитанное поле, иначе пустое имя уедет наверх новой
 * ревизией и перетрёт целое имя на здоровых устройствах.
 */
export function feedPostIsHeldFromSync(post: MaybeUnreadablePost | null | undefined): boolean {
  if (!post) return false;
  return feedPostIsUnreadable(post) || post.nameUnreadable === true || post.repostNameUnreadable === true;
}

/** То же правило для комментария. */
export function feedCommentIsHeldFromSync(comment: MaybeUnreadableComment | null | undefined): boolean {
  if (!comment) return false;
  return feedCommentIsUnreadable(comment) || comment.nameUnreadable === true;
}

/** Строка отказа для тех действий, которые отдают запись наружу. */
export const UNREADABLE_POST_ACTION_TEXT = 'Эту запись не удалось прочитать — её нельзя переслать';
