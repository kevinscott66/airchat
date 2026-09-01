/**
 * Файлы с переменными окружения не уезжают в репозиторий (v4.32.488).
 *
 * Дефект. .gitignore игнорировал только `.env*.local`, хотя Expo читает и
 * голый `.env`, и `.env.production`. Класть туда есть что: DSN Sentry
 * (`EXPO_PUBLIC_SENTRY_DSN`, см. core/errorHandler) и Team ID подписи iOS
 * (`APPLE_TEAM_ID`, см. app.config.js). То есть самый вероятный из этих
 * файлов не был прикрыт вовсе, и первый же `git add` с путём к нему —
 * или чужая рука с `git add -A` — унесли бы секреты в историю, откуда их
 * не убрать без переписывания истории.
 *
 * Проверка на значениях тут невозможна: правило живёт в .gitignore, а не в
 * коде. Поэтому спрашиваем сам git — так же, как это сделает разработчик.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../..');

function isIgnored(relPath: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', relPath], { cwd: REPO });
    return true;
  } catch {
    return false;
  }
}

describe('.gitignore и переменные окружения', () => {
  it('прикрывает голый .env — самый вероятный файл с секретами', () => {
    expect(isIgnored('.env')).toBe(true);
  });

  it('прикрывает .env с суффиксом окружения', () => {
    for (const f of ['.env.local', '.env.production', '.env.development', '.env.staging']) {
      expect([f, isIgnored(f)]).toEqual([f, true]);
    }
  });

  it('не прикрывает образец без значений — он нужен в репозитории', () => {
    expect(isIgnored('.env.example')).toBe(false);
  });

  it('в образце нет заполненных значений', () => {
    const src = readFileSync(join(REPO, '.env.example'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#'));
    expect(src.length).toBeGreaterThan(0);
    for (const line of src) {
      const value = line.slice(line.indexOf('=') + 1).trim();
      // Пусто или заведомо не секрет (`false`): иначе образец сам стал бы
      // тем, от чего защищаемся.
      expect([line, value === '' || value === 'false']).toEqual([line, true]);
    }
  });

  it('ни один .env не отслеживается git прямо сейчас', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' })
      .split('\n')
      .filter((f) => /(^|\/)\.env($|\.)/.test(f))
      .filter((f) => !f.endsWith('.env.example'));
    expect(tracked).toEqual([]);
  });
});
