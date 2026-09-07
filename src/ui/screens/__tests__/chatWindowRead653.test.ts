/**
 * Окно переписки отличает сбой чтения от пустой переписки (v4.32.653).
 *
 * Дефект. `appendNewMessages` в экране чата читал окно через
 * `svc.getMessages(...)`, а тот берёт строки у `listChatMessages`, который
 * гасит сбой пустым списком (`listChatMessagesPage(...) ?? []`). Результат
 * уходил в `mergeChatWindow` третьим доводом — как «всё окно целиком», —
 * а пустое окно эта склейка понимает однозначно: в базе не осталось ничего,
 * значит с экрана надо убрать всё. Одно неудачное открытие базы (окно
 * остывания при переоткрытии, `local.ts`) стирало переписку целиком, и она
 * не возвращалась до повторного входа в чат.
 *
 * Второй, более тихий случай той же природы: `getMessages` САМ отбрасывает
 * надгробия (строки с текстом из одного невидимого символа). Экран передавал
 * его выдачу как «окно, включая невидимые строки», хотя невидимых там уже не
 * было. Дюжина удалённых сообщений подряд (`POLL_BATCH = 12`) давала пустую
 * выдачу при непустой переписке — и экран очищался ровно так же.
 *
 * Лечение. Отдельный читатель окна, у которого отказ виден в типе
 * (`readChatMessageWindow` → `ChatMessageRow[] | null`), и метод
 * `readMessageWindow` у службы переписки: он не фильтрует и не гасит.
 * На `null` склейка не запускается вовсе — экран остаётся при том, что знал.
 *
 * Заодно правило порядка строк переехало в общий `compareChatRows`: до этого
 * оно было выписано в `getMessages` и `getOlderMessages` по отдельности, и
 * третий читатель выписал бы его в третий раз. Разъехавшийся порядок здесь
 * уже стоил пропавших сообщений (v4.32.581).
 */
import fs from 'fs';
import path from 'path';

import { compareChatRows, isOlderThan } from '../../../core/storage/chatPageCursor';

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const LOCAL = (): string => read('core/storage/local.ts');
const MESSAGING = (): string => read('core/social/messaging.ts');
const CHAT = (): string => read('ui/screens/ChatScreen.tsx');
const MERGE = (): string => read('core/utils/mergeChatWindow.ts');

/** Строки кода без комментариев — пояснение не должно подменять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

/** Отрезок исходника между двумя якорями. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('повод для правки жив', () => {
  it('listChatMessages по-прежнему гасит сбой пустым списком', () => {
    // Договор менять этот раунд не берётся — именно поэтому нужен отдельный
    // читатель. Если договор однажды поменяют, эта проверка упадёт и заставит
    // пересмотреть readChatMessageWindow, а не тихо оставит два пути.
    const body = slice(
      LOCAL(),
      'export async function listChatMessages(',
      'async function listChatMessagesPage('
    );
    expect(body).toContain('?? [];');
  });

  it('страничный читатель по-прежнему отдаёт null при сбое', () => {
    const body = slice(
      LOCAL(),
      'async function listChatMessagesPage(',
      'export async function listAllChatMessages('
    );
    expect(body).toContain('Promise<ChatMessageRow[] | null>');
    expect(body).toContain('return null;');
  });

  it('getMessages по-прежнему сам отбрасывает надгробия', () => {
    const body = slice(MESSAGING(), 'async getMessages(', 'async readMessageWindow(');
    expect(body).toContain(".filter((r) => r.text !== '\\u200b')");
  });

  it('склейка по-прежнему считает пустое окно приказом очистить экран', () => {
    expect(codeOnly(MERGE())).toContain(
      'if (windowRows.length === 0) return prev.length === 0 ? (prev as T[]) : [];'
    );
  });
});

describe('общий порядок строк переписки', () => {
  const row = (createdAt: number, id: string): { createdAt: number; id: string } => ({ createdAt, id });

  it('сначала время', () => {
    expect(compareChatRows(row(1, 'z'), row(2, 'a'))).toBeLessThan(0);
    expect(compareChatRows(row(2, 'a'), row(1, 'z'))).toBeGreaterThan(0);
  });

  it('при совпадении времени — id побайтно, а не по локали', () => {
    // Побайтно 'Z' (0x5A) идёт перед 'a' (0x61). По локали — наоборот, и
    // именно этим порядок разъезжается с 'ORDER BY ... id DESC' в запросе.
    expect(compareChatRows(row(5, 'Z'), row(5, 'a'))).toBeLessThan(0);
    expect(compareChatRows(row(5, 'a'), row(5, 'Z'))).toBeGreaterThan(0);
    // Сравнение по локали здесь дало бы другой знак — проверяем, что его нет
    // ни в одном из трёх читателей окна.
    expect(MESSAGING()).not.toContain('localeCompare');
  });

  it('одинаковые строки равны', () => {
    expect(compareChatRows(row(5, 'a'), row(5, 'a'))).toBe(0);
  });

  it('порядок совпадает с курсором страницы — иначе строки пропадают', () => {
    const rows = [row(5, 'b'), row(5, 'a'), row(4, 'z'), row(6, 'a')];
    for (const a of rows) {
      for (const b of rows) {
        if (a.id === b.id && a.createdAt === b.createdAt) continue;
        expect(compareChatRows(a, b) < 0).toBe(isOlderThan(a, b));
      }
    }
  });
});

describe('читатель окна: отказ виден в типе', () => {
  it('local.ts отдаёт окно без гашения пустым списком', () => {
    const body = slice(
      LOCAL(),
      'export async function readChatMessageWindow(',
      'export async function listChatMessages('
    );
    expect(body).toContain('Promise<ChatMessageRow[] | null>');
    expect(body).toContain('return listChatMessagesPage({ contactPubB64, limit, offset: 0, ownerProfileId });');
    expect(codeOnly(body)).not.toContain('?? []');
  });

  it('служба переписки не фильтрует окно и не гасит отказ', () => {
    const body = slice(MESSAGING(), 'async readMessageWindow(', 'async getOlderMessages(');
    expect(body).toContain('Promise<ChatMessageRow[] | null>');
    expect(body).toContain('if (rows === null) return null;');
    expect(body).toContain('.sort(compareChatRows)');
    // Надгробия обязаны остаться: ими задаётся граница окна.
    expect(codeOnly(body)).not.toContain("!== '\\u200b'");
  });
});

describe('экран чата: сорвавшееся чтение не стирает переписку', () => {
  it('окно берётся у читателя с отказом в типе, а не у getMessages', () => {
    const src = codeOnly(CHAT());
    expect(src).toContain('const win = await svc.readMessageWindow(peerB64, POLL_BATCH);');
    expect(src).not.toContain('svc.getMessages(peerB64, POLL_BATCH, 0)');
  });

  it('на отказе склейка не запускается, и он попадает в журнал', () => {
    const body = slice(CHAT(), 'const win = await svc.readMessageWindow(', 'setLines((prev) =>');
    expect(body).toContain('if (win === null) {');
    expect(body).toContain("log.warn('ui_chat_window_read_failed'");
    // Ранний выход обязателен: без него null дошёл бы до склейки.
    expect(body).toContain(
      "if (win === null) {\n        log.warn('ui_chat_window_read_failed', { ms: _dt });\n        return;\n      }"
    );
  });

  it('границу окна задаёт неотфильтрованная выборка', () => {
    const src = codeOnly(CHAT());
    expect(src).toContain("const filtered = win.filter((m) => m.text !== '\\u200b');");
    expect(src).toContain('mergeChatWindow(prev, filtered, win)');
    expect(src).not.toContain('mergeChatWindow(prev, filtered, latest)');
  });
});

describe('проверка не пустая', () => {
  it('все четыре исходника прочитаны', () => {
    for (const s of [LOCAL(), MESSAGING(), CHAT(), MERGE()]) {
      expect(s.length).toBeGreaterThan(500);
    }
  });

  it('codeOnly действительно снимает комментарии', () => {
    expect(codeOnly('// абв\nconst a = 1;')).toBe('const a = 1;');
  });

  it('slice действительно режет', () => {
    expect(slice('AxxxB', 'A', 'B')).toBe('Axxx');
  });
});
