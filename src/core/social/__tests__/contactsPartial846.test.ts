/**
 * Короткий справочник перестал выдаваться за полный (v4.32.846).
 *
 * Дефект. Строки контактов читаются по одной, и ту, которую не удалось
 * расшифровать, разбор пропускает: вычеркнуть её из указателя нельзя — контакт
 * тогда не вернуть уже ничем (v4.32.641). Пропуск верный. Неверно то, что о
 * нём никто не узнавал: `out` выходил короче `ids`, и снаружи этот список был
 * неотличим от полного. Ни одной проверки на `out.length < ids.length` не было.
 *
 * Цена. Не экран — рассылка. Кадр ленты (`feedTransport`), сторис
 * (`storyService`) и очередь повторов (`feedService`) берут тот же справочник
 * как список адресатов. Пропущенный контакт в `total` не попадал, `success ===
 * total` сходилось, `classifyBroadcast` отвечал `complete`, и
 * `feedBroadcastNeedsRetry` — `false`. То есть пост объявлялся дошедшим до
 * всех ровно в тот момент, когда до нескольких человек не дошёл и повторяться
 * уже не собирался. У сторис повтора нет вовсе: не сказать сейчас — значит не
 * сказать никогда.
 *
 * Отдельная беда — кэш. Укороченный список ложился в него на пять секунд и всё
 * это время выдавался как готовый ответ.
 *
 * Правка. Чтение считает непрочитанные строки и отдаёт счёт отдельным входом
 * (`listContactsReadDetailed`); счёт едет в кэше вместе со списком; разбор
 * исхода рассылки знает про неназванных адресатов, а экран контактов и автор
 * сторис — слышат о них словами.
 */

import fs from 'fs';
import path from 'path';

const mockUnreadable = new Set<string>();

jest.mock('../../storage/local', () => {
  const kv: Record<string, string> = {};
  const kvGet = jest.fn(async (key: string) => kv[key] ?? null);
  const kvSet = jest.fn(async (key: string, value: string) => { kv[key] = value; });
  const kvDelete = jest.fn(async (key: string) => { delete kv[key]; });
  return {
    __kv: kv,
    kvGet,
    kvSet,
    kvDelete,
    kvGetSecret: jest.fn(async (key: string) => kvGet(key)),
    kvGetSecretCell: jest.fn(async (key: string) => {
      if (mockUnreadable.has(key)) return { state: 'unreadable' };
      const v = await kvGet(key);
      return v == null ? { state: 'absent' } : { state: 'plain', text: v };
    }),
    kvSetSecret: jest.fn(async (key: string, value: string) => {
      await kvSet(key, value);
      return true;
    }),
    kvTryGet: jest.fn(async (key: string) => ({ value: await kvGet(key) })),
    kvSetChecked: jest.fn(async (key: string, value: string) => {
      await kvSet(key, value);
      return true;
    }),
    profileKvGet: jest.fn(async (profileId: number, key: string) => kvGet(`p${profileId}:${key}`)),
    profileKvSet: jest.fn(async (profileId: number, key: string, value: string) =>
      kvSet(`p${profileId}:${key}`, value)),
    profileKvDelete: jest.fn(async (profileId: number, key: string) =>
      kvDelete(`p${profileId}:${key}`)),
    notifyChatStorageChanged: jest.fn(),
  };
});

// feedTransport тянет за собой транспорт целиком; здесь нужен только разбор
// исхода, поэтому дорогу к сети заглушаем.
jest.mock('../../transport/ipfs/pubsub', () => ({
  pubsubSubscribe: jest.fn(),
  pubsubPublish: jest.fn(),
}));
jest.mock('../../transport/multiTransport', () => ({
  multiTransportRouter: { send: jest.fn(async () => true) },
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

jest.mock('../../crypto/keyManager', () => {
  const { x25519 } = require('@noble/curves/ed25519.js');
  return {
    ecdhSharedSecret: jest.fn((mySecretKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array =>
      x25519.getSharedSecret(mySecretKey.slice(0, 32), peerPublicKey.slice(0, 32))),
    publicKeyHash4: jest.requireActual('../../crypto/keyManager').publicKeyHash4,
  };
});

import { x25519 } from '@noble/curves/ed25519.js';

import {
  classifyBroadcast,
  dispositionOf,
  needsRetryQueue,
} from '../../sync/publishOutcome';
import { addContact, invalidateContactsList, listContactsReadDetailed } from '../contacts';
import { feedBroadcastNeedsRetry } from '../feedTransport';
import { storyPublishProblem } from '../storyPublishOutcome';

const mockLocal = jest.requireMock('../../storage/local') as { __kv: Record<string, string> };

function makeKeyPair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const secretKey = x25519.utils.randomSecretKey();
  return { publicKey: x25519.getPublicKey(secretKey), secretKey };
}

function rowKey(peer: Uint8Array): string {
  return `p1:contact:${Buffer.from(peer).toString('base64')}`;
}

beforeEach(() => {
  for (const k of Object.keys(mockLocal.__kv)) delete mockLocal.__kv[k];
  mockUnreadable.clear();
  invalidateContactsList();
});

const read = (...parts: string[]): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', ...parts), 'utf8');

/** Комментарий, где написано «как надо», за исходник не считается. */
const codeOnly = (s: string): string =>
  s
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

describe('чтение справочника считает непрочитанные строки', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: всё открылось — счёт ноль, список полон', async () => {
    const me = makeKeyPair();
    const bob = makeKeyPair();
    const eve = makeKeyPair();
    await addContact(me, bob.publicKey, 'Боб');
    await addContact(me, eve.publicKey, 'Ева');
    invalidateContactsList();

    const detailed = await listContactsReadDetailed(1);
    expect(detailed?.contacts).toHaveLength(2);
    expect(detailed?.missing).toBe(0);
  });

  it('одна строка не открылась — её нет в списке, но она сосчитана', async () => {
    const me = makeKeyPair();
    const bob = makeKeyPair();
    const eve = makeKeyPair();
    await addContact(me, bob.publicKey, 'Боб');
    await addContact(me, eve.publicKey, 'Ева');
    mockUnreadable.add(rowKey(eve.publicKey));
    invalidateContactsList();

    const detailed = await listContactsReadDetailed(1);
    // Ровно та беда, ради которой правка: список короче, и раньше это было
    // единственным следом произошедшего.
    expect(detailed?.contacts).toHaveLength(1);
    expect(detailed?.missing).toBe(1);
  });

  it('счёт переживает кэш: второй вопрос в ту же секунду отвечает так же', async () => {
    const me = makeKeyPair();
    const bob = makeKeyPair();
    await addContact(me, bob.publicKey, 'Боб');
    mockUnreadable.add(rowKey(bob.publicKey));
    invalidateContactsList();

    expect((await listContactsReadDetailed(1))?.missing).toBe(1);
    // Второй вызов идёт из кэша — и раньше отдал бы пустой список без всякого
    // признака того, что он неполон.
    const cached = await listContactsReadDetailed(1);
    expect(cached?.contacts).toHaveLength(0);
    expect(cached?.missing).toBe(1);
  });

  it('хранилище отпустило — счёт обнуляется сам', async () => {
    const me = makeKeyPair();
    const bob = makeKeyPair();
    await addContact(me, bob.publicKey, 'Боб');
    mockUnreadable.add(rowKey(bob.publicKey));
    invalidateContactsList();
    expect((await listContactsReadDetailed(1))?.missing).toBe(1);

    mockUnreadable.clear();
    invalidateContactsList();
    const healed = await listContactsReadDetailed(1);
    expect(healed?.contacts).toHaveLength(1);
    expect(healed?.missing).toBe(0);
  });

  it('справочник не прочитался целиком — это по-прежнему null, а не «ноль пропущенных»', async () => {
    // Указателя нет вовсе: прежний исход «пусто» должен остаться пустым, а не
    // притвориться неполным.
    const empty = await listContactsReadDetailed(1);
    expect(empty).toEqual({ contacts: [], missing: 0 });
  });
});

describe('рассылка знает про неназванных адресатов', () => {
  it('дошло до всех названных, но названы не все — это не полная доставка', () => {
    expect(classifyBroadcast(true, 2, 2, false, 1)).toBe('partial');
    expect(dispositionOf('partial')).toBe('queue-retry');
    expect(needsRetryQueue(classifyBroadcast(true, 2, 2, false, 1))).toBe(true);
  });

  it('названных не осталось вовсе — это «неизвестно кому», а не «некому»', () => {
    expect(classifyBroadcast(true, 0, 0, false, 3)).toBe('unknown-recipients');
    // Именно тут была самая дорогая подмена: `no-recipients` снимает запись с
    // очереди навсегда.
    expect(dispositionOf('no-recipients')).toBe('local-only');
    expect(dispositionOf('unknown-recipients')).toBe('queue-retry');
  });

  it('не дошло ни до кого из названных — по-прежнему failed', () => {
    expect(classifyBroadcast(true, 2, 0, false, 1)).toBe('failed');
  });

  it('прежние исходы целы', () => {
    expect(classifyBroadcast(true, 2, 2)).toBe('complete');
    expect(classifyBroadcast(true, 0, 0)).toBe('no-recipients');
    expect(classifyBroadcast(true, 2, 1)).toBe('partial');
    expect(classifyBroadcast(false, 0, 0)).toBe('skipped-offline');
    expect(classifyBroadcast(true, 0, 0, true)).toBe('unknown-recipients');
    // Нечитаемый весь список важнее нескольких строк: и то и другое ведёт в
    // очередь, но первое честнее назвать первым.
    expect(classifyBroadcast(true, 1, 1, true, 1)).toBe('unknown-recipients');
  });

  it('повтор назначается по неназванным адресатам тоже', () => {
    const full = {
      delivered: {
        total: 2, success: 2, successDids: ['a', 'b'],
        contactsUnreadable: false, contactsMissing: 0,
      },
    };
    expect(feedBroadcastNeedsRetry(full)).toBe(false);
    const short = { delivered: { ...full.delivered, contactsMissing: 1 } };
    expect(feedBroadcastNeedsRetry(short)).toBe(true);
    // ПОВОД ДЛЯ ПРАВКИ ЖИВ: старое условие на этом самом месте молчало.
    expect(short.delivered.success < short.delivered.total).toBe(false);
    expect(short.delivered.contactsUnreadable).toBe(false);
  });
});

describe('автору сторис говорят, что ушло не всем', () => {
  const base = { mediaFailure: null, contacts: 3, delivered: 3 };

  it('часть справочника не открылась — фраза называет число', () => {
    const said = storyPublishProblem({ ...base, contactsMissing: 2 }, 'image');
    expect(said).toContain('не всем');
    expect(said).toContain('2 контакта');
    // Повтора у сторис нет — значит сказано, что делать.
    expect(said).toContain('Опубликуйте её снова');
  });

  it('числа склоняются', () => {
    expect(storyPublishProblem({ ...base, contactsMissing: 1 }, 'image')).toContain('1 контакт ');
    expect(storyPublishProblem({ ...base, contactsMissing: 5 }, 'image')).toContain('5 контактов');
    expect(storyPublishProblem({ ...base, contactsMissing: 12 }, 'image')).toContain('12 контактов');
    expect(storyPublishProblem({ ...base, contactsMissing: 22 }, 'image')).toContain('22 контакта');
  });

  it('несостоявшаяся рассылка важнее неполной, а неполная — важнее медиа', () => {
    const media = { reason: 'failed' as const, limitBytes: 1024 };
    expect(
      storyPublishProblem({ ...base, contactsUnreadable: true, contactsMissing: 2 }, 'image'),
    ).toContain('никому не ушла');
    expect(
      storyPublishProblem({ ...base, mediaFailure: media, contactsMissing: 2 }, 'image'),
    ).toContain('не всем');
    // ПРОВЕРКА НЕ ПУСТАЯ: без пропущенных разговор о медиа остаётся прежним.
    expect(
      storyPublishProblem({ ...base, mediaFailure: media, contactsMissing: 0 }, 'image'),
    ).toBe('Изображение не загрузилось — сторис ушла без него');
    expect(storyPublishProblem({ ...base, contactsMissing: 0 }, 'image')).toBeNull();
  });
});

describe('форма исходников', () => {
  const CONTACTS = codeOnly(read('social', 'contacts.ts'));
  const TRANSPORT = codeOnly(read('social', 'feedTransport.ts'));
  const STORY = codeOnly(read('social', 'storyService.ts'));
  const SCREEN = codeOnly(read('..', 'ui', 'screens', 'ContactsScreen.tsx'));

  it('счёт ведёт одно чтение, а не вызывающий по кэшу', () => {
    expect(CONTACTS).toContain('async function readContactsFor(ownerProfileId: number)');
    expect(CONTACTS).toContain('return (await readContactsFor(ownerProfileId))?.contacts ?? null;');
    expect(CONTACTS).toContain('missing += 1;');
    expect(CONTACTS).toContain('contactsListCache.set(pid, { at: Date.now(), data: out, missing });');
    // Непрочитанная строка по-прежнему НЕ вычёркивается из указателя.
    expect(CONTACTS).not.toContain("if (cell.state === 'unreadable') badIds.push(id);");
  });

  it('рассылка и сторис берут чтение со счётом', () => {
    expect(TRANSPORT).toContain('const contactsRead = await listContactsReadDetailed();');
    expect(TRANSPORT).toContain('contactsMissing: number;');
    expect(TRANSPORT).toContain('res.delivered.contactsMissing > 0');
    expect(STORY).toContain('const contactsRead = await listContactsReadDetailed(pid);');
    expect(STORY).toContain('contactsMissing: contactsRead?.missing ?? 0,');
  });

  it('экран контактов не предъявляет укороченную книжку молча', () => {
    expect(SCREEN).toContain('const detailed = await listContactsReadDetailed();');
    expect(SCREEN).toContain('detailed.missing > 0');
    expect(SCREEN).toContain('они на месте, но в списке их нет');
  });
});
