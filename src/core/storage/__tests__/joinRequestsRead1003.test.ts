/**
 * v4.32.1003: «заявок нет» говорилось и тогда, когда заявки не смогли
 * прочитать.
 *
 * Дефект. `listGroupJoinRequests` и `countPendingJoinRequests` бросают —
 * и это правильно. Но оба зовут с экрана через `void ... .then(...)` без
 * `.catch`: обещание падало в пустоту, счётчик оставался нулём, список —
 * прежним. А обе кнопки заявок нарисованы по условию «больше нуля»: метка на
 * кнопке участников в чате группы и сама кнопка «Заявки на вступление» в
 * составе. На отказе чтения они не блёкли и не пустели — они исчезали.
 *
 * Цена. Заявка приходит от другого человека и ждёт ответа. Администратор не
 * узнавал ни про заявки, ни про то, что их не прочитали: экран выглядел ровно
 * как у группы, в которую никто не просился. С той стороны человек в это
 * время стоит у закрытой двери и ждёт — а по закрытой группе иначе войти
 * нельзя. Ошибка молчит и сама не проходит: `useEffect` привязан к
 * `[amAdmin, group.id, pid]`, и повторно он не сработает, пока экран не
 * пересоздадут.
 *
 * Правка. `listGroupJoinRequestsRead` и `countPendingJoinRequestsRead`:
 * список/число либо `null` — «не прочитали». Кнопки видны и в этом случае, на
 * метке стоит «?», а под пустым списком — «Заявки не удалось прочитать».
 *
 * Границы. Прочитанное «заявок нет» по-прежнему ноль, по-прежнему без кнопки:
 * это правда, и она не изменилась. Бросающие имена остались на месте — по ним
 * ходит приём заявок, которому пустота не годится.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Строки group_join_requests, какими их видит запрос. */
let mockReqRows: Array<Record<string, unknown>> = [];
/** Чтение списка отказывает. */
let mockListFails = false;
/** Чтение счётчика отказывает. */
let mockCountFails = false;
/** Сколько ждущих заявок отдаёт COUNT(*). */
let mockCount = 0;

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => undefined),
    runAsync: jest.fn(async () => ({ changes: 1, lastInsertRowId: 1 })),
    getAllAsync: jest.fn(async (sql: string) => {
      if (/FROM group_join_requests/i.test(sql)) {
        if (mockListFails) throw new Error('disk i/o error');
        return mockReqRows;
      }
      return [];
    }),
    getFirstAsync: jest.fn(async (sql: string) => {
      if (/COUNT\(\*\) as cnt FROM group_join_requests/i.test(sql)) {
        if (mockCountFails) throw new Error('disk i/o error');
        return { cnt: mockCount };
      }
      return null;
    }),
    withTransactionAsync: jest.fn(async (fn: () => Promise<void>) => fn()),
    closeAsync: jest.fn(async () => undefined),
  })),
  deleteDatabaseAsync: jest.fn(async () => undefined),
}));

jest.mock('../secureStoreQueued', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

jest.mock('../localEncryption', () => {
  const { classifyAtRestCell } = jest.requireActual('../atRestCell');
  const decode = (v: string): string | null => (v.startsWith('enc2:') ? v.slice('enc2:'.length) : v);
  return {
    AT_REST_PREFIX: 'enc2:',
    AT_REST_COLUMNS: [],
    DEK_KEY: 'dek',
    getOrCreateDataEncryptionKey: jest.fn(async () => new Uint8Array(32)),
    encryptAtRestString: jest.fn((v: string) => `enc2:${v}`),
    encryptAtRestNullable: jest.fn((v: string | null) => (v == null ? null : `enc2:${v}`)),
    encryptAtRestIfPlain: jest.fn((v: string | null) => v),
    decryptAtRestString: jest.fn((v: string) => decode(v) ?? ''),
    decryptAtRestNullable: jest.fn((v: string | null) => (v == null ? null : decode(v) ?? '')),
    tryDecryptAtRest: jest.fn((v: string) => decode(v)),
    readAtRestCell: jest.fn((v: string | null) =>
      v === null ? classifyAtRestCell(null, null) : classifyAtRestCell(v, decode(v))
    ),
    canaryOpensWith: jest.fn(async () => true),
    persistDek: jest.fn(async () => undefined),
    isAtRestCiphertext: jest.fn((v: unknown) => typeof v === 'string' && v.startsWith('enc2:')),
    resetDataEncryptionKeyCache: jest.fn(),
  };
});

/** Строка заявки, как её отдаёт запрос. */
function reqRow(id: string, name: string): Record<string, unknown> {
  return {
    id, group_id: 'grp-12345678', requester_pub_b64: 'peerAAAAAAAA',
    requester_name: `enc2:${name}`, message: null, status: 'pending',
    owner_profile_id: 1, created_at: 1700000000000,
  };
}

const src = (rel: string): string => fs.readFileSync(path.join(__dirname, '..', '..', '..', rel), 'utf8');

/** Только код: закомментированное объяснение не должно закрывать собой пин. */
function codeOnly(text: string): string {
  return text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

/** Одно место файла — чтобы совпадение не прилетело от соседа. */
function slice(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  expect(a).toBeGreaterThanOrEqual(0);
  const b = text.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return text.slice(a, b);
}

beforeEach(() => {
  mockReqRows = [];
  mockListFails = false;
  mockCountFails = false;
  mockCount = 0;
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: чтение заявок работает', () => {
  it('список заявок читается', async () => {
    const { listGroupJoinRequests } = await import('../local');
    mockReqRows = [reqRow('r1', 'Аня')];
    const reqs = await listGroupJoinRequests('grp-12345678', 1, 'pending');
    expect(reqs).toHaveLength(1);
    expect(reqs[0].requesterName).toBe('Аня');
  });

  it('счётчик читается', async () => {
    const { countPendingJoinRequests } = await import('../local');
    mockCount = 3;
    expect(await countPendingJoinRequests('grp-12345678', 1)).toBe(3);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: прежние имена по-прежнему бросают', () => {
  it('list бросает, а не отдаёт пустоту', async () => {
    const { listGroupJoinRequests } = await import('../local');
    mockListFails = true;
    await expect(listGroupJoinRequests('grp-12345678', 1, 'pending')).rejects.toThrow();
  });

  it('count бросает, а не отдаёт ноль', async () => {
    const { countPendingJoinRequests } = await import('../local');
    mockCountFails = true;
    await expect(countPendingJoinRequests('grp-12345678', 1)).rejects.toThrow();
  });
});

describe('третий исход у обоих чтений', () => {
  it('список не прочитался — null, а не пустой массив', async () => {
    const { listGroupJoinRequestsRead } = await import('../local');
    mockListFails = true;
    expect(await listGroupJoinRequestsRead('grp-12345678', 1, 'pending')).toBeNull();
  });

  it('счётчик не прочитался — null, а не ноль', async () => {
    const { countPendingJoinRequestsRead } = await import('../local');
    mockCountFails = true;
    expect(await countPendingJoinRequestsRead('grp-12345678', 1)).toBeNull();
  });
});

describe('ГРАНИЦА: честная пустота осталась пустотой', () => {
  it('заявок нет — пустой список, а не null', async () => {
    const { listGroupJoinRequestsRead } = await import('../local');
    expect(await listGroupJoinRequestsRead('grp-12345678', 1, 'pending')).toEqual([]);
  });

  it('заявок нет — ноль, а не null', async () => {
    const { countPendingJoinRequestsRead } = await import('../local');
    expect(await countPendingJoinRequestsRead('grp-12345678', 1)).toBe(0);
  });

  it('заявки есть — те же строки, что у прежнего имени', async () => {
    const { listGroupJoinRequestsRead } = await import('../local');
    mockReqRows = [reqRow('r1', 'Аня'), reqRow('r2', 'Боря')];
    const reqs = await listGroupJoinRequestsRead('grp-12345678', 1, 'pending');
    expect(reqs?.map((r) => r.requesterName)).toEqual(['Аня', 'Боря']);
  });
});

describe('экран больше не прячет кнопки на отказе чтения', () => {
  const screen = (): string => codeOnly(src('ui/screens/GroupsScreen.tsx'));

  it('счётчик в чате читается через трёхсостоятельное имя', () => {
    const s = screen();
    expect(s).toContain('countPendingJoinRequestsRead(group.id, pid).then((n) => {');
    expect(s).not.toContain('void countPendingJoinRequests(group.id, pid).then(setPendingJoinCount);');
  });

  it('список в составе читается через трёхсостоятельное имя', () => {
    const s = screen();
    expect(s).toContain("await listGroupJoinRequestsRead(group.id, pid, 'pending')");
    expect(s).not.toContain("await listGroupJoinRequests(group.id, pid, 'pending')");
  });

  it('метка в чате видна и при неизвестном числе', () => {
    const s = screen();
    expect(s).toContain('amAdmin && (pendingJoinUnknown || pendingJoinCount > 0)');
  });

  it('кнопка заявок видна и при непрочитанном списке', () => {
    const s = screen();
    expect(s).toContain('amAdmin && (joinReqUnreadable || pendingCount > 0)');
  });

  it('на неизвестном числе метка показывает знак вопроса, а не ноль', () => {
    const s = screen();
    expect(s).toContain("pendingJoinUnknown ? '?' : badgeText(pendingJoinCount, SMALL_BADGE_MAX)");
    expect(s).toContain("joinReqUnreadable ? '?' : badgeText(pendingCount, SMALL_BADGE_MAX)");
  });

  it('непрочитанный список не затирает показанный', () => {
    const body = slice(screen(), 'const loadJoinRequests = useCallback', '}, [amAdmin, group.id, pid]);');
    expect(body).toContain('setJoinReqUnreadable(reqs === null);');
    expect(body).toContain('if (reqs !== null) setJoinRequests(reqs);');
  });
});

describe('окно заявок отличает пустоту от непрочитанного', () => {
  const modal = (): string => codeOnly(src('ui/components/modals/groups/GroupJoinRequestsModal.tsx'));

  it('окно знает про непрочитанный список', () => {
    const m = modal();
    expect(m).toContain('unreadable?: boolean;');
    expect(m).toContain('joinRequests, unreadable, onApprove, onReject }: GroupJoinRequestsModalProps');
  });

  it('под пустым списком стоит пометка, а не «Нет запросов»', () => {
    const m = modal();
    expect(m).toContain('UNREADABLE_JOIN_REQUESTS_TEXT');
    expect(m).toContain('Нет запросов');
    const empty = slice(m, 'ListEmptyComponent=', 'style={{ maxHeight: 400 }}');
    expect(empty).toContain('unreadable ?');
    expect(empty).toContain('UNREADABLE_JOIN_REQUESTS_TEXT');
  });

  it('заголовок не обещает точное число, когда списка нет', () => {
    const m = modal();
    expect(m).toContain("unreadable ? 'Запросы на вступление' : `Запросы на вступление (${pendingCount})`");
  });

  it('экран передаёт признак в окно', () => {
    expect(codeOnly(src('ui/screens/GroupsScreen.tsx'))).toContain('unreadable={joinReqUnreadable}');
  });
});

describe('пометка живёт рядом с остальными', () => {
  it('строка заведена в unreadableText', () => {
    const t = src('core/storage/unreadableText.ts');
    expect(t).toContain("export const UNREADABLE_JOIN_REQUESTS_TEXT = 'Заявки не удалось прочитать';");
  });
});
