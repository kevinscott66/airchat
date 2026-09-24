/**
 * Одноразовый снимок больше не отдаётся наружу кнопкой «Поделиться»
 * (v4.32.804).
 *
 * Дефект. Одноразовое фото открывается тем же просмотрщиком, что и любое
 * другое, а у просмотрщика в верхней панели всегда была кнопка «Поделиться».
 * Для обычного снимка это нормально — человек вправе сохранить то, что ему
 * прислали. Для одноразового это кнопка «оставить навсегда»: кадр уходит в
 * «Фото» или в файлы одним нажатием, и оттуда его уже ничем не достать.
 *
 * Цена. Обещание «один раз» отменялось целиком, тем, кто снимок получил, за
 * время показа — то есть ровно до того, как сообщение сотрётся. Хуже прочего
 * то, что у отправителя не остаётся никакого следа: снимок исчезает из
 * переписки у обоих, и выглядит это так, будто всё сработало.
 *
 * Правка. Просмотрщик научился открываться без «Поделиться» (`allowShare`), а
 * решение о запрете переехало в `runViewOnceTap` — в то единственное место,
 * которое знает, что показывает одноразовый кадр. Держать его в экранах было
 * нельзя: снимок ничем не отличается от обычного, и следующий экран забыл бы
 * про запрет молча. По умолчанию выдача разрешена — обычному снимку запрещать
 * нечего.
 */
import fs from 'fs';
import path from 'path';

import { runViewOnceTap, type ViewOnceTapDeps } from '../chat-utils/viewOnceTap';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8');

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const VIEWER = codeOnly(read('ui', 'components', 'MediaViewer.tsx'));
const TAP = codeOnly(read('ui', 'screens', 'chat-utils', 'viewOnceTap.ts'));
const CHAT = codeOnly(read('ui', 'screens', 'ChatScreen.tsx'));
const GROUPS = codeOnly(read('ui', 'screens', 'GroupsScreen.tsx'));

/** Стенд поменьше соседнего: здесь важен один вызов — открытие. */
function stand(over: Partial<ViewOnceTapDeps> = {}): ViewOnceTapDeps {
  return {
    resolve: jest.fn(async () => ({ uris: ['file:///a.jpg'], missing: 0 })),
    alive: jest.fn(() => true),
    open: jest.fn(),
    later: jest.fn(),
    remove: jest.fn(async () => {}),
    reload: jest.fn(),
    onUnavailable: jest.fn(),
    onRemoveFailed: jest.fn(),
    ...over,
  };
}

describe('одноразовое открывается без «Поделиться»', () => {
  it('запрет ставит общий порядок, а не экран', async () => {
    const deps = stand();
    await runViewOnceTap(deps);
    expect(deps.open).toHaveBeenCalledWith(['file:///a.jpg'], { allowShare: false });
  });

  it('запрет стоит и когда расшифровалось не всё', async () => {
    // Здесь удаления не будет (missing > 0), то есть снимок останется в
    // переписке — тем более нельзя дать вынести его копию наружу.
    const deps = stand({ resolve: jest.fn(async () => ({ uris: ['file:///a.jpg'], missing: 2 })) });
    await runViewOnceTap(deps);
    expect(deps.open).toHaveBeenCalledWith(['file:///a.jpg'], { allowShare: false });
  });

  it('несколько кадров одного сообщения открываются так же', async () => {
    const deps = stand({ resolve: jest.fn(async () => ({ uris: ['file:///a.jpg', 'file:///b.jpg'], missing: 0 })) });
    await runViewOnceTap(deps);
    expect(deps.open).toHaveBeenCalledWith(['file:///a.jpg', 'file:///b.jpg'], { allowShare: false });
  });

  it('нечего показывать — просмотрщик не открывается вовсе', async () => {
    const deps = stand({ resolve: jest.fn(async () => ({ uris: [], missing: 1 })) });
    await runViewOnceTap(deps);
    expect(deps.open).not.toHaveBeenCalled();
    expect(deps.onUnavailable).toHaveBeenCalled();
  });

  it('экран закрыли за время расшифровки — тоже не открывается', async () => {
    const deps = stand({ alive: jest.fn(() => false) });
    await runViewOnceTap(deps);
    expect(deps.open).not.toHaveBeenCalled();
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: обычный снимок отдаётся как прежде', () => {
  it('обычные открытия остались без всяких настроек', () => {
    expect(CHAT).toContain('onImagePress={openMedia}');
    expect(GROUPS).toContain('onOpen={(urls, index) => grpMediaViewer.open(urls, index)}');
  });

  it('сама выдача файла никуда не делась', () => {
    expect(VIEWER).toContain('await Sharing.shareAsync(localUri, { mimeType });');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('«Поделиться» пишет кадр отдельным файлом — это и есть вынос наружу', () => {
    // Сетевой адрес сначала скачивается в кэш, и уже этот файл уходит в чужое
    // приложение. Отменить показ после такого нечем.
    expect(VIEWER).toContain('ac_share_');
    expect(VIEWER).toContain('Sharing.isAvailableAsync()');
  });

  it('одноразовое открывает тот же просмотрщик, что и остальное', () => {
    // Отдельного просмотрщика у него нет и не было: отличить кадр по нему
    // самому невозможно, значит запрет обязан прийти снаружи.
    expect(CHAT).toContain('const { open: openMedia, element: mediaViewerElement } = useMediaViewer();');
    expect(GROUPS).toContain('const grpMediaViewer = useMediaViewer();');
  });
});

describe('форма исходников: правка стоит там, где сказано', () => {
  it('запрет выписан в общем порядке один раз', () => {
    expect(TAP).toContain('deps.open(uris, { allowShare: false });');
    expect(TAP).toContain('open: (uris: string[], opts: { allowShare: boolean }) => void;');
  });

  it('оба экрана передают решение дальше, а не придумывают своё', () => {
    expect(CHAT).toContain('open: (uris, opts) => openMedia(uris, 0, opts),');
    expect(GROUPS).toContain('open: (uris, opts) => grpMediaViewer.open(uris, 0, opts),');
    for (const body of [CHAT, GROUPS]) expect(body).not.toContain('allowShare: false');
  });

  it('кнопки нет вовсе, а не «есть, но не работает»', () => {
    // Нажатие недоступной кнопки ничего не объясняет; место под ней остаётся
    // пустым, чтобы счётчик кадров не уехал к краю.
    expect(VIEWER).toContain('{allowShare ? (');
    expect(VIEWER).toContain('<View style={siv.iconPlaceholder} />');
    expect(VIEWER).toContain('iconPlaceholder:');
  });

  it('по умолчанию выдача разрешена — обычному снимку запрещать нечего', () => {
    // Лента, переписка и группы открывают обычные снимки, ничего не передавая.
    expect(VIEWER).toContain('allowShare = true');
    expect(VIEWER).toContain('allowShare: opts?.allowShare !== false');
  });

  it('признак доходит до самой панели, а не теряется по пути', () => {
    expect(VIEWER).toContain('allowShare: boolean;');
    expect(VIEWER).toContain('allowShare={allowShare}');
    expect(VIEWER).toContain('allowShare={state.allowShare}');
  });
});
