/**
 * Журнал ядра лежит закрытым, и лежит закрытым всегда.
 *
 * В строках журнала бывают DID и адреса пиров, поэтому файлу положены права
 * 0600. Ловушка в том, что режим в `fs.openSync(file, 'a', 0o600)` действует
 * ТОЛЬКО на создание: для уже существующего файла аргумент молча игнорируется.
 * То есть журнал, созданный прежней сборкой с правами по умолчанию, оставался
 * бы читаемым всем на всех последующих запусках — и первый тест ниже именно
 * про этот случай, второй только фиксирует новый файл.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { attachLogSink, detachLogSink } from '../runtime/logBus';

function mode(file: string): number {
  // Младшие 9 бит: rwx для владельца, группы и остальных.
  return fs.statSync(file).mode & 0o777;
}

describe('приёмник журнала ядра', () => {
  let dir = '';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbus-'));
  });

  afterEach(() => {
    detachLogSink();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('закрывает файл, который уже лежал открытым', () => {
    const file = path.join(dir, 'core.log');
    fs.writeFileSync(file, 'старая запись\n');
    fs.chmodSync(file, 0o644);
    expect(mode(file)).toBe(0o644);

    attachLogSink(file);

    expect(mode(file)).toBe(0o600);
    // Дописывание, а не перезапись: причины отказа нужны в том порядке, в
    // каком случились, в том числе через перезапуск.
    expect(fs.readFileSync(file, 'utf8')).toContain('старая запись');
  });

  it('создаёт новый файл сразу закрытым', () => {
    const file = path.join(dir, 'core.log');
    attachLogSink(file);
    expect(fs.existsSync(file)).toBe(true);
    expect(mode(file)).toBe(0o600);
  });
});
