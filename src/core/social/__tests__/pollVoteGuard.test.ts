import fs from 'fs';
import path from 'path';
import { checkIncomingPollVote, type PollMessageFacts } from '../pollVoteGuard';
import { makePollText } from '../pollEnvelope';

const ALICE = 'QWxpY2U=';
const BOB = 'Qm9i';

const SINGLE = makePollText('Куда идём?', ['В кино', 'Домой', 'Никуда']);
const MULTI = makePollText('Что взять?', ['Хлеб', 'Молоко'], undefined, undefined, true);

const dm = (contactPubB64: string, text: string | null = SINGLE): PollMessageFacts => ({
  kind: 'dm',
  contactPubB64,
  text,
});
const group = (groupId: string, text: string | null = SINGLE): PollMessageFacts => ({
  kind: 'group',
  groupId,
  text,
});

const LOCAL = () =>
  fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');

/** Тело функции от объявления до следующего верхнеуровневого. */
const slice = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
};

describe('checkIncomingPollVote', () => {
  it('пропускает голос в опросе из переписки с самим отправителем', () => {
    expect(checkIncomingPollVote(dm(BOB), { idx: 1 }, BOB)).toEqual({
      ok: true,
      allowMultiple: false,
    });
  });

  it('пропускает голос участника в опросе названной группы', () => {
    expect(checkIncomingPollVote(group('g1'), { idx: 0, groupId: 'g1' }, BOB)).toEqual({
      ok: true,
      allowMultiple: false,
    });
  });

  it('отказывает, когда сообщения нет', () => {
    expect(checkIncomingPollVote({ kind: 'missing' }, { idx: 0 }, BOB)).toEqual({
      ok: false,
      code: 'unknown_message',
    });
  });

  it('групповой опрос нельзя проголосовать конвертом без groupId', () => {
    // Главная дыра: проверка «участник и не забанен» стояла под if (env.groupId),
    // а строка в poll_votes от наличия groupId не зависит. Забаненный участник
    // убирал поле — и голосовал в обход проверки прав.
    expect(checkIncomingPollVote(group('g1'), { idx: 0 }, BOB)).toEqual({
      ok: false,
      code: 'not_in_chat',
    });
  });

  it('голос от участника другой группы не проходит', () => {
    // Права проверялись по env.groupId, а голос писался по env.msgId.
    expect(checkIncomingPollVote(group('g2'), { idx: 0, groupId: 'g1' }, BOB)).toEqual({
      ok: false,
      code: 'wrong_group',
    });
  });

  it('личный опрос из чужой переписки не проходит', () => {
    expect(checkIncomingPollVote(dm(ALICE), { idx: 0 }, BOB)).toEqual({
      ok: false,
      code: 'not_in_chat',
    });
  });

  it('групповой конверт не принимает сообщение личного чата', () => {
    expect(checkIncomingPollVote(dm(BOB), { idx: 0, groupId: 'g1' }, BOB)).toEqual({
      ok: false,
      code: 'wrong_group',
    });
  });

  it('сообщение, которое не опрос, голос не принимает', () => {
    expect(checkIncomingPollVote(dm(BOB, 'привет'), { idx: 0 }, BOB)).toEqual({
      ok: false,
      code: 'not_a_poll',
    });
  });

  it('вариант за пределами опроса не проходит', () => {
    // Конверт ограничивал индекс числом 11 — потолком формата, а не числом
    // вариантов конкретного опроса. Такая строка не рисуется нигде, но входит
    // в «Всего», и проценты перестают складываться в сто.
    expect(checkIncomingPollVote(dm(BOB), { idx: 3 }, BOB)).toEqual({
      ok: false,
      code: 'index_out_of_range',
    });
    expect(checkIncomingPollVote(dm(BOB), { idx: 2 }, BOB).ok).toBe(true);
  });

  it('отрицательный индекс не проходит', () => {
    expect(checkIncomingPollVote(dm(BOB), { idx: -1 }, BOB)).toEqual({
      ok: false,
      code: 'index_out_of_range',
    });
  });

  it('allowMultiple берётся из опроса, а не из конверта', () => {
    // С чужим multi: true хранилище не вытесняет прошлый выбор голосующего —
    // один человек занимал бы все варианты опроса с единственным ответом.
    expect(checkIncomingPollVote(dm(BOB, MULTI), { idx: 1 }, BOB)).toEqual({
      ok: true,
      allowMultiple: true,
    });
    expect(checkIncomingPollVote(dm(BOB, SINGLE), { idx: 1 }, BOB)).toEqual({
      ok: true,
      allowMultiple: false,
    });
  });

  it('пустой текст — честный «это не опрос»', () => {
    expect(checkIncomingPollVote(dm(BOB, ''), { idx: 0 }, BOB)).toEqual({
      ok: false,
      code: 'not_a_poll',
    });
  });

  it('нечитаемая своя копия — отдельный код, а не «это не опрос»', () => {
    // v4.32.574: раньше сюда приходила пустая строка (decryptAtRestString
    // отдаёт '' на осечке), и голос отвергался с кодом not_a_poll — след в
    // журнале указывал на отправителя, хотя сломано было у нас.
    expect(checkIncomingPollVote(dm(BOB, null), { idx: 0 }, BOB)).toEqual({
      ok: false,
      code: 'unreadable_message',
    });
    expect(checkIncomingPollVote(group('g1', null), { idx: 0, groupId: 'g1' }, BOB)).toEqual({
      ok: false,
      code: 'unreadable_message',
    });
  });

  it('нечитаемая копия не отменяет проверок прав — они идут раньше', () => {
    // Иначе по коду отказа было бы видно, что сообщение с таким id вообще
    // есть в базе, — хоть какой-то ответ на выдуманный id из чужого чата.
    expect(checkIncomingPollVote(dm(ALICE, null), { idx: 0 }, BOB)).toEqual({
      ok: false,
      code: 'not_in_chat',
    });
    expect(checkIncomingPollVote(group('g2', null), { idx: 0, groupId: 'g1' }, BOB)).toEqual({
      ok: false,
      code: 'wrong_group',
    });
  });
});

describe('источник фактов различает «пусто» и «не открылось»', () => {
  it('групповой читатель отдаёт null вместо пустой строки', () => {
    const body = slice(
      LOCAL(),
      'export async function getGroupMessageTarget(',
      '\nexport async function getChatMessageTarget('
    );
    expect(body).toContain('text: string | null');
    expect(body).toContain('cellTextOrNull(readAtRestCell(row.text, dek))');
    expect(body).not.toContain('decryptAtRestString');
  });

  it('личный читатель — так же', () => {
    const body = slice(
      LOCAL(),
      'export async function getChatMessageTarget(',
      '\n/**'
    );
    expect(body).toContain('text: string | null');
    expect(body).toContain('cellTextOrNull(readAtRestCell(row.text, dek))');
    expect(body).not.toContain('decryptAtRestString');
  });
});
