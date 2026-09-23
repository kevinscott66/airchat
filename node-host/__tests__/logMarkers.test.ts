/**
 * Имена строк журнала, по которым host отличает отказы ядра, ещё существуют.
 *
 * `mcp/tools.ts` не спрашивает у ядра причину отказа — ядро её не возвращает,
 * `sendMessage` отвечает одинаковым `null` на четыре разные беды. Причину он
 * достаёт из журнала, сравнивая имя строки со своим списком: `dm_send_blocked`,
 * `dm_send_rate_limited` и так далее.
 *
 * Связь эта держится на голых строковых литералах в двух файлах сразу, и
 * ломается она молча. Переименуют `dm_send_blocked` в ядре — host не упадёт, не
 * предупредит и даже не станет медленнее: он просто перестанет узнавать отказ,
 * и вместо «контакт заблокирован; снять блокировку может только человек»
 * вызывающий начнёт получать `unknown`. То есть развалится ровно то, ради чего
 * весь этот механизм и написан, а заметят это в лучшем случае через месяц.
 *
 * Поэтому имена собираются из самого `tools.ts` регулярным выражением, а не
 * переписываются сюда списком: новый маркер попадает под проверку сам, без
 * правки этого файла.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const TOOLS = join(__dirname, '..', 'mcp', 'tools.ts');
const CORE = join(__dirname, '..', '..', 'src');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/** Имена, по которым host опознаёт строки журнала. */
function markers(src: string): string[] {
  const found = new Set<string>();
  for (const re of [/\be\.msg === '([a-z0-9_]+)'/g, /\bmarker: '([a-z0-9_]+)'/g]) {
    for (const m of src.matchAll(re)) found.add(m[1]);
  }
  return [...found].sort();
}

describe('маркеры журнала ядра', () => {
  const names = markers(readFileSync(TOOLS, 'utf8'));
  const core = sources(CORE)
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');

  it('маркеры вообще нашлись', () => {
    // Страховка от «зелено, потому что регулярка перестала цеплять».
    expect(names.length).toBeGreaterThanOrEqual(6);
    expect(names).toContain('dm_send_blocked');
  });

  it('каждый маркер пишется ядром', () => {
    const orphan = names.filter((n) => !core.includes(`'${n}'`));
    expect(orphan).toEqual([]);
  });
});
