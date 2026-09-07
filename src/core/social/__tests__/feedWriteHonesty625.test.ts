/**
 * Запись в ленту больше не рапортует об успехе после отказа (v4.32.625).
 *
 * Три функции возвращали `Promise<void>` и накрывали тело пустым молчаливым
 * catch. Экран честно оборачивал их в runFeedOp или в `.catch` и показал бы
 * «Не удалось…» — но отвергнутого обещания не существовало, и до этой ветки
 * управление не доходило никогда.
 *
 * Хуже всех локальное удаление: падение уборки вложений означало, что
 * `deletePost` не звался вовсе, а плашка сообщала «Удалено локально».
 *
 * Здесь же — репост, у которого ссылка на снимок добавлялась до записи байтов
 * и оставалась даже при неудачной записи; и две плашки в UI, обещавшие
 * удаление, которого не было.
 */
import fs from 'fs';
import path from 'path';

const UI = path.join(__dirname, '..', '..', '..', 'ui');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');
const PPM = fs.readFileSync(
  path.join(UI, 'components', 'modals', 'profile', 'ProfilePostsModal.tsx'),
  'utf8',
);
const STORIES = fs.readFileSync(path.join(UI, 'components', 'StoriesRow.tsx'), 'utf8');

function bodyOf(source: string, head: string): string {
  const from = source.indexOf(head);
  expect(from).toBeGreaterThan(0);
  const to = source.indexOf('\n}\n', from);
  expect(to).toBeGreaterThan(from);
  return source
    .slice(from, to)
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const WRITES = [
  'export async function setFeedPostBookmarked(',
  'export async function setFeedPostArchived(',
  'export async function deleteFeedPostLocal(',
];

describe('записи в ленту доносят свой отказ', () => {
  it.each(WRITES)('%s не гасит ошибку', (head) => {
    expect(bodyOf(SRC, head)).not.toContain('catch');
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: тела те же и делают ту же работу', () => {
    expect(bodyOf(SRC, WRITES[0])).toContain('await s.setBookmarked(postId, bookmarked);');
    expect(bodyOf(SRC, WRITES[1])).toContain('await s.setArchived(postId, archived);');
    const del = bodyOf(SRC, WRITES[2]);
    expect(del).toContain('await cleanupInlinePayloads(postId);');
    expect(del).toContain('await s.deletePost(postId);');
    expect(del).toContain('emitFeedUpdate();');
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: чтения свой catch сохранили — null там отличается от пустоты', () => {
    expect(bodyOf(SRC, 'export async function listArchivedFeedPosts(')).toContain('catch');
    expect(bodyOf(SRC, 'export async function listBookmarkedFeedPosts(')).toContain('catch');
  });
});

describe('репост не ссылается на снимок, которого нет', () => {
  const repost = () => bodyOf(SRC, 'export async function publishRepost(');

  it('ссылка добавляется только после удачной записи байтов', () => {
    const b = repost();
    const write = b.indexOf('if (!(await kvSetInlineAttachment(`feed_inline_media:${newPostId}:${newI}`, b64)))');
    const push = b.indexOf('newMediaCids.push(`inline:${mime};${newI}:${newPostId}`);');
    expect(write).toBeGreaterThan(0);
    expect(push).toBeGreaterThan(write);
    expect(b).toContain("log.warn('feed_repost_inline_media_save_failed'");
  });

  it('прежней записи без проверки не осталось', () => {
    expect(repost()).not.toContain(
      'await kvSetInlineAttachment(`feed_inline_media:${newPostId}:${newI}`, b64);',
    );
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: байты по-прежнему складываются и уезжают получателю', () => {
    const b = repost();
    expect(b).toContain('mediaBase64s.push(b64);');
    expect(b).toContain('const newI = mediaBase64s.length;');
  });
});

describe('плашки альбомов и сторис говорят то, что случилось', () => {
  it('альбом: отказ не выдаётся за удаление', () => {
    expect(PPM).toContain("setNote(deleted\n              ? 'Альбом удалён вместе с копиями снимков.'\n              : 'Не удалось удалить альбом.');");
    expect(PPM).toContain('if (deleted) setAlbumId(null);');
  });

  it('история из альбома: то же самое', () => {
    expect(PPM).toContain("setNote(removed\n            ? 'История убрана из альбома вместе с копией снимка.'\n            : 'Не удалось убрать историю из альбома.');");
  });

  it('прежних безусловных плашек не осталось', () => {
    expect(PPM).not.toContain("            setNote('Альбом удалён вместе с копиями снимков.');");
    expect(PPM).not.toContain("          setNote('История убрана из альбома вместе с копией снимка.');");
  });

  it('удаление сторис отвечает на отказ', () => {
    expect(STORIES).toContain('.catch((e) => {');
    expect(STORIES).toContain("log.warn('ui_story_delete_failed'");
    expect(STORIES).toContain("showError('Не удалось удалить сторис.');");
    expect(STORIES).not.toContain('void deleteStory(story.id, ownerProfileId).then(onClose);');
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: закрытие просмотрщика после удачного удаления осталось', () => {
    expect(STORIES).toContain('void deleteStory(story.id, ownerProfileId)');
    expect(STORIES).toContain('.then(onClose)');
  });
});
