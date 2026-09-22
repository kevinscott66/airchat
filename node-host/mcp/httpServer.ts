/**
 * HTTP-транспорт MCP: тот же набор инструментов, но для сервера, который живёт
 * дольше одного запуска агента.
 *
 * ─── Почему без пропуска не поднимается вовсе ───────────────────────────────
 *
 * За этими инструментами стоит аккаунт целиком: переписка, список контактов,
 * право писать от чужого имени. Порт, на котором это доступно без проверки, —
 * не «упрощение для отладки», а раздача аккаунта каждому, кто до порта дошёл.
 * Поэтому пропуск обязателен, и его отсутствие — отказ старта, а не
 * предупреждение: предупреждение в потоке вывода systemd никто не прочитает.
 *
 * ─── Почему пропуск в заголовке, а не в адресе ──────────────────────────────
 *
 * `?token=…` оседает в журнале любого прокси, в истории браузера, в поле
 * Referer при переходе по ссылке и в списке процессов у того, кто позвал curl.
 * Секрет, побывавший в адресе, надо считать раскрытым. `Authorization: Bearer`
 * в журналы по умолчанию не попадает — отсюда и выбор.
 *
 * Сравнение — по свёрткам и `timingSafeEqual`: обычное `===` на строках
 * выходит на первом несовпавшем байте, и по времени ответа пропуск
 * подбирается посимвольно. Свёртка нужна ещё и затем, чтобы сравнивать буферы
 * одной длины: сама длина настоящего пропуска тоже подсказка.
 *
 * ─── Почему только петля ────────────────────────────────────────────────────
 *
 * TLS этот процесс не умеет, и делать вид, что умеет, незачем. Пропуск,
 * улетевший в открытом виде по чужой сети, равен отсутствию пропуска. Поэтому
 * слушается только петлевой адрес, а наружу это выставляется тем, что умеет
 * TLS, — обратным прокси или ssh-туннелем. Ключа «разрешить всё равно» здесь
 * нет намеренно: он бы и стал обычным способом запуска.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** Минимальная длина пропуска: 32 символа — это меньше 192 бит в base64url. */
export const MIN_TOKEN_LENGTH = 32;

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export type HttpOptions = {
  host: string;
  port: number;
  token: string;
  /** Создаёт отдельный экземпляр MCP на каждую сессию: состояние сессии своё. */
  makeServer: () => McpServer;
  log: (line: string) => void;
};

export class HttpPreconditionError extends Error {}

/** Проверки, после которых слушать порт уже не стыдно. */
export function checkHttpPreconditions(host: string, token: string | undefined): string {
  if (!token) {
    throw new HttpPreconditionError(
      'AIRCHAT_MCP_TOKEN не задан. HTTP-транспорт без пропуска не поднимается: ' +
        'за инструментами стоит аккаунт целиком. Сгенерировать, например: ' +
        'openssl rand -base64 32'
    );
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new HttpPreconditionError(
      `AIRCHAT_MCP_TOKEN короче ${MIN_TOKEN_LENGTH} символов — такой подбирается`
    );
  }
  if (!LOOPBACK.has(host)) {
    throw new HttpPreconditionError(
      `слушать ${host} нельзя: этот процесс не умеет TLS, и пропуск ушёл бы открытым текстом. ` +
        'Выставляйте наружу обратным прокси с TLS или ssh-туннелем, а сюда оставьте 127.0.0.1'
    );
  }
  return token;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Пропуск верный? Сравнение постоянного времени, на свёртках равной длины. */
function tokenMatches(header: string | undefined, expected: Buffer): boolean {
  if (!header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  return timingSafeEqual(digest(m[1]), expected);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error('body_too_large');
    chunks.push(buf);
  }
  if (size === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function send(
  res: ServerResponse,
  code: number,
  body: unknown,
  headers?: Record<string, string>
): void {
  res.writeHead(code, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export type RunningHttp = {
  server: Server;
  /** Закрывает живые сессии, а не рвёт их на полуслове. */
  close: () => Promise<void>;
};

export async function startHttp(options: HttpOptions): Promise<RunningHttp> {
  const expected = digest(options.token);
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; mcp: McpServer }>();

  const http = createHttpServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        if (url.pathname !== '/mcp') {
          send(res, 404, { error: 'not_found' });
          return;
        }
        if (!tokenMatches(req.headers.authorization, expected)) {
          // Ни намёка на то, чем именно пропуск не подошёл: любая подробность
          // здесь — подсказка подбирающему. Заголовок WWW-Authenticate нужен
          // клиенту, чтобы понять, что спрашивают именно пропуск.
          options.log(`http_unauthorized ${req.method} от ${req.socket.remoteAddress ?? '?'}`);
          send(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer realm="airchat-mcp"' });
          return;
        }

        const sid = req.headers['mcp-session-id'];
        const sessionId = Array.isArray(sid) ? sid[0] : sid;

        if (sessionId) {
          const known = sessions.get(sessionId);
          if (!known) {
            send(res, 404, { error: 'unknown_session' });
            return;
          }
          const body = req.method === 'POST' ? await readBody(req) : undefined;
          await known.transport.handleRequest(req, res, body);
          return;
        }

        if (req.method !== 'POST') {
          send(res, 400, { error: 'session_required' });
          return;
        }
        const body = await readBody(req);
        if (!isInitializeRequest(body)) {
          send(res, 400, { error: 'expected_initialize' });
          return;
        }

        // Новая сессия. Свой экземпляр MCP на сессию: у протокола есть
        // состояние (согласованная версия, подписки), и делить его между
        // клиентами — значит смешивать разговоры.
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          // Проверка Host и Origin: без неё страница, открытая в браузере на
          // этой же машине, может достучаться до петлевого порта от имени
          // человека (та самая перепривязка DNS).
          enableDnsRebindingProtection: true,
          allowedHosts: [
            `${options.host}:${options.port}`,
            `localhost:${options.port}`,
            `127.0.0.1:${options.port}`,
          ],
          // Заголовок Origin проверяется только когда он есть: браузер его
          // ставит всегда, обычный клиент — никогда. Поэтому список отсекает
          // чужую страницу, не мешая тому, кто пришёл не из браузера.
          allowedOrigins: [`http://${options.host}:${options.port}`, `http://127.0.0.1:${options.port}`],
          onsessioninitialized: (id) => {
            options.log(`http_session_open ${id}`);
          },
        });
        const mcp = options.makeServer();
        transport.onclose = () => {
          const id = transport.sessionId;
          if (id) {
            sessions.delete(id);
            options.log(`http_session_close ${id}`);
          }
          void mcp.close();
        };
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
        if (transport.sessionId) sessions.set(transport.sessionId, { transport, mcp });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        options.log(`http_request_failed ${msg}`);
        if (!res.headersSent) send(res, 400, { error: 'bad_request', detail: msg });
        else res.end();
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, options.host, () => {
      http.off('error', reject);
      resolve();
    });
  });

  return {
    server: http,
    close: async () => {
      for (const { transport } of sessions.values()) {
        await transport.close().catch(() => undefined);
      }
      sessions.clear();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
