/**
 * Подпись сообщения в списках и поиске.
 *
 * Цепочка «префикс — подпись» существовала в четырёх копиях, и копии разошлись.
 * Здесь закреплён общий набор, чтобы новый тип сообщения нельзя было добавить
 * в один экран и забыть про остальные.
 */

import {
  REPLY_PREVIEW_MAX,
  isControlOnlyText,
  isSilentEnvelope,
  previewLabelForText,
  truncateReplyPreview,
} from '../messagePreview';

describe('previewLabelForText', () => {
  it('обычный текст проходит насквозь', () => {
    expect(previewLabelForText('привет')).toBe('привет');
    expect(previewLabelForText('')).toBe('');
  });

  it('каждый тип вложения получает свою подпись', () => {
    expect(previewLabelForText('\x01voice:cid')).toBe('🎤 Голосовое сообщение');
    expect(previewLabelForText('\x04poll:{}')).toBe('📊 Опрос');
    expect(previewLabelForText('\x05contact:{}')).toBe('👤 Контакт');
    expect(previewLabelForText('\x06doc:{}')).toBe('📄 Документ');
    expect(previewLabelForText('\x07loc:{}')).toBe('📍 Геолокация');
    expect(previewLabelForText('\x09vo:cid')).toBe('🔥 Одноразовое сообщение');
    expect(previewLabelForText('\x0agif:https://x/y.gif')).toBe('🎞 GIF');
    expect(previewLabelForText('\x0cliveloc:{}')).toBe('📡 Живая геолокация');
  });

  it('системная строка показывается без управляющего байта', () => {
    // Прежняя причина расхождения: в списке диалогов этой ветки не было, и
    // системная строка попадала в поиск сырой, вместе с '\x0b'.
    expect(previewLabelForText('\x0bsys:Исчезающие сообщения выключены')).toBe('Исчезающие сообщения выключены');
  });

  it('пересылка показывает исходное содержимое, а не имя отправителя', () => {
    expect(previewLabelForText('\x08fwd:Аня\nпривет')).toBe('↪ привет');
    expect(previewLabelForText('\x08fwd:Аня\n\x01voice:cid')).toBe('↪ 🎤 Голосовое сообщение');
    expect(previewLabelForText('\x08fwd:Аня\n')).toBe('↪ Пересланное сообщение');
  });

  it('в подпись не попадает ничего чувствительного', () => {
    // Эта же подпись уходит в тело системного уведомления — то есть на экран
    // блокировки и в журнал уведомлений Android (см. groupMessaging.ts).
    const cases = [
      '\x01voice:{"u":"https://ntfy.sh/abc","k":"SECRETKEY"}',
      '\x06doc:{"name":"паспорт.pdf","size":1,"cid":"QmSECRET"}',
      '\x07loc:{"lat":59.9386,"lon":30.3141,"label":"дом"}',
      '\x05contact:{"name":"Аня","pub":"SECRETKEY"}',
      '\x09vo:подпись одноразового',
      '\x0agif:https://media.giphy.com/x.gif',
    ];
    for (const c of cases) {
      const label = previewLabelForText(c);
      for (const leak of ['secretkey', 'qmsecret', '59.93', '30.31', 'подпись', 'giphy', 'паспорт', 'https']) {
        expect(label.toLowerCase()).not.toContain(leak);
      }
    }
  });

  it('служебные конверты не показываются как текст', () => {
    // Утечка такой строки в превью означала бы показ ключей и путей к файлам.
    for (const c of ['\x02grp:{}', '\x03grpr:{}', '\x0agjr:{}', '\x0egctl:{}', '\x0freact:{}',
      '\x10dmpin:{}', '\x11dis:{}', '\x12pres:{}', '\x13story:{}', '\x14prof:{}']) {
      expect(previewLabelForText(c)).toBe('Системное сообщение');
    }
  });
});

describe('isControlOnlyText', () => {
  it('служебные конверты распознаются', () => {
    // Этот список решает, попадёт ли конверт в переписку строкой: отправка
    // управляющих сообщений идёт через тот же svc.sendMessage, что и обычный
    // текст, и без проверки каждая реакция оседала бы отдельным сообщением.
    for (const c of ['\x02grp:{}', '\x03grpr:{}', '\x0agjr:{}', '\x0egctl:{}', '\x0freact:{}',
      '\x10dmpin:{}', '\x11dis:{}', '\x12pres:{}', '\x13story:{}', '\x14prof:{}']) {
      expect(isControlOnlyText(c)).toBe(true);
    }
  });

  it('конверты с видимым сообщением остаются в переписке', () => {
    // У байта \x0a два значения: gif — настоящее сообщение, gjr — служебный
    // ответ на запрос. Различает их только суффикс, поэтому проверяется отдельно.
    expect(isControlOnlyText('\x0agif:https://media.giphy.com/x.gif')).toBe(false);
    for (const c of ['\x01voice:cid', '\x04poll:{}', '\x05contact:{}', '\x06doc:{}', '\x07loc:{}',
      '\x08fwd:Аня', '\x09vo:подпись', '\x0bsys:вошёл', '\x0cliveloc:{}']) {
      expect(isControlOnlyText(c)).toBe(false);
    }
  });

  it('обычный текст и пустая строка — не конверт', () => {
    expect(isControlOnlyText('привет')).toBe(false);
    expect(isControlOnlyText('')).toBe(false);
  });
});

describe('isSilentEnvelope', () => {
  it('уведомления не заслуживают: отметки, реакции, настройки, сторис, профиль', () => {
    for (const c of ['\x03grpr:{}', '\x0freact:{}', '\x10dmpin:{}', '\x11dis:{}',
      '\x12pres:{}', '\x13story:{}', '\x14prof:{}']) {
      expect(isSilentEnvelope(c)).toBe(true);
    }
  });
  it('группа, приглашение и заявка на вступление будят собеседника', () => {
    expect(isSilentEnvelope('\x02grp:{}')).toBe(false);
    expect(isSilentEnvelope('\x0egctl:{"op":"invite"}')).toBe(false);
    expect(isSilentEnvelope('\x0agjr:{}')).toBe(false);
  });
  it('обычное сообщение уведомление получает', () => {
    expect(isSilentEnvelope('привет')).toBe(false);
    expect(isSilentEnvelope('\x0agif:https://media.giphy.com/x.gif')).toBe(false);
    expect(isSilentEnvelope('\x01voice:cid')).toBe(false);
    expect(isSilentEnvelope('')).toBe(false);
  });
});

describe('truncateReplyPreview', () => {
  it('короткая цитата не трогается', () => {
    expect(truncateReplyPreview('привет')).toBe('привет');
  });

  it('длинная режется по общему пределу', () => {
    const long = 'я'.repeat(REPLY_PREVIEW_MAX + 50);
    expect(truncateReplyPreview(long)).toHaveLength(REPLY_PREVIEW_MAX);
  });

  it('пустая цитата — это отсутствие цитаты, а не пустой пузырь', () => {
    expect(truncateReplyPreview('')).toBeNull();
    expect(truncateReplyPreview(null)).toBeNull();
    expect(truncateReplyPreview(undefined)).toBeNull();
  });

  it('чужая цитата с сети ограничена так же, как своя', () => {
    // v4.32.282: входящая цитата приходит от собеседника, и до этой версии её
    // длину не проверял никто — она ложилась в базу целиком.
    expect(truncateReplyPreview('x'.repeat(100_000))).toHaveLength(REPLY_PREVIEW_MAX);
  });
});

describe('подпись как одна безопасная строка (v4.32.328)', () => {
  it('метка переворота строки не доезжает до списка', () => {
    // U+202E разворачивает всё, что идёт после него, — в списке диалогов это
    // перевернуло бы строку целиком, вместе с именем собеседника и временем.
    expect(previewLabelForText('\u202Eпривет')).toBe('привет');
  });

  it('многострочное сообщение показывается одной строкой', () => {
    expect(previewLabelForText('первая\nвторая\tтретья')).toBe('первая вторая третья');
  });

  it('сообщение из одних переносов не выглядит пустым чатом', () => {
    // Раньше подпись оставалась '\n\n\n' и рисовалась пустой строкой.
    expect(previewLabelForText('\n\n\nПривет')).toBe('Привет');
  });

  it('системная строка тоже чистится', () => {
    expect(previewLabelForText('\x0bsys:\u202EГруппа переименована')).toBe('Группа переименована');
  });

  it('пересланное сообщение чистится вместе с оригиналом', () => {
    expect(previewLabelForText('\x08fwd:Аня\n\u202Eтекст')).toBe('↪ текст');
  });

  it('обычный текст не меняется', () => {
    expect(previewLabelForText('Привет! Как дела?')).toBe('Привет! Как дела?');
  });
});
