/**
 * Публикация с фотографиями, которых не видно, шла как публикация без
 * фотографий (v4.32.852).
 *
 * Дефект. `resolveFeedMediaUris` складывал готовые ссылки и заканчивал
 * строкой `const clean = byPost[pid].filter(...)`: слот, который не открылся,
 * не оставлял после себя ничего. Дальше `if (clean.length > 0) map[pid] =
 * clean` — то есть пост, у которого не открылось ни одно вложение, в карту не
 * попадал вовсе.
 *
 * Цена. Пост с тремя снимками показывал два, и подпись для незрячих называла
 * их «Изображение 2 из 2»: число бралось из того же схлопнутого списка.
 * Человек не мог отличить «фотографий не было» от «фотографии не загрузились»
 * ни глазами, ни на слух — а отличие это решающее, потому что во втором
 * случае фотографии лежат на месте и ждут сети или ключа. Хуже всего это
 * выходило там же, где и всегда: на телефоне IPFS выключен, шлюз пуст, и
 * `gatewayUrl` отдаёт пустую строку СРАЗУ ВСЕМ вложениям вида «обычный CID».
 * Такая публикация выглядела как заметка без единого снимка.
 *
 * Правка. Слоты заводятся по длине списка вложений поста и не схлопываются:
 * не открывшийся остаётся `null`. Место в ряду занято значком, подпись под
 * рядом называет оба числа («2 из 3»), а подпись для незрячих — номер слота.
 * Просмотр листает только то, что открылось, поэтому номер для него
 * пересчитывается отдельно (`openedIndexOf`).
 *
 * Границы набора. `feedService` в наборе не поднимается: модуль тянет
 * expo-file-system, SQLite и хранилище профилей, и разбор его импорта рвёт
 * окружение. Поэтому его правило проверяется по исходнику, а считающая часть
 * вынесена в core/media/mediaSlots и проверяется вызовами.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { gatewayUrl } from '../gatewayUrl';
import {
  mediaSlotsNotice,
  openedIndexOf,
  openedSlots,
  unopenedSlotCount,
  unopenedSlotLabel,
} from '../mediaSlots';

const SRC = join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => readFileSync(join(SRC, ...p), 'utf8');

/** Только код: пояснение не должно само удовлетворять проверку. */
const codeOnly = (src: string): string =>
  src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

const FEED_SERVICE = read('core', 'social', 'feedService.ts');
const FEED_SCREEN = read('ui', 'screens', 'FeedScreen.tsx');
const PROFILE_POSTS = read('ui', 'components', 'modals', 'profile', 'ProfilePostsModal.tsx');

/** Тело `resolveFeedMediaUris` — правило живёт в нём, а не по всему файлу. */
function resolveBody(): string {
  const from = FEED_SERVICE.indexOf('export async function resolveFeedMediaUris(');
  expect(from).toBeGreaterThan(0);
  const to = FEED_SERVICE.indexOf('\n}\n', from);
  expect(to).toBeGreaterThan(from);
  return codeOnly(FEED_SERVICE.slice(from, to));
}

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('на телефоне без шлюза обычный CID превращается в пустоту — и не в одном слоте', () => {
    // IPFS на телефоне выключен (см. transport/ipfs/heliaNode), шлюз в
    // настройках пуст. Ровно та минута, когда пропадал ВЕСЬ ряд снимков.
    for (const cid of ['QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o', 'bafybeigdyrzt5']) {
      expect(gatewayUrl('', cid)).toBe('');
      expect(gatewayUrl(null, cid)).toBe('');
    }
  });

  it('вложения поста считаются по одному списку: второго счётчика на экране нет', () => {
    // Если бы число снимков экран брал откуда-то ещё, схлопнутый список не
    // расходился бы с публикацией — и чинить было бы нечего.
    const code = codeOnly(FEED_SCREEN);
    expect(code).toContain('mediaUrls={mediaUrlsMap[item.id] ?? []}');
    expect(code).toContain('mediaUrls.map(');
  });

  it('просмотр листает список, который ему передали, а не сам лезет в пост', () => {
    expect(codeOnly(FEED_SCREEN)).toContain('onMediaPress: (urls: string[], idx: number) => void;');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('разбор вложений по-прежнему идёт задачами через общий пул', () => {
    const body = resolveBody();
    expect(body).toContain('tasks.push({ postId: p.id, idx: i, cid: p.mediaCids[i] });');
    expect(body).toContain('runWithConcurrency(tasks, FEED_IMAGE_READ_CONCURRENCY');
  });

  it('подпись для незрячих осталась на месте и берёт оба числа', () => {
    const ru = JSON.parse(read('i18n', 'ru.json')) as { feed: Record<string, string> };
    expect(ru.feed.a11yImageN).toContain('{{n}}');
    expect(ru.feed.a11yImageN).toContain('{{total}}');
    expect(codeOnly(FEED_SCREEN)).toContain("t('feed.a11yImageN', { n: idx + 1, total: mediaUrls.length })");
  });

  it('целый CID при заданном шлюзе по-прежнему превращается в адрес', () => {
    expect(gatewayUrl('https://gw.example', 'QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o'))
      .toBe('https://gw.example/ipfs/QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o');
  });
});

describe('слоты: не открывшееся вложение остаётся на своём месте', () => {
  it('открытыми считаются только непустые ссылки', () => {
    expect(openedSlots(['a', null, 'b'])).toEqual(['a', 'b']);
    expect(openedSlots([null, null])).toEqual([]);
    // Пустая строка — это тот же отказ: `gatewayUrl` отвечает ею.
    expect(openedSlots(['', 'a'])).toEqual(['a']);
  });

  it('неоткрывшиеся считаются, включая пустые строки', () => {
    expect(unopenedSlotCount(['a', null, 'b'])).toBe(1);
    expect(unopenedSlotCount(['', null])).toBe(2);
    expect(unopenedSlotCount(['a', 'b'])).toBe(0);
  });

  it('номер для просмотра считается по порядку, а не поиском ссылки', () => {
    // Один и тот же снимок, приложенный дважды: `indexOf` вернул бы на второй
    // плитке первую, и нажатие открывало бы не то, на что нажали.
    expect(openedIndexOf(['a', null, 'a'], 2)).toBe(1);
    expect(openedIndexOf([null, 'a'], 1)).toBe(0);
    expect(openedIndexOf(['a', null], 1)).toBe(-1);
  });

  it('подпись под рядом называет оба числа и молчит, когда жаловаться не на что', () => {
    expect(mediaSlotsNotice(['a', 'b'])).toBeNull();
    expect(mediaSlotsNotice(['a', null, 'b'])).toBe('Не загрузилось фотографий: 1 из 3');
    expect(mediaSlotsNotice([null, null, null])).toBe('Не загрузилось фотографий: 3 из 3');
  });

  it('подпись для незрячих на пустом месте называет место, а не «изображение»', () => {
    expect(unopenedSlotLabel(1, 3)).toBe('Фотография 2 из 3 — не загрузилась');
  });
});

describe('ядро: слот не схлопывается', () => {
  it('список слотов заводится по длине вложений поста', () => {
    expect(resolveBody()).toContain('new Array<string | null>(p.mediaCids.length).fill(null)');
  });

  it('готовых ссылок из списка больше не отсеивают', () => {
    const body = resolveBody();
    expect(body).not.toContain('.filter((u): u is string');
    expect(body).not.toContain('if (clean.length > 0)');
  });

  it('тип ответа говорит о слотах, а не о готовых ссылках', () => {
    expect(codeOnly(FEED_SERVICE)).toContain('Promise<Record<string, (string | null)[]>>');
  });
});

describe('экран ленты: место занято, число названо', () => {
  const code = (): string => codeOnly(FEED_SCREEN);

  it('пустой слот рисуется значком с подписью, а не пропускается', () => {
    expect(code()).toContain('unopenedSlotLabel(idx, mediaUrls.length)');
    expect(code()).toContain('styles.thumbMissing');
  });

  it('подпись под рядом показывается в обоих местах: в ленте и в шапке обсуждения', () => {
    expect(code().split('mediaSlotsNotice(').length - 1).toBeGreaterThanOrEqual(4);
    expect(code()).toContain('unopenedSlotLabel(idx, pinnedMediaUrls.length)');
  });

  it('просмотр открывает то, на что нажали: список и номер пересчитаны', () => {
    expect(code()).toContain('onMediaPress(openedSlots(mediaUrls), openedIndexOf(mediaUrls, idx))');
    expect(code()).toContain('openFeedMedia(openedSlots(pinnedMediaUrls), openedIndexOf(pinnedMediaUrls, idx))');
    // Прежний вызов отдавал просмотру слоты как есть — с дырами.
    expect(code()).not.toContain('onMediaPress(mediaUrls, idx)');
    expect(code()).not.toContain('openFeedMedia(pinnedMediaUrls, idx)');
  });

  it('карта снимков хранит слоты', () => {
    expect(code()).toContain('useState<Record<string, MediaSlot[]>>({})');
  });
});

describe('стена профиля: то же правило, тот же текст', () => {
  const code = (): string => codeOnly(PROFILE_POSTS);

  it('слот без ссылки занимает место значком', () => {
    expect(code()).toContain('unopenedSlotLabel(i, uris.length)');
    expect(code()).toContain('styles.thumbMissing');
  });

  it('подпись под рядом берётся из общего места, а не переписывается заново', () => {
    expect(code()).toContain('mediaSlotsNotice(uris)');
    expect(code()).not.toContain('Не загрузилось фотографий:');
  });

  it('карта снимков хранит слоты', () => {
    expect(code()).toContain('useState<Record<string, MediaSlot[]>>({})');
  });
});
