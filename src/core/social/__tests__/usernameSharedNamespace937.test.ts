/**
 * Дефект: пространств имён было два. У человека юзернейм лежал в общем реестре
 * и был уникален; у группы «публичный адрес» не лежал нигде — его писал себе
 * каждый сам и рассылал конвертом `meta`. Одно и то же `@x` спокойно носили
 * человек, группа и канал, а справочник о группах не знал вовсе: нажатие на
 * адрес канала отвечало «занят, но владелец не открыл переход по имени» —
 * то есть выдавало канал за недоступного человека.
 *
 * Цена: адрес — единственная человекочитаемая вывеска, по которой в приложение
 * приходят снаружи. «Пиши на @support» не значило ничего: за именем мог стоять
 * кто угодно, и отличить их было нечем.
 *
 * Правка (v4.32.937): адрес группы занимается тем же `claim`, в том же
 * реестре, с предметом — публичным идентификатором `GR-…`/`CH-…`. Справочник
 * отдаёт вид и идентификатор, и `@имя` группы больше не открывается как
 * человек.
 *
 * Границы: реестр даёт уникальность, а не доказательство владения — своей
 * ключевой пары у группы нет, подписывает заявку ключ занимающего. Полномочия
 * того, кто поставил адрес, по-прежнему проверяет получатель конверта.
 */
jest.mock('../mentionLookup', () => ({ lookupMention: jest.fn() }));
jest.mock('../../sync/syncApi', () => ({ lookupSyncUsername: jest.fn() }));

import { readFileSync } from 'fs';
import { join } from 'path';

import { publicIdFor } from '../../identity/publicId';
import { lookupMention } from '../mentionLookup';
import { lookupSyncUsername } from '../../sync/syncApi';
import { groupSubject } from '../groupHandleRegistry';
import { mentionMissText, resolveMentionTarget } from '../usernameDirectory';

const local = lookupMention as jest.MockedFunction<typeof lookupMention>;
const remote = lookupSyncUsername as jest.MockedFunction<typeof lookupSyncUsername>;

const ROOT = join(__dirname, '..', '..', '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const SCREEN = read('src/ui/screens/GroupsScreen.tsx');
const SYNC_API = read('src/core/sync/syncApi.ts');
const SERVER = read('server/cloud-vault/index.js');
const REGISTRY = read('src/core/social/groupHandleRegistry.ts');

beforeEach(() => {
  local.mockReset();
  remote.mockReset();
  local.mockResolvedValue({ status: 'none' });
});

describe('единое пространство имён у людей, групп и каналов', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: исходники читаются, адрес ставится на экране групп', () => {
    expect(SCREEN.length).toBeGreaterThan(10000);
    expect(SERVER.length).toBeGreaterThan(10000);
    expect(SCREEN).toContain('const saveHandle = useCallback(');
    expect(REGISTRY).toContain('export async function saveGroupHandleGlobally(');
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: адрес по-прежнему едет конвертом meta', () => {
    // Реестр конверт не заменяет: участники узнают адрес из него, а не из
    // сети. Пропади рассылка — реестр остался бы уникальностью ни для кого.
    expect(SCREEN).toContain("{ op: 'meta', username: next }");
    // И правила самого имени как были общими с аккаунтами, так и остались:
    // реестр их не заменяет, он добавляет к ним уникальность.
    expect(SCREEN).toContain('checkGroupHandle(');
  });

  it('адрес занимается ДО записи в группу и до рассылки', () => {
    const body = SCREEN.slice(SCREEN.indexOf('const saveHandle = useCallback('));
    const claim = body.indexOf('await saveGroupHandleGlobally(');
    const write = body.indexOf('await updateGroupMeta(');
    const fanout = body.indexOf('fanoutGroupControl(');
    expect(claim).toBeGreaterThan(0);
    // Обратный порядок значил бы разослать участникам адрес, который уже
    // за кем-то: локальная запись — единственная точка правды для конвертов.
    expect(claim).toBeLessThan(write);
    expect(claim).toBeLessThan(fanout);
  });

  it('занятый адрес останавливает сохранение, а недоступный реестр — нет', () => {
    const body = SCREEN.slice(SCREEN.indexOf('const saveHandle = useCallback('));
    expect(body).toContain("claimed.reason === 'taken'");
    expect(body).toContain('уже занят');
    // `offline` до экрана не доходит: реестр отвечает `scope: 'local'`, и
    // человеку говорят, что адрес поставлен, но не забронирован.
    expect(REGISTRY).toContain("if (claim.reason === 'offline') return { ok: true, scope: 'local' };");
    expect(body).toContain("scope === 'global'");
  });

  it('снятый адрес освобождается в реестре', () => {
    const body = SCREEN.slice(SCREEN.indexOf('const saveHandle = useCallback('));
    expect(body).toContain('await releaseGroupHandleGlobally(');
    // Заметка на диск ложится ДО сети: снятие адреса в самолёте иначе
    // оставило бы имя занятым навсегда.
    const note = REGISTRY.indexOf('await kvSetChecked(noteKey(subject)');
    const net = REGISTRY.indexOf('await tryReleaseOnce(subject, profileId);\n}');
    expect(note).toBeGreaterThan(0);
    expect(note).toBeLessThan(net);
    // И у недоотпущенных адресов есть кому их добрать.
    expect(SCREEN).toContain('void retryPendingGroupHandleReleases()');
  });

  it('предмет заявки — публичный идентификатор, и у группы с каналом он разный', () => {
    const asGroup = groupSubject('group', 'uuid-1');
    const asChannel = groupSubject('channel', 'uuid-1');
    expect(asGroup).toEqual({ kind: 'group', id: publicIdFor('group', 'uuid-1') });
    expect(asChannel).toEqual({ kind: 'channel', id: publicIdFor('channel', 'uuid-1') });
    expect(asGroup!.id.startsWith('GR-')).toBe(true);
    expect(asChannel!.id.startsWith('CH-')).toBe(true);
    expect(asGroup!.id).not.toBe(asChannel!.id);
    // Группы без идентификатора не бывает — но заявку без предмета слать
    // нельзя: она заняла бы имя как ЛИЧНОЕ имя владельца.
    expect(groupSubject('group', '')).toBeNull();
  });

  it('строка привязки расширяется предметом дословно так же, как на сервере', () => {
    expect(SYNC_API).toContain('const bound = subject ? `${base}:${subject.kind}:${subject.id}` : base;');
    expect(SERVER).toContain('subject ? `${base}:${subject.kind}:${subject.id}` : base');
    // Условно — иначе заявки прежних версий перестали бы сходиться побайтово.
    expect(SYNC_API).toContain('airchat-username-directory:v1:${username}:${accountId}:${ownerProfileId}');
  });

  it('адрес группы не открывается как человек', async () => {
    remote.mockResolvedValue({
      status: 'taken', peerPubB64: null, peerName: null,
      subject: { kind: 'channel', id: 'CH-ABCDE-FGHJK' },
    });
    await expect(resolveMentionTarget('@AirNews', 1)).resolves.toEqual({
      status: 'space', kind: 'channel', publicId: 'CH-ABCDE-FGHJK', username: 'airnews',
    });
  });

  it('предмет перевешивает ключ: карточка незнакомца по адресу группы не открывается', async () => {
    // Ключ в такой записи мог оказаться какой угодно: заявку подписывает тот,
    // кто занимает адрес, а не группа. Открой мы по нему карточку — человек
    // писал бы «в канал» в личку случайному владельцу телефона.
    const PUB = 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyaGk=';
    remote.mockResolvedValue({
      status: 'taken', peerPubB64: PUB, peerName: 'Кто-то',
      subject: { kind: 'group', id: 'GR-ABCDE-FGHJK' },
    });
    const hit = await resolveMentionTarget('aircafe', 1);
    expect(hit.status).toBe('space');
    expect(hit).not.toHaveProperty('peerPubB64');
  });

  it('человек по-прежнему открывается: предмета у его записи нет', async () => {
    const PUB = 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyaGk=';
    remote.mockResolvedValue({ status: 'taken', peerPubB64: PUB, peerName: 'Рита', subject: null });
    await expect(resolveMentionTarget('margarita', 1)).resolves.toEqual({
      status: 'stranger', peerPubB64: PUB, username: 'margarita', peerName: 'Рита',
    });
  });

  it('о промахе сказано честно: имя есть, но за ним не человек', () => {
    expect(mentionMissText('space', 'airnews', 'channel')).toBe('@airnews — это адрес канала, а не человека');
    expect(mentionMissText('space', 'aircafe', 'group')).toBe('@aircafe — это адрес группы, а не человека');
    // Перехода туда ещё нет, и обещать его текстом нельзя.
    expect(mentionMissText('space', 'aircafe', 'group')).not.toContain('Откр');
  });
});
