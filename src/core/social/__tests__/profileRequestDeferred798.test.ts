/**
 * Просьба прислать профиль, на которую не смогли ответить (v4.32.798).
 *
 * Дефект. Ответ на просьбу занимал окно на пять минут ДО отправки, а сама
 * отправка молчала обо всех своих осечках: службы нет, дороги нет, отправку
 * отклонили, запись сорвалась — наружу из неё выходил один и тот же `void`.
 * Обработчик поверх этого отвечал `true` («конверт наш»), и ветка приёма
 * объявляла кадр разобранным в любом случае.
 *
 * Цена. Собеседник остаётся с кружком-буквой вместо карточки, и переспросить
 * ему нечем: своё окно он занял той же самой просьбой, а окна с обеих сторон
 * одинаковые. То есть одна пропавшая секунда стоила пяти минут пустой
 * карточки — при том что кадр просьбы лежит у ретранслятора и его достаточно
 * было не объявлять разобранным.
 *
 * Правка. Отправка называет исход словом: отправили, нечего/незачем, не
 * смогли. На «не смогли» обработчик снимает свою отметку и отвечает
 * `deferred` — повтор кадра застаёт окно свободным. Отказ по частоте
 * отсрочкой не считается: он окончательный по замыслу.
 */
import fs from 'fs';
import path from 'path';

const mockKv = new Map<string, string>();
jest.mock('../../storage/profileScopedKv', () => ({
  scopedKvGetFor: jest.fn(async (pid: number, key: string) => mockKv.get(`${pid}:${key}`) ?? null),
  scopedKvTryGetFor: jest.fn(async (pid: number, key: string) => ({
    value: mockKv.get(`${pid}:${key}`) ?? null,
  })),
  scopedKvSetFor: jest.fn(async (pid: number, key: string, v: string) => {
    mockKv.set(`${pid}:${key}`, v);
  }),
  // v4.32.960: первая отметка версии профиля пишется проверенной записью —
  // не легла, значит версия была бы разовой и рассылка пошла бы по кругу.
  scopedKvSetCheckedFor: jest.fn(async (pid: number, key: string, v: string) => {
    mockKv.set(`${pid}:${key}`, v);
    return true;
  }),
  // v4.32.946: карта «кому какую версию отправляли» переехала в шифрованную
  // пару. Для этой проверки шифр безразличен — важно, что значение то же
  // самое; подделка держит его в той же ячейке, что и открытая пара.
  scopedKvTryGetSecretFor: jest.fn(async (pid: number, key: string) => ({
    value: mockKv.get(`${pid}:${key}`) ?? null,
  })),
  scopedKvSetSecretCheckedFor: jest.fn(async (pid: number, key: string, v: string) => {
    mockKv.set(`${pid}:${key}`, v);
    return true;
  }),
  scopedKvSet: jest.fn(async () => {}),
}));

/** Поднята ли служба переписки: до неё отправка даже не доходит. */
let mockSvcUp = true;
const mockSend = jest.fn(async (): Promise<string> => 'cid-798');
jest.mock('../messaging', () => ({
  getMessagingService: () =>
    mockSvcUp ? { sendMessage: (...a: unknown[]) => mockSend(...(a as [])) } : null,
}));

const mockReach = jest.fn(async () => true);
jest.mock('../sendGate', () => ({ canReachPeer: (...a: unknown[]) => mockReach(...(a as [])) }));

jest.mock('../contacts', () => ({
  listContactsFor: jest.fn(async () => []),
  setPeerProfileFor: jest.fn(async () => true),
}));
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 7 }) },
}));

/** Заполнено ли имя в своём профиле: с пустым слать нечего. */
let mockOwnName: string | null = 'Рита';
jest.mock('../../identity/ownProfile', () => ({
  getOwnDisplayNameFor: jest.fn(async () => mockOwnName),
  getOwnUsernameFor: jest.fn(async () => null),
  ownFieldGetFor: jest.fn(async () => ''),
}));
jest.mock('../../identity/ownAvatar', () => ({
  ownAvatarNameFor: jest.fn(async () => null),
  ownAvatarUriFor: jest.fn(async () => null),
}));
jest.mock('../../settings/avatarVisibility', () => ({
  avatarVisibilityTryFor: jest.fn(async () => 'everybody'),
}));
jest.mock('../../identity/ownBadge', () => ({ ownBadgeGrantFor: jest.fn(async () => null) }));
// Пустой список привязок настоящий ownLinksFor отдаёт как null — с [] проверка
// «есть ли что рассылать» не сработала бы, и пустой профиль всё равно уезжал.
jest.mock('../../identity/ownLinks', () => ({ ownLinksFor: jest.fn(async () => null) }));
jest.mock('../../identity/verification', () => ({ badgeFor: jest.fn(() => false) }));
jest.mock('../../identity/did', () => ({ didFromPubB64: (p: string) => `did:key:${p}` }));

import { PROFILE_PREFIX, encodeProfileRequest } from '../profileEnvelope';
import { handleIncomingProfileRequest } from '../profileSync';

const PID = 7;

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

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

/** Прислать просьбу от названного собеседника. */
const ask = (peer: string): Promise<string> =>
  handleIncomingProfileRequest(encodeProfileRequest(), peer, PID);

/** Ушла ли в ответ именно карточка. */
const answers = (): string[] =>
  mockSend.mock.calls
    .map((c) => (c as unknown as [string, string])[1])
    .filter((t) => t.startsWith(PROFILE_PREFIX));

beforeEach(() => {
  mockKv.clear();
  mockSvcUp = true;
  mockOwnName = 'Рита';
  mockReach.mockResolvedValue(true);
  mockSend.mockReset();
  mockSend.mockResolvedValue('cid-798');
});

describe('ответ, которого не было, — это отсрочка, а не «разобрано»', () => {
  it('дороги не было секунду: кадр откладывается, и повтор отвечает карточкой', async () => {
    mockReach.mockResolvedValue(false);
    expect(await ask('PEER_ROAD')).toBe('deferred');
    expect(answers()).toEqual([]);

    // Окно освобождено — иначе повтор кадра упёрся бы в частоту и промолчал.
    mockReach.mockResolvedValue(true);
    expect(await ask('PEER_ROAD')).toBe('consumed');
    expect(answers()).toHaveLength(1);
  });

  it('отправку отклонили: кадр откладывается', async () => {
    mockSend.mockResolvedValue('');
    expect(await ask('PEER_REFUSED')).toBe('deferred');

    mockSend.mockResolvedValue('cid-798');
    expect(await ask('PEER_REFUSED')).toBe('consumed');
    expect(answers()).toHaveLength(2); // вторая попытка — настоящая отправка
  });

  it('служба переписки не поднята: кадр откладывается', async () => {
    mockSvcUp = false;
    expect(await ask('PEER_NOSVC')).toBe('deferred');
    expect(mockSend).not.toHaveBeenCalled();

    mockSvcUp = true;
    expect(await ask('PEER_NOSVC')).toBe('consumed');
    expect(answers()).toHaveLength(1);
  });

  it('отправка сорвалась исключением: кадр откладывается', async () => {
    mockSend.mockRejectedValueOnce(new Error('сеть отвалилась'));
    expect(await ask('PEER_THROW')).toBe('deferred');

    // Попытка была, но сорвалась: доехала карточка только со второй.
    expect(await ask('PEER_THROW')).toBe('consumed');
    expect(answers()).toHaveLength(2);
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Здесь — только то, что должно было работать и до правки: слово кадра эти
 * проверки не читают вовсе. Проверки ниже («граница правки») читают именно
 * его, и на старом коде они провалятся все до одной — там ответом было `true`.
 * Это не доказательство их пустоты, а следствие того, что предмет правки и
 * есть слово; полезны они тем, что ловят лечение наотмашь, при котором
 * откладывается всё подряд.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: обычная работа не задета', () => {
  it('карточка уходит именно тому, кто просил', async () => {
    await ask('PEER_OK');
    expect(mockSend).toHaveBeenCalledTimes(1);
    const [to, text] = mockSend.mock.calls[0] as unknown as [string, string];
    expect(to).toBe('PEER_OK');
    expect(text.startsWith(PROFILE_PREFIX)).toBe(true);
  });

  it('вторая просьба подряд второй карточки не шлёт', async () => {
    await ask('PEER_FAST');
    await ask('PEER_FAST');
    await ask('PEER_FAST');
    expect(answers()).toHaveLength(1);
  });

  it('пустой профиль не уезжает вовсе', async () => {
    mockOwnName = null;
    await ask('PEER_EMPTY');
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('ГРАНИЦА ПРАВКИ: окончательные исходы отсрочкой не становятся', () => {
  it('удавшийся ответ — «разобрано»', async () => {
    expect(await ask('PEER_OK2')).toBe('consumed');
    expect(answers()).toHaveLength(1);
  });

  it('отказ по частоте — «разобрано»', async () => {
    expect(await ask('PEER_FAST2')).toBe('consumed');
    // Мы ответили только что, и повтор кадра этого не изменит: отсрочка тут
    // крутила бы кадр впустую.
    expect(await ask('PEER_FAST2')).toBe('consumed');
  });

  it('свой профиль пуст — «разобрано»: повтор кадра его не заполнит', async () => {
    mockOwnName = null;
    expect(await ask('PEER_EMPTY2')).toBe('consumed');
  });

  it('конверт без подтверждённого отправителя — «разобрано»', async () => {
    expect(await handleIncomingProfileRequest(encodeProfileRequest(), undefined, PID)).toBe(
      'consumed'
    );
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('переспросить раньше чем через пять минут просящему нечем', () => {
    const body = codeOnly(read('core/social/profileSync.ts'));
    // Окно одно на обе стороны: и на просьбу, и на ответ.
    expect(body).toContain('const REQ_COOLDOWN_MS = 5 * 60_000;');
    // v4.32.826: в ключе окна появился номер профиля — сам ключ и длина окна
    // от этого не изменились, а вот строка вызова изменилась.
    expect(body).toContain('if (!passThrottle(reqSentAt, reqKey, Date.now())) return;');
  });

  it('другого пути ответить на просьбу нет', () => {
    const body = codeOnly(read('core/social/messaging.ts'));
    expect(body.split('handleIncomingProfileRequest').length - 1).toBe(2); // импорт и вызов
  });
});

describe('форма исходников: правка стоит там, где сказано', () => {
  it('отправка называет исход словом', () => {
    const body = codeOnly(read('core/social/profileSync.ts'));
    expect(body).toContain("type ProfileSendOutcome = 'sent' | 'skipped' | 'failed';");
    expect(body).toContain('): Promise<ProfileSendOutcome> {');
    expect(body).not.toContain(
      'async function sendProfileTo(pid: number, peerPubB64: string, force: boolean): Promise<void>'
    );
  });

  it('на «не смогли» отметка снимается', () => {
    const body = codeOnly(read('core/social/profileSync.ts'));
    const at = body.indexOf('export async function handleIncomingProfileRequest(');
    expect(at).toBeGreaterThan(0);
    const tail = body.slice(at);
    expect(tail).toContain("if (outcome === 'failed') {");
    expect(tail).toContain('reqAnsweredAt.delete(ansKey);'); // v4.32.826: ключ с профилем
    expect(tail).toContain("return 'deferred';");
  });

  it('ветка приёма отдаёт наружу ответ обработчика', () => {
    const body = codeOnly(read('core/social/messaging.ts'));
    const at = body.indexOf('if (textPayload.text?.startsWith(PROFILE_REQ_PREFIX)) {');
    expect(at).toBeGreaterThan(0);
    expect(body.slice(at, at + 400)).toContain(
      'return await handleIncomingProfileRequest(textPayload.text, peerPubKeyB64, ownerPid);'
    );
  });
});
