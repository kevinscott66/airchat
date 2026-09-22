/**
 * Тело долгоживущего процесса: поднять ядро, отдать инструменты, честно
 * остановиться.
 *
 * Разделение с `main.ts` не косметическое. Всё, что здесь, статически
 * импортирует ядро, а значит выполняется только после того, как `main.ts`
 * назначил рабочий каталог и запретил запасной ключ. Поменяйте местами — и
 * ядро на загрузке потрогает хранилище раньше, чем узнает, где оно.
 *
 * ─── Что тут про «переживать обрывы» ────────────────────────────────────────
 *
 * Почти ничего, и это намеренно. Переподключение к релею, повтор подписки и
 * водяной знак, по которому дочитывается пропущенное, уже живут в ядре
 * (`internetCoordinator`, `relayBacklog`, `internetTransport`) и работают на
 * телефоне, где сеть рвётся куда чаще, чем на сервере. Свой цикл
 * переподключения здесь соревновался бы с ядерным, а не помогал ему.
 *
 * Наша часть — только края: остановка по сигналу без порванной базы и
 * поведение, когда ядро всё-таки упало.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { startCore, stopCore } from '../host';
import { checkHttpPreconditions, startHttp, type RunningHttp } from './httpServer';
import { createServer } from './server';
import { markStarted } from './tools';
import pkg from '../../package.json';

export type RunOptions = {
  mode: 'stdio' | 'http' | 'enroll';
  workdir: string;
  host: string;
  port: number;
};

/** Сколько ждать остановку ядра, прежде чем выйти всё равно. */
const STOP_DEADLINE_MS = 10_000;

const EXIT_STOP_TIMEOUT = 75;
const EXIT_CRASH = 70;

function note(line: string): void {
  // Всё служебное — только в stderr. В режиме stdio стандартный вывод занят
  // протоколом, и одна посторонняя строка в нём рвёт разговор с агентом.
  process.stderr.write(`[mcp] ${line}\n`);
}

/**
 * Перенаправление консоли в stderr.
 *
 * Ядро писалось для телефона и в нескольких местах говорит через `console.*`
 * (шимы недоступных нативных модулей — тоже). В режиме stdio такая строка
 * попала бы в поток протокола между кадрами JSON-RPC, и клиент отвалился бы с
 * ошибкой разбора, причём в месте, никак не связанном с настоящей причиной.
 */
function moveConsoleToStderr(): void {
  const out = (...args: unknown[]): void => {
    process.stderr.write(`${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
  };
  console.log = out;
  console.info = out;
  console.debug = out;
  console.warn = out;
  console.error = out;
}

/**
 * Остановка ровно один раз, с крайним сроком.
 *
 * Крайний срок нужен потому, что остановка ждёт сокет и закрытие базы, а
 * systemd ждёт нас — и по истечении своего терпения присылает SIGKILL, после
 * которого база остаётся с недописанным WAL. Уж лучше выйти самим с понятным
 * кодом, чем быть убитым в произвольной точке.
 */
function makeShutdown(closeTransport: () => Promise<void>): (code: number) => Promise<never> {
  let started = false;
  return async (code: number): Promise<never> => {
    if (started) {
      // Второй сигнал — просьба не церемониться. Первый мог застрять в
      // закрытии сокета; человеку, нажавшему Ctrl-C дважды, нужен выход.
      process.exit(130);
    }
    started = true;
    const deadline = setTimeout(() => {
      note(`остановка не уложилась в ${STOP_DEADLINE_MS} мс, выходим`);
      process.exit(EXIT_STOP_TIMEOUT);
    }, STOP_DEADLINE_MS);
    try {
      await closeTransport();
      await stopCore();
      note('остановлено чисто');
    } catch (e) {
      note(`остановка с ошибкой: ${e instanceof Error ? e.message : String(e)}`);
      clearTimeout(deadline);
      process.exit(EXIT_STOP_TIMEOUT);
    }
    clearTimeout(deadline);
    process.exit(code);
  };
}

/**
 * Что делать, когда ядро всё-таки упало.
 *
 * Node по умолчанию на необработанном исключении завершается сам, но до
 * `closeLocalDatabase` дело не доходит. Здесь падение сначала называется
 * вслух, потом закрывается база, и только потом процесс уходит с ненулевым
 * кодом — чтобы надзиратель (systemd, agent) увидел отказ и поднял заново, а
 * не решил, что работа закончена.
 *
 * Продолжать работу после такого мы не пробуем: упавшее посреди шага ядро
 * оставляет неизвестное состояние, и инструменты поверх него отвечали бы
 * неизвестно чем.
 */
function installCrashPolicy(shutdown: (code: number) => Promise<never>): void {
  process.on('uncaughtException', (e) => {
    note(`необработанное исключение: ${e.stack ?? e.message}`);
    void shutdown(EXIT_CRASH);
  });
  process.on('unhandledRejection', (reason) => {
    note(`необработанный отказ обещания: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
    void shutdown(EXIT_CRASH);
  });
}

function installSignals(shutdown: (code: number) => Promise<never>): void {
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      note(`получен ${sig}`);
      void shutdown(0);
    });
  }
}

export async function run(options: RunOptions): Promise<void> {
  if (options.mode === 'enroll') {
    await enroll(options.workdir);
    return;
  }
  if (options.mode === 'stdio') moveConsoleToStderr();

  // Пропуск нужен до запуска ядра: поднимать сеть и открывать базу ради того,
  // чтобы через двадцать секунд отказаться слушать порт, — впустую тратить и
  // время, и запись в журнале релея о появлении устройства.
  const token =
    options.mode === 'http'
      ? checkHttpPreconditions(options.host, process.env.AIRCHAT_MCP_TOKEN)
      : null;
  // Дальше пропуск живёт только в виде свёртки внутри `startHttp`. Удаление
  // из окружения не отменяет того, что его уже видели запускавший процесс и
  // всякий, кто успел прочитать /proc/<pid>/environ, — но сокращает окно и, что
  // важнее, не даёт ему уехать в окружение дочерних процессов.
  delete process.env.AIRCHAT_MCP_TOKEN;

  const core = await startCore({ workdir: options.workdir });
  markStarted(Date.now());
  note(`ядро поднято: did=${core.did} профиль=${core.pid}`);

  let http: RunningHttp | null = null;
  let stdio: StdioServerTransport | null = null;

  const shutdown = makeShutdown(async () => {
    if (http) await http.close();
    if (stdio) await stdio.close();
  });
  installSignals(shutdown);
  installCrashPolicy(shutdown);

  if (options.mode === 'http') {
    http = await startHttp({
      host: options.host,
      port: options.port,
      token: token as string,
      // Свой экземпляр MCP на сессию — состояние протокола не делится.
      makeServer: () => createServer(pkg.version),
      log: note,
    });
    note(`слушаю http://${options.host}:${options.port}/mcp`);
    return;
  }

  stdio = new StdioServerTransport();
  // Клиент ушёл — уходим и мы: висеть с поднятым ядром и закрытым каналом
  // значит держать слот устройства у релея впустую.
  stdio.onclose = () => {
    note('канал stdio закрыт клиентом');
    void shutdown(0);
  };
  await createServer(pkg.version).connect(stdio);
  note('готов, транспорт stdio');
}

/**
 * Заведение аккаунта в каталоге: единственный момент, когда секретные слова
 * вообще проходят через этот процесс.
 *
 * ─── Почему stdin, а не аргумент и не переменная окружения ──────────────────
 *
 * Аргумент командной строки виден в `ps` любому пользователю машины и
 * остаётся в истории оболочки — то есть в файле, который живёт дольше всего
 * остального. Переменная окружения не показывается в `ps`, но лежит в
 * `/proc/<pid>/environ` всё время жизни процесса и достаётся по наследству
 * каждому дочернему, а в юните systemd — ещё и в конфигурации на диске.
 * Стандартный ввод не остаётся нигде: ни в истории, ни в списке процессов, ни
 * в файле юнита.
 *
 * ─── Чего это не даёт ───────────────────────────────────────────────────────
 *
 * Стереть фразу из памяти нельзя: строки в JS неизменяемы, и копии, сделанные
 * сборщиком мусора, нам недоступны. Что мы можем — не дать ей попасть никуда
 * ещё: её не видит журнал, не видит `ps`, и живёт она ровно до конца этой
 * команды, после которой в каталоге остаётся только шифротекст. Дальше сервер
 * запускается без неё вовсе.
 */
async function enroll(dir: string): Promise<void> {
  const phrase = await readSecret('секретные слова аккаунта (ввод не отображается): ');
  if (!phrase) {
    process.stderr.write('пустой ввод — нечего заводить\n');
    process.exit(2);
  }
  const core = await startCore({ workdir: dir, mnemonic: phrase });
  note(`аккаунт заведён: did=${core.did} профиль=${core.pid}`);
  note('слова больше не нужны: запускайте сервер без них');
  await stopCore();
}

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // Трубой: `pass show airchat | airchat-mcp enroll --workdir …`. Секрет не
    // касается ни оболочки, ни диска.
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  // С терминала. Эхо снимается вручную, посимвольным чтением: готовый
  // `readline` показал бы фразу на экране и оставил её в своей истории строк.
  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  try {
    return await new Promise<string>((resolve, reject) => {
      let buf = '';
      const done = (): void => {
        process.stdin.off('data', onData);
        process.stderr.write('\n');
      };
      const onData = (chunk: string): void => {
        for (const ch of chunk) {
          if (ch === '\r' || ch === '\n') {
            done();
            resolve(buf.trim());
            return;
          }
          if (ch === '') {
            done();
            reject(new Error('ввод прерван'));
            return;
          }
          if (ch === '' || ch === '\b') {
            buf = buf.slice(0, -1);
            continue;
          }
          buf += ch;
        }
      };
      process.stdin.on('data', onData);
    });
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}
