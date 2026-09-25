/**
 * Переход по `@имени` помнит, каким ключом это имя открывалось (v4.32.945).
 *
 * Дефект. Карточка незнакомца по `@имени` собирается из ответа сервера
 * справочника целиком: он называет ключ, и переписка идёт с тем, чей ключ
 * назван. Проверить его нечем — подпись, которой сервер проверяет заявку на
 * имя, стоит под тем же ключом, который сервер и называет, так что
 * подделывающий ответ подписал бы свой ключ сам.
 *
 * Цена. Один сервер решает, кто такой `@аня` для всех, кто по этому имени
 * перейдёт. Подмена выглядит как обычный незнакомец: ни одной строки на экране
 * не меняется.
 *
 * Правка. Сверять не с кем, кроме себя прежнего: ключ, с которым имя открылось
 * впервые, запоминается, и расхождение при следующем переходе показывается
 * человеку. Переход не запрещается — ключ меняется и честно, — но и не
 * молчит, а запомненное само собой не переписывается.
 *
 * Границы. Первый переход по имени не защищён ничем; знакомые сюда не попадают
 * вовсе — их ключ лежит в адресной книге и справочник о них не спрашивают.
 */
jest.mock('../../storage/profileSharedKv', () => ({
  activeProfileIdOrNull: jest.fn(() => mockProfileId),
  tryReadProfileSharedSecret: jest.fn(async () => (mockUnreadable ? null : { value: mockCell })),
  writeProfileSharedSecret: jest.fn(async (_k: string, v: string) => {
    if (mockWriteFails) return false;
    mockCell = v;
    return true;
  }),
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import {
  acceptUsernameKey,
  checkUsernameKeyPin,
  MAX_USERNAME_PINS,
  resetUsernameKeyPinCache,
  USERNAME_KEY_PINS_KEY,
} from '../usernameKeyPin';

/** Содержимое записи профиля — то, что модуль пишет и читает. */
let mockCell: string | null = null;
/** База отвечает отказом на чтение. */
let mockUnreadable = false;
/** База отвечает отказом на запись. */
let mockWriteFails = false;
let mockProfileId: number | null = 1;

const PUB_A = 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=';
const PUB_B = 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=';

beforeEach(() => {
  mockCell = null;
  mockUnreadable = false;
  mockWriteFails = false;
  mockProfileId = 1;
  resetUsernameKeyPinCache();
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('первый переход по имени запоминается, а не отвергается', async () => {
    expect(await checkUsernameKeyPin('anya', PUB_A)).toEqual({ status: 'first' });
    expect(mockCell).toContain('anya');
  });

  it('тот же ключ во второй раз — совпадение, а не тревога', async () => {
    await checkUsernameKeyPin('anya', PUB_A);
    resetUsernameKeyPinCache();
    const second = await checkUsernameKeyPin('anya', PUB_A);
    expect(second.status).toBe('same');
  });

  it('разные имена друг другу не мешают', async () => {
    expect((await checkUsernameKeyPin('anya', PUB_A)).status).toBe('first');
    expect((await checkUsernameKeyPin('boris', PUB_B)).status).toBe('first');
    expect((await checkUsernameKeyPin('anya', PUB_A)).status).toBe('same');
    expect((await checkUsernameKeyPin('boris', PUB_B)).status).toBe('same');
  });
});

describe('подмена ответа справочника не проходит молча', () => {
  it('другой ключ за тем же именем — расхождение с датой прежнего', async () => {
    const before = Date.now();
    await checkUsernameKeyPin('anya', PUB_A);
    const verdict = await checkUsernameKeyPin('anya', PUB_B);
    expect(verdict.status).toBe('changed');
    if (verdict.status === 'changed') {
      expect(verdict.since).toBeGreaterThanOrEqual(before);
    }
  });

  it('расхождение НЕ переписывает запомненное само', async () => {
    await checkUsernameKeyPin('anya', PUB_A);
    await checkUsernameKeyPin('anya', PUB_B);
    // Иначе предупреждение показалось бы ровно один раз, и подменённый ключ
    // стал бы «тем самым» — то есть проверка сама закрепила бы подмену.
    expect((await checkUsernameKeyPin('anya', PUB_B)).status).toBe('changed');
    expect((await checkUsernameKeyPin('anya', PUB_A)).status).toBe('same');
  });

  it('запомненное переписывается только по отдельному согласию', async () => {
    await checkUsernameKeyPin('anya', PUB_A);
    expect(await acceptUsernameKey('anya', PUB_B)).toBe(true);
    expect((await checkUsernameKeyPin('anya', PUB_B)).status).toBe('same');
    expect((await checkUsernameKeyPin('anya', PUB_A)).status).toBe('changed');
  });

  it('запись переживает забытый кэш: она в базе, а не в памяти', async () => {
    await checkUsernameKeyPin('anya', PUB_A);
    resetUsernameKeyPinCache();
    expect((await checkUsernameKeyPin('anya', PUB_B)).status).toBe('changed');
  });
});

describe('отказ базы не превращается в ложную тревогу', () => {
  it('нечитаемая запись — «не знаем», а не «сменился»', async () => {
    mockUnreadable = true;
    expect(await checkUsernameKeyPin('anya', PUB_A)).toEqual({ status: 'unknown' });
  });

  it('неудачное чтение не попадает в кэш пустотой', async () => {
    mockUnreadable = true;
    await checkUsernameKeyPin('anya', PUB_A);
    mockUnreadable = false;
    // Иначе одна заминка базы означала бы «не помним ничего» до конца сеанса, а
    // первая же запись поверх стёрла бы всё запомненное раньше.
    mockCell = JSON.stringify({ anya: { pub: PUB_A, ts: 1 } });
    expect((await checkUsernameKeyPin('anya', PUB_A)).status).toBe('same');
  });

  it('неудачная запись не выдаётся за запомненное', async () => {
    mockWriteFails = true;
    expect(await checkUsernameKeyPin('anya', PUB_A)).toEqual({ status: 'unknown' });
    mockWriteFails = false;
    // Не запомнили — значит в следующий раз спросим заново, а не соврём «same».
    expect((await checkUsernameKeyPin('anya', PUB_A)).status).toBe('first');
  });

  it('без профиля не пишем', async () => {
    mockProfileId = null;
    expect(await checkUsernameKeyPin('anya', PUB_A)).toEqual({ status: 'unknown' });
    expect(await acceptUsernameKey('anya', PUB_A)).toBe(false);
  });
});

describe('испорченная запись не разворачивается во что попало', () => {
  it('не объект — как будто ничего не помним', async () => {
    mockCell = '"anya"';
    expect((await checkUsernameKeyPin('anya', PUB_A)).status).toBe('first');
  });

  it('список — тоже', async () => {
    mockCell = JSON.stringify([{ pub: PUB_A, ts: 1 }]);
    expect((await checkUsernameKeyPin('anya', PUB_A)).status).toBe('first');
  });

  it('не разбирается вовсе — не роняет', async () => {
    mockCell = '{не json';
    expect((await checkUsernameKeyPin('anya', PUB_A)).status).toBe('first');
  });

  it('запись без ключа или без времени пропускается, соседние — нет', async () => {
    mockCell = JSON.stringify({
      anya: { pub: PUB_A },
      boris: { pub: PUB_B, ts: 'вчера' },
      vera: { pub: PUB_A, ts: 12 },
    });
    expect((await checkUsernameKeyPin('anya', PUB_B)).status).toBe('first');
    resetUsernameKeyPinCache();
    mockCell = JSON.stringify({
      anya: { pub: PUB_A },
      boris: { pub: PUB_B, ts: 'вчера' },
      vera: { pub: PUB_A, ts: 12 },
    });
    expect((await checkUsernameKeyPin('vera', PUB_B)).status).toBe('changed');
  });

  it('ключ неправдоподобной длины не запоминается', async () => {
    expect(await checkUsernameKeyPin('anya', 'x'.repeat(200))).toEqual({ status: 'unknown' });
    expect(mockCell).toBeNull();
  });
});

describe('список не растёт без предела', () => {
  it('на пределе вытесняется самое давнее, а не самое нужное', async () => {
    const pins: Record<string, { pub: string; ts: number }> = {};
    for (let i = 0; i < MAX_USERNAME_PINS; i += 1) {
      // Самое давнее — `name0`: у него наименьшее время.
      pins[`name${i}`] = { pub: PUB_A, ts: 1000 + i };
    }
    mockCell = JSON.stringify(pins);
    expect((await checkUsernameKeyPin('anya', PUB_B)).status).toBe('first');

    const after = JSON.parse(mockCell) as Record<string, unknown>;
    expect(Object.keys(after).length).toBe(MAX_USERNAME_PINS);
    expect(after.name0).toBeUndefined();
    expect(after[`name${MAX_USERNAME_PINS - 1}`]).toBeDefined();
    expect(after.anya).toBeDefined();
  });

  it('чтение обрезает переполненную запись до предела', async () => {
    const pins: Record<string, { pub: string; ts: number }> = {};
    for (let i = 0; i < MAX_USERNAME_PINS + 50; i += 1) pins[`name${i}`] = { pub: PUB_A, ts: 1000 + i };
    mockCell = JSON.stringify(pins);
    await checkUsernameKeyPin('anya', PUB_B);
    expect(Object.keys(JSON.parse(mockCell) as object).length).toBeLessThanOrEqual(MAX_USERNAME_PINS);
  });
});

describe('форма исходников: сверка стоит на пути перехода', () => {
  const read = (p: string): string => readFileSync(join(__dirname, '..', p), 'utf8');

  it('переход по имени спрашивает запомненное', () => {
    const body = read('usernameDirectory.ts');
    expect(body).toContain("import { checkUsernameKeyPin } from './usernameKeyPin';");
    expect(body).toContain('await checkUsernameKeyPin(username, answer.peerPubB64)');
    expect(body).toContain('keyChangedSince:');
  });

  it('сверка идёт после отказов, а не до них', () => {
    const body = read('usernameDirectory.ts');
    const unlisted = body.indexOf("if (!answer.peerPubB64) return { status: 'unlisted' };");
    const check = body.indexOf('await checkUsernameKeyPin(');
    expect(unlisted).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(unlisted);
  });

  it('запись под общим ключом профиля, а не своим на каждый профиль', () => {
    expect(USERNAME_KEY_PINS_KEY).toBe('username_key_pins');
    const body = read('usernameKeyPin.ts');
    // Шифрованное хранилище профиля — то же, что у списка заглушённых рядом.
    expect(body).toContain("from '../storage/profileSharedKv'");
  });

  it('карточка показывает расхождение и переспрашивает перед перепиской', () => {
    const peek = readFileSync(
      join(__dirname, '..', '..', '..', 'ui', 'components', 'UserProfilePeek.tsx'),
      'utf8',
    );
    expect(peek).toContain('keyChangedSince');
    expect(peek).toContain('За этим именем теперь другой ключ');
    // Принять новый ключ можно только действием человека.
    expect(peek).toContain('void acceptUsernameKey(usernameHint, pubB64)');
  });

  it('все три экрана доносят признак до карточки', () => {
    const ui = join(__dirname, '..', '..', '..', 'ui', 'screens');
    for (const name of ['ChatScreen.tsx', 'GroupsScreen.tsx', 'FeedScreen.tsx']) {
      expect(readFileSync(join(ui, name), 'utf8')).toContain('keyChangedSince');
    }
  });
});
