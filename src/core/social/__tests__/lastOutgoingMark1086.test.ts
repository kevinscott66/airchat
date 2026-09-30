/**
 * ДЕФЕКТ. В строке списка чатов значок у моей последней реплики рисовался
 * правилом `item.unreadCount === 0 ? 'checkmark-done' : 'checkmark'`.
 * `unreadCount` — счётчик МОИХ непрочитанных входящих: его обнуляет
 * `markConversationRead`, когда я открываю переписку. О том, дошла ли моя
 * реплика до собеседника и открыл ли он её, этот счётчик не знает ничего.
 *
 * ЦЕНА. Если последнее сообщение моё, входящих непрочитанных обычно нет, и
 * условие выполнялось всегда: двойная галочка — «прочитано» — появлялась в
 * ту же секунду, когда я нажал «отправить». Она стояла и при `failed`
 * (сообщение не ушло вовсе), и при `sent` без cid (лежит в очереди), и когда
 * собеседник неделю не открывал приложение. Двойная галочка — утверждение о
 * другом человеке; список утверждал его без единого основания. При этом сам
 * чат, открытый на экран ниже, показывал правду: MessageStatusIcon
 * разворачивает настоящий статус в пять разных значков. Два соседних экрана
 * говорили об одном сообщении разное, и врал тот, куда смотрят чаще.
 *
 * ПРАВКА. Настоящий статус лежит в `chat_messages.status` и доезжает до
 * строки списка полем `lastOutgoing`. Разворачивает его в значок отдельный
 * чистый модуль — тем же словарём, что и переписка. Если исходящей не нашли
 * или статус незнаком, это отдельный ответ, а не «прочитано».
 *
 * ГРАНИЦЫ. Цвет отдаётся именем токена палитры, значения знает экран.
 * Денормализованной колонки в `conversations` не заводим: статус меняется
 * после записи строки и рассохся бы на первой же смене.
 */
import { lastOutgoingMark } from '../lastOutgoingMark';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../../..');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8');

const codeOnly = (src: string): string =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  if (a < 0) throw new Error(`не нашли начало: ${from}`);
  const b = src.indexOf(to, a);
  if (b < 0) throw new Error(`не нашли конец: ${to}`);
  return src.slice(a, b);
}

const SCREEN = (): string => read('src/ui/screens/ChatListScreen.tsx');
const DB = (): string => read('src/core/storage/local.ts');
const BUBBLE = (): string => read('src/ui/screens/chat-components/MessageStatusIcon.tsx');

/** Блок строки списка, где живёт значок: от контейнера времени до времени. */
const timeRow = (): string =>
  slice(codeOnly(SCREEN()), '<View style={rowStyles.timeRow}>', '<Text style={[rowStyles.time,');

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  test('модуль на месте и отвечает', () => {
    expect(typeof lastOutgoingMark).toBe('function');
    expect(lastOutgoingMark({ status: 'read', cid: 'bafy' })).not.toBeNull();
  });

  test('якоря в исходниках находятся', () => {
    expect(timeRow().length).toBeGreaterThan(20);
    expect(SCREEN()).toContain("const isOut = item.lastMessageDirection === 'out'");
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  test('unreadCount обнуляется, когда переписку открываю Я', () => {
    // Счётчик про моё чтение, а не про чужое: правило одно на весь файл.
    expect(DB()).toContain(
      "'UPDATE conversations SET unread_count = 0 WHERE contact_pub_b64 = ? AND owner_profile_id = ? AND unread_count != 0'"
    );
    expect(DB()).toContain('export async function markConversationRead(');
  });

  test('настоящий статус у сообщения есть и всегда был', () => {
    expect(DB()).toContain('status TEXT NOT NULL');
  });

  test('в переписке тот же статус разворачивается в пять разных значков', () => {
    const b = BUBBLE();
    expect(b).toContain("case 'read':");
    expect(b).toContain("case 'delivered':");
    expect(b).toContain("case 'sent':");
    expect(b).toContain("case 'sending':");
    expect(b).toContain("case 'failed':");
  });
});

describe('список больше не выдаёт «прочитано» за догадку', () => {
  test('значок в строке не считается из счётчика непрочитанных', () => {
    const row = timeRow();
    expect(row).toContain('<Ionicons');
    expect(row).not.toContain('unreadCount');
  });

  test('экран берёт значок у модуля, а не выдумывает сам', () => {
    const code = codeOnly(SCREEN());
    expect(code).toContain('lastOutgoingMark(item.lastOutgoing)');
    expect(code).toContain('name={outMark.icon}');
    expect(code).toContain('color={colors[outMark.tone]}');
    expect(code).toContain('accessibilityLabel={outMark.label}');
  });

  test('не знаем — не рисуем', () => {
    expect(codeOnly(SCREEN())).toContain('{isOut && outMark ?');
    expect(lastOutgoingMark(null)).toBeNull();
    expect(lastOutgoingMark(undefined)).toBeNull();
  });

  test('статус доезжает до строки из самих сообщений', () => {
    const db = codeOnly(DB());
    expect(db).toContain('AS last_out_status');
    expect(db).toContain('AS last_out_cid');
    expect(db).toContain("m.direction = 'out'");
    expect(db).toContain('lastOutgoing:');
    // Прежнее чтение строки диалога ничего не знало о сообщениях.
    expect(db).not.toContain('`SELECT * FROM conversations');
  });

  test('подзапрос не читает сообщений там, где значка не будет', () => {
    // Диалог с входящей последней репликой: значок не рисуется, и искать
    // исходящую по всей переписке незачем.
    expect(codeOnly(DB())).toContain("WHERE c.last_message_direction = 'out'");
  });
});

describe('каждому исходу своё лицо', () => {
  test('прочитано — двойная галочка акцентом', () => {
    expect(lastOutgoingMark({ status: 'read', cid: 'bafy' })).toEqual({
      icon: 'checkmark-done',
      tone: 'accent',
      label: 'Прочитано',
    });
  });

  test('доставлено — не то же, что прочитано', () => {
    const delivered = lastOutgoingMark({ status: 'delivered', cid: 'bafy' });
    const read_ = lastOutgoingMark({ status: 'read', cid: 'bafy' });
    expect(delivered).toEqual({
      icon: 'checkmark-done-outline',
      tone: 'textMuted',
      label: 'Доставлено',
    });
    expect(delivered?.icon).not.toBe(read_?.icon);
    expect(delivered?.tone).not.toBe(read_?.tone);
  });

  test('отправлено — одиночная галочка', () => {
    expect(lastOutgoingMark({ status: 'sent', cid: 'bafy' })).toEqual({
      icon: 'checkmark-outline',
      tone: 'textMuted',
      label: 'Отправлено',
    });
  });

  test('не отправлено — не галочка и цветом ошибки', () => {
    const failed = lastOutgoingMark({ status: 'failed', cid: null });
    expect(failed).toEqual({
      icon: 'alert-circle-outline',
      tone: 'error',
      label: 'Не отправлено',
    });
    expect(failed?.icon).not.toContain('checkmark');
  });

  test('отправляется — часы, а не галочка', () => {
    const sending = lastOutgoingMark({ status: 'sending', cid: null });
    expect(sending?.label).toBe('Отправляется');
    expect(sending?.icon).not.toContain('checkmark');
  });

  test('отдано в очередь, но тела в сети нет — свой значок', () => {
    const queued = lastOutgoingMark({ status: 'sent', cid: null });
    expect(queued).toEqual({
      icon: 'cloud-upload-outline',
      tone: 'textMuted',
      label: 'В очереди на отправку',
    });
    expect(queued?.icon).not.toBe(lastOutgoingMark({ status: 'sent', cid: 'bafy' })?.icon);
  });

  test('незнакомый статус — «не знаем», а не «прочитано»', () => {
    const unknown = lastOutgoingMark({ status: 'какое-то новое слово', cid: 'bafy' });
    expect(unknown?.label).toBe('Статус неизвестен');
    expect(unknown?.icon).not.toContain('checkmark');
    expect(unknown?.tone).not.toBe('accent');
  });

  test('ни один известный исход не молчит', () => {
    for (const status of ['read', 'delivered', 'sent', 'sending', 'failed']) {
      expect(lastOutgoingMark({ status, cid: 'bafy' })).not.toBeNull();
    }
  });
});

describe('список и переписка говорят одно', () => {
  test('значки известных исходов совпадают с пузырём', () => {
    const b = BUBBLE();
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ['read', 'checkmark-done'],
      ['delivered', 'checkmark-done-outline'],
      ['sent', 'checkmark-outline'],
    ];
    for (const [status, icon] of pairs) {
      expect(lastOutgoingMark({ status, cid: 'bafy' })?.icon).toBe(icon);
      expect(b).toContain(`name="${icon}"`);
    }
  });

  test('очередь названа в обоих местах одинаково', () => {
    expect(lastOutgoingMark({ status: 'sent', cid: null })?.label).toBe('В очереди на отправку');
    expect(BUBBLE()).toContain('accessibilityLabel="В очереди на отправку"');
  });
});

describe('ГРАНИЦА', () => {
  test('цвет отдаётся именем токена, а не значением', () => {
    const src = read('src/core/social/lastOutgoingMark.ts');
    expect(src).not.toContain('#');
    expect(src).not.toContain("from '../../ui/");
  });

  test('имена токенов есть в палитре', () => {
    const theme = read('src/ui/theme.ts');
    for (const tone of ['accent', 'textMuted', 'error']) {
      expect(theme).toContain(`${tone}:`);
    }
  });

  test('cid важен только для «отправлено»', () => {
    for (const status of ['read', 'delivered', 'sending', 'failed']) {
      expect(lastOutgoingMark({ status, cid: null })).toEqual(
        lastOutgoingMark({ status, cid: 'bafy' })
      );
    }
  });
});
