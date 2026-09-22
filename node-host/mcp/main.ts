/**
 * Точка входа сервера MCP. Здесь нет ни одного вызова ядра — только то, что
 * обязано случиться ДО первого его импорта.
 *
 * Причина та же, что у `proof.ts`: статические импорты ESM выполняются раньше
 * любого кода, а ядро на загрузке уже трогает хранилище (`rateLimiter`
 * поднимает список заблокированных). Значит рабочий каталог и запрет на
 * запасной ключ должны быть выставлены здесь, а ядро подтянуто динамическим
 * импортом после.
 *
 * ─── Почему ключ обязателен именно тут ──────────────────────────────────────
 *
 * Первый этап позволял положить ключ шифрования файлом рядом с данными и
 * печатал об этом предупреждение. Для сервера это недопустимо: в том же
 * каталоге лежат секретные слова кошелька, то есть весь аккаунт, — и снимок
 * тома, резервная копия или забытый на диске каталог унесли бы шифротекст
 * вместе с ключом к нему. Поэтому без `AIRCHAT_SECURE_STORE_KEY` процесс не
 * стартует вовсе и объясняет, чего ему не хватает, — молчаливая деградация
 * здесь означала бы, что защита выключилась, а выглядит всё по-прежнему.
 */
import { setWorkdir } from '../runtime/workdir';
import { requireEnvSecureStoreKey } from '../shims/expo-secure-store';

type Mode = 'stdio' | 'http' | 'enroll';

function usage(): string {
  return [
    'airchat-mcp <stdio|http|enroll> --workdir <каталог> [--host 127.0.0.1] [--port 8787]',
    '',
    '  stdio   — сервер MCP на стандартных потоках: процесс поднимает агент',
    '  http    — сервер MCP на петлевом порту; нужен AIRCHAT_MCP_TOKEN',
    '  enroll  — однократно положить слова аккаунта в secure-store (читает stdin)',
    '',
    'Обязательно: AIRCHAT_SECURE_STORE_KEY — 32 байта в base64.',
  ].join('\n');
}

function die(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const mode = process.argv[2] as Mode | undefined;
if (!mode || !['stdio', 'http', 'enroll'].includes(mode)) {
  die(usage());
}

const dir = arg('workdir') ?? process.env.AIRCHAT_WORKDIR;
if (!dir) die(`не указан рабочий каталог\n\n${usage()}`);

// Проверка ключа — до создания каталога и до любого касания диска. Ошибка
// длины разбирается здесь же: шим сказал бы то же самое, но при первом
// обращении к secure-store, то есть посреди запуска ядра.
const rawKey = process.env.AIRCHAT_SECURE_STORE_KEY;
if (!rawKey) {
  die(
    'AIRCHAT_SECURE_STORE_KEY не задан.\n' +
      'Без него ключ шифрования лёг бы файлом рядом с секретными словами кошелька — ' +
      'то есть защищал бы только от случайного взгляда.\n' +
      'Сгенерировать, например: openssl rand -base64 32\n' +
      'Передавать лучше не переменной окружения в юните, а через LoadCredential systemd ' +
      'или другой источник, который не виден в /proc/<pid>/environ соседним процессам.'
  );
}
if (Buffer.from(rawKey, 'base64').length !== 32) {
  die(
    `AIRCHAT_SECURE_STORE_KEY должен быть 32 байтами в base64, получено ` +
      `${Buffer.from(rawKey, 'base64').length}`
  );
}
requireEnvSecureStoreKey();

setWorkdir(dir);

const { run } = await import('./run');
try {
  await run({
    mode,
    workdir: dir,
    host: arg('host') ?? process.env.AIRCHAT_MCP_HOST ?? '127.0.0.1',
    port: Number(arg('port') ?? process.env.AIRCHAT_MCP_PORT ?? 8787),
  });
} catch (e) {
  // Всё, что не дало начать работу, — один и тот же случай: условия запуска не
  // те. Код возврата тот же, что у проверок выше, чтобы надзиратель отличал
  // «неправильно позвали» (2) от «работало и упало» (70) без разбора текста.
  // Стек печатается только вместе с сообщением: без него отказ вроде
  // `core_no_identity` выглядел бы поломкой, а это законный ответ.
  die(`запуск не состоялся: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
}
