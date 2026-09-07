/**
 * Планка итераций KDF стала двусторонней (v4.32.625).
 *
 * Снизу её ставили ещё в v4.32.177 — от попытки удешевить перебор пароля.
 * Сверху не ставили нигде, а `Math.max` значение только поднимает. Между тем
 * число приходит СНАРУЖИ: конверт привязки — с сервера, зашифрованная копия —
 * из буфера обмена. `iters: 1e15` проходил `Number.isSafeInteger` и уезжал в
 * синхронный pbkdf2, то есть вешал поток JS навсегда — без отмены и без
 * спиннера, потому что вход по Apple ID начинается до `setBusy(true)`.
 *
 * Само число проверяется поведением, а разводка по трём местам — формой
 * исходника: подсунуть в тест конверт с запредельным `iters` нельзя, не
 * повесив сам тест.
 */
import fs from 'fs';
import path from 'path';
import { MAX_KDF_ITERS, acceptKdfIters } from '../../crypto/kdfIters';

const BACKUP = path.join(__dirname, '..');
const SEED_BINDING = fs.readFileSync(path.join(BACKUP, 'seedBinding.ts'), 'utf8');
const SEED_PHRASE = fs.readFileSync(path.join(BACKUP, 'seedPhrase.ts'), 'utf8');

/** Строки без комментариев: свой же текст не должен подтверждать проверку. */
function codeLines(source: string): string {
  return source
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

describe('acceptKdfIters — годное число итераций', () => {
  it('запредельное значение отвергается', () => {
    expect(acceptKdfIters(1e15, 600_000)).toBeNull();
    expect(acceptKdfIters(MAX_KDF_ITERS + 1, 600_000)).toBeNull();
  });

  it('заниженное значение отвергается — прежняя планка на месте', () => {
    expect(acceptKdfIters(1, 600_000)).toBeNull();
    expect(acceptKdfIters(599_999, 600_000)).toBeNull();
  });

  it('не число и не целое — тоже отказ', () => {
    expect(acceptKdfIters(undefined, 600_000)).toBeNull();
    expect(acceptKdfIters('600000', 600_000)).toBeNull();
    expect(acceptKdfIters(600_000.5, 600_000)).toBeNull();
    expect(acceptKdfIters(Number.POSITIVE_INFINITY, 600_000)).toBeNull();
    expect(acceptKdfIters(-1, 600_000)).toBeNull();
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: годные значения проходят и возвращаются как есть', () => {
    expect(acceptKdfIters(600_000, 600_000)).toBe(600_000);
    expect(acceptKdfIters(1_000_000, 600_000)).toBe(1_000_000);
    expect(acceptKdfIters(MAX_KDF_ITERS, 600_000)).toBe(MAX_KDF_ITERS);
  });

  it('потолок совпадает с серверным SEED_ENVELOPE_MAX_ITERS', () => {
    const server = fs.readFileSync(
      path.join(BACKUP, '..', '..', '..', 'server', 'cloud-vault', 'seed-binding.js'),
      'utf8',
    );
    const m = server.match(/SEED_ENVELOPE_MAX_ITERS\s*=\s*([0-9_]+)/);
    expect(m).not.toBeNull();
    expect(Number((m as RegExpMatchArray)[1].replace(/_/g, ''))).toBe(MAX_KDF_ITERS);
  });
});

describe('все три входа проходят через общую планку', () => {
  it('конверт привязки берёт iters только у acceptKdfIters', () => {
    const code = codeLines(SEED_BINDING);
    expect(code).toContain('const iters = acceptKdfIters(envelope.iters, SEED_BINDING_KDF_ITERS);');
    expect(code).toContain('if (iters == null) return null;');
    // Прежняя односторонняя проверка ушла целиком.
    expect(code).not.toContain('Number.isSafeInteger(envelope.iters)');
    // И ключ выводится из проверенного числа, а не из сырого поля.
    expect(code).toContain('deriveBindingKey(password, new Uint8Array(salt), iters)');
    expect(code).not.toContain('deriveBindingKey(password, new Uint8Array(salt), envelope.iters)');
  });

  it('у конверта привязки появился предел на длину шифртекста', () => {
    const code = codeLines(SEED_BINDING);
    expect(code).toContain('const SEED_BINDING_MAX_DATA_B64 = 4096;');
    const gate = code.indexOf('if (envelope.dataB64.length > SEED_BINDING_MAX_DATA_B64) return null;');
    const decode = code.indexOf("Buffer.from(envelope.dataB64, 'base64')");
    expect(gate).toBeGreaterThan(0);
    // Проверка длины — ДО раскодирования, иначе память уже выделена.
    expect(decode).toBeGreaterThan(gate);
  });

  it('вставленная копия и местная обёртка — тем же входом', () => {
    const code = codeLines(SEED_PHRASE);
    expect(code).toContain('const iters = acceptKdfIters(payload.iters ?? BACKUP_KDF_ITERS, BACKUP_KDF_ITERS);');
    expect(code).toContain('if (iters == null) throw new Error(BAD_BACKUP_MESSAGE);');
    expect(code).toContain('const iters = acceptKdfIters(p.iters ?? LOCAL_WRAP_ITERS, LOCAL_WRAP_ITERS);');
    // Прежний односторонний Math.max не остался ни там, ни там.
    expect(code).not.toContain('Math.max(payload.iters');
    expect(code).not.toContain('Math.max(p.iters');
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: сами вызовы pbkdf2 на месте и берут проверенное число', () => {
    const code = codeLines(SEED_PHRASE);
    expect(code).toContain('c: iters,');
    expect(code).toContain('{ c: iters, dkLen: 32 }');
  });
});
