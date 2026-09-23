/**
 * Служебные конверты отвечают словом, а не «наш ли это конверт» (v4.32.759).
 *
 * Четыре обработчика — автоудаление, запрет копирования, «не показывай время
 * входа» и профиль контакта — возвращали `boolean`, и означал он «префикс
 * мой». Вызывающему в messaging.ts это было не нужно: префикс он уже проверил
 * сам, ответ выбрасывал и объявлял кадр разобранным в любом исходе.
 *
 * «Разобрано» двигает метку докуда прочитано, а relay отдаёт накопленное
 * только по ней. Второго такого конверта не будет: собеседник помнит, что
 * прислал. Порядок «проверить знак — применить — сдвинуть знак» внутри уже был
 * правильным (v4.32.655, v4.32.750, v4.32.751), но чинил он только повтор,
 * которого никто не присылает. Секунда занятой базы стоила настройки навсегда,
 * причём у отправителя она стоит: конверт ушёл.
 *
 * Правка: обработчики отвечают `EnvelopeIntake`, а messaging.ts отдаёт их
 * ответ наружу — неудавшееся применение откладывает кадр, и relay приносит его
 * снова. Поведение трёх первых закреплено в controlEnvelopeReplay; здесь —
 * четвёртый (профиль контакта, у него провал приходит исключением) и проводка
 * всех четырёх.
 */

/** Что сделает запись профиля контакта: true — ответит отказом, как занятая база. */
let mockContactWriteFails = false;
/** Что ответит запись, когда отказа нет: один из пяти исходов (v4.32.768). */
let mockWriteOutcome: 'applied' | 'unchanged' | 'stale' | 'no-contact' = 'applied';
/** Что записано в контакты — по порядку. */
const mockWrites: { pid: number; peer: string; name: string | null }[] = [];

jest.mock('../contacts', () => ({
  listContactsFor: async () => [],
  // v4.32.768: запись отвечает словом, а не бросает. Прежний мок бросал
  // исключение — настоящая функция его никогда не бросала, свой `catch` у неё
  // внутри, и ветка отсрочки в profileSync не зажигалась ни разу.
  setPeerProfileForChecked: async (pid: number, peer: string, env: { name: string | null }) => {
    if (mockContactWriteFails) return 'failed';
    if (mockWriteOutcome === 'applied') mockWrites.push({ pid, peer, name: env.name });
    return mockWriteOutcome;
  },
}));

// Служба переписки нужна только отправке — приёму она не нужна вовсе, а
// тянет за собой транспорт целиком.
jest.mock('../messaging', () => ({
  getMessagingService: () => null,
}));

jest.mock('../sendGate', () => ({
  canReachPeer: async () => ({ ok: true }),
}));

jest.mock('../../identity/verification', () => ({
  badgeFor: async () => null,
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1, name: 'Личный' }) },
}));

jest.mock('../../storage/local', () => ({
  kvGet: async () => null,
  kvSet: async () => undefined,
  kvSetChecked: async () => true,
  kvTryGet: async () => ({ value: null }),
  kvDelete: async () => undefined,
}));

jest.mock('../../logger', () => ({
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { encodeProfileEnvelope } from '../profileEnvelope';
import { handleIncomingPeerProfile } from '../profileSync';

const PEER = 'peer-pub-b64-aaaa';
const PID = 3;

/** Конверт профиля с именем — самое дешёвое, что вообще можно прислать. */
function profileEnv(name: string, ts: number): string {
  return encodeProfileEnvelope({ name, bio: null, avatarCid: null, ts });
}

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const read = (...p: string[]): string =>
  readFileSync(join(__dirname, '..', '..', '..', ...p), 'utf8');

beforeEach(() => {
  mockContactWriteFails = false;
  mockWriteOutcome = 'applied';
  mockWrites.length = 0;
});

describe('профиль контакта: занятая база откладывает кадр', () => {
  it('запись упала — кадр отложен, и тот же конверт применяется потом', async () => {
    mockContactWriteFails = true;
    const env = profileEnv('Мария', Date.now() - 10_000);
    expect(await handleIncomingPeerProfile(env, PEER, PID)).toBe('deferred');
    expect(mockWrites).toEqual([]);

    // База освободилась — тот же самый кадр, принесённый relay заново.
    mockContactWriteFails = false;
    expect(await handleIncomingPeerProfile(env, PEER, PID)).toBe('consumed');
    expect(mockWrites).toEqual([{ pid: PID, peer: PEER, name: 'Мария' }]);
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Отсрочка — не бесплатная: кадр разбирается второй раз, и обработчик, который
 * откладывает всё подряд, был бы ничем не лучше прежнего. Откладываем ровно то,
 * что пройдёт само; негодное годным не станет и потому разобрано.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: негодное не откладывается', () => {
  it('удавшаяся запись — «разобрано»', async () => {
    expect(await handleIncomingPeerProfile(profileEnv('Пётр', Date.now()), PEER, PID)).toBe(
      'consumed'
    );
    expect(mockWrites).toHaveLength(1);
  });

  it('чужой префикс — «разобрано»', async () => {
    expect(await handleIncomingPeerProfile('обычный текст', PEER, PID)).toBe('consumed');
    expect(mockWrites).toEqual([]);
  });

  it('мусор вместо конверта — «разобрано»', async () => {
    expect(await handleIncomingPeerProfile('\x14prof:{не json', PEER, PID)).toBe('consumed');
    expect(mockWrites).toEqual([]);
  });

  it.each(['unchanged', 'stale', 'no-contact'] as const)(
    'исход «%s» — «разобрано»: повтором кадра его не исправить',
    async (outcome) => {
      // v4.32.768: откладывается ровно отказ записи. Совпавший, устаревший и
      // ничейный профиль годными от второго захода не станут, а отсрочка стоит
      // разбора кадра заново.
      mockWriteOutcome = outcome;
      expect(await handleIncomingPeerProfile(profileEnv('Мария', Date.now()), PEER, PID)).toBe(
        'consumed'
      );
    }
  );

  it('конверт без отправителя — «разобрано»: чей он, узнать неоткуда', async () => {
    mockContactWriteFails = true;
    const env = profileEnv('Мария', Date.now());
    expect(await handleIncomingPeerProfile(env, undefined, PID)).toBe('consumed');
    expect(mockWrites).toEqual([]);
  });
});

/**
 * ПОВОД ДЛЯ ПРАВКИ ЖИВ.
 *
 * Слово обработчика само по себе ничего не решает: решает его тот, кто это
 * слово отдаёт наружу. Ветки живут в messaging.ts, который тянет транспорт и
 * SQLite целиком, поэтому здесь — форма.
 */
describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  const HANDLERS: [string, string][] = [
    ['DISAPPEAR_PREFIX', 'handleIncomingDisappear'],
    ['COPY_GUARD_PREFIX', 'handleIncomingCopyGuard'],
    ['PRESENCE_PREF_PREFIX', 'handleIncomingLastSeenPref'],
    ['PROFILE_PREFIX', 'handleIncomingPeerProfile'],
  ];

  it.each(HANDLERS)('%s: ответ обработчика — ответ ветки', (prefix, fn) => {
    const body = codeOnly(read('core/social/messaging.ts'));
    const at = body.indexOf(`if (textPayload.text?.startsWith(${prefix})) {`);
    expect(at).toBeGreaterThan(0);
    // Ровно в этой ветке — возврат ответа, а не вызов ради побочного действия.
    expect(body.slice(at, at + 400)).toContain(
      `return await ${fn}(textPayload.text, peerPubKeyB64, ownerPid);`
    );
  });

  it.each([
    ['disappearSync.ts', 'handleIncomingDisappear'],
    ['copyGuardSync.ts', 'handleIncomingCopyGuard'],
    ['presencePrefSync.ts', 'handleIncomingLastSeenPref'],
    ['profileSync.ts', 'handleIncomingPeerProfile'],
  ])('%s отвечает словом, а не булевым', (file, fn) => {
    const body = codeOnly(read('core/social', file));
    const at = body.indexOf(`export async function ${fn}(`);
    expect(at).toBeGreaterThan(0);
    const head = body.slice(at, at + 260);
    expect(head).toContain('): Promise<EnvelopeIntake> {');
    expect(head).not.toContain('): Promise<boolean> {');
    // И отсрочка в этом обработчике действительно есть — иначе слово пустое.
    expect(body.slice(at)).toContain("return 'deferred';");
  });

  it('просьба прислать профиль отложению не подлежит — и остаётся булевой', () => {
    // Отказ у неё один: слишком частые просьбы. Он окончательный по замыслу,
    // повтор кадра его не изменит — откладывать нечего.
    const body = codeOnly(read('core/social/profileSync.ts'));
    const at = body.indexOf('export async function handleIncomingProfileRequest(');
    expect(at).toBeGreaterThan(0);
    expect(body.slice(at, at + 260)).toContain('): Promise<boolean> {');
  });
});
