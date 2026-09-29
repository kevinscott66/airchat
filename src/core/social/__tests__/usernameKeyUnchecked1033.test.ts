/**
 * v4.32.1033: «сверить не смогли» перестало читаться как «ключ тот же».
 *
 * Дефект. `checkUsernameKeyPin` отвечает четырьмя словами и отдельно называет
 * `unknown` — «запомненное не прочиталось, сверять не с чем». Справочник же
 * схлопывал ответ в одно число:
 * `keyChangedSince: pin.status === 'changed' ? pin.since : null`.
 * `unknown` становился тем же `null`, что и `same`.
 *
 * Цена. `null` — это отсутствие тревоги. Красная строка «За этим именем
 * теперь другой ключ» не рисуется, а «Написать» открывает переписку без
 * единого вопроса. То есть ровно то предупреждение, ради которого модуль
 * пиньонов и написан, гасится отказом чтения — а отказ настоящий:
 * `tryReadProfileSharedSecret` отвечает `null`, когда ячейка профиля не
 * открылась ключом (`state: 'unreadable'`) или база не отдала общую запись.
 * Окно — первое за сеанс касание `@имени`, то есть запуск и загрузка истории,
 * когда база занята. Написанное в этом окне не отозвать.
 *
 * Правка. Исход сверки едет в карточку тремя словами (`MentionKeyPin`), а не
 * одним числом. Отдельно разведён и сам вердикт: «не прочитали запомненное»
 * (`unknown`) и «имя новое, но запомнить не вышло» (`unsaved`). Второе тревоги
 * не стоит: мы сверили и ничего не нашли, — а показывать янтарную строку на
 * каждом первом переходе значило бы приучить её не читать.
 *
 * Границы. Первый переход по имени по-прежнему не защищён ничем. Карточка —
 * компонент React Native, render-харнесса в сборке нет, поэтому её поведение
 * проверяется по исходнику; разбор исхода проверяется вызовом.
 */
jest.mock('../mentionLookup', () => ({ lookupMention: jest.fn() }));
jest.mock('../../sync/syncApi', () => ({ lookupSyncUsername: jest.fn() }));
jest.mock('../usernameKeyPin', () => ({ checkUsernameKeyPin: jest.fn() }));

import { readFileSync } from 'fs';
import { join } from 'path';

import { lookupSyncUsername } from '../../sync/syncApi';
import { lookupMention } from '../mentionLookup';
import { resolveMentionTarget } from '../usernameDirectory';
import { checkUsernameKeyPin, type PinVerdict } from '../usernameKeyPin';

const local = lookupMention as jest.MockedFunction<typeof lookupMention>;
const remote = lookupSyncUsername as jest.MockedFunction<typeof lookupSyncUsername>;
const pin = checkUsernameKeyPin as jest.MockedFunction<typeof checkUsernameKeyPin>;

const PUB = 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyaGk=';

const read = (...p: string[]): string =>
  readFileSync(join(__dirname, '..', '..', '..', ...p), 'utf8');

/** Только код: пояснения не должны сами удовлетворять проверку. */
const codeOnly = (src: string): string =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const PEEK = read('ui', 'components', 'UserProfilePeek.tsx');
const DIR = codeOnly(read('core', 'social', 'usernameDirectory.ts'));
const PINS = codeOnly(read('core', 'social', 'usernameKeyPin.ts'));
const SHARED = codeOnly(read('core', 'storage', 'profileSharedKv.ts'));

/** Исход перехода по чужому имени при заданном вердикте сверки. */
async function strangerFor(verdict: PinVerdict): Promise<unknown> {
  local.mockResolvedValue({ status: 'none' });
  remote.mockResolvedValue({ status: 'taken', subject: null, peerPubB64: PUB, peerName: 'Рита' });
  pin.mockResolvedValue(verdict);
  return resolveMentionTarget('margarita', 1);
}

beforeEach(() => {
  local.mockReset();
  remote.mockReset();
  pin.mockReset();
});

describe('непрочитанное запомненное не выдаётся за совпадение', () => {
  it('«посмотреть не смогли» и «ключ тот же» — не один ответ', async () => {
    const same = await strangerFor({ status: 'same', since: 1_700_000_000_000 });
    const unknown = await strangerFor({ status: 'unknown' });
    // Пока это один и тот же объект, карточка не может показать разное —
    // и не показывает: тревоги нет ни там, ни там.
    expect(unknown).not.toEqual(same);
  });

  it('непрочитанное называется своим словом', async () => {
    expect(await strangerFor({ status: 'unknown' })).toMatchObject({
      status: 'stranger',
      keyPin: { state: 'unchecked' },
    });
  });

  it('расхождение доносится вместе с датой прежнего ключа', async () => {
    expect(await strangerFor({ status: 'changed', since: 1_700_000_000_000 })).toMatchObject({
      keyPin: { state: 'changed', since: 1_700_000_000_000 },
    });
  });

  it('совпадение и первый переход тревоги не поднимают', async () => {
    expect(await strangerFor({ status: 'same', since: 12 })).toMatchObject({ keyPin: { state: 'ok' } });
    expect(await strangerFor({ status: 'first' })).toMatchObject({ keyPin: { state: 'ok' } });
  });

  it('«не запомнили» — это не «не посмотрели»', async () => {
    // Запомненное мы прочли и ничего за именем не нашли; не легла только
    // запись. Тревожить этим нельзя: иначе янтарная строка показывалась бы на
    // каждом первом переходе при заминке базы и перестала бы что-то значить.
    expect(await strangerFor({ status: 'unsaved' })).toMatchObject({ keyPin: { state: 'ok' } });
  });
});

describe('карточка различает три слова', () => {
  it('у непрочитанной сверки своя строка, и это тревога', () => {
    expect(PEEK).toContain("keyPin.state === 'unchecked'");
    expect(PEEK).toContain('Сверить ключ за этим именем не удалось');
    const at = PEEK.indexOf('Сверить ключ за этим именем не удалось');
    // Строка стоит в том же блоке, что и предупреждение о смене ключа, и
    // читается вспомогательными технологиями так же.
    expect(PEEK.slice(Math.max(0, at - 400), at)).toContain('accessibilityRole="alert"');
  });

  it('переписка по непроверенному ключу начинается с вопроса', () => {
    expect(PEEK).toContain("if (keyPin.state === 'unchecked')");
    const at = PEEK.indexOf('const openChatAfterKeyUnchecked');
    expect(at).toBeGreaterThan(0);
    const body = PEEK.slice(at, at + 1400);
    expect(body).toContain('Alert.alert(');
    expect(body).toContain('Всё равно написать');
    // Принимать нечего: запомненное мы не прочли, и запись поверх стёрла бы
    // то, чего мы не видели.
    expect(body).not.toContain('acceptUsernameKey');
  });

  it('все три экрана доносят до карточки исход, а не число', () => {
    for (const name of ['ChatScreen.tsx', 'GroupsScreen.tsx', 'FeedScreen.tsx']) {
      expect(read('ui', 'screens', name)).toContain('keyPin');
    }
  });

  it('прежнего одного числа в справочнике не осталось', () => {
    expect(DIR).not.toContain('keyChangedSince');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: соседние исходы перехода целы', () => {
  it('свой контакт разрешается на устройстве, сверка не спрашивается', async () => {
    local.mockResolvedValue({ status: 'found', peerPubB64: PUB, displayName: 'Рита' });
    await expect(resolveMentionTarget('rita', 1)).resolves.toEqual({
      status: 'contact', peerPubB64: PUB, displayName: 'Рита',
    });
    expect(pin).not.toHaveBeenCalled();
  });

  it('имя без опубликованного ключа сверять нечем', async () => {
    local.mockResolvedValue({ status: 'none' });
    remote.mockResolvedValue({ status: 'taken', subject: null, peerPubB64: null, peerName: null });
    await expect(resolveMentionTarget('margarita', 1)).resolves.toEqual({ status: 'unlisted' });
    expect(pin).not.toHaveBeenCalled();
  });

  it('реестр не ответил — и это не «имени нет»', async () => {
    local.mockResolvedValue({ status: 'none' });
    remote.mockResolvedValue({ status: 'unknown' });
    await expect(resolveMentionTarget('margarita', 1)).resolves.toEqual({ status: 'unknown' });
    expect(pin).not.toHaveBeenCalled();
  });

  it('свободное имя остаётся свободным', async () => {
    local.mockResolvedValue({ status: 'none' });
    remote.mockResolvedValue({ status: 'free' });
    await expect(resolveMentionTarget('margarita', 1)).resolves.toEqual({ status: 'unclaimed' });
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('сверка по-прежнему отвечает «не прочитали» отдельным словом', () => {
    expect(PINS).toContain("if (pins === null) return { status: 'unknown' };");
    expect(PINS).toContain('async function currentPins(): Promise<Map<string, Pin> | null> {');
  });

  it('отказ чтения настоящий: ячейка профиля бывает нечитаемой', () => {
    expect(SHARED).toContain("if (cell.state === 'unreadable') return null;");
    expect(SHARED).toContain('if (sharedRead === null) return own == null ? null : { value: own };');
  });

  it('другого свидетеля подмены нет — сверка одна', () => {
    expect(DIR).toContain('await checkUsernameKeyPin(username, answer.peerPubB64)');
    const whole = read('core', 'social', 'usernameDirectory.ts');
    // Ровно один вызов: второго места, где подмену можно было бы заметить, нет.
    expect(whole.split('checkUsernameKeyPin(').length - 1).toBe(1);
  });

  it('предупреждение о смене ключа и согласие на него остались как были', () => {
    expect(PEEK).toContain('За этим именем теперь другой ключ');
    expect(PEEK).toContain('void acceptUsernameKey(usernameHint, pubB64)');
  });

  it('сверка идёт после отказов, а не до них', () => {
    const unlisted = DIR.indexOf("if (!answer.peerPubB64) return { status: 'unlisted' };");
    const check = DIR.indexOf('await checkUsernameKeyPin(');
    expect(unlisted).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(unlisted);
  });
});
