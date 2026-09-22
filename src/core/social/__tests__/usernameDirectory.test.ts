/**
 * v4.32.607. Проверяются ровно те две жалобы, с которых началась правка:
 * «юзернейма такого вообще нет» — а приложение говорило про контакты, и
 * «для перехода по юзу этот человек не обязательно должен быть в контактах».
 */
jest.mock('../mentionLookup', () => ({ lookupMention: jest.fn() }));
jest.mock('../../sync/syncApi', () => ({ lookupSyncUsername: jest.fn() }));

import { lookupMention } from '../mentionLookup';
import { lookupSyncUsername } from '../../sync/syncApi';
import { mentionMissText, resolveMentionTarget } from '../usernameDirectory';

const local = lookupMention as jest.MockedFunction<typeof lookupMention>;
const remote = lookupSyncUsername as jest.MockedFunction<typeof lookupSyncUsername>;

const PUB = 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyaGk=';

beforeEach(() => {
  local.mockReset();
  remote.mockReset();
});

describe('resolveMentionTarget', () => {
  it('контакт разрешается на устройстве, реестр не спрашивается', async () => {
    local.mockResolvedValue({ status: 'found', peerPubB64: PUB, displayName: 'Рита' });
    await expect(resolveMentionTarget('rita', 1)).resolves.toEqual({
      status: 'contact', peerPubB64: PUB, displayName: 'Рита',
    });
    expect(remote).not.toHaveBeenCalled();
  });

  it('незнакомец из реестра открывается без добавления в контакты', async () => {
    local.mockResolvedValue({ status: 'none' });
    remote.mockResolvedValue({ status: 'taken', peerPubB64: PUB, peerName: null });
    // v4.32.616: юзернейм едет юзернеймом. Раньше он же уезжал в displayName,
    // и карточка выдавала адрес за имя: человек, назвавшийся у себя «Ритой»,
    // открывался как «margarita». toEqual сверяет объект целиком, значит
    // вернувшийся displayName провалит проверку — что и требуется.
    const hit = await resolveMentionTarget('@Founder', 1);
    expect(hit).toEqual({ status: 'stranger', peerPubB64: PUB, username: 'founder', peerName: null });
    expect(hit).not.toHaveProperty('displayName');
    expect(remote).toHaveBeenCalledWith('founder');
  });

  it('имя, опубликованное владельцем в реестре, едет в карточку незнакомца', async () => {
    local.mockResolvedValue({ status: 'none' });
    remote.mockResolvedValue({ status: 'taken', peerPubB64: PUB, peerName: 'Рита' });
    await expect(resolveMentionTarget('margarita', 1)).resolves.toEqual({
      status: 'stranger', peerPubB64: PUB, username: 'margarita', peerName: 'Рита',
    });
  });

  it('свободное имя — «не существует», а не «нет в контактах»', async () => {
    local.mockResolvedValue({ status: 'none' });
    remote.mockResolvedValue({ status: 'free' });
    await expect(resolveMentionTarget('founderr', 1)).resolves.toEqual({ status: 'unclaimed' });
    expect(mentionMissText('unclaimed', 'founderr')).toBe('Юзернейма @founderr не существует');
  });

  it('недоступный реестр не выдаётся за отсутствие имени', async () => {
    local.mockResolvedValue({ status: 'none' });
    remote.mockResolvedValue({ status: 'unknown' });
    await expect(resolveMentionTarget('founder', 1)).resolves.toEqual({ status: 'unknown' });
    expect(mentionMissText('unknown', 'founder')).toContain('Не удалось проверить');
  });

  it('сборка без реестра не выдаётся за обрыв связи', async () => {
    local.mockResolvedValue({ status: 'none' });
    remote.mockResolvedValue({ status: 'unconfigured' });
    await expect(resolveMentionTarget('margarita', 1)).resolves.toEqual({ status: 'unconfigured' });
    const text = mentionMissText('unconfigured', 'margarita');
    expect(text).not.toContain('связи');
    expect(text).toContain('не настроен');
  });

  it('занятое имя без опубликованного ключа — отдельный исход', async () => {
    local.mockResolvedValue({ status: 'none' });
    remote.mockResolvedValue({ status: 'taken', peerPubB64: null, peerName: null });
    await expect(resolveMentionTarget('oldtimer', 1)).resolves.toEqual({ status: 'unlisted' });
  });

  it('несколько одноимённых контактов остаются неоднозначностью', async () => {
    local.mockResolvedValue({ status: 'ambiguous' });
    await expect(resolveMentionTarget('Иван', 1)).resolves.toEqual({ status: 'ambiguous' });
    expect(remote).not.toHaveBeenCalled();
  });

  it('текст, не годящийся в username, в реестр не уходит', async () => {
    local.mockResolvedValue({ status: 'none' });
    await expect(resolveMentionTarget('Пётр Петров', 1)).resolves.toEqual({ status: 'unclaimed' });
    expect(remote).not.toHaveBeenCalled();
  });
});

describe('mentionMissText', () => {
  it('ни один исход не сваливает вину на адресную книгу', () => {
    for (const status of ['ambiguous', 'unclaimed', 'unlisted', 'unconfigured', 'unknown'] as const) {
      if (status === 'ambiguous') continue;
      expect(mentionMissText(status, 'x')).not.toContain('контакт');
    }
  });
});
