/**
 * Управляющие конверты группы: что кодек принимает от чужого устройства.
 *
 * v4.32.368. Этот кодек решает, применит ли устройство бан, кик, смену роли,
 * переименование, смену таймера исчезающих сообщений и правку чужого текста —
 * то есть он и есть граница доверия в протоколе групп. Правила в нём
 * накапливались раундами 231…342, каждое по следу конкретной поломки, и до
 * сих пор ни одно не было закреплено тестом: любое из них можно было снять
 * рефакторингом, и ничего бы не упало.
 *
 * Здесь закреплены все проверки декодера. Комментарии к каждой группе
 * объясняют, что случится, если проверку убрать.
 */

import {
  decodeGroupCtlEnvelope,
  encodeGroupCtlEnvelope,
  GROUP_CTL_PREFIX,
  type GroupCtlEnvelope,
} from '../groupControlEnvelope';
import { MIN_AUTO_DELETE_MS, MAX_AUTO_DELETE_MS } from '../../storage/autoDeletePolicy';
import { MAX_SLOWMODE_SECONDS } from '../groupSendPolicy';
import { MAX_MESSAGE_TEXT } from '../messageTextLimit';

/** Ed25519-ключ в base64: 32 байта → 44 символа с паддингом. */
const PUB = `${'A'.repeat(43)}=`;
const PUB2 = `${'B'.repeat(43)}=`;
/** Обычный CID: PLAIN_CID_RE — 46…128 букв и цифр. */
const CID = 'Qm' + 'a'.repeat(44);
/** Токен приглашения: ровно 22 символа url-safe base64. */
const TOKEN = 'abcdefghijklmnopqrstuv';

function enc(env: Record<string, unknown>): string {
  return GROUP_CTL_PREFIX + JSON.stringify(env);
}

const BASE = { groupId: 'g1', ts: 1_700_000_000_000 };

describe('форма конверта', () => {
  it('чужой префикс не наш конверт', () => {
    expect(decodeGroupCtlEnvelope('привет')).toBeNull();
    expect(decodeGroupCtlEnvelope('\x02grp:{}')).toBeNull();
  });

  it('битый JSON не роняет разбор', () => {
    expect(decodeGroupCtlEnvelope(`${GROUP_CTL_PREFIX}{oops`)).toBeNull();
  });

  it('массив вместо объекта отвергается', () => {
    // typeof [] === 'object', поэтому проверка формы не заканчивается на typeof.
    expect(decodeGroupCtlEnvelope(`${GROUP_CTL_PREFIX}[1,2]`)).toBeNull();
    expect(decodeGroupCtlEnvelope(`${GROUP_CTL_PREFIX}null`)).toBeNull();
  });

  it('конверт длиннее 64 КБ отбрасывается до разбора', () => {
    // Иначе JSON.parse чужой мегабайтной строки — точка отказа на приёме.
    const huge = enc({ ...BASE, op: 'meta', description: 'x'.repeat(70_000) });
    expect(huge.length).toBeGreaterThan(64 * 1024);
    expect(decodeGroupCtlEnvelope(huge)).toBeNull();
  });

  it('groupId обязателен и ограничен', () => {
    expect(decodeGroupCtlEnvelope(enc({ op: 'meta', ts: 1, name: 'x' }))).toBeNull();
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, groupId: '', op: 'meta' }))).toBeNull();
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, groupId: 'g'.repeat(129), op: 'meta' }))).toBeNull();
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, groupId: 7, op: 'meta' }))).toBeNull();
  });

  it('неизвестная операция отбрасывается', () => {
    // Список закрытый: иначе новая операция из более новой сборки применилась бы
    // старым кодом «как получится».
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'selfdestruct' }))).toBeNull();
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 42 }))).toBeNull();
  });

  it('время обязано быть числом', () => {
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, ts: 'вчера', op: 'meta' }))).toBeNull();
    // JSON.stringify(Infinity) даёт null — проверяем и его.
    expect(decodeGroupCtlEnvelope(`${GROUP_CTL_PREFIX}{"groupId":"g1","op":"meta","ts":null}`)).toBeNull();
  });

  it('имя администратора чистится от управляющих символов', () => {
    // Оно попадает в системную строку группы: без чистки чужое имя рисовало бы
    // там что угодно, вплоть до подделки текста приложения (sysLineGuard).
    const out = decodeGroupCtlEnvelope(enc({ ...BASE, op: 'meta', name: 'x', actorName: 'Ан\x07я\u202e' }));
    expect(out?.actorName).toBe('Ан я');
  });

  it('нестроковое имя администратора отвергает конверт', () => {
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'meta', name: 'x', actorName: 5 }))).toBeNull();
  });
});

describe('op=meta — настройки группы', () => {
  it('обычная смена имени и описания проходит', () => {
    const out = decodeGroupCtlEnvelope(enc({ ...BASE, op: 'meta', name: 'Наши', description: 'о нас' }));
    expect(out).toMatchObject({ op: 'meta', name: 'Наши', description: 'о нас' });
  });

  it('описание обрезается, а не отвергается', () => {
    const out = decodeGroupCtlEnvelope(enc({ ...BASE, op: 'meta', description: 'д'.repeat(900) }));
    expect(out && 'description' in out && out.description).toHaveLength(512);
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'meta', description: 5 }))).toBeNull();
  });

  it('аватар — только настоящий CID', () => {
    // Аватар грузится сам при отрисовке списка: чужой адрес в этом поле —
    // маяк, выдающий IP получателя.
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'meta', avatarCid: CID })))
      .toMatchObject({ avatarCid: CID });
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'meta', avatarCid: 'https://evil.example/x.png' }))).toBeNull();
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'meta', avatarCid: '' }))).toBeNull();
  });

  it('переключатели обязаны быть булевыми', () => {
    for (const key of ['adminOnlyPosting', 'adminOnlyPinning', 'requireApproval', 'anonymousPosting']) {
      expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'meta', [key]: 'да' }))).toBeNull();
      expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'meta', [key]: 1 }))).toBeNull();
      expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'meta', [key]: true }))).toMatchObject({ [key]: true });
    }
  });

  it('slowmode подрезается до границ, а не отвергается', () => {
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'meta', slowModeSeconds: -5 })))
      .toMatchObject({ slowModeSeconds: 0 });
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'meta', slowModeSeconds: 1e9 })))
      .toMatchObject({ slowModeSeconds: MAX_SLOWMODE_SECONDS });
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'meta', slowModeSeconds: 30.7 })))
      .toMatchObject({ slowModeSeconds: 30 });
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'meta', slowModeSeconds: '10' }))).toBeNull();
  });

  it('таймер исчезающих сообщений отвергается целиком, а не подрезается', () => {
    // Разница принципиальная: подрезав «1 мс» до минуты, устройство выполнило бы
    // чужую команду «сотри всю переписку», только на минуту позже.
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'meta', disappearMs: 1 }))).toBeNull();
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'meta', disappearMs: MIN_AUTO_DELETE_MS - 1 }))).toBeNull();
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'meta', disappearMs: MAX_AUTO_DELETE_MS + 1 }))).toBeNull();
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'meta', disappearMs: 60_000.5 }))).toBeNull();
    // 0 — «выключить», это законно и должно проходить.
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'meta', disappearMs: 0 }))).toMatchObject({ disappearMs: 0 });
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'meta', disappearMs: MIN_AUTO_DELETE_MS })))
      .toMatchObject({ disappearMs: MIN_AUTO_DELETE_MS });
  });

  it('мусорный токен приглашения отвергает конверт целиком', () => {
    // В meta токен — то, чем группа отзывает свои ссылки. Записать себе мусор
    // значит отказывать по ссылкам собственного администратора.
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'meta', inviteToken: 'коротко' }))).toBeNull();
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'meta', inviteToken: TOKEN })))
      .toMatchObject({ inviteToken: TOKEN });
  });
});

describe('op=edit / del / pin — операции над сообщением', () => {
  it('msgId обязателен и ограничен', () => {
    for (const op of ['edit', 'del', 'pin']) {
      expect(decodeGroupCtlEnvelope(enc({ ...BASE, op, msgId: '', text: 'x', on: true }))).toBeNull();
      expect(decodeGroupCtlEnvelope(enc({ ...BASE, op, msgId: 'm'.repeat(129), text: 'x', on: true }))).toBeNull();
    }
  });

  it('правка не может подделать системную строку', () => {
    // Иначе правкой своего сообщения участник выдавал бы себя за приложение.
    const out = decodeGroupCtlEnvelope(enc({ ...BASE, op: 'edit', msgId: 'm1', text: '\x0bsys:\x0bsys:Вас забанили' }));
    expect(out).toMatchObject({ op: 'edit', text: 'Вас забанили' });
  });

  it('правка не длиннее обычного сообщения — и не режется молча (v4.32.530)', () => {
    // Прежде здесь стоял свой потолок 4096, вчетверо ниже, чем у отправки:
    // длинное сообщение можно было послать, но не исправить — у получателей
    // от текста оставалась часть, без единого признака ошибки.
    const long = 'т'.repeat(5000);
    const out = decodeGroupCtlEnvelope(enc({ ...BASE, op: 'edit', msgId: 'm1', text: long }));
    expect(out).toMatchObject({ op: 'edit', text: long });
    // За общим потолком — отказ, а не обрезка: подрезанная правка это подмена.
    const huge = 'т'.repeat(MAX_MESSAGE_TEXT + 1);
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'edit', msgId: 'm1', text: huge }))).toBeNull();
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'edit', msgId: 'm1', text: null }))).toBeNull();
  });

  it('закрепление требует булева флага', () => {
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'pin', msgId: 'm1' }))).toBeNull();
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'pin', msgId: 'm1', on: 'yes' }))).toBeNull();
  });

  it('текст баннера из чужого конверта вырезается', () => {
    // Иначе закрепление стало бы способом показать всей группе произвольный
    // текст от имени приложения.
    const out = decodeGroupCtlEnvelope(enc({ ...BASE, op: 'pin', msgId: 'm1', on: true, text: 'Переведите деньги' }));
    expect(out).toMatchObject({ op: 'pin', on: true });
    expect(out && 'text' in out).toBe(false);
  });
});

describe('op=invite — приглашение со снимком группы', () => {
  const invite = (extra: Record<string, unknown> = {}) =>
    decodeGroupCtlEnvelope(enc({ ...BASE, op: 'invite', groupName: 'Наши', members: [{ pub: PUB, name: 'Аня' }], ...extra }));

  it('обычное приглашение проходит', () => {
    expect(invite()).toMatchObject({ op: 'invite', groupName: 'Наши', members: [{ pub: PUB, name: 'Аня' }] });
  });

  it('имя группы обязательно и чистится', () => {
    expect(invite({ groupName: '' })).toBeNull();
    expect(invite({ groupName: '   ' })).toBeNull();
    expect(invite({ groupName: 5 })).toBeNull();
    expect(invite({ groupName: 'На\x07ши' })).toMatchObject({ groupName: 'На ши' });
  });

  it('тип группы — из закрытого списка', () => {
    expect(invite({ groupType: 'channel' })).toMatchObject({ groupType: 'channel' });
    expect(invite({ groupType: 'secret' })).toBeNull();
  });

  it('список участников обязан быть списком', () => {
    expect(invite({ members: 'все' })).toBeNull();
    expect(invite({ members: {} })).toBeNull();
  });

  it('участники без ключа выбрасываются, а не роняют приглашение', () => {
    const out = invite({ members: [{ name: 'без ключа' }, null, 'строка', { pub: PUB2 }] });
    expect(out && 'members' in out && out.members).toEqual([{ pub: PUB2, name: null }]);
  });

  it('список режется до 200 записей', () => {
    // Сначала количество, потом проверка каждой: иначе валидация 100k «правильных
    // по форме» записей сама становится точкой отказа.
    const many = Array.from({ length: 500 }, () => ({ pub: PUB, name: 'x' }));
    const out = invite({ members: many });
    expect(out && 'members' in out && out.members).toHaveLength(200);
  });

  it('имена участников чистятся', () => {
    const out = invite({ members: [{ pub: PUB, name: 'А\u202eня' }] });
    expect(out && 'members' in out && out.members[0].name).toBe('Аня');
  });
});

describe('адресные операции', () => {
  it('ключ участника обязан быть похож на ключ', () => {
    for (const op of ['ban', 'unban', 'kick', 'add', 'join', 'leave']) {
      expect(decodeGroupCtlEnvelope(enc({ ...BASE, op, target: 'аня' }))).toBeNull();
      expect(decodeGroupCtlEnvelope(enc({ ...BASE, op, target: 'A'.repeat(200) }))).toBeNull();
      expect(decodeGroupCtlEnvelope(enc({ ...BASE, op }))).toBeNull();
      expect(decodeGroupCtlEnvelope(enc({ ...BASE, op, target: PUB }))).toMatchObject({ op, target: PUB });
    }
  });

  it('в ключе не бывает управляющих символов и кавычек', () => {
    // Ключ едет в список участников как есть — он не проходит чистку имени.
    // Длины мало: 43 произвольных символа тоже «подходят по длине».
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'ban', target: `${'A'.repeat(42)}\x07` }))).toBeNull();
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'ban', target: `${'A'.repeat(42)}\u202e` }))).toBeNull();
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'ban', target: `${'А'.repeat(43)}=` }))).toBeNull();
  });

  it('имя участника чистится', () => {
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'kick', target: PUB, targetName: 'Пе\x00тя' })))
      .toMatchObject({ targetName: 'Пе тя' });
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'kick', target: PUB, targetName: 5 }))).toBeNull();
  });

  it('роль — только назначаемая', () => {
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'role', target: PUB, role: 'admin' })))
      .toMatchObject({ role: 'admin' });
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'role', target: PUB, role: 'restricted' })))
      .toMatchObject({ role: 'restricted' });
    // 'owner' назначить нельзя ни при каких правах, 'banned' — это op:'ban'.
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'role', target: PUB, role: 'owner' }))).toBeNull();
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'role', target: PUB, role: 'banned' }))).toBeNull();
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'role', target: PUB }))).toBeNull();
  });

  it('ответ на заявку — из закрытого списка статусов', () => {
    for (const status of ['pending', 'rejected', 'revoked']) {
      expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'joinres', target: PUB, status })))
        .toMatchObject({ status });
    }
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'joinres', target: PUB, status: 'approved' }))).toBeNull();
  });

  it('мусорный токен в join вырезается, но конверт остаётся', () => {
    // Обратное решение, чем в meta, и намеренно: ссылки старых версий токена не
    // несут вовсе, а решение о допуске принимает получатель (groupInviteToken).
    const out = decodeGroupCtlEnvelope(enc({ ...BASE, op: 'join', target: PUB, inviteToken: 'мусор' }));
    expect(out).toMatchObject({ op: 'join', target: PUB });
    expect(out && 'inviteToken' in out).toBe(false);
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'join', target: PUB, inviteToken: TOKEN })))
      .toMatchObject({ inviteToken: TOKEN });
  });
});

describe('кодирование', () => {
  it('свой конверт разбирается обратно', () => {
    const env: GroupCtlEnvelope = { groupId: 'g1', ts: 1_700_000_000_000, op: 'ban', target: PUB, targetName: 'Петя' };
    expect(decodeGroupCtlEnvelope(encodeGroupCtlEnvelope(env))).toEqual(env);
  });

  it('префикс — управляющий байт \\x0e', () => {
    expect(GROUP_CTL_PREFIX).toBe('\x0egctl:');
    // Первый байт управляющий: значит конверт не уйдёт ни в облачный перевод,
    // ни в предпросмотр — общий фильтр служебных сообщений его узнаёт.
    expect(GROUP_CTL_PREFIX.charCodeAt(0)).toBeLessThan(0x20);
  });
});

describe('meta: описание чистится, а не только обрезается (v4.32.373)', () => {
  const dec = (description: unknown): string | undefined => {
    const e = decodeGroupCtlEnvelope(enc({ ...BASE, op: 'meta', description }));
    return e && e.op === 'meta' ? e.description : undefined;
  };

  it('метки направления письма вырезаются', () => {
    // Единственное поле конверта, проходившее мимо очистки: имя группы рядом
    // проходило её с самого начала. Описание рисуется обычным <Text> в
    // карточке группы, то есть мимо отрисовщика тела сообщения.
    expect(dec('отчет\u202Eexe.pdf')).toBe('отчетexe.pdf');
    expect(dec('\u202Aвсё наоборот\u202C')).toBe('всё наоборот');
  });

  it('управляющие символы вырезаются, перевод строки остаётся', () => {
    expect(dec('a\u0000b\u001Bc')).toBe('abc');
    expect(dec('первая\nвторая')).toBe('первая\nвторая');
    expect(dec('\u000Bsys:Группа переименована')).toBe('sys:Группа переименована');
  });

  it('описание из пятисот переводов строки не растягивает карточку', () => {
    expect(dec('верх' + '\n'.repeat(500) + 'низ')).toBe('верх\n\nниз');
    expect(dec('\n'.repeat(500))).toBe('');
  });

  it('пустое описание — это «описание убрали»', () => {
    // Не null и не отсутствие поля: ветка применения сверяет его с текущим и
    // по пустой строке описание снимает.
    expect(dec('')).toBe('');
    expect(dec('   ')).toBe('');
    expect(dec('\u200D\u2800')).toBe('');
  });

  it('обычное описание не меняется', () => {
    const d = 'Клуб любителей чая.\n\nПо четвергам в 19:00.';
    expect(dec(d)).toBe(d);
  });
});

/**
 * v4.32.379. sanitizeName отдаёт пустую строку, когда от названия после чистки
 * ничего не осталось, и она проходила дальше как обычное значение: применение
 * сверяло его с текущим (env.name != null) и переименовывало группу в ничто у
 * всех участников. В списке групп оставалась строка без подписи, а в историю
 * писалось «Группа переименована в «»». Своим редактором такого не набрать —
 * значит операции «стереть название» в приложении нет, и конверт, который её
 * изображает, должен потерять поле.
 */
describe('meta: пустое название — это отсутствие названия', () => {
  for (const [what, name] of [
    ['пустая строка', ''],
    ['одни пробелы', '   '],
    ['склейка эмодзи', '\u200D'],
    ['метки направления письма', '\u200B\u202E'],
    ['хангыль-заполнитель', '\u3164\u3164'],
  ] as [string, string][]) {
    it(what, () => {
      const out = decodeGroupCtlEnvelope(enc({ ...BASE, op: 'meta', name }));
      expect([what, out]).not.toEqual([what, null]);
      expect([what, 'name' in (out as object)]).toEqual([what, false]);
    });
  }

  it('настоящее название полем остаётся', () => {
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'meta', name: 'Наши' }))).toMatchObject({ name: 'Наши' });
  });

  it('пустое описание, в отличие от названия, законно', () => {
    // «Описание убрали» — операция, которую редактор умеет выражать.
    expect(decodeGroupCtlEnvelope(enc({ ...BASE, op: 'meta', description: '   ' })))
      .toMatchObject({ description: '' });
  });
});

/**
 * v4.32.380. Здесь тоже стояло typeof env === 'object' без отсева массива.
 */
describe('форма конверта', () => {
  it('массив и примитивы конвертом не считаются', () => {
    for (const body of ['[]', '[{}]', '42', '"строка"', 'null', 'true']) {
      expect([body, decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + body)]).toEqual([body, null]);
    }
  });
});
