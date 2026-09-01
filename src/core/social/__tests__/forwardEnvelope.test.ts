/**
 * Пересылка: '\x08fwd:Имя\nТекст'.
 *
 * До v4.32.240 кодек был четырьмя строками в ChatScreen.tsx: имя подставлялось
 * без вычистки, тело — как есть (включая JSON голосового с локальным путём),
 * а пачка сообщений склеивалась через '\n\n', хотя разбор смотрит только на
 * первый перевод строки.
 */

import {
  FORWARD_PREFIX,
  isForwardedMessage,
  makeForwardBundleText,
  makeForwardText,
  parseForwardedMessage,
} from '../forwardEnvelope';

describe('makeForwardText / parseForwardedMessage', () => {
  it('round-trip обычного текста', () => {
    const t = makeForwardText('Аня', 'привет');
    expect(isForwardedMessage(t)).toBe(true);
    expect(parseForwardedMessage(t)).toEqual({ senderName: 'Аня', originalText: 'привет' });
  });

  it('многострочный текст доезжает целиком', () => {
    const t = makeForwardText('Аня', 'первая\nвторая\nтретья');
    expect(parseForwardedMessage(t)?.originalText).toBe('первая\nвторая\nтретья');
  });

  it('не пересылка — null', () => {
    for (const t of ['', 'привет', '\x01voice:{}']) expect(parseForwardedMessage(t)).toBeNull();
  });

  it('перевод строки в имени не дописывает текст к пересылке', () => {
    // Раньше '\x08fwd:' + 'Аня\nПеревод денег подтверждён' + '\n' + 'ок' давало
    // строку, неотличимую от пересылки от «Аня» с текстом
    // «Перевод денег подтверждён\nок».
    const t = makeForwardText('Аня\nПеревод денег подтверждён', 'ок');
    const p = parseForwardedMessage(t);
    expect(p?.senderName).not.toContain('\n');
    expect(p?.originalText).toBe('ок');
  });

  it('имя обрезается по длине заголовка', () => {
    const p = parseForwardedMessage(makeForwardText('и'.repeat(500), 'привет'));
    expect(p?.senderName.length).toBe(64);
    expect(p?.originalText).toBe('привет');
  });

  it('имя вычищается и на разборе — строку мог собрать чужой клиент', () => {
    const p = parseForwardedMessage(`${FORWARD_PREFIX}Аня\x07\x00\nпривет`);
    // v4.32.374: два управляющих символа на конце давали два пробела и подпись
    // «Аня  » с отступом до самого текста. Края имени теперь срезаются.
    expect(p?.senderName).toBe('Аня');
  });

  it('пересылка без перевода строки не роняет разбор', () => {
    expect(parseForwardedMessage(`${FORWARD_PREFIX}привет`)).toEqual({ senderName: '', originalText: 'привет' });
  });
});

describe('пересылка мультимедиа не тащит машинное тело', () => {
  it('голосовое едет подписью, а не путём к файлу отправителя', () => {
    const voice = '\x01voice:{"uri":"file:///data/user/0/com.anonymous.airchat/cache/rec.m4a","durationMs":3200}';
    const p = parseForwardedMessage(makeForwardText('Аня', voice));
    expect(p?.originalText).toBe('🎤 Голосовое сообщение');
    expect(p?.originalText).not.toContain('file://');
  });

  it('документ, геолокация, контакт и опрос — тоже подписью', () => {
    const cases: Array<[string, string]> = [
      ['\x06doc:{"name":"смета.xlsx","size":1,"cid":"Qm1"}', '📄 Документ'],
      ['\x07loc:{"lat":1,"lon":2,"label":""}', '📍 Геолокация'],
      ['\x05contact:{"name":"Аня","pub":"AAA"}', '👤 Контакт'],
      ['\x04poll:{"q":"?"}', '📊 Опрос'],
      ['\x0cliveloc:{"lat":1,"lon":2}', '📡 Живая геолокация'],
    ];
    for (const [raw, label] of cases) {
      expect(parseForwardedMessage(makeForwardText('Аня', raw))?.originalText).toBe(label);
    }
  });

  it('служебный конверт не показывает свой JSON', () => {
    const p = parseForwardedMessage(makeForwardText('Аня', '\x02grp:{"gid":"g1","key":"secret"}'));
    expect(p?.originalText).toBe('Системное сообщение');
    expect(p?.originalText).not.toContain('secret');
  });

  it('системная строка едет своим человеческим текстом, без байта', () => {
    const p = parseForwardedMessage(makeForwardText('Аня', '\x0bsys:Звонок завершён'));
    expect(p?.originalText).toBe('Звонок завершён');
  });

  it('одноразовое остаётся текстом — префикс снимает экран', () => {
    expect(parseForwardedMessage(makeForwardText('Аня', '\x09vo:подпись'))?.originalText).toBe('\x09vo:подпись');
  });

  it('чужой клиент прислал сырой конверт внутри пересылки — разбор всё равно подменяет', () => {
    const p = parseForwardedMessage(`${FORWARD_PREFIX}Аня\n\x01voice:{"uri":"file:///private/x.m4a"}`);
    expect(p?.originalText).toBe('🎤 Голосовое сообщение');
  });
});

describe('пересылка пересылки', () => {
  it('сохраняет первоначального автора, а не посредника', () => {
    const once = makeForwardText('Аня', 'привет');
    const twice = makeForwardText('Боря', once);
    expect(parseForwardedMessage(twice)).toEqual({ senderName: 'Аня', originalText: 'привет' });
  });
});

describe('makeForwardBundleText', () => {
  const items = [
    { senderName: 'Аня', text: 'привет' },
    { senderName: 'Боря', text: 'пока' },
  ];

  it('несколько сообщений — один конверт, а не склейка конвертов', () => {
    const t = makeForwardBundleText(items);
    // Ровно один префикс на всю пачку: иначе разбор увидит только первый.
    expect(t.split(FORWARD_PREFIX).length - 1).toBe(1);
    const p = parseForwardedMessage(t);
    expect(p?.senderName).toBe('');
    expect(p?.originalText).toBe('Аня: привет\nБоря: пока');
  });

  it('одно сообщение — обычная пересылка с именем', () => {
    expect(parseForwardedMessage(makeForwardBundleText([items[0]]))).toEqual({ senderName: 'Аня', originalText: 'привет' });
  });

  it('пустой список — пустая строка', () => {
    expect(makeForwardBundleText([])).toBe('');
  });

  it('мультимедиа в пачке тоже едет подписью', () => {
    const t = makeForwardBundleText([
      { senderName: 'Аня', text: '\x01voice:{"uri":"file:///private/x.m4a","durationMs":1}' },
      { senderName: 'Боря', text: 'пока' },
    ]);
    expect(parseForwardedMessage(t)?.originalText).toBe('Аня: 🎤 Голосовое сообщение\nБоря: пока');
  });

  it('перевод строки в имени внутри пачки не подделывает лишнюю строку', () => {
    const t = makeForwardBundleText([
      { senderName: 'Аня\nБанк: платёж принят', text: 'привет' },
      { senderName: 'Боря', text: 'пока' },
    ]);
    expect(parseForwardedMessage(t)?.originalText).toBe('Аня Банк: платёж принят: привет\nБоря: пока');
  });
});
