/**
 * Собственное имя: очистка и единственный ключ kv.
 *
 * Здесь же зафиксировано главное, из-за чего появился модуль: читать имя надо
 * ровно из того ключа, в который его пишут. До v4.32.287 шесть мест читали
 * `user_display_name`, которого не писал никто.
 */
jest.mock('../../storage/local', () => {
  const kv: Record<string, string> = {};
  // Шифрование подменено обратимым префиксом: здесь проверяется, что в kv
  // ложится не открытый текст и что читается ровно записанное. Сам XChaCha20 —
  // в storage/__tests__/localEncryption.test.ts.
  const PREFIX = 'enc2:';
  let writesFail = false;
  const kvGet = jest.fn(async (key: string) => kv[key] ?? null);
  const kvSet = jest.fn(async (key: string, value: string) => { kv[key] = value; });
  const kvDelete = jest.fn(async (key: string) => { delete kv[key]; });
  const kvSetSecret = jest.fn(async (key: string, value: string) => {
    if (writesFail) return false;
    kv[key] = PREFIX + value;
    return true;
  });
  const kvGetSecret = jest.fn(async (key: string) => {
    const stored = kv[key];
    if (stored == null) return null;
    return stored.startsWith(PREFIX) ? stored.slice(PREFIX.length) : stored;
  });
  const kvGetSecretUpgrading = jest.fn(async (key: string) => {
    const stored = kv[key];
    if (stored == null) return null;
    if (stored.startsWith(PREFIX)) return stored.slice(PREFIX.length);
    await kvSetSecret(key, stored);
    return stored;
  });
  return {
    __kv: kv,
    __prefix: PREFIX,
    __failWrites: (on: boolean) => { writesFail = on; },
    kvGet,
    kvSet,
    kvDelete,
    kvGetSecret,
    kvSetSecret,
    kvGetSecretUpgrading,
    // Как в storage/local: тонкая обёртка с префиксом `p{id}:` — тесты
    // проверяют настоящее скоупирование, а не упрощённую заглушку.
    kvSetSecretScoped: jest.fn(async (profileId: number, key: string, value: string) =>
      kvSetSecret(`p${profileId}:${key}`, value)),
  };
});

// profileManager тянет SecureStore и Keystore — в тестах подменяем активный профиль.
let mockActiveProfile: { id: number; name: string } | null = { id: 1, name: 'Личный' };
// v4.32.478: имя по номеру профиля — настоящий profileManager берёт его из
// состояния, а не из активного профиля, поэтому и заглушка ищет по списку.
let mockProfiles: { id: number; name: string }[] = [];
jest.mock('../profileManager', () => ({
  profileManager: {
    getActiveProfile: () => mockActiveProfile,
    getProfileName: (pid: number) =>
      mockProfiles.find((row) => row.id === pid)?.name
      ?? (mockActiveProfile?.id === pid ? mockActiveProfile.name : null),
  },
}));

import {
  OWN_DISPLAY_NAME_KEY,
  OWN_DISPLAY_NAME_MAX,
  getOwnDisplayName,
  ownFieldGet,
  ownFieldSet,
  sanitizeOwnDisplayName,
  stripOwnDisplayName,
} from '../ownProfile';

const mockLocal = jest.requireMock('../../storage/local') as {
  __kv: Record<string, string>;
  __prefix: string;
  __failWrites: (on: boolean) => void;
};

beforeEach(() => {
  for (const k of Object.keys(mockLocal.__kv)) delete mockLocal.__kv[k];
  mockLocal.__failWrites(false);
  mockActiveProfile = { id: 1, name: 'Личный' };
  mockProfiles = [];
});

describe('stripOwnDisplayName', () => {
  it('оставляет обычное имя как есть', () => {
    expect(stripOwnDisplayName('Аня')).toBe('Аня');
  });

  it('обрезает пробелы по краям', () => {
    expect(stripOwnDisplayName('  Аня  ')).toBe('Аня');
  });

  it('вырезает управляющие символы', () => {
    expect(stripOwnDisplayName('Аня\u0000\u001F')).toBe('Аня');
  });

  it('вырезает zero-width и RTL-override', () => {
    // U+202E переворачивает показ строки — им подделывают вид имени.
    expect(stripOwnDisplayName('\u200BАня\u202E\uFEFF')).toBe('Аня');
  });

  it('не обрезает по длине — это дело sanitizeOwnDisplayName', () => {
    const long = 'я'.repeat(OWN_DISPLAY_NAME_MAX + 10);
    expect(stripOwnDisplayName(long)).toHaveLength(OWN_DISPLAY_NAME_MAX + 10);
  });

  it('null и undefined дают пустую строку', () => {
    expect(stripOwnDisplayName(null)).toBe('');
    expect(stripOwnDisplayName(undefined)).toBe('');
  });

  it('U+200C внутри имени остаётся: без неё не пишется фарси (v4.32.369)', () => {
    // Общее правило вычистки, на которое перешла функция, U+200C и U+200D
    // оставляет намеренно — старый свой список вырезал их вместе со всем
    // диапазоном U+200B…U+200F.
    expect(stripOwnDisplayName('\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645')).toBe('\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645');
  });

  it('изоляторы направления письма тоже вырезаются (v4.32.369)', () => {
    // U+2066…U+2069 переставляют текст так же, как U+202E, но в прежнем
    // списке их не было.
    expect(stripOwnDisplayName('Аня\u2067Админ')).toBe('АняАдмин');
    expect(stripOwnDisplayName('Аня\u061cАдмин')).toBe('АняАдмин');
    expect(stripOwnDisplayName('Аня\u2028Админ')).toBe('АняАдмин');
    expect(stripOwnDisplayName('Аня\u0085Админ')).toBe('АняАдмин');
  });

  it('имя из одних невидимых символов схлопывается в пустое', () => {
    expect(stripOwnDisplayName('\u200B\u200C\u202E')).toBe('');
  });

  it('список невидимых теперь общий с именами из сети (v4.32.371)', () => {
    // Своё правило знало только U+200C и U+200D. Пустой символ Брайля и
    // хангыль-заполнители — то, чем набивают пустое имя обычно, — оно не
    // ловило вовсе, и проверка «имя не задано» пропускала такое имя.
    for (const s of ['\u2800\u2800', '\u3164', '\uFFA0', '\u115F\u1160', '\u180E', '\u17B4']) {
      expect([s, stripOwnDisplayName(s)]).toEqual([s, '']);
    }
  });
});

describe('sanitizeOwnDisplayName: обрезка может срезать всё видимое (v4.32.371)', () => {
  it('имя, у которого в предел попала только невидимая часть, — пустое', () => {
    // Проверка «ничего не видно» стояла ДО обрезки: строка видима целиком,
    // а показывается от неё только первая, невидимая половина.
    const name = '\u200D'.repeat(OWN_DISPLAY_NAME_MAX) + 'Аня';
    expect(stripOwnDisplayName(name)).not.toBe('');
    expect(sanitizeOwnDisplayName(name)).toBe('');
  });

  it('имя, укладывающееся в предел вместе с видимой частью, остаётся', () => {
    expect(sanitizeOwnDisplayName('\u200D'.repeat(5) + 'Аня')).toContain('Аня');
  });
});

describe('sanitizeOwnDisplayName', () => {
  it('обрезает до предела длины', () => {
    expect(sanitizeOwnDisplayName('я'.repeat(100))).toHaveLength(OWN_DISPLAY_NAME_MAX);
  });

  it('невидимые символы не съедают предел: имя длиннее предела только с ними — влезает', () => {
    const name = 'я'.repeat(OWN_DISPLAY_NAME_MAX) + '\u200B'.repeat(10);
    expect(sanitizeOwnDisplayName(name)).toHaveLength(OWN_DISPLAY_NAME_MAX);
  });

  it('не оставляет висящий пробел после обрезки', () => {
    const name = 'я'.repeat(OWN_DISPLAY_NAME_MAX - 1) + ' хвост';
    expect(sanitizeOwnDisplayName(name)).toBe('я'.repeat(OWN_DISPLAY_NAME_MAX - 1));
  });
});

describe('getOwnDisplayName', () => {
  it('читает тот же ключ, в который пишут экраны профиля и регистрации', async () => {
    mockLocal.__kv[OWN_DISPLAY_NAME_KEY] = 'Аня';
    expect(await getOwnDisplayName()).toBe('Аня');
  });

  it('пока имя не сохранено — имя профиля, под которым его завели', async () => {
    expect(await getOwnDisplayName()).toBe('Личный');
  });

  it('null, когда нет ни имени, ни профиля', async () => {
    mockActiveProfile = null;
    expect(await getOwnDisplayName()).toBeNull();
  });

  it('null, когда в имени остались одни невидимые символы', async () => {
    mockActiveProfile = null;
    mockLocal.__kv[OWN_DISPLAY_NAME_KEY] = '\u200B\u202E';
    expect(await getOwnDisplayName()).toBeNull();
  });

  it('чистит имя, записанное до появления правила', async () => {
    mockLocal.__kv[OWN_DISPLAY_NAME_KEY] = '\u202EАня\u200B';
    expect(await getOwnDisplayName()).toBe('Аня');
  });

  it('ключ — user_username, а не user_display_name (тот не писал никто)', async () => {
    mockLocal.__kv['user_display_name'] = 'Не отсюда';
    mockLocal.__kv['user_username'] = 'Аня';
    expect(OWN_DISPLAY_NAME_KEY).toBe('user_username');
    expect(await getOwnDisplayName()).toBe('Аня');
  });
});

describe('карточка профиля по профилям', () => {
  it('пишется под ключ с префиксом профиля', async () => {
    mockActiveProfile = { id: 2, name: 'Второй' };
    await ownFieldSet('user_bio', 'обо мне');
    expect(mockLocal.__kv['p2:user_bio']).toBe(`${mockLocal.__prefix}обо мне`);
    expect(mockLocal.__kv['user_bio']).toBeUndefined();
  });

  it('второй профиль не видит карточку первого', async () => {
    await ownFieldSet('user_bio', 'первый');
    mockActiveProfile = { id: 2, name: 'Второй' };
    expect(await ownFieldGet('user_bio')).toBeNull();
  });

  it('второй профиль не видит и общую запись до v4.32.288', async () => {
    mockLocal.__kv['user_bio'] = 'общая запись';
    mockActiveProfile = { id: 2, name: 'Второй' };
    expect(await ownFieldGet('user_bio')).toBeNull();
  });

  it('первый профиль наследует общую запись до v4.32.288', async () => {
    mockLocal.__kv['user_avatar_uri'] = 'file:///старый.jpg';
    expect(await ownFieldGet('user_avatar_uri')).toBe('file:///старый.jpg');
  });

  it('своя запись первого профиля важнее общей', async () => {
    mockLocal.__kv['user_bio'] = 'старое';
    await ownFieldSet('user_bio', 'новое');
    expect(await ownFieldGet('user_bio')).toBe('новое');
  });

  it('пустая строка — это значение, а не «нет записи»', async () => {
    mockLocal.__kv['user_bio'] = 'старое';
    await ownFieldSet('user_bio', '');
    expect(await ownFieldGet('user_bio')).toBe('');
  });

  it('правка во втором профиле не трогает первый', async () => {
    await ownFieldSet('user_bio', 'первый');
    mockActiveProfile = { id: 2, name: 'Второй' };
    await ownFieldSet('user_bio', 'второй');
    mockActiveProfile = { id: 1, name: 'Личный' };
    expect(await ownFieldGet('user_bio')).toBe('первый');
  });

  it('имя второго профиля — своё, а не имя первого', async () => {
    await ownFieldSet(OWN_DISPLAY_NAME_KEY, 'Аня');
    mockActiveProfile = { id: 2, name: 'Рабочий' };
    expect(await getOwnDisplayName()).toBe('Рабочий');
  });

  it('после правки имени во втором профиле показывается оно', async () => {
    mockActiveProfile = { id: 2, name: 'Рабочий' };
    await ownFieldSet(OWN_DISPLAY_NAME_KEY, 'Анна Петровна');
    expect(await getOwnDisplayName()).toBe('Анна Петровна');
  });
});

/**
 * v4.32.306. Карточка — имя, «о себе», ссылки, аватар — была одним из
 * последних мест, где открытая база прямым текстом отвечала, чей это телефон.
 */
describe('карточка не лежит открытым текстом', () => {
  it('в kv попадает шифртекст, а не то, что ввёл человек', async () => {
    await ownFieldSet('user_bio', 'работаю в банке');
    // Подмена шифрования обратима, поэтому проверяем сам факт: значение прошло
    // через kvSetSecret, а не через kvSet.
    expect(mockLocal.__kv['p1:user_bio']).toBe(`${mockLocal.__prefix}работаю в банке`);
    expect(await ownFieldGet('user_bio')).toBe('работаю в банке');
  });

  it('дескриптор аватара тоже: он несёт ключ расшифровки файла', async () => {
    // Тот же случай, что avatar_cid группы в v4.32.304.
    await ownFieldSet('user_avatar_cid', 'nb:ключ-и-адрес');
    expect(mockLocal.__kv['p1:user_avatar_cid']).toBe(`${mockLocal.__prefix}nb:ключ-и-адрес`);
  });

  it('записанное открытым текстом дошифровывается при первом чтении', async () => {
    mockLocal.__kv['p1:user_username'] = 'Аня';
    expect(await ownFieldGet('user_username')).toBe('Аня');
    expect(mockLocal.__kv['p1:user_username']).toBe(`${mockLocal.__prefix}Аня`);
  });

  it('общая запись до v4.32.288 забирается, а не остаётся зеркалом', async () => {
    // Зеркало заводили ради отката на прошлую версию, но прошлая версия
    // шифртекст всё равно не прочитает — а открытая копия карточки осталась бы
    // в базе навсегда.
    mockLocal.__kv['user_bio'] = 'старое';
    expect(await ownFieldGet('user_bio')).toBe('старое');
    expect(mockLocal.__kv['user_bio']).toBeUndefined();
    expect(mockLocal.__kv['p1:user_bio']).toBe(`${mockLocal.__prefix}старое`);
  });

  it('запись первого профиля не оставляет открытой копии в общем ключе', async () => {
    mockLocal.__kv['user_bio'] = 'старое';
    await ownFieldSet('user_bio', 'новое');
    expect(mockLocal.__kv['user_bio']).toBeUndefined();
    expect(await ownFieldGet('user_bio')).toBe('новое');
  });

  it('не зашифровалось — не записалось и не соврало', async () => {
    // v4.32.293: молча откатиться к открытому тексту значит вернуть ту самую
    // дыру; промолчать о провале — сказать человеку «сохранено» впустую.
    mockLocal.__failWrites(true);
    expect(await ownFieldSet('user_bio', 'секрет')).toBe(false);
    expect(Object.values(mockLocal.__kv)).not.toContain('секрет');
  });

  it('не зашифровалось при переносе общей записи — она не удаляется', async () => {
    mockLocal.__kv['user_bio'] = 'старое';
    mockLocal.__failWrites(true);
    expect(await ownFieldGet('user_bio')).toBe('старое');
    expect(mockLocal.__kv['user_bio']).toBe('старое');
  });
});
