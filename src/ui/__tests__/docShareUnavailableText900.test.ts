/**
 * Когда открыть файл нечем — об этом говорят правду (v4.32.900).
 *
 * Дефект: в ленте нажатие на документ в публикации на устройстве без
 * системного «Поделиться» показывало «Файл сохранён: file:///var/mobile/
 * Containers/Data/Application/…/Caches/feed_…pdf». Сохранения не было:
 * `saveFeedDocumentToCache` кладёт расшифрованную копию в кэш приложения,
 * куда человеку не попасть, и система вычистит её когда захочет.
 *
 * Цена. Обещание сохранности снимает повод искать другой путь: человек
 * закрывает окно спокойным, а больше этого документа у него нигде нет —
 * внутри AirChat он лежит зашифрованным, наружу не выдаётся. Путь из
 * сообщения ему тоже не поможет: набрать его негде и открыть нечем. В личной
 * переписке та же ветка (`DocBubble`) давно говорит правду — «На этом
 * устройстве нечем открыть файл», — и лента ей противоречила.
 *
 * Заодно: просмотрщик медиа в двух соседних окнах звал это «шарингом».
 * Слова «шаринг» человек в русском интерфейсе не ждёт, а кнопка, которая
 * ведёт к этим окнам, называется «Поделиться».
 *
 * Правка: ключ `feed.docSavedTo` заменён на `feed.docNoOpener` без пути в
 * тексте; два окна просмотрщика переписаны без жаргона.
 */

import fs from 'fs';
import path from 'path';

const UI = path.join(__dirname, '..');
const SRC = path.join(UI, '..');
const read = (rel: string, root: string = UI): string => fs.readFileSync(path.join(root, rel), 'utf8');
/** Только код: пояснения не должны сами удовлетворять проверку. */
const codeOnly = (rel: string, root: string = UI): string =>
  read(rel, root)
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
const ru = JSON.parse(read('i18n/ru.json', SRC)) as { feed: Record<string, string> };

describe('лента не обещает сохранности того, что лежит в кэше', () => {
  it('ключа с путём в тексте больше нет', () => {
    expect(ru.feed.docSavedTo).toBeUndefined();
    expect(codeOnly('screens/FeedScreen.tsx')).not.toContain('docSavedTo');
  });

  it('новый текст не поминает ни сохранение, ни путь', () => {
    const msg = ru.feed.docNoOpener;
    expect(typeof msg).toBe('string');
    expect(msg).not.toContain('{{uri}}');
    // Отрицание «сохранить не может» допустимо; запрещено утверждение,
    // что файл уже где-то лежит сохранённым.
    expect(msg).not.toMatch(/сохранён|сохранена|сохранено/i);
    expect(msg).not.toContain('file://');
  });

  it('текст называет и причину, и то, что файла снаружи нет', () => {
    const msg = ru.feed.docNoOpener;
    expect(msg).toContain('нечем открыть');
    // Без этой половины человек решит, что документ можно достать позже.
    expect(msg).toMatch(/сохранить его отдельно AirChat не может/);
  });

  it('ветка «поделиться нечем» показывает именно его', () => {
    const body = codeOnly('screens/FeedScreen.tsx');
    const branch = body.indexOf('const available = await Sharing.isAvailableAsync();');
    expect(branch).toBeGreaterThan(0);
    const tail = body.slice(branch, branch + 260);
    expect(tail).toContain("Alert.alert(t('feed.docTitle'), t('feed.docNoOpener'));");
    expect(tail).not.toContain('{ uri }');
  });
});

describe('просмотрщик медиа говорит без жаргона', () => {
  it('слова «шаринг» в приложении не осталось', () => {
    for (const rel of ['components/MediaViewer.tsx', 'screens/FeedScreen.tsx']) {
      expect(read(rel)).not.toMatch(/шаринг/i);
    }
  });

  it('оба окна просмотрщика переписаны по-человечески', () => {
    const body = codeOnly('components/MediaViewer.tsx');
    expect(body).toContain('Файл слишком большой, чтобы им поделиться');
    expect(body).toContain('На этом устройстве нет приложения, которому можно передать файл');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('копия документа по-прежнему уходит в кэш приложения', () => {
    const body = codeOnly('../core/social/feedService.ts', UI);
    const fn = body.indexOf('export async function saveFeedDocumentToCache(');
    expect(fn).toBeGreaterThan(0);
    const tail = body.slice(fn, fn + 700);
    expect(tail).toContain('FileSystem.cacheDirectory');
    expect(tail).toContain('feed_${postId.slice(0, 24)}');
  });

  it('ветка без системного «Поделиться» в ленте достижима', () => {
    const body = codeOnly('screens/FeedScreen.tsx');
    expect(body).toContain('const available = await Sharing.isAvailableAsync();');
    expect(body).toContain('if (!available) {');
  });

  it('в просмотрщике обе ветки на месте', () => {
    const body = codeOnly('components/MediaViewer.tsx');
    expect(body).toContain('const canShare = await Sharing.isAvailableAsync();');
    expect(body).toContain('if (!got) {');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('в переписке та же ветка и была образцом', () => {
    const body = codeOnly('screens/chat-components/DocBubble.tsx');
    expect(body).toContain('await sharing.isAvailableAsync()');
    expect(body).toContain('На этом устройстве нечем открыть файл');
  });

  it('остальные ключи документа в словаре целы', () => {
    for (const key of ['docTitle', 'docOpenFailed', 'docOpenError']) {
      expect(typeof ru.feed[key]).toBe('string');
      expect(ru.feed[key].length).toBeGreaterThan(0);
    }
  });
});
