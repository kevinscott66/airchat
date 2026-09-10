/**
 * v4.32.683: в канале своя запись стоит там же, где её видит подписчик.
 *
 * Группа и канал делили один рендер сообщения, и сторона пузыря считалась
 * одним признаком «моё». В группе это верно: там разговаривают люди, и «кто
 * сказал» — половина смысла. В канале говорит сам канал: подписчик видит
 * запись слева, серым пузырём и с шапкой автора. Автор же видел ту же запись
 * справа и залитой `primary` — оформление, которого не видит ни один
 * читатель, — и правил переносы, отступы, превью ссылок и сетку снимков
 * вслепую.
 *
 * Признак «моё» этим не отменяется, и проверки ниже это стерегут: галочка
 * доставки, счётчик прочитавших, свой голосовой файл на диске и запрет
 * открыть собственное одноразовое по-прежнему считаются от `isMe`.
 */
import fs from 'fs';
import path from 'path';

const SCREEN = fs.readFileSync(
  path.join(__dirname, '..', 'GroupsScreen.tsx'),
  'utf8'
);

/** Тело рендера одного сообщения — от «моё?» до списка участников. */
function bubbleBody(): string {
  const from = SCREEN.indexOf('const isMe = item.senderPubB64 === myPubB64;');
  const to = SCREEN.indexOf('const isMe = item.peerPubB64 === myPubB64;');
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  const body = SCREEN.slice(from, to);
  // ПРОВЕРКА НЕ ПУСТАЯ: срез действительно захватил рендер сообщения.
  expect(body.length).toBeGreaterThan(10_000);
  return body;
}

describe('сторона пузыря в канале', () => {
  test('экран вообще прочитан', () => {
    expect(SCREEN.length).toBeGreaterThan(100_000);
  });

  test('сторона считается отдельным признаком, а не «моё»', () => {
    expect(SCREEN).toContain("const outgoing = isMe && group.type !== 'channel';");
  });

  test('выравнивание строки и якорь пузыря берут outgoing', () => {
    const body = bubbleBody();
    expect(body).toContain('outgoing ? gcStyles.msgOut : gcStyles.msgIn');
    expect(body).toContain('outgoing ? gcStyles.bubbleAnchorOut : gcStyles.bubbleAnchorIn');
    // ПОВОД ДЛЯ ПРАВКИ ЖИВ: старая форма ушла из файла целиком.
    expect(body).not.toContain('isMe ? gcStyles.msgOut');
    expect(body).not.toContain('isMe ? gcStyles.bubbleAnchorOut');
  });

  test('заливка пузыря берёт outgoing', () => {
    const body = bubbleBody();
    expect(body).toContain('(outgoing ? colors.primary : colors.surface)');
    expect(body).not.toContain('(isMe ? colors.primary : colors.surface)');
  });

  test('шапка автора показывается и на своей записи канала', () => {
    const body = bubbleBody();
    expect(body).toContain('{!outgoing && !anonymousPosting');
    expect(body).not.toContain('{!isMe && !anonymousPosting');
  });

  test('чернила пузыря нигде не считаются от isMe', () => {
    const body = bubbleBody();
    // meInk выведены из colors.primary: на сером пузыре канала они были бы
    // текстом одного цвета с фоном.
    expect(body).not.toContain('isMe ? meInk');
    expect(body).not.toContain('isMe ? meTile');
    expect(body).not.toContain('isMe={isMe}');
    expect(body).not.toContain('isOutgoing={isMe}');
  });

  test('«моё» осталось там, где решает не сторона', () => {
    const body = bubbleBody();
    // свой голосовой файл лежит на диске этой установки
    expect(body).toContain('isOutgoing: isMe, gateway');
    // превью чужой ссылки грузится по отдельному разрешению
    expect(body).toContain('fromPeer={!isMe}');
    // собственное одноразовое не открывается
    expect(body).toContain("{isMe ? 'Один просмотр' : 'Нажмите, чтобы открыть'}");
    // упоминание самого себя не подсвечивается
    expect(body).toContain('const isMentioned = !isMe &&');
    // счётчик прочитавших и галочка доставки — только на своей записи
    expect(body).toContain('isMe && (item.seenBy?.length ?? 0) > 0');
    expect(body).toContain("item.seenUnreadable && (isMe || group.type === 'channel')");
  });

  test('чернила галочки и счётчика не остались фиолетовыми на сером', () => {
    const body = bubbleBody();
    expect(body).toContain('color={outgoing ? meInk.muted : colors.textMuted}');
    expect(body).toContain('color: outgoing ? meInk.secondary : colors.textMuted');
    // ПОВОД ДЛЯ ПРАВКИ ЖИВ: голого meInk в этих двух местах больше нет.
    expect(body).not.toContain('color={meInk.muted}');
    expect(body).not.toContain('color: meInk.secondary }');
  });
});
