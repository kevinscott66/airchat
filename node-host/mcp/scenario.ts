/**
 * Проверка сервера MCP: не «поднялся», а сценарий с числами.
 *
 * Отличие от `proofBody.ts` в том, что здесь ядро не трогается напрямую ни
 * разу. Всё идёт через собранный `dist/mcp.mjs`, который запускается отдельным
 * процессом ровно так, как его запустит агент, и разговор ведётся настоящим
 * клиентом MCP. Проверяется то, что увидит агент, а не то, что мы про себя
 * знаем.
 *
 * Два места, где сценарий намеренно недоверчив:
 *
 *  - Доставка сверяется не ответом отправителя, а чтением у получателя. Ответ
 *    `message_send` говорит лишь, что конверт принят релеем; что входящий цикл
 *    жив, доказывает только строка, появившаяся в базе второго экземпляра.
 *
 *  - Отказ старта проверяется кодом возврата и текстом, а не тем, что «ошибка
 *    напечаталась». Процесс, который при отсутствии ключа шифрования всё-таки
 *    поднялся бы, — ровно то, чего здесь быть не должно.
 *
 * Личности синтетические, генерируются этим запуском. Текст сообщения уходит
 * на публичный ntfy.sh, поэтому он очевидно тестовый.
 */
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateMnemonic } from 'bip39';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { check, finish, say } from '../report';

const HOST_BUNDLE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp.mjs');

/**
 * Окружение дочернего процесса собирается списком, а не наследованием: в этом
 * и смысл проверки — увидеть, что хосту хватает ровно названного, и что
 * ничего лишнего из нашего окружения к нему не уезжает.
 */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    NODE_ENV: process.env.NODE_ENV ?? 'production',
    ...extra,
  };
}

type Run = { code: number | null; signal: string | null; out: string; err: string; ms: number };

/** Запустить хост как отдельный процесс и дождаться его конца. */
function runHost(args: string[], env: Record<string, string>, stdin?: string): Promise<Run> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOST_BUNDLE, ...args], {
      env: childEnv(env),
      stdio: ['pipe', 'pipe', 'pipe'] as const,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      err += c.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal, out, err, ms: Date.now() - t0 });
    });
    child.stdin.end(stdin ?? '');
  });
}

type ToolAnswer = { isError: boolean; data: Record<string, unknown> };

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolAnswer> {
  const res = await client.callTool({ name, arguments: args });
  const first = (res.content as Array<{ type: string; text?: string }>)[0];
  const data = JSON.parse(first?.text ?? '{}') as Record<string, unknown>;
  return { isError: res.isError === true, data };
}

type Peer = { name: string; dir: string; client: Client; stderr: string[]; did: string };

/** Поднять экземпляр в режиме stdio и подключиться к нему клиентом MCP. */
async function connect(name: string, dir: string, key: string): Promise<Peer> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [HOST_BUNDLE, 'stdio', '--workdir', dir],
    env: childEnv({ AIRCHAT_SECURE_STORE_KEY: key }) as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'airchat-mcp-scenario', version: '1' });
  await client.connect(transport);
  const stderr: string[] = [];
  transport.stderr?.on('data', (c: Buffer) => {
    for (const l of c.toString('utf8').split('\n')) if (l.trim()) stderr.push(l);
  });
  return { name, dir, client, stderr, did: '' };
}

/** Дождаться открытого сокета, спрашивая у самого сервера. */
async function waitWs(peer: Peer, timeoutMs: number): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = await call(peer.client, 'status');
    const t = s.data.transport as { wsOpen?: boolean } | undefined;
    if (t?.wsOpen) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 250));
  }
  return -1;
}

async function main(): Promise<void> {
  const root = process.argv[2] ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'airchat-mcp-')));
  const dirA = path.join(root, 'a');
  const dirB = path.join(root, 'b');
  const dirC = path.join(root, 'c');
  const key = randomBytes(32).toString('base64');

  say('=== AirChat node-host: сценарий сервера MCP ===');
  say(`node ${process.version}, каталог ${root}`);
  say(`ключ secure-store: 32 байта, сгенерирован этим запуском`);
  say('');

  // ── 1. Отказы старта ────────────────────────────────────────────────────
  say('[1] Условия, без которых процесс не стартует');
  const noKey = await runHost(['stdio', '--workdir', dirA], {});
  check(
    noKey.code === 2 && noKey.err.includes('AIRCHAT_SECURE_STORE_KEY'),
    'без AIRCHAT_SECURE_STORE_KEY отказ',
    `код ${noKey.code}, ${noKey.err.split('\n')[0]}`
  );
  const shortKey = await runHost(['stdio', '--workdir', dirA], {
    AIRCHAT_SECURE_STORE_KEY: Buffer.from('слишком короткий').toString('base64'),
  });
  check(
    shortKey.code === 2 && shortKey.err.includes('32 байтами'),
    'ключ не тех размеров — отказ',
    `код ${shortKey.code}, ${shortKey.err.split('\n')[0]}`
  );
  const noDir = await runHost(['stdio'], { AIRCHAT_SECURE_STORE_KEY: key });
  check(noDir.code === 2, 'без каталога отказ', `код ${noDir.code}`);
  const noIdentity = await runHost(['stdio', '--workdir', path.join(root, 'empty')], {
    AIRCHAT_SECURE_STORE_KEY: key,
  });
  check(
    noIdentity.code === 2 && noIdentity.err.includes('core_no_identity'),
    'пустой каталог не заводит аккаунт молча',
    `код ${noIdentity.code}, core_no_identity`
  );
  const noToken = await runHost(['http', '--workdir', dirA], { AIRCHAT_SECURE_STORE_KEY: key });
  check(
    noToken.code === 2 && noToken.err.includes('AIRCHAT_MCP_TOKEN'),
    'http без пропуска не поднимается',
    `код ${noToken.code}`
  );
  const wideOpen = await runHost(['http', '--workdir', dirA, '--host', '0.0.0.0'], {
    AIRCHAT_SECURE_STORE_KEY: key,
    AIRCHAT_MCP_TOKEN: randomBytes(24).toString('base64'),
  });
  check(
    wideOpen.code === 2 && wideOpen.err.includes('TLS'),
    'http наружу без TLS не поднимается',
    `код ${wideOpen.code}`
  );
  say('');

  // ── 2. Заведение аккаунтов ──────────────────────────────────────────────
  say('[2] Заведение двух аккаунтов: слова приходят потоком ввода');
  const mnemonicA = generateMnemonic(256);
  const mnemonicB = generateMnemonic(256);
  const enrollA = await runHost(['enroll', '--workdir', dirA], { AIRCHAT_SECURE_STORE_KEY: key }, mnemonicA);
  const enrollB = await runHost(['enroll', '--workdir', dirB], { AIRCHAT_SECURE_STORE_KEY: key }, mnemonicB);
  check(enrollA.code === 0, 'аккаунт A заведён', `${enrollA.ms} мс, ${enrollA.err.trim().split('\n')[0]}`);
  check(enrollB.code === 0, 'аккаунт B заведён', `${enrollB.ms} мс`);
  const wrongPhrase = await runHost(['enroll', '--workdir', dirA], { AIRCHAT_SECURE_STORE_KEY: key }, mnemonicB);
  check(
    wrongPhrase.code === 2 && wrongPhrase.err.includes('workdir_belongs_to_another_wallet'),
    'чужие слова в занятом каталоге — отказ',
    `код ${wrongPhrase.code}`
  );

  // Фраза не должна лежать на диске открытым текстом ни в одном файле.
  const words = mnemonicA.split(' ');
  const probe = `${words[0]} ${words[1]} ${words[2]}`;
  let scanned = 0;
  let leaked = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p);
        continue;
      }
      scanned += 1;
      const buf = await fs.readFile(p).catch(() => Buffer.alloc(0));
      if (buf.includes(probe)) {
        leaked += 1;
        say(`    утечка в ${p}`);
      }
    }
  };
  await walk(dirA);
  check(leaked === 0, 'слов нет в открытом виде ни в одном файле каталога', `проверено файлов: ${scanned}`);
  say('');

  // ── 3. Подключение агента ───────────────────────────────────────────────
  say('[3] Два экземпляра в режиме stdio, клиент MCP настоящий');
  const a = await connect('A', dirA, key);
  const b = await connect('B', dirB, key);
  const tools = await a.client.listTools();
  say(`  tools/list: ${tools.tools.length} инструментов`);
  say(`  ${tools.tools.map((t) => t.name).join(', ')}`);
  check(tools.tools.length === 10, 'инструментов ровно столько, сколько объявлено', `${tools.tools.length}`);
  const noTunnel = tools.tools.some((t) => /flux|tunnel|setting/i.test(t.name));
  check(!noTunnel, 'туннеля и настроек приложения в списке нет', 'ни одного совпадения');

  const statusA = await call(a.client, 'status');
  const statusB = await call(b.client, 'status');
  a.did = statusA.data.did as string;
  b.did = statusB.data.did as string;
  check(a.did !== b.did, 'два разных аккаунта', `A=${a.did.slice(0, 24)}… B=${b.did.slice(0, 24)}…`);
  const wsA = await waitWs(a, 30_000);
  const wsB = await waitWs(b, 30_000);
  check(wsA >= 0 && wsB >= 0, 'сокеты релея открылись', `A ${wsA} мс, B ${wsB} мс`);
  const st = (await call(a.client, 'status')).data.transport as Record<string, unknown>;
  say(`  A: релей ${String(st.relay)}, тема ${String(st.topic)}, переподключений ${String(st.reconnectAttempt)}`);
  say('');

  // ── 4. Контакты ─────────────────────────────────────────────────────────
  say('[4] Контакты');
  const addB = await call(a.client, 'contact_add', { id: b.did, name: 'Тестовый B' });
  check(!addB.isError, 'A добавил B', JSON.stringify(addB.data.contact ?? addB.data));
  const addA = await call(b.client, 'contact_add', { id: a.did, name: 'Тестовый A' });
  check(!addA.isError, 'B добавил A', JSON.stringify(addA.data.contact ?? addA.data));
  const listA = await call(a.client, 'contacts_list');
  const contacts = (listA.data.contacts as unknown[]) ?? [];
  check(contacts.length >= 1, 'contacts_list вернул список, а не отказ', `${contacts.length} шт.`);
  const garbage = await call(a.client, 'contact_add', { id: 'не-идентификатор', name: 'x' });
  check(
    garbage.isError && garbage.data.reason === 'bad_contact_id',
    'мусорный идентификатор — отказ с причиной',
    `${String(garbage.data.reason)}`
  );
  const self = await call(a.client, 'contact_add', { id: a.did, name: 'я сам' });
  check(
    self.isError && self.data.reason === 'self_contact',
    'себя в контакты — отказ с причиной',
    `${String(self.data.reason)}`
  );
  say('');

  // ── 5. Отправка и приём ─────────────────────────────────────────────────
  say('[5] Сообщение A → B и его появление у B');
  const marker = `mcp-scenario-${Date.now()}`;
  const text = `SYNTHETIC TEST MESSAGE ${marker} (automated check, no personal data)`;
  const t0 = Date.now();
  const sent = await call(a.client, 'message_send', { contact: b.did, text });
  check(
    !sent.isError,
    'message_send принят',
    sent.isError
      ? `${String(sent.data.reason)}: ${String(sent.data.detail)}`
      : `messageId=${String(sent.data.messageId)}, путь=${String(sent.data.transport)}, ${String(sent.data.elapsedMs)} мс`
  );

  let deliveredMs = -1;
  let incoming: Record<string, unknown> | null = null;
  for (let i = 0; i < 120 && deliveredMs < 0; i++) {
    const page = await call(b.client, 'conversation_messages', { contact: a.did, limit: 20 });
    if (page.isError) {
      check(false, 'conversation_messages у B', `${String(page.data.reason)}`);
      break;
    }
    const messages = (page.data.messages as Array<Record<string, unknown>>) ?? [];
    const hit = messages.find((m) => typeof m.text === 'string' && m.text.includes(marker));
    if (hit) {
      deliveredMs = Date.now() - t0;
      incoming = hit;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  check(
    deliveredMs >= 0,
    'сообщение доехало до B и легло в его базу',
    deliveredMs >= 0 ? `${deliveredMs} мс от вызова message_send` : 'не появилось за 60 с'
  );
  if (incoming) {
    say(`  id=${String(incoming.id)} направление=${String(incoming.direction)} статус=${String(incoming.status)}`);
    say(`  текст совпал посимвольно: ${String(incoming.text) === text}`);
  }
  const convB = await call(b.client, 'conversations_list');
  const convs = (convB.data.conversations as Array<Record<string, unknown>>) ?? [];
  check(convs.length >= 1, 'переписка появилась в списке у B', `${convs.length} шт., имена: ${String(convB.data.namesRead)}`);
  if (convs[0]) {
    say(`  непрочитанных: ${String(convs[0].unreadCount)}, направление последнего: ${String(convs[0].lastMessageDirection)}`);
  }
  const badCursor = await call(b.client, 'conversation_messages', {
    contact: a.did,
    before: { createdAt: 0, id: '' },
  });
  check(badCursor.isError, 'негодный курсор — отказ, а не пустая страница', `${String(badCursor.data.reason)}`);
  say('');

  // ── 6. Карточка и приватность ───────────────────────────────────────────
  say('[6] Карточка профиля и настройки приватности');
  const newName = `Проверка ${Date.now() % 100000}`;
  const setP = await call(a.client, 'profile_set', { displayName: newName, bio: 'строка сценария' });
  check(!setP.isError, 'profile_set принят', `рассылка: ${String(setP.data.broadcast)}`);
  const getP = await call(a.client, 'profile_get');
  const profile = getP.data.profile as Record<string, { state: string; value?: string }>;
  check(
    profile?.displayName?.value === newName,
    'profile_get вернул записанное имя',
    `${profile?.displayName?.state} ${profile?.displayName?.value ?? ''}`
  );
  check(
    profile?.username?.state === 'unset',
    '@имя не занято и показано состоянием, а не пустой строкой',
    `username: ${profile?.username?.state}`
  );
  const setPriv = await call(a.client, 'privacy_set', {
    key: 'privacy_last_seen_visibility',
    value: 'contacts',
  });
  check(!setPriv.isError, 'privacy_set принят', `рассылка: ${String(setPriv.data.broadcast)}`);
  const getPriv = await call(a.client, 'privacy_get');
  const privacy = getPriv.data.privacy as Record<string, { state: string; value?: string }>;
  check(
    privacy?.privacy_last_seen_visibility?.value === 'contacts',
    'privacy_get вернул записанное значение',
    `${privacy?.privacy_last_seen_visibility?.value ?? privacy?.privacy_last_seen_visibility?.state}`
  );
  const badPriv = await call(a.client, 'privacy_set', { key: 'privacy_last_seen_visibility', value: 'может быть' });
  check(badPriv.isError, 'негодное значение — отказ', `${String(badPriv.data.reason)}`);
  const unknownPriv = await call(a.client, 'privacy_set', { key: 'privacy_unknown', value: 'true' });
  check(unknownPriv.isError, 'незнакомая настройка — отказ', `${String(unknownPriv.data.reason)}`);
  say('');

  await a.client.close();
  await b.client.close();

  // ── 7. HTTP ─────────────────────────────────────────────────────────────
  say('[7] HTTP-транспорт: пропуск и остановка по сигналу');
  await runHost(['enroll', '--workdir', dirC], { AIRCHAT_SECURE_STORE_KEY: key }, generateMnemonic(256));
  const token = randomBytes(32).toString('base64');
  const port = 8787 + (process.pid % 200);
  const child = spawn(process.execPath, [HOST_BUNDLE, 'http', '--workdir', dirC, '--port', String(port)], {
    env: childEnv({ AIRCHAT_SECURE_STORE_KEY: key, AIRCHAT_MCP_TOKEN: token }),
    stdio: ['ignore', 'pipe', 'pipe'] as const,
  });
  let childErr = '';
  child.stderr.on('data', (c: Buffer) => {
    childErr += c.toString('utf8');
  });
  const listening = await new Promise<boolean>((resolve) => {
    const deadline = setTimeout(() => resolve(false), 60_000);
    const iv = setInterval(() => {
      if (childErr.includes('слушаю http://')) {
        clearInterval(iv);
        clearTimeout(deadline);
        resolve(true);
      }
    }, 200);
  });
  check(listening, 'порт слушается', listening ? `127.0.0.1:${port}` : 'не дождались');

  const initBody = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'scenario', version: '1' },
    },
  });
  const post = (auth?: string): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(auth ? { authorization: auth } : {}),
      },
      body: initBody,
    });
  if (listening) {
    const anon = await post();
    check(anon.status === 401, 'без пропуска 401', `${anon.status} ${anon.headers.get('www-authenticate') ?? ''}`);
    const wrong = await post(`Bearer ${randomBytes(32).toString('base64')}`);
    check(wrong.status === 401, 'с чужим пропуском 401', `${wrong.status}`);
    const right = await post(`Bearer ${token}`);
    const sid = right.headers.get('mcp-session-id');
    check(right.status === 200 && Boolean(sid), 'с пропуском 200 и сессия', `${right.status}, сессия ${sid ?? 'нет'}`);
    await right.body?.cancel();
    const inUrl = await fetch(`http://127.0.0.1:${port}/mcp?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: initBody,
    });
    check(inUrl.status === 401, 'пропуск в адресе не считается пропуском', `${inUrl.status}`);

    // И полный разговор поверх HTTP: 200 на initialize сам по себе доказывает
    // только проверку пропуска, а не то, что инструменты по этому транспорту
    // действительно работают.
    const httpClient = new Client({ name: 'airchat-mcp-scenario-http', version: '1' });
    const httpTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await httpClient.connect(httpTransport);
    const httpTools = await httpClient.listTools();
    const httpStatus = await call(httpClient, 'status');
    check(
      httpTools.tools.length === 10 && !httpStatus.isError,
      'инструменты работают и поверх HTTP',
      `${httpTools.tools.length} шт., did=${String(httpStatus.data.did).slice(0, 24)}…`
    );
    await httpClient.close();
  }

  const stopped = await new Promise<{ code: number | null; ms: number }>((resolve) => {
    const t = Date.now();
    child.on('close', (code) => resolve({ code, ms: Date.now() - t }));
    child.kill('SIGTERM');
  });
  check(stopped.code === 0, 'SIGTERM — чистая остановка', `код ${stopped.code} за ${stopped.ms} мс`);
  check(
    childErr.includes('остановлено чисто'),
    'ядро закрыто, а не брошено',
    childErr.trim().split('\n').slice(-1)[0] ?? ''
  );
  say('');

  finish(`каталог сценария оставлен: ${root}`);
}

await main();
