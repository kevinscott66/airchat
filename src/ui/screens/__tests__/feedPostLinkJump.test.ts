/**
 * Переход по ссылке на публикацию: одно нажатие — один переход (v4.32.614).
 *
 * Эффект, открывающий запись по ссылке, стоял на зависимостях
 * `[token, postId, openComments, loadFeed]`. `loadFeed` объявлен от `gateway`,
 * а `gateway` — состояние, которое приходит из `loadConfig` уже после первого
 * рендера. То есть личность `loadFeed` менялась через мгновение после
 * открытия, эффект перезапускался, и на одно нажатие ссылки уходило два
 * запроса к серверу за одной и той же записью и два открытия комментариев.
 *
 * Второй дефект — в том же эффекте. Полноэкранный оверлей гасился по отметке
 * `alive`, то есть по живости КОНКРЕТНОГО запуска эффекта. Человек нажимает
 * вторую ссылку, пока грузится первая: старый запуск объявляется мёртвым и
 * оверлей не гасит, новый находит запись в базе и выходит, не трогая флаг, —
 * «Загружаем публикацию…» остаётся на экране навсегда. Оверлей общий на экран,
 * значит и гасить его надо по живости экрана.
 *
 * Третий — та же надпись стояла в разметке голой строкой мимо словаря.
 */
import fs from 'fs';
import path from 'path';

const SCREEN = fs.readFileSync(path.join(__dirname, '..', 'FeedScreen.tsx'), 'utf8');
const RU = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', '..', 'i18n', 'ru.json'), 'utf8'),
) as { feed: Record<string, string> };

/** Тело эффекта перехода по ссылке — от чтения postId до строки зависимостей. */
function jumpEffect(): string {
  const start = SCREEN.indexOf('    const postId = postJump?.postId;');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = SCREEN.indexOf('  }, [postJump?.token,', start);
  expect(end).toBeGreaterThan(start);
  return SCREEN.slice(start, end);
}

describe('переход по ссылке на публикацию', () => {
  const body = jumpEffect();

  it('отрабатывает token один раз', () => {
    expect(body).toContain('if (handledJumpTokenRef.current === token) return;');
    expect(body).toContain('handledJumpTokenRef.current = token;');
  });

  it('объявляет отметку отработанного перехода вне эффекта', () => {
    expect(SCREEN).toContain('const handledJumpTokenRef = useRef<number | null>(null);');
  });

  it('гасит оверлей по живости экрана, а не запуска эффекта', () => {
    expect(body).toContain('if (isMountedRef.current) setLinkLoading(false);');
    expect(SCREEN).not.toContain('if (alive) setLinkLoading(false)');
  });

  it('надпись оверлея и оба отказа берутся из словаря', () => {
    expect(SCREEN).toContain("t('feed.linkLoading')");
    expect(SCREEN).not.toContain("'Загружаем публикацию…'");
    expect(body).toContain("showError(t('feed.linkMissing'));");
    expect(body).toContain("showError(t('feed.linkFailed'));");
    expect(RU.feed.linkLoading).toBe('Загружаем публикацию…');
    expect(typeof RU.feed.linkMissing).toBe('string');
    expect(typeof RU.feed.linkFailed).toBe('string');
  });
});

/**
 * Отказ «копию выложить не удалось» больше не начинается со слов «Ссылка
 * скопирована» (v4.32.614).
 *
 * Та же функция зовётся из «поделиться», где в буфер обмена ничего не клали, —
 * половину времени зачин был просто неправдой. А в «скопировать ссылку» он
 * дословно повторял тост, показанный секундой раньше, и человек получал два
 * сообщения об одном действии, спорящих друг с другом.
 */
describe('копирование ссылки на публикацию', () => {
  it('отказ не повторяет и не подменяет тост об удавшемся копировании', () => {
    expect(SCREEN).toContain("showError(t('feed.linkPublishFailed'));");
    expect(SCREEN).not.toContain('${COPIED_LINK}, но');
    expect(RU.feed.linkPublishFailed).not.toContain('копирован');
  });

  it('на чужой записи не обещает, что ссылка откроется у кого угодно', () => {
    expect(SCREEN).toContain("showSuccess(isSelfP ? COPIED_LINK : t('feed.linkCopiedForeign'))");
    expect(typeof RU.feed.linkCopiedForeign).toBe('string');
  });
});
