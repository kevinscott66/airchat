/**
 * Никаких запросов по открытому http:// к чужим хостам (v4.32.367).
 *
 * Проверка появилась после того, как в дереве нашёлся прототип
 * `src/core/transport/wifiLocal/`: он рассылал тело сообщения POST-ом на
 * `http://${peer.host}:47320/airchat/message` — открытым текстом, любому
 * устройству в сети, ответившему 200 на пинг. Прототип удалён (рабочий
 * LAN-транспорт живёт в `src/core/transport/lan/`), но сам класс ошибки
 * ловится плохо: одна буква «s» в шаблонной строке, и проверить это на
 * значениях нельзя — адрес собирается прямо в месте вызова.
 *
 * Поэтому проверяем исходники. Правило: литерал внутри `fetch(...)` не может
 * начинаться с `http://`, если сразу за схемой не стоит явный адрес петли.
 * Петля разрешена — это свой же узел IPFS на 127.0.0.1, туда шифрование
 * канала ничего не добавляет.
 *
 * Важно, что запрещён и `http://${host}` с подстановкой: именно так выглядел
 * удалённый прототип, и по литералу не видно, что туда приедет.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');

/** Хосты, которым открытый http не вредит: запрос не покидает устройство. */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      walk(full, out);
    } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

/** Хосты из вызовов fetch с открытой схемой. Пустой массив — нарушений нет. */
export function cleartextFetchHosts(source: string): string[] {
  // Литерал сразу после `fetch(` — с кавычкой любого вида, включая шаблон.
  const calls = source.match(/fetch\(\s*[`'"]http:\/\/[^`'"\s]*/g) ?? [];
  return calls
    .map((c) => (c.match(/http:\/\/([^`'"/\s]*)/) ?? ['', ''])[1])
    // Порт к делу не относится: открытый http на 8080 не лучше открытого на 80.
    .map((h) => h.replace(/:\d+$/, ''))
    .filter((h) => !LOOPBACK.has(h));
}

describe('открытый http наружу', () => {
  const files = walk(SRC);

  it('обход исходников что-то находит', () => {
    // Пустой список означал бы, что проверка молча ничего не проверяет.
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.endsWith('config.ts'))).toBe(true);
  });

  it('ни один fetch не ходит по http к чужому хосту', () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const host of cleartextFetchHosts(readFileSync(f, 'utf8'))) {
        offenders.push(`${f.slice(SRC.length + 1)} → http://${host}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('удалённый прототип не вернулся', () => {
    expect(files.some((f) => f.includes('wifiLocal'))).toBe(false);
  });
});

describe('cleartextFetchHosts', () => {
  it('находит подстановку хоста — так выглядел прототип', () => {
    expect(cleartextFetchHosts('await fetch(`http://${peer.host}:47320/airchat/message`, {})'))
      .toEqual(['${peer.host}']);
  });

  it('петля разрешена вместе с портом', () => {
    expect(cleartextFetchHosts("fetch('http://127.0.0.1:5001/api/v0/add')")).toEqual([]);
    expect(cleartextFetchHosts('fetch(`http://localhost:8080/x`)')).toEqual([]);
  });

  it('https не трогаем', () => {
    expect(cleartextFetchHosts("fetch('https://example.org/x')")).toEqual([]);
  });

  it('строка про http вне вызова — не нарушение', () => {
    // В комментариях и в разборе адресов схема упоминается постоянно.
    expect(cleartextFetchHosts("const s = 'http://ntfy.sh';")).toEqual([]);
    expect(cleartextFetchHosts(".replace(/^ws:\\/\\//i, 'http://')")).toEqual([]);
  });

  it('находит несколько нарушений в одном файле', () => {
    const src = "fetch('http://a.example/1');\nfetch(`http://b.example/2`);";
    expect(cleartextFetchHosts(src)).toEqual(['a.example', 'b.example']);
  });
});
