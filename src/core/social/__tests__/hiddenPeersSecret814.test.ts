/**
 * Список «не отмечай меня» перестал лежать открытым текстом (v4.32.814).
 *
 * Дефект. Просьбы собеседников хранились как `JSON.stringify([...ключи])` в
 * столбце `v` таблицы `kv` — том самом, что шифруется выбранно, а здесь запись
 * шла мимо шифрования. В v4.32.813 из имени ключа присутствия убрали открытый
 * ключ собеседника ровно по этой причине; эта строка осталась в стороне, хотя
 * держит тот же перечень, только целиком и в одном месте.
 *
 * Цена. Унёсший файл базы получал готовый список: с кем человек связан и —
 * отдельно ценное — кто из них просил себя не отмечать, то есть кому
 * небезразлично, видно ли его присутствие. Одна строка, никакого разбора; это
 * дороже отдельного сообщения и ровно то, от чего шифрование и заводилось.
 *
 * Правка. Запись идёт через `scopedKvSetSecretCheckedFor`, чтение — через
 * `scopedKvTryGetSecretFor`. Прежние строки открытым текстом читаются как
 * есть и уходят в шифртекст при первой же записи: признак несёт сама строка,
 * префикса `enc2:` у неё нет. Три состояния чтения сохранены: не открылось —
 * это «не знаем», а не «запретов нет», иначе один сбой снял бы все просьбы
 * разом.
 */
const mockKv = new Map<string, string>();
/** Ключи, запись которых база не выполняет. */
const mockFailWrites = new Set<string>();
/** Ключи, чтение которых база не выполняет. */
const mockFailReads = new Set<string>();
/** Шифртекст, который не открывается ключом данных. */
const BROKEN = 'enc2:сломано';

jest.mock('../../storage/local', () => {
  const PREFIX = 'enc2:';
  return {
    kvTryGet: async (k: string) => (mockFailReads.has(k) ? null : { value: mockKv.get(k) ?? null }),
    kvSet: async (k: string, v: string) => { mockKv.set(k, v); },
    kvSetChecked: async (k: string, v: string) => {
      if (mockFailWrites.has(k)) return false;
      mockKv.set(k, v);
      return true;
    },
    kvDelete: async (k: string) => { mockKv.delete(k); },
    kvDeleteChecked: async (k: string) => { mockKv.delete(k); return true; },
    kvListKeysByPrefix: async (p: string) => [...mockKv.keys()].filter((k) => k.startsWith(p)),
    // Секретная пара — та же, что в local.ts, но без SQLite. Вместо шифра
    // здесь base64: не защита, а замена, при которой видно, ушло ли значение
    // в столбец узнаваемым. Оставить его как есть значило бы проверять
    // подстановку, а не код.
    kvSetSecret: async (k: string, v: string) => {
      if (mockFailWrites.has(k)) return false;
      mockKv.set(k, `${PREFIX}${Buffer.from(v, 'utf8').toString('base64')}`);
      return true;
    },
    kvGetSecretCellScoped: async (pid: number, k: string) => {
      const scoped = `p${pid}:${k}`;
      if (mockFailReads.has(scoped)) return { state: 'unreadable' };
      const raw = mockKv.get(scoped);
      if (raw === undefined) return { state: 'absent' };
      if (raw === BROKEN) return { state: 'unreadable' };
      if (!raw.startsWith(PREFIX)) return { state: 'plain', text: raw };
      return {
        state: 'plain',
        text: Buffer.from(raw.slice(PREFIX.length), 'base64').toString('utf8'),
      };
    },
  };
});

jest.mock('../../storage/localEncryption', () => ({
  getOrCreateDataEncryptionKey: async () => new Uint8Array(32).fill(7),
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: {
    getActiveProfile: () => ({ id: 1, name: 'П', did: 'did:key:z1' }),
    getAllProfiles: () => [{ id: 1, name: 'Личный', did: 'did:key:z1' }],
  },
}));

jest.mock('../../identity/ownProfile', () => ({ ownFieldGetFor: async () => '' }));
jest.mock('../../transport/ipfs/pubsub', () => ({ pubsubPublish: async () => null, pubsubSubscribe: async () => null }));
jest.mock('../../transport/ipfs/heliaNode', () => ({ isIpfsEnabled: () => false }));
jest.mock('../contacts', () => ({ listContacts: async () => [], listContactsFor: async () => [] }));
jest.mock('../../settings/privacyPrefs', () => ({ privacyPrefTryGet: async () => ({ value: 'everybody' }) }));
jest.mock('../../logger', () => ({ log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} } }));
jest.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove: () => {} }), currentState: 'active' } }));

import * as fs from 'fs';
import * as path from 'path';

import {
  getPresenceState,
  loadPersistedPresence,
  recordPeerActivity,
  setPeerLastSeenAllowed,
  setPeerLastSeenAllowedFor,
  stopPresenceBroadcast,
} from '../presenceService';

const HIDDEN = 'presence:hidden_peers';
const PID = 2;
const OTHER_PID = 3;
const SHY = 'ктоПросилНеОтмечать==';
const OPEN = 'ктоНеПросил==';
const WHEN = 1_700_000_000_000;

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

/** Что лежит в столбце значений под списком запретов у профиля. */
function storedHidden(pid: number): string | undefined {
  return mockKv.get(`p${pid}:${HIDDEN}`);
}

beforeEach(async () => {
  mockKv.clear();
  mockFailWrites.clear();
  mockFailReads.clear();
  await stopPresenceBroadcast();
});

describe('ключи собеседников не ложатся в базу открытым текстом', () => {
  it('просьба работающего профиля уходит шифртекстом', async () => {
    await loadPersistedPresence([], PID);
    await setPeerLastSeenAllowed(SHY, false);
    const raw = storedHidden(PID);
    expect(raw).toBeDefined();
    expect(raw?.startsWith('enc2:')).toBe(true);
    expect(raw).not.toContain(SHY);
  });

  it('просьба, адресованная другому аккаунту, — тоже', async () => {
    // Этот путь пишет прямо в чужую запись, минуя память, и до правки был
    // отдельной второй дырой с тем же содержимым.
    await loadPersistedPresence([], PID);
    await setPeerLastSeenAllowedFor(OTHER_PID, SHY, false);
    const raw = storedHidden(OTHER_PID);
    expect(raw?.startsWith('enc2:')).toBe(true);
    expect(raw).not.toContain(SHY);
  });

  it('ни одна запись присутствия не содержит открытого ключа', async () => {
    await loadPersistedPresence([], PID);
    recordPeerActivity(OPEN, WHEN);
    await setPeerLastSeenAllowed(SHY, false);
    for (const [k, v] of mockKv) {
      expect(k).not.toContain(SHY);
      expect(k).not.toContain(OPEN);
      expect(v).not.toContain(SHY);
      expect(v).not.toContain(OPEN);
    }
  });
});

describe('прежние записи открытым текстом', () => {
  it('читаются как есть — просьба не теряется при обновлении', async () => {
    mockKv.set(`p${PID}:${HIDDEN}`, JSON.stringify([SHY]));
    await loadPersistedPresence([], PID);
    recordPeerActivity(SHY, WHEN);
    // Просьба в силе: время не записывается и не показывается.
    expect(getPresenceState(SHY).lastActiveAt).toBe(0);
  });

  it('переписываются шифртекстом при первой же записи', async () => {
    mockKv.set(`p${PID}:${HIDDEN}`, JSON.stringify([SHY]));
    await loadPersistedPresence([], PID);
    await setPeerLastSeenAllowed(OPEN, false);
    expect(storedHidden(PID)?.startsWith('enc2:')).toBe(true);
    expect(storedHidden(PID)).not.toContain(SHY);
  });
});

describe('нечитаемый список не подменяется пустым', () => {
  it('«не открылось» — это «не знаем», а не «запретов нет»', async () => {
    // До правки список лежал открытым текстом, и «не открылось» не бывало
    // вовсе: непонятная строка разбиралась в пустой массив и ложилась поверх
    // накопленного. Теперь такой ответ отличим — и запись отменяется, иначе
    // один сбой снял бы все просьбы разом, и присутствие тех, кто просил себя
    // не показывать, снова стало бы видно.
    await loadPersistedPresence([], PID);
    expect(await setPeerLastSeenAllowedFor(PID + 100, SHY, false)).toBe(true);
    mockKv.set(`p${PID + 100}:${HIDDEN}`, BROKEN);
    expect(await setPeerLastSeenAllowedFor(PID + 100, OPEN, false)).toBe(false);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежние исходы целы', () => {
  it('просьба переживает перезапуск', async () => {
    await loadPersistedPresence([], PID);
    await setPeerLastSeenAllowed(SHY, false);
    await stopPresenceBroadcast();
    await loadPersistedPresence([SHY], PID);
    recordPeerActivity(SHY, WHEN);
    expect(getPresenceState(SHY).lastActiveAt).toBe(0);
  });

  it('отказ записи доходит до вызывающего', async () => {
    await loadPersistedPresence([], PID);
    mockFailWrites.add(`p${PID}:${HIDDEN}`);
    expect(await setPeerLastSeenAllowed(SHY, false)).toBe(false);
  });

  it('снятие запрета по-прежнему работает', async () => {
    await loadPersistedPresence([], PID);
    await setPeerLastSeenAllowed(SHY, false);
    expect(await setPeerLastSeenAllowed(SHY, true)).toBe(true);
    recordPeerActivity(SHY, WHEN);
    expect(getPresenceState(SHY).lastActiveAt).toBe(WHEN);
  });

  it('список остаётся своим у каждого аккаунта', async () => {
    await loadPersistedPresence([], PID);
    await setPeerLastSeenAllowed(SHY, false);
    expect(storedHidden(OTHER_PID)).toBeUndefined();
    expect(mockKv.has(HIDDEN)).toBe(false);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: столбец значений открыт', () => {
  it('обычная запись kv кладёт значение как есть', () => {
    const local = codeOnly(read('core', 'storage', 'local.ts'));
    const at = local.indexOf('export async function kvSetChecked(');
    expect(at).toBeGreaterThan(0);
    const body = local.slice(at, local.indexOf('\n}', at));
    expect(body).toContain("'INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', [key, value]");
    expect(body).not.toContain('encryptAtRest');
  });

  it('секретная запись отличается от обычной именно шифрованием', () => {
    const local = codeOnly(read('core', 'storage', 'local.ts'));
    expect(local).toContain('return await kvSetChecked(key, encryptAtRestString(value, dek));');
  });
});

describe('форма исходников', () => {
  it('список запретов пишется и читается секретной парой', () => {
    const s = codeOnly(read('core', 'social', 'presenceService.ts'));
    expect(s).toContain('scopedKvTryGetSecretFor(presencePid, HIDDEN_PEERS_KEY)');
    expect(s).toContain('scopedKvTryGetSecretFor(ownerProfileId, HIDDEN_PEERS_KEY)');
    expect(s).toContain('scopedKvSetSecretCheckedFor(ownerProfileId, HIDDEN_PEERS_KEY, JSON.stringify(next))');
    expect(s).not.toContain('scopedKvTryGetFor(presencePid, HIDDEN_PEERS_KEY)');
    expect(s).not.toContain('scopedKvSetCheckedFor(ownerProfileId, HIDDEN_PEERS_KEY');
  });

  it('секретная пара не пишет открытым текстом взамен несостоявшегося шифра', () => {
    const s = codeOnly(read('core', 'storage', 'profileScopedKv.ts'));
    const at = s.indexOf('export async function scopedKvSetSecretCheckedFor(');
    expect(at).toBeGreaterThan(0);
    const body = s.slice(at, s.indexOf('\n}\n', at));
    expect(body).toContain('const written = await kvSetSecret(profileScopedKey(pid, key), value);');
    expect(body).not.toContain('kvSetChecked');
  });

  it('чтение отличает «не открылось» от «записи нет»', () => {
    const s = codeOnly(read('core', 'storage', 'profileScopedKv.ts'));
    expect(s).toContain("if (cell.state === 'unreadable') return null;");
    expect(s).toContain("return { value: cell.state === 'plain' ? cell.text : null };");
  });
});
