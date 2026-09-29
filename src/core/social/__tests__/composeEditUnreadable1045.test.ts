/**
 * Непрочитанная правленая запись стирала черновик (v4.32.1045).
 *
 * ДЕФЕКТ. Восстановление черновика спрашивало `getFeedPost`, а тот отдаёт один
 * и тот же null и когда записи нет, и когда база не ответила. Экран сводил
 * ответ к `editTargetExists: !!restoredEditing`, `planComposeRestore` отвечал
 * `discard`, и дальше шло `clearPersistedComposeDraft`.
 *
 * ЦЕНА. Стирание необратимо: текст правки, который человек не успел сохранить,
 * потому что приложение убили, исчезает насовсем. Вдобавок ему говорят
 * «Публикацию, которую вы правили, уже удалили» про запись, которая цела.
 * Момент выбран худший из возможных: восстановление идёт при монтировании
 * ленты, то есть на запуске, когда связка ключей ещё не отдала ключ шифрования
 * базы, а сама база занята первым проходом синхронизации. Отказ здесь не
 * редкость, а ожидаемое состояние первых секунд.
 *
 * ПРАВКА. `getFeedPostTry` отвечает исходом чтения: null — не прочитали,
 * `{ post }` — прочитали. Экран отличает третий случай, `planComposeRestore`
 * отвечает на него `defer`, и тогда не делается НИЧЕГО: черновик остаётся на
 * диске, композер не открывается, человеку говорят правду. Следующий запуск
 * спросит базу снова.
 *
 * ГРАНИЦЫ. Композер не открывается и правкой тоже — неизвестно, что правим.
 * Открыть его новой публикацией нельзя тем более: запрет из v4.32.333 (правка
 * не должна превращаться в рассылку не спрошенного) здесь в полной силе.
 * Прочитанное отсутствие записи по-прежнему выбрасывает черновик — это не
 * изменилось.
 */
import io from 'fs';
import path from 'path';

jest.mock('../../transport/ipfs/pubsub', () => ({
  pubsubSubscribe: jest.fn(),
  pubsubPublish: jest.fn(),
}));

let mockGetPostThrows = false;
const mockRows: Record<string, { id: string } | undefined> = {};

jest.mock('../../storage/feedStorage', () => ({
  deleteFeedDbForProfile: jest.fn(async () => undefined),
  FeedStorage: class {
    async init(): Promise<void> { /* база в тесте не нужна */ }
    async getPost(id: string): Promise<{ id: string } | null> {
      if (mockGetPostThrows) throw new Error('database is locked');
      return mockRows[id] ?? null;
    }
  },
}));

import { planComposeRestore } from '../composeDraft';
import { getFeedPost, getFeedPostTry, setFeedProfileContext } from '../feedService';

const ROOT = path.resolve(__dirname, '../../../..');

function read(rel: string): string {
  return io.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Комментарии не доказательство: пины смотрят только на код. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

beforeAll(async () => { await setFeedProfileContext(1); });
beforeEach(() => {
  mockGetPostThrows = false;
  for (const k of Object.keys(mockRows)) delete mockRows[k];
});

describe('чтение одной записи отвечает исходом', () => {
  it('база не ответила — null, а не «записи нет»', async () => {
    mockGetPostThrows = true;
    await expect(getFeedPostTry('post-1')).resolves.toBeNull();
  });

  it('прочитали и записи нет — это другой ответ', async () => {
    await expect(getFeedPostTry('post-1')).resolves.toEqual({ post: null });
  });

  it('прочитали и запись есть — она же и возвращается', async () => {
    mockRows['post-1'] = { id: 'post-1' };
    await expect(getFeedPostTry('post-1')).resolves.toEqual({ post: { id: 'post-1' } });
  });

  it('ГРАНИЦА: прежний getFeedPost остался и отвечает как раньше', async () => {
    mockRows['post-2'] = { id: 'post-2' };
    await expect(getFeedPost('post-2')).resolves.toEqual({ id: 'post-2' });
    mockGetPostThrows = true;
    await expect(getFeedPost('post-2')).resolves.toBeNull();
  });
});

describe('план восстановления', () => {
  it('непрочитанная запись — отложить, а не выбросить', () => {
    const plan = planComposeRestore({ editingPostId: 'post-1', editTarget: 'unreadable' });
    expect(plan).toEqual({ kind: 'defer', reason: 'edit_target_unreadable' });
  });

  it('и тем более не открывать новой публикацией', () => {
    const plan = planComposeRestore({ editingPostId: 'post-1', editTarget: 'unreadable' });
    expect(plan.kind).not.toBe('new');
    expect(plan.kind).not.toBe('discard');
  });

  it('ГРАНИЦА: прочитанное отсутствие по-прежнему выбрасывает черновик', () => {
    expect(planComposeRestore({ editingPostId: 'post-1', editTarget: 'gone' })).toEqual({
      kind: 'discard',
      reason: 'edit_target_gone',
    });
  });

  it('ГРАНИЦА: найденная запись по-прежнему открывается правкой', () => {
    expect(planComposeRestore({ editingPostId: 'post-1', editTarget: 'found' })).toEqual({
      kind: 'edit',
      postId: 'post-1',
    });
  });

  it('ГРАНИЦА: без идентификатора правки исход чтения ничего не решает', () => {
    for (const t of ['found', 'gone', 'unreadable'] as const) {
      expect(planComposeRestore({ editingPostId: null, editTarget: t }).kind).toBe('new');
    }
  });
});

describe('экран ленты спрашивает исходом', () => {
  const screen = codeOnly(read('src/ui/screens/FeedScreen.tsx'));
  const body = screen.slice(
    screen.indexOf('await loadComposeDraft(did)'),
    screen.indexOf("log.warn('ui_feed_compose_recover_failed'"),
  );

  it('восстановление берёт различающее чтение', () => {
    expect(body).toContain('await getFeedPostTry(snap.editingPostId)');
    expect(body).not.toContain('editTargetExists');
  });

  it('третий исход доводится до плана, а не сводится к двум', () => {
    expect(body).toContain("'unreadable'");
  });

  it('отложенный черновик с диска не стирается', () => {
    const defer = body.indexOf("plan.kind === 'defer'");
    const wipe = body.indexOf('clearPersistedComposeDraft(did)');
    expect(defer).toBeGreaterThan(0);
    expect(wipe).toBeGreaterThan(0);
    // Ветка `defer` возвращается раньше единственного стирания.
    expect(defer).toBeLessThan(wipe);
    expect(body.slice(defer, wipe)).toContain('return;');
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: прочитанное отсутствие черновик всё так же стирает', () => {
    const discard = body.indexOf("plan.kind === 'discard'");
    expect(discard).toBeGreaterThan(0);
    expect(body.slice(discard, discard + 320)).toContain('clearPersistedComposeDraft(did)');
  });
});

describe('слова на экране', () => {
  const ru = JSON.parse(read('src/i18n/ru.json')) as { feed: Record<string, string> };

  it('про непрочитанное говорится отдельно и не про удаление', () => {
    const text = ru.feed.editTargetUnreadable;
    expect(typeof text).toBe('string');
    expect(text).not.toContain('удалил');
    expect(text.length).toBeGreaterThan(20);
  });

  it('ГРАНИЦА: прежняя строка про удалённую запись на месте', () => {
    expect(ru.feed.editTargetGone).toContain('удалили');
  });
});
