/**
 * Черновик публикации (v4.32.292).
 *
 * Проверяется три вещи: черновик лежит шифртекстом, лежит в namespace своего
 * профиля (и потому исчезает вместе с ним), а восстановленный снимок не может
 * выйти за границы интерфейса — запись kv могли подменить.
 */
jest.mock('../../storage/local', () => {
  const kv: Record<string, string> = {};
  const PREFIX = 'enc2:';
  return {
    __kv: kv,
    kvGet: jest.fn(async (k: string) => kv[k] ?? null),
    kvSet: jest.fn(async (k: string, v: string) => { kv[k] = v; }),
    kvDelete: jest.fn(async (k: string) => { delete kv[k]; }),
    // Шифрование в тесте изображается base64 под тем же префиксом `enc2:`:
    // криптографии здесь не проверяют, но текст в kv не должен читаться —
    // иначе проверка «не лежит открытым» проверяла бы саму заглушку.
    kvGetSecret: jest.fn(async (k: string) => {
      const v = kv[k];
      if (v == null || !v.startsWith(PREFIX)) return null;
      try {
        return Buffer.from(v.slice(PREFIX.length), 'base64').toString('utf8');
      } catch {
        return null;
      }
    }),
    kvSetSecret: jest.fn(async (k: string, v: string) => {
      kv[k] = PREFIX + Buffer.from(v, 'utf8').toString('base64');
    }),
  };
});

let mockProfiles: Array<{ id: number; did: string }> = [];
let mockActiveId = 1;
jest.mock('../../identity/profileManager', () => ({
  profileManager: {
    getActiveProfile: () => mockProfiles.find((p) => p.id === mockActiveId) ?? null,
    getAllProfiles: () => mockProfiles,
  },
}));

import {
  COMPOSE_DRAFT_TTL_MS,
  FEED_MAX_DOC_BYTES,
  FEED_MAX_IMAGES,
  FEED_MAX_DOCS,
  FEED_POLL_MAX_OPTIONS,
  type ComposeDraft,
  clearComposeDraft,
  deleteLegacyComposeDraft,
  loadComposeDraft,
  parseComposeDraft,
  planComposeRestore,
  saveComposeDraft,
  selectComposeDocs,
} from '../composeDraft';

const mockLocal = jest.requireMock('../../storage/local') as {
  __kv: Record<string, string>;
  kvSet: jest.Mock;
};

const DID_A = 'did:key:zAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const DID_B = 'did:key:zBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const EMPTY: ComposeDraft = {
  draft: '',
  uris: [],
  pickedDocs: [],
  postLocationTag: null,
  isPollMode: false,
  pollQuestion: '',
  pollOptions: ['', ''],
  editingPostId: null,
};

function legacyKey(did: string): string {
  return `feed_compose_pending:${did}`;
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(mockLocal.__kv)) delete mockLocal.__kv[k];
  mockProfiles = [{ id: 1, did: DID_A }, { id: 2, did: DID_B }];
  mockActiveId = 1;
});

describe('черновик публикации принадлежит профилю и лежит шифртекстом', () => {
  it('открытым текстом в базе его нет', async () => {
    await saveComposeDraft(DID_A, { ...EMPTY, draft: 'секретная мысль' });
    const stored = mockLocal.__kv['p1:feed_compose_pending'];
    expect(stored).toBeDefined();
    expect(stored).not.toContain('секретная мысль');
    // Открытый kv-писатель к черновику не прикасается вовсе.
    expect(mockLocal.kvSet).not.toHaveBeenCalled();
    expect((await loadComposeDraft(DID_A))?.draft).toBe('секретная мысль');
  });

  it('второй профиль не видит черновик первого', async () => {
    await saveComposeDraft(DID_A, { ...EMPTY, draft: 'моё' });
    mockActiveId = 2;
    expect(await loadComposeDraft(DID_B)).toBeNull();
  });

  it('ключ попадает под уборку профиля', async () => {
    mockActiveId = 2;
    await saveComposeDraft(DID_B, { ...EMPTY, draft: 'моё' });
    expect(Object.keys(mockLocal.__kv).every((k) => k.startsWith('p2:'))).toBe(true);
  });

  it('чужой did никуда не пишется', async () => {
    // Профиля с таким did на устройстве нет: подставить первый значило бы
    // сложить черновики разных аккаунтов в одно место.
    await saveComposeDraft('did:key:zZZZ', { ...EMPTY, draft: 'ничей' });
    expect(Object.keys(mockLocal.__kv)).toEqual([]);
  });

  it('после отправки черновика не остаётся', async () => {
    await saveComposeDraft(DID_A, { ...EMPTY, draft: 'опубликовал' });
    await clearComposeDraft(DID_A);
    expect(mockLocal.__kv['p1:feed_compose_pending']).toBeUndefined();
    expect(await loadComposeDraft(DID_A)).toBeNull();
  });
});

describe('черновик из версий до v4.32.292', () => {
  it('поднимается и стирается — открытый текст не остаётся', async () => {
    mockLocal.__kv[legacyKey(DID_A)] = JSON.stringify({ draft: 'старое', ts: Date.now() });
    expect((await loadComposeDraft(DID_A))?.draft).toBe('старое');
    expect(mockLocal.__kv[legacyKey(DID_A)]).toBeUndefined();
  });

  it('стирается, даже если свой черновик уже есть', async () => {
    await saveComposeDraft(DID_A, { ...EMPTY, draft: 'новое' });
    mockLocal.__kv[legacyKey(DID_A)] = JSON.stringify({ draft: 'старое', ts: Date.now() });
    expect((await loadComposeDraft(DID_A))?.draft).toBe('новое');
    expect(mockLocal.__kv[legacyKey(DID_A)]).toBeUndefined();
  });

  it('убирается вместе с удалённым профилем', async () => {
    mockLocal.__kv[legacyKey(DID_B)] = JSON.stringify({ draft: 'удаляемого', ts: Date.now() });
    await deleteLegacyComposeDraft(DID_B);
    expect(mockLocal.__kv[legacyKey(DID_B)]).toBeUndefined();
  });
});

describe('снимок разбирается в границах интерфейса', () => {
  const now = 1_700_000_000_000;

  it('протухший не восстанавливается', () => {
    const stale = JSON.stringify({ draft: 'вчерашнее', ts: now - COMPOSE_DRAFT_TTL_MS - 1 });
    expect(parseComposeDraft(stale, now)).toBeNull();
    const fresh = JSON.stringify({ draft: 'свежее', ts: now - 1000 });
    expect(parseComposeDraft(fresh, now)?.draft).toBe('свежее');
  });

  it('без метки времени не восстанавливается', () => {
    expect(parseComposeDraft(JSON.stringify({ draft: 'без ts' }), now)).toBeNull();
  });

  it('мусор не роняет вызывающего', () => {
    expect(parseComposeDraft('не json', now)).toBeNull();
    expect(parseComposeDraft('[1,2,3]', now)).toBeNull();
    expect(parseComposeDraft('null', now)).toBeNull();
    expect(parseComposeDraft('42', now)).toBeNull();
    expect(parseComposeDraft('', now)).toBeNull();
    expect(parseComposeDraft(null, now)).toBeNull();
  });

  it('битую запись убирает за собой', async () => {
    mockLocal.__kv['p1:feed_compose_pending'] = `enc2:${Buffer.from('не json', 'utf8').toString('base64')}`;
    expect(await loadComposeDraft(DID_A)).toBeNull();
    expect(mockLocal.__kv['p1:feed_compose_pending']).toBeUndefined();
  });

  it('раздутые поля обрезаются до лимитов', () => {
    const snap = parseComposeDraft(JSON.stringify({
      ts: now,
      draft: 'я'.repeat(50_000),
      uris: Array.from({ length: 200 }, (_, i) => `file://${i}`),
      pickedDocs: Array.from({ length: 50 }, (_, i) => ({ uri: `file://d${i}`, name: 'a', mime: 'text/plain' })),
      pollOptions: Array.from({ length: 50 }, (_, i) => `вариант ${i}`),
    }), now);
    expect(snap!.draft.length).toBe(8192);
    expect(snap!.uris.length).toBe(FEED_MAX_IMAGES);
    expect(snap!.pickedDocs.length).toBe(FEED_MAX_DOCS);
    expect(snap!.pollOptions.length).toBe(FEED_POLL_MAX_OPTIONS);
  });

  it('поля чужого типа не доходят до интерфейса', () => {
    const snap = parseComposeDraft(JSON.stringify({
      ts: now,
      draft: { нет: 'строки' },
      uris: ['file://ok', 42, null, { a: 1 }],
      pickedDocs: ['строка вместо документа', { name: 'без uri' }, null],
      postLocationTag: 12,
      isPollMode: 'да',
      pollQuestion: ['массив'],
      editingPostId: 7,
    }), now);
    expect(snap!.draft).toBe('');
    expect(snap!.uris).toEqual(['file://ok']);
    expect(snap!.pickedDocs).toEqual([]);
    expect(snap!.postLocationTag).toBeNull();
    expect(snap!.isPollMode).toBe(false);
    expect(snap!.pollQuestion).toBe('');
    expect(snap!.editingPostId).toBeNull();
  });

  it('вариантов опроса всегда не меньше двух', () => {
    const snap = parseComposeDraft(JSON.stringify({ ts: now, pollOptions: ['один'] }), now);
    expect(snap!.pollOptions).toEqual(['один', '']);
  });

  it('документ доезжает целиком, размер — только числом', () => {
    const snap = parseComposeDraft(JSON.stringify({
      ts: now,
      pickedDocs: [
        { uri: 'file://a.pdf', name: 'договор.pdf', mime: 'application/pdf', size: 1234 },
        { uri: 'file://b.pdf', name: 'b', mime: 'application/pdf', size: 'много' },
      ],
    }), now);
    expect(snap!.pickedDocs[0]).toEqual({ uri: 'file://a.pdf', name: 'договор.pdf', mime: 'application/pdf', size: 1234 });
    expect(snap!.pickedDocs[1]).not.toHaveProperty('size');
  });
});

describe('отбор документов из ответа picker\'а (v4.32.321)', () => {
  const doc = (name: string, size: number) => ({
    uri: `file://${name}`,
    name,
    mimeType: 'application/pdf',
    size,
  });

  it('обычный выбор — берётся всё', () => {
    const res = selectComposeDocs([doc('a.pdf', 1000), doc('b.pdf', 2000)], 0);
    expect(res.picked).toEqual([
      { uri: 'file://a.pdf', name: 'a.pdf', mime: 'application/pdf', size: 1000 },
      { uri: 'file://b.pdf', name: 'b.pdf', mime: 'application/pdf', size: 2000 },
    ]);
    expect(res.tooBig).toBe(0);
    expect(res.noRoom).toBe(0);
  });

  it('тяжёлый файл не берётся и назван отдельной причиной', () => {
    const res = selectComposeDocs([doc('big.pdf', FEED_MAX_DOC_BYTES + 1), doc('ok.pdf', 10)], 0);
    expect(res.picked.map((d) => d.uri)).toEqual(['file://ok.pdf']);
    expect(res.tooBig).toBe(1);
    expect(res.noRoom).toBe(0);
  });

  it('ровно по границе — ещё берётся', () => {
    const res = selectComposeDocs([doc('edge.pdf', FEED_MAX_DOC_BYTES)], 0);
    expect(res.picked).toHaveLength(1);
    expect(res.tooBig).toBe(0);
  });

  it('лишние сверх предела не пропадают молча', () => {
    const many = Array.from({ length: FEED_MAX_DOCS + 2 }, (_, i) => doc(`d${i}.pdf`, 10));
    const res = selectComposeDocs(many, 0);
    expect(res.picked).toHaveLength(FEED_MAX_DOCS);
    expect(res.noRoom).toBe(2);
  });

  it('места считаются с учётом уже приложенного', () => {
    const res = selectComposeDocs([doc('a.pdf', 10), doc('b.pdf', 10)], FEED_MAX_DOCS - 1);
    expect(res.picked).toHaveLength(1);
    expect(res.noRoom).toBe(1);
  });

  it('мест не осталось — не берём ничего', () => {
    const res = selectComposeDocs([doc('a.pdf', 10)], FEED_MAX_DOCS);
    expect(res.picked).toEqual([]);
    expect(res.noRoom).toBe(1);
  });

  it('безымянный файл получает имя и тип, ответ не того вида — пустой отбор', () => {
    const res = selectComposeDocs([{ uri: 'file://x' }, { name: 'без uri' }, null, 'строка'], 0);
    expect(res.picked).toEqual([
      { uri: 'file://x', name: 'document', mime: 'application/octet-stream', size: 0 },
    ]);
    expect(selectComposeDocs(null, 0)).toEqual({ picked: [], tooBig: 0, noRoom: 0 });
  });

  it('размер неизвестен — файл всё равно берётся', () => {
    // DocumentPicker на части устройств не отдаёт size для content://-ссылок.
    // Считать такой файл тяжёлым нельзя: он просто неизмерен.
    const res = selectComposeDocs([{ uri: 'content://doc', name: 'x.pdf' }], 0);
    expect(res.picked).toHaveLength(1);
    expect(res.tooBig).toBe(0);
  });
});

/**
 * v4.32.333. Правка не должна превращаться в публикацию — вся суть этой части.
 * Композер после восстановления выглядит одинаково в обоих режимах, отличается
 * только надпись на кнопке, поэтому промах здесь человек замечает уже после
 * того, как вторая копия записи ушла всем контактам.
 */
describe('planComposeRestore', () => {
  it('обычный черновик восстанавливается как новая публикация', () => {
    expect(planComposeRestore({ editingPostId: null, editTargetExists: false })).toEqual({
      kind: 'new',
    });
  });

  it('правка возвращается правкой той же записи', () => {
    expect(planComposeRestore({ editingPostId: 'post-1', editTargetExists: true })).toEqual({
      kind: 'edit',
      postId: 'post-1',
    });
  });

  it('исчезнувшая запись — черновик выбрасывается, а НЕ публикуется заново', () => {
    const plan = planComposeRestore({ editingPostId: 'post-1', editTargetExists: false });
    expect(plan).toEqual({ kind: 'discard', reason: 'edit_target_gone' });
    // Ровно то, чего быть не должно: молчаливый переход в режим публикации.
    expect(plan.kind).not.toBe('new');
  });

  it('пустая строка идентификатора не считается правкой', () => {
    expect(planComposeRestore({ editingPostId: '', editTargetExists: false }).kind).toBe('new');
  });
});
