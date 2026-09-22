/**
 * Поток «ссылка на публикацию» — поведение, а не текст исходника (AC-04, AC-17, AC-18).
 *
 * Копия записи для ссылки лежит на сервере без шифрования. Поэтому проверяется
 * то, что видит человек и что уходит наружу: без подтверждения ничего не
 * публикуется, ссылка отдаётся только после ответа сервера, при отказе не
 * отдаётся ничего, двойное нажатие не шлёт копию дважды, отзыв снимает статус.
 */
import { createPostLinkFlow, type PostLinkFlowDeps, type PostLinkTarget } from '../postLinkFlow';

const URL = 'https://airchat.example/l/post/p1';

/** Обещание, которое тест завершает сам, — чтобы проверить порядок событий. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function makeDeps(over: Partial<PostLinkFlowDeps> = {}) {
  const events: string[] = [];
  const deps = {
    canPublish: jest.fn(() => true),
    confirmPublish: jest.fn(async () => { events.push('confirm'); return true; }),
    confirmRevoke: jest.fn(async () => { events.push('confirmRevoke'); return true; }),
    publish: jest.fn(async (id: string) => { events.push(`publish:${id}`); return true; }),
    revoke: jest.fn(async (id: string) => { events.push(`revoke:${id}`); return true; }),
    copy: jest.fn(async (text: string) => { events.push(`copy:${text}`); }),
    share: jest.fn(async (message: string) => { events.push(`share:${message}`); }),
    onBusyChange: jest.fn((id: string, busy: boolean) => { events.push(`busy:${id}:${busy}`); }),
    onPublishedChange: jest.fn((id: string, published: boolean) => { events.push(`published:${id}:${published}`); }),
    ...over,
  };
  return { deps, events };
}

const own = (published = false): PostLinkTarget => ({ postId: 'p1', own: true, published });
const foreign: PostLinkTarget = { postId: 'p1', own: false, published: false };

describe('копирование ссылки на свою неопубликованную запись', () => {
  it('сначала подтверждение, затем публикация, и только потом буфер обмена', async () => {
    const { deps, events } = makeDeps();
    const flow = createPostLinkFlow(deps);
    const outcome = await flow.copyLink(own(), URL);
    expect(outcome).toEqual({ kind: 'done', reach: 'public', justPublished: true });
    expect(events).toEqual([
      'confirm',
      'busy:p1:true',
      'publish:p1',
      'busy:p1:false',
      'published:p1:true',
      `copy:${URL}`,
    ]);
  });

  it('ссылка не попадает в буфер, пока сервер не ответил', async () => {
    const reply = deferred<boolean>();
    const { deps } = makeDeps({ publish: jest.fn(() => reply.promise) });
    const flow = createPostLinkFlow(deps);
    const pending = flow.copyLink(own(), URL);
    await new Promise((r) => setImmediate(r));
    expect(deps.publish).toHaveBeenCalledTimes(1);
    expect(deps.copy).not.toHaveBeenCalled();
    expect(flow.isBusy('p1')).toBe(true);
    reply.resolve(true);
    await pending;
    expect(deps.copy).toHaveBeenCalledWith(URL);
    expect(flow.isBusy('p1')).toBe(false);
  });

  it('отмена подтверждения — нет ни публикации, ни ссылки в буфере', async () => {
    const { deps } = makeDeps({ confirmPublish: jest.fn(async () => false) });
    const flow = createPostLinkFlow(deps);
    expect(await flow.copyLink(own(), URL)).toEqual({ kind: 'cancelled' });
    expect(deps.publish).not.toHaveBeenCalled();
    expect(deps.copy).not.toHaveBeenCalled();
    expect(deps.onPublishedChange).not.toHaveBeenCalled();
  });

  it('отказ сервера — ошибка, буфер не тронут, статус не поставлен', async () => {
    const { deps } = makeDeps({ publish: jest.fn(async () => false) });
    const flow = createPostLinkFlow(deps);
    expect(await flow.copyLink(own(), URL)).toEqual({ kind: 'publishFailed' });
    expect(deps.copy).not.toHaveBeenCalled();
    expect(deps.onPublishedChange).not.toHaveBeenCalled();
    // Индикатор погашен и после отказа.
    expect(deps.onBusyChange).toHaveBeenLastCalledWith('p1', false);
  });

  it('исключение при публикации — тот же отказ, а не «скопировано»', async () => {
    const { deps } = makeDeps({ publish: jest.fn(async () => { throw new Error('net'); }) });
    const flow = createPostLinkFlow(deps);
    expect(await flow.copyLink(own(), URL)).toEqual({ kind: 'publishFailed' });
    expect(deps.copy).not.toHaveBeenCalled();
  });

  it('двойное нажатие — одна публикация и одно копирование', async () => {
    const reply = deferred<boolean>();
    const { deps } = makeDeps({ publish: jest.fn(() => reply.promise) });
    const flow = createPostLinkFlow(deps);
    const first = flow.copyLink(own(), URL);
    const second = await flow.copyLink(own(), URL);
    expect(second).toEqual({ kind: 'busy' });
    reply.resolve(true);
    expect(await first).toEqual({ kind: 'done', reach: 'public', justPublished: true });
    expect(deps.confirmPublish).toHaveBeenCalledTimes(1);
    expect(deps.publish).toHaveBeenCalledTimes(1);
    expect(deps.copy).toHaveBeenCalledTimes(1);
  });

  it('сбой буфера обмена после публикации отличим от отказа сервера', async () => {
    const { deps } = makeDeps({ copy: jest.fn(async () => { throw new Error('clip'); }) });
    const flow = createPostLinkFlow(deps);
    expect(await flow.copyLink(own(), URL)).toEqual({ kind: 'handoffFailed' });
    // Копия легла — и это честно отражено в статусе.
    expect(deps.onPublishedChange).toHaveBeenCalledWith('p1', true);
  });
});

describe('копирование ссылки без публикации', () => {
  it('уже опубликованная запись не выкладывается заново и не спрашивает', async () => {
    const { deps } = makeDeps();
    const flow = createPostLinkFlow(deps);
    expect(await flow.copyLink(own(true), URL)).toEqual({ kind: 'done', reach: 'public', justPublished: false });
    expect(deps.confirmPublish).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
    expect(deps.copy).toHaveBeenCalledWith(URL);
  });

  it('чужая запись — ссылка местная, наружу ничего не уходит', async () => {
    const { deps } = makeDeps();
    const flow = createPostLinkFlow(deps);
    expect(await flow.copyLink(foreign, URL)).toEqual({ kind: 'done', reach: 'local', justPublished: false });
    expect(deps.confirmPublish).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it('без облака своя запись тоже не публикуется и не спрашивает', async () => {
    const { deps } = makeDeps({ canPublish: jest.fn(() => false) });
    const flow = createPostLinkFlow(deps);
    expect(await flow.copyLink(own(), URL)).toEqual({ kind: 'done', reach: 'local', justPublished: false });
    expect(deps.confirmPublish).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
  });
});

describe('«Поделиться»', () => {
  it('лист открывается только после публикации', async () => {
    const { deps, events } = makeDeps();
    const flow = createPostLinkFlow(deps);
    await flow.shareLink(own(), 'msg');
    expect(events.indexOf('publish:p1')).toBeLessThan(events.indexOf('share:msg'));
  });

  it('отказ сервера — лист не открывается', async () => {
    const { deps } = makeDeps({ publish: jest.fn(async () => false) });
    const flow = createPostLinkFlow(deps);
    expect(await flow.shareLink(own(), 'msg')).toEqual({ kind: 'publishFailed' });
    expect(deps.share).not.toHaveBeenCalled();
  });

  it('отмена подтверждения — ни копии, ни листа', async () => {
    const { deps } = makeDeps({ confirmPublish: jest.fn(async () => false) });
    const flow = createPostLinkFlow(deps);
    expect(await flow.shareLink(own(), 'msg')).toEqual({ kind: 'cancelled' });
    expect(deps.publish).not.toHaveBeenCalled();
    expect(deps.share).not.toHaveBeenCalled();
  });
});

describe('явное «Опубликовать по ссылке»', () => {
  it('публикует только после подтверждения и ставит статус', async () => {
    const { deps } = makeDeps();
    const flow = createPostLinkFlow(deps);
    expect(await flow.publish(own())).toBe('published');
    expect(deps.confirmPublish).toHaveBeenCalledTimes(1);
    expect(deps.onPublishedChange).toHaveBeenCalledWith('p1', true);
    expect(deps.copy).not.toHaveBeenCalled();
    expect(deps.share).not.toHaveBeenCalled();
  });

  it('отмена — ничего не создано', async () => {
    const { deps } = makeDeps({ confirmPublish: jest.fn(async () => false) });
    const flow = createPostLinkFlow(deps);
    expect(await flow.publish(own())).toBe('cancelled');
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it('чужую запись выложить нельзя', async () => {
    const { deps } = makeDeps();
    const flow = createPostLinkFlow(deps);
    expect(await flow.publish(foreign)).toBe('unavailable');
    expect(deps.confirmPublish).not.toHaveBeenCalled();
  });

  it('уже опубликованную не шлёт повторно', async () => {
    const { deps } = makeDeps();
    const flow = createPostLinkFlow(deps);
    expect(await flow.publish(own(true))).toBe('alreadyPublished');
    expect(deps.publish).not.toHaveBeenCalled();
  });
});

describe('«Отозвать ссылку»', () => {
  it('после подтверждения снимает копию и статус', async () => {
    const { deps, events } = makeDeps();
    const flow = createPostLinkFlow(deps);
    expect(await flow.revoke(own(true))).toBe('revoked');
    expect(events).toEqual(['confirmRevoke', 'busy:p1:true', 'revoke:p1', 'busy:p1:false', 'published:p1:false']);
  });

  it('отмена — копия остаётся', async () => {
    const { deps } = makeDeps({ confirmRevoke: jest.fn(async () => false) });
    const flow = createPostLinkFlow(deps);
    expect(await flow.revoke(own(true))).toBe('cancelled');
    expect(deps.revoke).not.toHaveBeenCalled();
  });

  it('отказ сервера — статус «опубликовано» не снимается', async () => {
    const { deps } = makeDeps({ revoke: jest.fn(async () => false) });
    const flow = createPostLinkFlow(deps);
    expect(await flow.revoke(own(true))).toBe('failed');
    expect(deps.onPublishedChange).not.toHaveBeenCalled();
  });

  it('неопубликованную запись отзывать нечего', async () => {
    const { deps } = makeDeps();
    const flow = createPostLinkFlow(deps);
    expect(await flow.revoke(own(false))).toBe('notPublished');
    expect(deps.confirmRevoke).not.toHaveBeenCalled();
  });

  it('пока идёт публикация, отзыв той же записи не запускается', async () => {
    const reply = deferred<boolean>();
    const { deps } = makeDeps({ publish: jest.fn(() => reply.promise) });
    const flow = createPostLinkFlow(deps);
    const publishing = flow.publish(own());
    expect(await flow.revoke(own(true))).toBe('busy');
    reply.resolve(true);
    expect(await publishing).toBe('published');
    expect(deps.revoke).not.toHaveBeenCalled();
  });
});
