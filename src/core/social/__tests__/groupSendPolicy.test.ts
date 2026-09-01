/**
 * Право на отправку в группу.
 *
 * Функция вызывается в трёх местах: композер решает, показывать ли поле ввода;
 * fanoutGroupMessage решает, уходит ли сообщение в сеть; приёмник решает,
 * записывать ли входящее. Расхождение любых двух означает либо тихо теряемое
 * сообщение, либо дыру — поэтому вердикт зафиксирован тестами, а сама функция
 * не имеет импортов и одинаково доступна всем трём.
 *
 * До 4.32.234 проверка существовала, но не срабатывала ни разу: она была
 * написана против модели groupStorage.ts, приводилась к живой модели через
 * `as unknown`, падала на отсутствующем поле и глоталась внешним catch.
 */

import {
  canInteractInGroup,
  canApplyGroupMessageOp,
  canSendToGroup,
  mediaKindOfText,
  slowModeRemaining,
  formatSlowMode,
  slowModeSysLine,
  MAX_SLOWMODE_SECONDS,
  type SendRole,
} from '../groupSendPolicy';
import { SYS_LINE_PREFIX, stripSpoofedSysPrefix } from '../sysLineGuard';

const ROLES: SendRole[] = ['owner', 'admin', 'member', 'restricted', 'banned'];

describe('canSendToGroup', () => {
  it('владелец и админ пишут при любых настройках', () => {
    for (const role of ['owner', 'admin'] as SendRole[]) {
      for (const type of ['group', 'channel', 'supergroup'] as const) {
        for (const adminOnlyPosting of [true, false]) {
          expect(canSendToGroup({ role, type, adminOnlyPosting }).allowed).toBe(true);
        }
      }
    }
  });

  it('не участник — отказ', () => {
    const v = canSendToGroup({ role: null, type: 'group', adminOnlyPosting: false });
    expect(v).toEqual({ allowed: false, code: 'not_member', reason: expect.any(String) });
  });

  it('забаненный — отказ везде и всегда', () => {
    for (const type of ['group', 'channel', 'supergroup'] as const) {
      for (const adminOnlyPosting of [true, false]) {
        const v = canSendToGroup({ role: 'banned', type, adminOnlyPosting });
        expect(v.allowed).toBe(false);
        expect((v as { code: string }).code).toBe('banned');
      }
    }
  });

  it('restricted не пишет даже в открытой группе', () => {
    // Роль — точечный запрет на отправку, поэтому сильнее групповой настройки.
    const v = canSendToGroup({ role: 'restricted', type: 'group', adminOnlyPosting: false });
    expect(v.allowed).toBe(false);
    expect((v as { code: string }).code).toBe('restricted');
  });

  it('участник: в открытой группе можно, при adminOnlyPosting — нет', () => {
    expect(canSendToGroup({ role: 'member', type: 'group', adminOnlyPosting: false }).allowed).toBe(true);
    expect(canSendToGroup({ role: 'member', type: 'supergroup', adminOnlyPosting: false }).allowed).toBe(true);
    const v = canSendToGroup({ role: 'member', type: 'group', adminOnlyPosting: true });
    expect(v.allowed).toBe(false);
    expect((v as { code: string }).code).toBe('admin_only_posting');
  });

  it('в канале подписчик не публикует ничего', () => {
    for (const role of ['member', 'restricted'] as SendRole[]) {
      const v = canSendToGroup({ role, type: 'channel', adminOnlyPosting: false });
      expect(v.allowed).toBe(false);
    }
    // Отдельный код: UI показывает «Канал — только подписка», а не «нет прав».
    expect((canSendToGroup({ role: 'member', type: 'channel', adminOnlyPosting: false }) as { code: string }).code)
      .toBe('channel_admin_only');
  });

  it('системные сообщения протокола проходят при любом запрете', () => {
    // Иначе участник не узнает ни о бане, ни о включении «только для админов»:
    // уведомление об изменении режима само упёрлось бы в этот режим.
    for (const role of [...ROLES, null] as (SendRole | null)[]) {
      expect(canSendToGroup({ role, type: 'channel', adminOnlyPosting: true, media: 'system' }).allowed).toBe(true);
    }
  });

  it('вид вложения не расширяет права', () => {
    // Медиа, голос и опрос подчиняются тому же вердикту, что и текст: обходной
    // путь через «прикрепить файл» — ровно то, из-за чего проверка переехала
    // в fanout, а не осталась в обработчике кнопки «отправить».
    for (const media of ['text', 'media', 'voice', 'file', 'location', 'poll'] as const) {
      expect(canSendToGroup({ role: 'member', type: 'group', adminOnlyPosting: true, media }).allowed).toBe(false);
      expect(canSendToGroup({ role: 'restricted', type: 'group', adminOnlyPosting: false, media }).allowed).toBe(false);
    }
  });

  it('причина отказа непустая — её показывают пользователю', () => {
    for (const role of ['banned', 'restricted', 'member'] as SendRole[]) {
      const v = canSendToGroup({ role, type: 'channel', adminOnlyPosting: true });
      if (!v.allowed) expect(v.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('mediaKindOfText', () => {
  it('распознаёт префиксы протокола', () => {
    expect(mediaKindOfText('\x0bsys:кого-то забанили')).toBe('system');
    expect(mediaKindOfText('\x01voice:cid')).toBe('voice');
    expect(mediaKindOfText('\x04poll:{}')).toBe('poll');
    expect(mediaKindOfText('\x06doc:cid')).toBe('file');
    expect(mediaKindOfText('\x07loc:1,2')).toBe('location');
    expect(mediaKindOfText('\x0cliveloc:{}')).toBe('location');
    expect(mediaKindOfText('\x09vo:cid')).toBe('media');
    expect(mediaKindOfText('обычный текст')).toBe('text');
  });

  it('префикс считается только в начале строки', () => {
    // Иначе отправитель приписал бы '\x0bsys:' в середину и получил обход
    // любого запрета: системные сообщения проходят всегда.
    expect(mediaKindOfText('привет \x0bsys:я системное')).toBe('text');
    expect(mediaKindOfText(' \x0bsys:')).toBe('text');
  });
});

describe('slowModeRemaining', () => {
  const T = 1_700_000_000_000;

  it('выключенный режим не ограничивает никого', () => {
    for (const role of ROLES) {
      expect(slowModeRemaining({ role, slowModeSeconds: 0, lastSentAt: T, now: T })).toBe(0);
      expect(slowModeRemaining({ role, slowModeSeconds: -5, lastSentAt: T, now: T })).toBe(0);
    }
  });

  it('администрация не ограничена медленным режимом', () => {
    for (const role of ['owner', 'admin'] as SendRole[]) {
      expect(slowModeRemaining({ role, slowModeSeconds: 60, lastSentAt: T, now: T })).toBe(0);
    }
  });

  it('участник ждёт остаток интервала', () => {
    expect(slowModeRemaining({ role: 'member', slowModeSeconds: 30, lastSentAt: T, now: T })).toBe(30);
    expect(slowModeRemaining({ role: 'member', slowModeSeconds: 30, lastSentAt: T, now: T + 10_000 })).toBe(20);
    expect(slowModeRemaining({ role: 'member', slowModeSeconds: 30, lastSentAt: T, now: T + 29_999 })).toBe(1);
    expect(slowModeRemaining({ role: 'member', slowModeSeconds: 30, lastSentAt: T, now: T + 30_000 })).toBe(0);
    expect(slowModeRemaining({ role: 'member', slowModeSeconds: 30, lastSentAt: T, now: T + 99_000 })).toBe(0);
  });

  it('первое сообщение не ждёт', () => {
    expect(slowModeRemaining({ role: 'member', slowModeSeconds: 30, lastSentAt: 0, now: T })).toBe(0);
  });

  it('часы, уехавшие назад, не превращаются в вечный запрет', () => {
    expect(slowModeRemaining({ role: 'member', slowModeSeconds: 30, lastSentAt: T + 60_000, now: T })).toBe(0);
    expect(slowModeRemaining({ role: 'member', slowModeSeconds: NaN, lastSentAt: T, now: T })).toBe(0);
  });
});

describe('formatSlowMode', () => {
  it('форматирует интервал', () => {
    expect(formatSlowMode(0)).toBe('Выключен');
    expect(formatSlowMode(-1)).toBe('Выключен');
    expect(formatSlowMode(30)).toBe('30 сек');
    expect(formatSlowMode(60)).toBe('1 мин');
    expect(formatSlowMode(900)).toBe('15 мин');
    expect(formatSlowMode(3600)).toBe('1 ч');
  });
});

describe('slowModeSysLine', () => {
  it('одна формулировка на включившего и на всех остальных', () => {
    // Дыра была не в логике, а в тексте: включивший видел в истории
    // «Медленный режим: 5 мин», а получатели конверта — «300 сек».
    expect(slowModeSysLine(300)).toBe('Медленный режим: 5 мин');
    expect(slowModeSysLine(30)).toBe('Медленный режим: 30 сек');
    expect(slowModeSysLine(3600)).toBe('Медленный режим: 1 ч');
  });

  it('выключение — отдельная строка, а не «Выключен»', () => {
    expect(slowModeSysLine(0)).toBe('Медленный режим отключён');
    expect(slowModeSysLine(-5)).toBe('Медленный режим отключён');
  });

  it('строка распознаётся журналом администратора', () => {
    // GroupAdminLogModal подбирает иконку по вхождению «Медленный режим».
    for (const secs of [0, 10, 300, MAX_SLOWMODE_SECONDS]) {
      expect(slowModeSysLine(secs)).toContain('Медленный режим');
    }
  });
});

describe('поддельный системный префикс не открывает отправку', () => {
  /**
   * media === 'system' проходит проверку прав ВСЕГДА — иначе участник не
   * узнает, что режим включили. Значит, текст, начинающийся с '\x0bsys:',
   * был бы для забаненного пропуском в закрытую группу, и права держались бы
   * ровно на том, что приёмник снимает подделанный префикс ДО вызова
   * mediaKindOfText (groupMessaging.ts). Тест фиксирует связку: те же две
   * функции, тот же порядок.
   */
  const hostile = SYS_LINE_PREFIX + 'Вы заблокированы в группе';

  it('своя системная строка распознаётся как системная', () => {
    expect(mediaKindOfText(hostile)).toBe('system');
    expect(canSendToGroup({ role: 'banned', type: 'group', adminOnlyPosting: false, media: 'system' }).allowed).toBe(true);
  });

  it('та же строка из сети — обычный текст, и забаненный ею не проходит', () => {
    const fromNetwork = stripSpoofedSysPrefix(hostile);
    expect(mediaKindOfText(fromNetwork)).toBe('text');
    const verdict = canSendToGroup({
      role: 'banned',
      type: 'group',
      adminOnlyPosting: false,
      media: mediaKindOfText(fromNetwork),
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.code).toBe('banned');
  });

  it('повтор префикса тоже не проходит', () => {
    // stripSpoofedSysPrefix снимает префикс в цикле — иначе двойной '\x0bsys:'
    // остался бы системной строкой после снятия первого.
    const doubled = SYS_LINE_PREFIX + SYS_LINE_PREFIX + 'подделка';
    expect(mediaKindOfText(stripSpoofedSysPrefix(doubled))).toBe('text');
  });
});

/**
 * Реакция и голос в опросе — не публикация.
 *
 * Проверка живёт на обеих сторонах: отправитель зовёт её до записи в свою БД,
 * получатель — до применения конверта. Разойдись они, и голос виден ровно
 * одному человеку: своему автору.
 */
describe('canInteractInGroup', () => {
  it('обычный участник реагирует и голосует', () => {
    expect(canInteractInGroup('member').allowed).toBe(true);
  });

  it('владелец и админ — тоже', () => {
    expect(canInteractInGroup('owner').allowed).toBe(true);
    expect(canInteractInGroup('admin').allowed).toBe(true);
  });

  it('read-only участник не голосует и не реагирует', () => {
    const v = canInteractInGroup('restricted');
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.code).toBe('restricted');
  });

  it('забаненный — тем более', () => {
    const v = canInteractInGroup('banned');
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.code).toBe('banned');
  });

  it('не участник группы не голосует', () => {
    const v = canInteractInGroup(null);
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.code).toBe('not_member');
  });

  /**
   * Ключевое отличие от canSendToGroup: подписчик канала публиковать не вправе,
   * но голосовать обязан — иначе опрос в канале не имеет смысла. То же и для
   * режима «пишут только администраторы»: он про сообщения, не про реакции.
   */
  it('подписчик канала не пишет, но голосует', () => {
    expect(canSendToGroup({ role: 'member', type: 'channel', adminOnlyPosting: false }).allowed).toBe(false);
    expect(canInteractInGroup('member').allowed).toBe(true);
  });

  it('режим «только админы» не отбирает реакции', () => {
    expect(canSendToGroup({ role: 'member', type: 'group', adminOnlyPosting: true }).allowed).toBe(false);
    expect(canInteractInGroup('member').allowed).toBe(true);
  });

  it('у отказа всегда есть текст для человека', () => {
    for (const role of ['restricted', 'banned'] as SendRole[]) {
      const v = canInteractInGroup(role);
      expect(v.allowed === false && v.reason.length).toBeGreaterThan(0);
    }
  });
});

/**
 * Правка и удаление уже отправленного сообщения.
 *
 * Правка = публикация нового текста в историю всей группы, поэтому право на
 * неё то же, что на отправку. Удаление — не высказывание, поэтому только
 * авторство и роль.
 */
describe('canApplyGroupMessageOp', () => {
  const base = { type: 'group' as const, adminOnlyPosting: false };

  it('автор правит своё', () => {
    expect(canApplyGroupMessageOp({ ...base, op: 'edit', role: 'member', isAuthor: true }).allowed).toBe(true);
  });

  it('чужое не правит даже владелец — это подмена авторства, а не модерация', () => {
    const v = canApplyGroupMessageOp({ ...base, op: 'edit', role: 'owner', isAuthor: false });
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.code).toBe('not_author');
  });

  it('режим «только чтение» отбирает и правку своего старого сообщения', () => {
    // Иначе запрет говорить обходится: переписал вчерашнее — сказал новое.
    const v = canApplyGroupMessageOp({ ...base, op: 'edit', role: 'restricted', isAuthor: true });
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.code).toBe('restricted');
  });

  it('подписчик канала не правит свою старую публикацию', () => {
    const v = canApplyGroupMessageOp({ ...base, type: 'channel', op: 'edit', role: 'member', isAuthor: true });
    expect(v.allowed === false && v.code).toBe('channel_admin_only');
  });

  it('режим «пишут только администраторы» распространяется на правку', () => {
    const v = canApplyGroupMessageOp({ ...base, adminOnlyPosting: true, op: 'edit', role: 'member', isAuthor: true });
    expect(v.allowed === false && v.code).toBe('admin_only_posting');
    expect(canApplyGroupMessageOp({ ...base, adminOnlyPosting: true, op: 'edit', role: 'admin', isAuthor: true }).allowed).toBe(true);
  });

  it('правкой нельзя сделать системную строку', () => {
    // Приёмник конверта и так снимает поддельный префикс, но правило не должно
    // зависеть от того, что кто-то раньше по цепочке об этом не забыл.
    const v = canApplyGroupMessageOp({ ...base, op: 'edit', role: 'restricted', isAuthor: true, media: 'system' });
    expect(v.allowed).toBe(false);
  });

  it('автор удаляет своё, даже когда писать ему уже нельзя', () => {
    expect(canApplyGroupMessageOp({ ...base, op: 'del', role: 'restricted', isAuthor: true }).allowed).toBe(true);
    expect(canApplyGroupMessageOp({ ...base, type: 'channel', op: 'del', role: 'member', isAuthor: true }).allowed).toBe(true);
  });

  it('чужое удаляет администратор — это и есть модерация', () => {
    expect(canApplyGroupMessageOp({ ...base, op: 'del', role: 'admin', isAuthor: false }).allowed).toBe(true);
    const v = canApplyGroupMessageOp({ ...base, op: 'del', role: 'member', isAuthor: false });
    expect(v.allowed === false && v.code).toBe('not_moderator');
  });

  it('забаненный не правит и не удаляет ничего', () => {
    for (const op of ['edit', 'del'] as const) {
      const v = canApplyGroupMessageOp({ ...base, op, role: 'banned', isAuthor: true });
      expect(v.allowed === false && v.code).toBe('banned');
    }
  });

  it('не участник не правит и не удаляет ничего', () => {
    for (const op of ['edit', 'del'] as const) {
      const v = canApplyGroupMessageOp({ ...base, op, role: null, isAuthor: true });
      expect(v.allowed === false && v.code).toBe('not_member');
    }
  });

  it('у отказа всегда есть текст для человека', () => {
    const denials = [
      canApplyGroupMessageOp({ ...base, op: 'edit', role: 'owner', isAuthor: false }),
      canApplyGroupMessageOp({ ...base, op: 'del', role: 'member', isAuthor: false }),
      canApplyGroupMessageOp({ ...base, op: 'edit', role: 'restricted', isAuthor: true }),
    ];
    for (const v of denials) expect(v.allowed === false && v.reason.length).toBeGreaterThan(0);
  });
});
