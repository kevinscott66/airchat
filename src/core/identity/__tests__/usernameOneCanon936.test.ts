/**
 * Один канон «@имени» — на клиенте, на сервере и во входящем конверте
 * (v4.32.936).
 *
 * Дефект. Определений у «@имени» в приложении было четыре, и они расходились.
 * `normalizeUsername` держал протокольные 3–32 символа. `checkUsernameClaim`
 * добавлял список занятых слов и порог самостоятельного занятия, но нижнюю
 * границу протокола проверял последним словом — и отказывал с причиной
 * `charset`, то есть говорил человеку про символы там, где дело было в длине.
 * Сервер той границы не имел совсем, а справочный запрос на нём принимал имена
 * от одного символа. Групповой же адрес из входящего конверта проверялся ТОЛЬКО
 * на форму: список занятых слов к нему не применялся вовсе.
 *
 * Цена. Изменённый клиент ставил своей группе публичный адрес `@support`, и
 * чужие приложения рисовали его в шапке рядом с названием — ровно та вывеска,
 * ради запрета которой список и заведён. Отдельно: имя из одной-двух букв,
 * выписанное бумагой, сервер записывал в реестр навсегда, а дойти по нему до
 * аккаунта было нельзя — все пути разбора «@имени» в приложении идут через
 * `normalizeUsername`.
 *
 * Правка. Нижняя граница протокола стала абсолютной и явной на обеих сторонах;
 * справочный запрос выровнен по ней же; входящий конверт разбирается тем же
 * `checkUsernameClaim`, что и своё поле ввода, с разделением «это не адрес» и
 * «такой адрес занять нельзя».
 *
 * Границы. Здесь сверяются ПРАВИЛА. Совпадение ответов клиента и сервера на
 * общем наборе имён проверяет `usernameServerMirror.test.ts`, совпадение самих
 * списков — серверный `username-registry.test.js`.
 */
import { checkUsernameClaim, USERNAME_MIN, USERNAME_MIN_SELF_SERVICE } from '../reservedUsernames';
import { normalizeUsername } from '../username';
import { parseGroupHandleFromEnvelope } from '../../social/groupHandle';
import { decodeGroupCtlEnvelope, encodeGroupCtlEnvelope, type GroupCtlEnvelope } from '../../social/groupControlEnvelope';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const server = require('../../../../server/cloud-vault/reserved-usernames.js') as {
  normalizeClaimableUsername: (value: unknown, unlocked?: unknown) => string | null;
  normalizeLookupUsername: (value: unknown) => string | null;
  USERNAME_MIN: number;
};

type MetaEnvelope = Extract<GroupCtlEnvelope, { op: 'meta' }>;

/** Разбор с сужением до 'meta': поля названия и адреса есть только у него. */
const decodeMeta = (text: string): MetaEnvelope | null =>
  decodeGroupCtlEnvelope(text) as MetaEnvelope | null;

/** Конверт 'meta' с чужого устройства: название законное, адрес — по случаю. */
const meta = (username: unknown): string =>
  encodeGroupCtlEnvelope({
    groupId: 'g1',
    ts: 1_700_000_000_000,
    op: 'meta',
    name: 'Кафе',
    username,
  } as unknown as GroupCtlEnvelope);

describe('одно определение «@имени» на все стороны', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: конверт с законным адресом проходит целиком', () => {
    const env = decodeMeta(meta('AirCafe'));
    expect(env).not.toBeNull();
    expect(env?.name).toBe('Кафе');
    expect(env?.username).toBe('aircafe');
    expect(USERNAME_MIN).toBe(3);
    expect(USERNAME_MIN_SELF_SERVICE).toBeGreaterThan(USERNAME_MIN);
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: у группы нет бумаги, которой можно было бы открыть список', () => {
    // Послабление на входе было списано с аккаунтов, где короткое имя выдаётся
    // сервером. Проверяем, что у группового разбора такого входа просто нет:
    // функция принимает один аргумент.
    expect(parseGroupHandleFromEnvelope.length).toBe(1);
  });

  it('нижняя граница протокола одна и та же у клиента и у сервера', () => {
    expect(server.USERNAME_MIN).toBe(USERNAME_MIN);
  });

  it('бумага не открывает нижнюю границу протокола', () => {
    for (const short of ['a', 'ab', 'a_']) {
      expect(checkUsernameClaim(short, short)).toEqual({ ok: false, reason: 'too_short' });
      expect(server.normalizeClaimableUsername(short, short)).toBeNull();
    }
  });

  it('про длину человеку говорят «коротко», а не «не те символы»', () => {
    // Раньше отказ приходил последним словом, из нормализатора, с причиной
    // `charset`: экран показывал подсказку про латиницу и подчёркивание.
    const r = checkUsernameClaim('ab', 'ab');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('too_short');
  });

  it('справочный запрос спрашивает ровно про те имена, которые можно занять', () => {
    expect(server.normalizeLookupUsername('a')).toBeNull();
    expect(server.normalizeLookupUsername('ab')).toBeNull();
    // Занятые и короткие для САМОСТОЯТЕЛЬНОГО занятия имена спросить можно:
    // они существуют, и справка о них честная.
    expect(server.normalizeLookupUsername('nft')).toBe('nft');
    expect(server.normalizeLookupUsername(' @Support ')).toBe('support');
    expect(server.normalizeLookupUsername('a'.repeat(33))).toBeNull();
  });

  it('конверт не занимает адрес, которого не занять своим экраном', () => {
    for (const taken of ['support', 'official', 'nft', 'abc']) {
      expect(checkUsernameClaim(taken).ok).toBe(false);
      expect(parseGroupHandleFromEnvelope(taken).kind).toBe('refused');
    }
  });

  it('отказ по адресу не отбрасывает название и описание', () => {
    // Название менять отправитель вправе; выпадает одно поле, и применяющая
    // сторона его пропускает, потому что гейт у неё — `username != null`.
    const env = decodeMeta(meta('support'));
    expect(env).not.toBeNull();
    expect(env?.name).toBe('Кафе');
    expect(env?.username).toBeUndefined();
    expect('username' in (env as object)).toBe(false);
  });

  it('мусор в адресе по-прежнему отбрасывает конверт целиком', () => {
    for (const junk of ['air cafe', 'Аня', '@@', 'a'.repeat(33), 42]) {
      expect(decodeGroupCtlEnvelope(meta(junk))).toBeNull();
    }
  });

  it('пустая строка — это «адрес убрали», а не мусор', () => {
    const env = decodeMeta(meta(''));
    expect(env).not.toBeNull();
    expect(env?.username).toBe('');
  });

  it('канон один: что принял конверт, то принял бы и экран', () => {
    const NAMES = [
      'aircafe', 'air_cafe', 'a12345', 'support', 'nft', 'abc', 'ab', 'a',
      '12345', 'AirCafe', ' @AirCafe ', 'air cafe', 'Аня', '', 'a'.repeat(33),
    ];
    for (const name of NAMES) {
      const parsed = parseGroupHandleFromEnvelope(name);
      const claim = checkUsernameClaim(name);
      expect(parsed.kind === 'ok').toBe(claim.ok);
      if (parsed.kind === 'ok' && claim.ok) expect(parsed.handle).toBe(claim.username);
      // И форма — из одного источника.
      if (parsed.kind !== 'malformed') expect(normalizeUsername(name)).not.toBeNull();
    }
  });
});
