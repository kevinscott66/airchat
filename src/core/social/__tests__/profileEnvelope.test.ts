/**
 * Кодек конверта профиля. Проверяется только чистая половина: применение
 * (setPeerProfile) тянет SQLite.
 */
import {
  decodeProfileEnvelope,
  encodeProfileEnvelope,
  normalizeOwnBio,
  OWN_BIO_MAX,
  PROFILE_PREFIX,
  type PeerProfileEnvelope,
} from '../profileEnvelope';

const NOW = 1_700_000_000_000;

function base(over: Partial<PeerProfileEnvelope> = {}): PeerProfileEnvelope {
  return { name: 'Кир', bio: 'люблю горы', avatarCid: null, ts: NOW, ...over };
}

describe('profileEnvelope', () => {
  it('round-trip', () => {
    const env = base();
    expect(decodeProfileEnvelope(encodeProfileEnvelope(env), NOW)).toEqual(env);
  });

  it('сохраняет один канонический username аккаунта', () => {
    const env = decodeProfileEnvelope(encodeProfileEnvelope(base({ username: '@DobroPalm_' })), NOW);
    expect(env?.username).toBe('dobropalm_');
  });

  it('старые конверты без username остаются совместимыми', () => {
    const env = decodeProfileEnvelope(encodeProfileEnvelope(base()), NOW);
    expect(env).not.toHaveProperty('username');
  });

  it('недопустимый username не принимается как идентификатор', () => {
    const env = decodeProfileEnvelope(PROFILE_PREFIX + JSON.stringify({ ...base(), username: 'bad name' }), NOW);
    expect(env?.username).toBeNull();
  });

  it('чужой префикс и битый JSON — не наш конверт', () => {
    expect(decodeProfileEnvelope('обычное сообщение', NOW)).toBeNull();
    expect(decodeProfileEnvelope('\x13story:{}', NOW)).toBeNull();
    expect(decodeProfileEnvelope(PROFILE_PREFIX + '{не json', NOW)).toBeNull();
    expect(decodeProfileEnvelope(PROFILE_PREFIX + JSON.stringify([1, 2]), NOW)).toBeNull();
  });

  it('пустые поля допустимы — так снимают фото и стирают «О себе»', () => {
    const env = decodeProfileEnvelope(encodeProfileEnvelope(base({ bio: null, avatarCid: null })), NOW);
    expect(env).toEqual({ name: 'Кир', bio: null, avatarCid: null, ts: NOW });
    // Пустая строка — то же самое, что «не задано».
    const blank = decodeProfileEnvelope(PROFILE_PREFIX + JSON.stringify({ ...base(), bio: '   ' }), NOW);
    expect(blank?.bio).toBeNull();
  });

  it('нестроковые поля — конверт битый', () => {
    expect(decodeProfileEnvelope(PROFILE_PREFIX + JSON.stringify({ ...base(), name: 42 }), NOW)).toBeNull();
    expect(decodeProfileEnvelope(PROFILE_PREFIX + JSON.stringify({ ...base(), bio: { a: 1 } }), NOW)).toBeNull();
    expect(decodeProfileEnvelope(PROFILE_PREFIX + JSON.stringify({ ...base(), ts: 'вчера' }), NOW)).toBeNull();
    expect(decodeProfileEnvelope(PROFILE_PREFIX + JSON.stringify({ ...base(), ts: Infinity }), NOW)).toBeNull();
  });

  it('имя и «О себе» режутся, управляющие символы вырезаются', () => {
    const long = decodeProfileEnvelope(encodeProfileEnvelope(base({ name: 'я'.repeat(200), bio: 'б'.repeat(2000) })), NOW);
    expect(long?.name).toHaveLength(64);
    expect(long?.bio).toHaveLength(512);
    // U+202E переворачивает строку в списке чатов — вырезается вместе с
    // остальными управляющими и невидимыми символами.
    const rtl = decodeProfileEnvelope(encodeProfileEnvelope(base({ name: 'Кир\u202E\u200Bов' })), NOW);
    expect(rtl?.name).toBe('Киров');
  });

  it('фото: обычный CID и nb:-дескриптор проходят, подставленный адрес — нет', () => {
    const cid = 'Q'.repeat(46);
    expect(decodeProfileEnvelope(encodeProfileEnvelope(base({ avatarCid: cid })), NOW)?.avatarCid).toBe(cid);

    const nb = 'nb:' + JSON.stringify({ u: 'https://ntfy.example/file/abc', k: 'a'.repeat(43) });
    expect(decodeProfileEnvelope(encodeProfileEnvelope(base({ avatarCid: nb })), NOW)?.avatarCid).toBe(nb);

    // Фото контакта грузится само при отрисовке списка чатов — подставленный
    // адрес выдал бы IP получателя и время, когда он открыл приложение.
    for (const bad of ['../../evil.example/p.png', 'x/../../y', 'https://evil.example/p.png', '', 42]) {
      expect(decodeProfileEnvelope(PROFILE_PREFIX + JSON.stringify({ ...base(), avatarCid: bad }), NOW)).toBeNull();
    }
  });

  it('время из будущего зажимается — иначе конверт закрыл бы все следующие', () => {
    const far = decodeProfileEnvelope(encodeProfileEnvelope(base({ ts: 9e15 })), NOW);
    expect(far?.ts).toBe(NOW + 5 * 60_000);
    // Старое время не трогаем: по нему получатель отбрасывает опоздавший конверт.
    const old = decodeProfileEnvelope(encodeProfileEnvelope(base({ ts: NOW - 86_400_000 })), NOW);
    expect(old?.ts).toBe(NOW - 86_400_000);
  });

  it('гигантский конверт не разбирается', () => {
    expect(decodeProfileEnvelope(PROFILE_PREFIX + 'я'.repeat(9000), NOW)).toBeNull();
  });
});

describe('профиль: имя и «О себе» чистятся общими правилами (v4.32.374)', () => {
  const dec = (over: Record<string, unknown>): PeerProfileEnvelope | null =>
    decodeProfileEnvelope(PROFILE_PREFIX + JSON.stringify({ ...base(), ...over }), NOW);

  it('перевод строки в имени становится пробелом, а не исчезает', () => {
    // Своё правило конверта вырезало управляющий символ насовсем, и
    // «Иван<перевод строки>Петров» приезжал к собеседнику как «ИванПетров».
    expect(dec({ name: 'Иван\nПетров' })?.name).toBe('Иван Петров');
    expect(dec({ name: 'Иван\u2028Петров' })?.name).toBe('Иван Петров');
  });

  it('имя из одних невидимых символов — это отсутствие имени', () => {
    // Правило v4.32.371 конверта профиля не касалось: своя чистка проверки
    // «ничего не видно» не знала и отдавала склейку как полноценное имя.
    for (const n of ['\u200D', '\u2800\u2800', '   ', '\u3164']) {
      expect([JSON.stringify(n), dec({ name: n })?.name]).toEqual([JSON.stringify(n), null]);
    }
  });

  it('абзацы в «О себе» доезжают до собеседника', () => {
    // Поле в редакторе профиля многострочное. Владелец видел у себя абзацы, а
    // все его контакты — сплошную строку, где конец одной строки сросся с
    // началом следующей.
    const bio = 'Люблю горы.\n\nЖиву в Тбилиси.';
    expect(dec({ bio })?.bio).toBe(bio);
    expect(dec({ bio: 'Люблю горы.\nЖиву в Тбилиси.' })?.bio).toBe('Люблю горы.\nЖиву в Тбилиси.');
  });

  it('пустых строк подряд в «О себе» не больше одной', () => {
    expect(dec({ bio: 'верх' + '\n'.repeat(400) + 'низ' })?.bio).toBe('верх\n\nниз');
    expect(dec({ bio: '\n'.repeat(512) })?.bio).toBeNull();
  });

  it('управляющие символы и метки направления письма вырезаются', () => {
    expect(dec({ bio: 'отчет\u202Eexe.pdf' })?.bio).toBe('отчетexe.pdf');
    expect(dec({ bio: 'а\u0000б\u0007в' })?.bio).toBe('абв');
    expect(dec({ name: 'Кир\u202E\u200Bов' })?.name).toBe('Киров');
  });

  it('подделка системной строки не проходит ни в имени, ни в «О себе»', () => {
    expect(dec({ name: '\x0bsys:Группа переименована' })?.name).toBe('sys:Группа переименована');
    expect(dec({ bio: '\x0bsys:Вы заблокированы' })?.bio).toBe('sys:Вы заблокированы');
  });

  it('нестроковое поле по-прежнему значит «конверт битый»', () => {
    for (const v of [42, {}, ['а'], true]) {
      expect(dec({ name: v })).toBeNull();
      expect(dec({ bio: v })).toBeNull();
    }
  });
});

/**
 * v4.32.378. Чистка стояла только на приёме. Значит своё «О себе» хранилось и
 * показывалось владельцу как набрано, а контактам уезжало другим — и, что
 * важнее, уже сохранённые строки продолжали бы уезжать сырыми, сколько ни чини
 * редактор. Поэтому чистка стоит и на сборке конверта — на последней остановке
 * перед отправкой.
 */
describe('свой профиль чистится тем же правилом, что и чужой', () => {
  const enc = (over: Partial<PeerProfileEnvelope>): PeerProfileEnvelope | null =>
    decodeProfileEnvelope(encodeProfileEnvelope(base(over)), NOW);

  it('сборка конверта вычищает то, что лежит в базе сырым', () => {
    expect(enc({ bio: 'отчет‮exe.pdf' })?.bio).toBe('отчетexe.pdf');
    expect(enc({ name: 'Иван\nПетров' })?.name).toBe('Иван Петров');
    expect(enc({ bio: '‍⠀' })?.bio).toBeNull();
  });

  it('собранный конверт разбирается в самого себя', () => {
    // Чистка на сборке и на разборе — одно правило, значит второй проход по
    // уже чистой строке ничего не меняет. Иначе они разошлись бы молча.
    const once = encodeProfileEnvelope(base({ name: 'Иван\nПетров', bio: 'верх\n\n\n\nниз' }));
    const twice = encodeProfileEnvelope(decodeProfileEnvelope(once, NOW)!);
    expect(twice).toBe(once);
  });

  it('своё «О себе» перед записью — то же правило и свой предел', () => {
    expect(normalizeOwnBio('  Люблю горы.\n\nЖиву в Тбилиси.  ')).toBe('Люблю горы.\n\nЖиву в Тбилиси.');
    expect(normalizeOwnBio('отчет‮exe.pdf')).toBe('отчетexe.pdf');
    // Пустая строка значит «не задано» — так это поле и хранится.
    expect(normalizeOwnBio('   ')).toBe('');
    expect(normalizeOwnBio('‍')).toBe('');
    expect(normalizeOwnBio(null)).toBe('');
    expect(normalizeOwnBio(42)).toBe('');
    expect(normalizeOwnBio('б'.repeat(500))).toHaveLength(OWN_BIO_MAX);
  });
});
