/**
 * Правка ленты либо доходит до базы, либо об этом говорят (v4.32.534).
 *
 * `editFeedPost` возвращалась обычным способом, когда записи уже нет или она
 * чужая: экран не мог отличить это от успеха — закрывал редактор, стирал
 * черновик и перечитывал ленту, а текст оставался прежним.
 *
 * Рядом жила та же беда без типов: пункты меню публикации («Скрыть автора»,
 * «Отключить уведомления», «Удалить») висели как обещание без `.catch`, голос
 * в опросе писался в базу без перехвата, отказ перевода лента проглатывала
 * молча (чат и группы о нём говорили), а лист пересылки при сбое чтения
 * навсегда оставался с надписью «Загрузка…» — как и у человека, у которого
 * просто нет ни одного контакта.
 *
 * Здесь рэтчет на то, что все пять мест пользуются одним входом, а не заводят
 * шестую копию try/catch.
 */
jest.mock('../../../core/transport/ipfs/pubsub', () => ({
  pubsubSubscribe: jest.fn(),
  pubsubPublish: jest.fn(),
}));
jest.mock('../../../core/transport/multiTransport', () => ({
  multiTransportRouter: { send: jest.fn(async () => undefined) },
}));
jest.mock('../../../core/social/contacts', () => ({ listContacts: jest.fn(async () => []) }));
jest.mock('../../../core/social/mutedAuthors', () => ({ isAuthorMuted: jest.fn(async () => false) }));

const mockPosts = new Map<string, { id: string; authorDid: string; text: string }>();
const mockUpdated: { id: string; text: string }[] = [];

jest.mock('../../../core/storage/feedStorage', () => ({
  deleteFeedDbForProfile: jest.fn(async () => undefined),
  FeedStorage: class {
    async init(): Promise<void> { /* база в тесте не нужна */ }
    async getPost(id: string): Promise<unknown> { return mockPosts.get(id) ?? null; }
    async updatePostText(id: string, text: string): Promise<void> { mockUpdated.push({ id, text }); }
  },
}));

import fs from 'fs';
import path from 'path';

import { ed25519 } from '@noble/curves/ed25519.js';

import { publicKeyToDidKey } from '../../../core/identity/did';
import { editFeedPost, setFeedProfileContext } from '../../../core/social/feedService';

const SCREEN = fs.readFileSync(path.join(__dirname, '..', 'FeedScreen.tsx'), 'utf8');
const SERVICE = fs.readFileSync(path.join(
  __dirname, '..', '..', '..', 'core', 'social', 'feedService.ts'), 'utf8');
const RU = JSON.parse(fs.readFileSync(path.join(
  __dirname, '..', '..', '..', 'i18n', 'ru.json'), 'utf8')) as { feed: Record<string, string> };

const keys = ed25519.keygen();
const pair = { secretKey: keys.secretKey, publicKey: keys.publicKey };
const myDid = publicKeyToDidKey(keys.publicKey);
const otherDid = publicKeyToDidKey(ed25519.keygen().publicKey);

beforeAll(async () => { await setFeedProfileContext(1); });
beforeEach(() => { mockPosts.clear(); mockUpdated.length = 0; });

describe('правка записи: отказ выглядит как отказ', () => {
  it('исчезнувшая запись — отказ, а не тихий возврат', async () => {
    await expect(editFeedPost(pair, 'нет-такой', 'новый текст')).rejects.toThrow();
  });

  it('чужая запись — отказ', async () => {
    mockPosts.set('p1', { id: 'p1', authorDid: otherDid, text: 'чужое' });
    await expect(editFeedPost(pair, 'p1', 'новый текст')).rejects.toThrow();
    expect(mockUpdated).toHaveLength(0);
  });

  it('пустой текст отклоняется до обращения к базе', async () => {
    await expect(editFeedPost(pair, 'p1', '   ')).rejects.toThrow();
    expect(mockUpdated).toHaveLength(0);
  });

  it('своя запись — текст доходит до базы', async () => {
    mockPosts.set('p2', { id: 'p2', authorDid: myDid, text: 'старое' });
    await editFeedPost(pair, 'p2', 'новое');
    expect(mockUpdated).toEqual([{ id: 'p2', text: 'новое' }]);
  });

  it('в исходнике не осталось тихого возврата из ветвей отказа', () => {
    const start = SERVICE.indexOf('export async function editFeedPost(');
    expect(start).toBeGreaterThan(-1);
    const rest = SERVICE.slice(start + 10);
    const end = rest.indexOf('\nexport ');
    const body = end === -1 ? rest : rest.slice(0, end);
    expect(body).toContain("throw new Error('Запись не найдена");
    expect(body).toContain("throw new Error('Изменить можно только свою запись')");
    // Ни одной ветви, которая молча выходит, не сделав правки.
    expect(body).not.toContain('\n    return;\n');
  });
});

describe('действия над публикацией идут через один вход', () => {
  it('вход объявлен и снабжён запасным текстом', () => {
    expect(SCREEN).toContain('function runGuardedOp(op: () => Promise<unknown>, fallback: string): void');
    expect(SCREEN).toContain('const runFeedOp = useCallback((op: () => Promise<unknown>, fallback: string): void =>');
    expect(SCREEN).toContain('showError(userErrorText(e, fallback));');
  });

  it('удаление, архив и скрытие автора перечитывают ленту после записи', () => {
    // v4.32.546: удаление стало асинхронной веткой — после записи показывается
    // охват рассылки, поэтому вызов обёрнут в async-колбэк, но вход тот же.
    expect(SCREEN).toContain("const reach = await deleteFeedPost(pair, p.id);");
    expect(SCREEN).toContain("await deleteFeedPostLocal(p.id);");
    expect(SCREEN).toContain("}, t('feed.deletePostFailed'));");
    expect(SCREEN).toContain("runFeedOp(() => toggleMuteAuthor(p.authorDid), t('feed.muteAuthorFailed'))");
    expect(SCREEN).toContain("}, t('feed.archiveFailed'))");
  });

  it('уведомления о комментариях — без перечитывания, но с отказом', () => {
    expect(SCREEN).toContain("runGuardedOp(() => toggleMutePost(p.id), t('feed.mutePostFailed'))");
  });

  it('прежних необработанных обещаний в меню не осталось', () => {
    expect(SCREEN).not.toContain('void toggleMutePost(p.id)');
    expect(SCREEN).not.toContain('void toggleMuteAuthor(p.authorDid)');
    expect(SCREEN).not.toContain('void deleteFeedPost(pair, p.id)');
    expect(SCREEN).not.toContain('void deleteFeedPostLocal(p.id)');
    expect(SCREEN).not.toContain('void setFeedPostArchived(p.id, !isArchivedP)');
  });

  it('ошибку операции отделяют от ошибки перечитывания', () => {
    const op = SCREEN.indexOf('showError(userErrorText(e, fallback));');
    const reload = SCREEN.indexOf("log.warn('feed_reload_after_op_failed'");
    expect(op).toBeGreaterThan(-1);
    expect(reload).toBeGreaterThan(op);
  });

  it('хвост «перечитать ленту, а если открыт архив — ещё и его» существует в одном месте', () => {
    const copies = SCREEN.split("if (archiveFilter) void listArchivedFeedPosts()").length - 1;
    expect(copies).toBe(0);
    expect(SCREEN).toContain('const reloadFeedLists = useCallback(async () => {');
  });
});

describe('голос в опросе', () => {
  it('запись голоса перехвачена, а рассылка идёт только после неё', () => {
    const start = SCREEN.indexOf('const vote = useCallback(async (optIdx: number) => {');
    expect(start).toBeGreaterThan(-1);
    const body = SCREEN.slice(start, SCREEN.indexOf('}, [myVotes, poll,', start));
    expect(body).toContain("log.warn('feed_poll_vote_save_failed'");
    expect(body).toContain("showError(userErrorText(e, 'Не удалось сохранить голос'));");
    const fail = body.indexOf("feed_poll_vote_save_failed");
    const cast = body.indexOf('await broadcastPollVote(');
    expect(fail).toBeGreaterThan(-1);
    expect(cast).toBeGreaterThan(fail);
    // Провал перечитывания не выдаётся за провал записи.
    expect(body).toContain("log.warn('feed_poll_reload_failed'");
  });
});

describe('перевод и список получателей', () => {
  it('отказ перевода доходит до человека, как в чате и группах', () => {
    expect(SCREEN).toContain("log.warn('feed_translate_failed', { err: rawErrorText(e) });");
    expect(SCREEN).toContain("showError(t('feed.translateFailed'));");
  });

  it('у чтения получателей три исхода, а не два', () => {
    expect(SCREEN).toContain("useState<'loading' | 'ready' | 'failed'>('loading')");
    expect(SCREEN).toContain("setShareTargets('failed')");
    expect(SCREEN).toContain("setShareTargets('ready')");
    expect(SCREEN).toContain("log.warn('feed_share_targets_failed'");
    // «Загрузка…» больше не зависит от того, пуст ли список.
    expect(SCREEN).not.toContain("shareContacts.length === 0 && shareGroups.length === 0 ? t('common.loading')");
    expect(SCREEN).toContain("t('feed.shareNoTargets')");
  });

  it('эффект листа пересылки снимает свои результаты при закрытии', () => {
    const start = SCREEN.indexOf('void Promise.all([listContacts(), listGroups(pid)])');
    expect(start).toBeGreaterThan(-1);
    const head = SCREEN.lastIndexOf('useEffect(() => {', start);
    const body = SCREEN.slice(head, SCREEN.indexOf('}, [shareToTarget]);', start));
    expect(body).toContain('let alive = true;');
    expect(body).toContain('return () => { alive = false; };');
    expect(body).toContain('if (!alive) return;');
  });
});

describe('тексты отказов существуют', () => {
  it('каждый новый ключ есть в ru.json', () => {
    for (const key of [
      'deletePostFailed', 'muteAuthorFailed', 'mutePostFailed',
      'translateFailed', 'shareNoTargets', 'shareTargetsFailed',
    ]) {
      expect(typeof RU.feed[key]).toBe('string');
      expect(RU.feed[key].length).toBeGreaterThan(3);
    }
  });

  it('экран не показывает сырые ключи вместо текста', () => {
    const used = [...SCREEN.matchAll(/t\('feed\.([a-zA-Z0-9_]+)'/g)].map((m) => m[1]);
    const missing = [...new Set(used)].filter((k) => !(k in RU.feed));
    expect(missing).toEqual([]);
  });
});
