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

describe('значения из .env не встречаются в отслеживаемых файлах (v4.32.723)', () => {
  // Прикрыть сам .env мало: секрет утекает не файлом, а строкой — скопированной
  // в конфиг «на время отладки», вписанной в тест как пример, оставленной в
  // скрипте сборки. Поводом стала ссылка на документ OpenFlux: она выглядит как
  // обычный адрес Яндекс.Диска, в code review между строк конфига тревоги не
  // вызывает, а даёт право писать в документ, через который идёт весь трафик
  // приложения в сети с белым списком.
  //
  // Поэтому спрашиваем не про конкретный секрет, а про все разом: берём
  // значения из собственного .env разработчика и ищем каждое в индексе git.
  // Список сам растёт вместе с .env, и следующий секрет будет прикрыт без
  // правки этого файла.
  const envValues = (): string[] => {
    let raw = '';
    try {
      raw = readFileSync(join(REPO, '.env'), 'utf8');
    } catch {
      // .env есть не у всех (CI, свежий клон) — проверять тогда нечего.
      return [];
    }
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, ''))
      // Короткие значения (`false`, `1`, пустое) секретами не бывают, зато
      // совпадают повсюду и превратили бы проверку в шум.
      .filter((v) => v.length >= 12);
  };

  /** Файлы в индексе git, содержащие строку. Пусто — не нашлось. */
  const trackedFilesContaining = (needle: string): string[] => {
    try {
      return execFileSync('git', ['grep', '-I', '-l', '-F', needle, '--', '.'], {
        cwd: REPO,
        encoding: 'utf8',
      })
        .split('\n')
        .filter(Boolean);
    } catch {
      // git grep выходит с кодом 1, когда совпадений нет, — это и нужно.
      return [];
    }
  };

  it('ни одно значение из .env не попало в отслеживаемые файлы', () => {
    for (const value of envValues()) {
      // В сообщении об ошибке — имена файлов, а не сам секрет: иначе журнал
      // упавшего теста стал бы новым местом, где он лежит открыто.
      expect(trackedFilesContaining(value)).toEqual([]);
    }
  });

  it('переменная для ссылки на документ объявлена в образце и пуста', () => {
    const src = readFileSync(join(REPO, '.env.example'), 'utf8');
    expect(src).toMatch(/^EXPO_PUBLIC_OPENFLUX_DOC_URL=\s*$/m);
  });

  it('ядро OpenFlux не отслеживается: 13 МБ артефакта сборки в git не место', () => {
    const blobs = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' })
      .split('\n')
      .filter((f) => /\.(so|a)$/.test(f) || /libopenflux\.h$/.test(f));
    expect(blobs).toEqual([]);
  });
});
