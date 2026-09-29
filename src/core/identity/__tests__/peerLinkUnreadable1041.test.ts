/**
 * Непрочитанная отметка проверки звала сходить на площадку (v4.32.1041).
 *
 * ДЕФЕКТ. Отметку «эту привязку я уже проверял» карточка чужого профиля
 * читала через `scopedKvGet` — строкой, где «не проверяли» и «запись не
 * открылась» сведены к одному `null`.
 *
 * ЦЕНА. Не в галочке. Весь этот модуль построен вокруг одного правила: запрос
 * к github.com и x.com уходит ТОЛЬКО по нажатию, потому что иначе две чужие
 * площадки узнают, чей профиль человек открыл и когда. Кнопка «Проверить
 * привязку» показывается ровно тем привязкам, которые числятся
 * непроверенными, — и занятый SQLite приписывал к ним уже проверенную. Рядом
 * стояло «Пока вы её не проверили»: утверждение о том, чего мы не знаем, и
 * повод нажать. Отказ базы таким образом уговаривал человека сделать ровно
 * тот запрос, которого модуль избегает делать сам.
 *
 * ПРАВКА. `peerLinkVerifiedAtTry`: `null` — «запись не открылась», `{ at }` —
 * прочитали. Карточка на первое не утверждает ничего: пишет, что выяснить не
 * удалось, и называет цену нажатия. Кнопку не прячем — человек может как раз
 * и хотеть проверить; отнимать у него это из-за отказа базы было бы второй
 * ложью того же рода.
 *
 * ГРАНИЦЫ. Отсутствие адреса публикации — полноценный ответ «проверять
 * нечего», и база для него не нужна. Запись про другой адрес или другое имя
 * по-прежнему подтверждением не считается (v4.32.638): это прочитанный
 * ответ, а не отказ.
 */
const mockStore = new Map<string, string>();
let mockReadFails = false;

jest.mock('../../storage/profileScopedKv', () => ({
  scopedKvTryGet: jest.fn(async (k: string) =>
    mockReadFails ? null : { value: mockStore.get(k) ?? null }
  ),
  scopedKvSet: jest.fn(async (k: string, v: string) => {
    mockStore.set(k, v);
  }),
}));

jest.mock('../linkProofCheck', () => ({
  checkLinkProof: jest.fn(async () => ({ ok: true })),
}));

jest.mock('../../logger', () => ({
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { peerLinkVerifiedAt, peerLinkVerifiedAtTry, verifyPeerLink } from '../peerLinkVerify';
import type { ProfileLink } from '../profileLinks';

const PEER = 'B'.repeat(43);
const LINK: ProfileLink = { p: 'github', h: 'anna', u: 'https://gist.github.com/anna/1' };

/** Только код: пояснения не должны сами удовлетворять проверку. */
const codeOnly = (src: string): string =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const ROW = (): string =>
  codeOnly(
    readFileSync(
      join(__dirname, '..', '..', '..', 'ui', 'components', 'modals', 'profile', 'ProfileLinksRow.tsx'),
      'utf8'
    )
  );

beforeEach(() => {
  mockStore.clear();
  mockReadFails = false;
});

describe('отметка проверки исходом', () => {
  it('проверяли — прочитали и отдали дату', async () => {
    await verifyPeerLink(PEER, LINK);
    const read = await peerLinkVerifiedAtTry(PEER, LINK);
    expect(read).not.toBeNull();
    expect(typeof read?.at).toBe('number');
  });

  it('не проверяли — прочитали, внутри пусто', async () => {
    await expect(peerLinkVerifiedAtTry(PEER, LINK)).resolves.toEqual({ at: null });
  });

  it('запись не открылась — это «не знаем», а не «не проверяли»', async () => {
    await verifyPeerLink(PEER, LINK);
    mockReadFails = true;
    await expect(peerLinkVerifiedAtTry(PEER, LINK)).resolves.toBeNull();
  });

  it('ГРАНИЦА: адреса публикации нет — ответ полный и база не нужна', async () => {
    mockReadFails = true;
    await expect(peerLinkVerifiedAtTry(PEER, { p: 'x', h: 'anna', u: null })).resolves.toEqual({ at: null });
  });

  it('ГРАНИЦА: запись про другое имя — прочитанный ответ, а не отказ', async () => {
    await verifyPeerLink(PEER, LINK);
    await expect(peerLinkVerifiedAtTry(PEER, { ...LINK, h: 'petr' })).resolves.toEqual({ at: null });
  });

  it('короткая форма осталась обёрткой и оба ответа по-прежнему сводит', async () => {
    await verifyPeerLink(PEER, LINK);
    expect(await peerLinkVerifiedAt(PEER, LINK)).toEqual(expect.any(Number));
    mockReadFails = true;
    expect(await peerLinkVerifiedAt(PEER, LINK)).toBeNull();
  });
});

describe('форма исходников', () => {
  it('карточка спрашивает исходом и держит третий ответ отдельно', () => {
    const r = ROW();
    expect(r).toContain('const read = await peerLinkVerifiedAtTry(peerPubB64, l);');
    expect(r).toContain("out[l.p] = read === null ? 'unread' : read.at;");
    // Собирающей формы в карточке не осталось: с ней третий ответ негде взять.
    expect(r).not.toContain('peerLinkVerifiedAt(peerPubB64');
  });

  it('непрочитанное подтверждённым не выглядит', () => {
    const r = ROW();
    // Без этого `at !== null` считал бы строку 'unread' датой проверки.
    expect(r.split("const at = typeof state === 'number' ? state : null;").length - 1).toBe(2);
    expect(r.split("const unread = state === 'unread';").length - 1).toBe(2);
  });

  it('вместо утверждения о человеке — что выяснить не удалось и чем грозит нажатие', () => {
    const r = ROW();
    const at = r.indexOf('Проверяли ли вы эту привязку, выяснить не удалось');
    expect(at).toBeGreaterThan(0);
    const said = r.slice(at, at + 400);
    expect(said).toContain('запрос уйдёт на площадку');
    expect(said).toContain('она увидит, что вы смотрите этот профиль');
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: кнопка показывается именно непроверенным', () => {
    const r = ROW();
    expect(r).toContain("if (!isSelf && link.u && !verified) {");
    expect(r).toContain("buttons.push({ text: 'Проверить привязку'");
  });

  it('ЗАКРЕПКА: в сеть без нажатия по-прежнему не ходят', () => {
    const core = codeOnly(readFileSync(join(__dirname, '..', 'peerLinkVerify.ts'), 'utf8'));
    // Чтение отметки обязано оставаться чтением: единственный поход к
    // площадке живёт в verifyPeerLink.
    const tryAt = core.indexOf('export async function peerLinkVerifiedAtTry');
    const verify = core.indexOf('export async function verifyPeerLink');
    expect(tryAt).toBeGreaterThan(0);
    expect(verify).toBeGreaterThan(tryAt);
    expect(core.slice(tryAt, verify)).not.toContain('checkLinkProof');
  });
});
