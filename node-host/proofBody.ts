/**
 * Проверка headless-ядра: не «запустилось без ошибок», а числа, которые можно
 * пересчитать.
 *
 * Каждый шаг отвечает на отдельный вопрос и печатает то, чем ответ
 * подтверждается. Два места, где проверка намеренно не верит ядру на слово:
 *
 *  - Чтения из базы сверяются не с «не упало», а с типом ответа. В этом коде
 *    `null` от `listConversationsRead` означает «прочитать не удалось», и
 *    пустой список от него отличается принципиально: на пустоте рисуют «пока
 *    никого», на отказе — обязаны сказать про отказ. Проверка провалится, если
 *    придёт `null`.
 *
 *  - Доставка сверяется не с ответом `sendMessage`. Тот отдаёт `null` и при
 *    блокировке, и при часовом лимите, и при отсутствии маршрута, а
 *    непустой ответ говорит лишь о том, что отправка дошла до конца своей
 *    функции. Поэтому конверт вычитывается обратно с релея отдельным HTTP —
 *    из другого сокета, по адресу, посчитанному здесь заново.
 *
 * Личности и тексты синтетические: мнемоники генерируются на месте, каждый
 * запуск новые, и ни одна из них не читается с диска пользователя. Текст
 * сообщения уходит на публичный ntfy.sh, поэтому он очевидно тестовый и
 * ничего личного не несёт.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { generateMnemonic } from 'bip39';
import { sha256 } from '@noble/hashes/sha2.js';

import { startCore, stopCore } from './host';
import { check, finish, say } from './report';
import { documentDir } from './runtime/workdir';

import { deriveKeyPairFromMnemonic } from '../src/core/backup/seedPhrase';
import { publicKeyToDidKey } from '../src/core/identity/did';
import { listConversationsRead } from '../src/core/storage/local';
import { listContactsRead } from '../src/core/social/contacts';
import { getMessagingService } from '../src/core/social/messaging';
import {
  getInternetTransportSingleton,
  topicForDid,
} from '../src/core/transport/internet/internetTransport';

const RELAY_BASE = 'https://ntfy.sh';

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/** Отпечаток фразы вместо самой фразы: слова не печатаются даже тестовые. */
function mnemonicFingerprint(mnemonic: string): string {
  return hex(sha256(new TextEncoder().encode(mnemonic))).slice(0, 16);
}

async function sizeOf(file: string): Promise<number> {
  const st = await fs.stat(file).catch(() => null);
  return st ? st.size : -1;
}

/**
 * Вторая загрузка — отдельным процессом, а не вторым вызовом `startCore`.
 *
 * Ядро держит открытую базу, реестр профилей и кеш мнемоники на уровне
 * модулей; в одном процессе второй каталог получил бы состояние первого, и
 * совпадение DID доказывало бы только наличие кеша. Фраза уходит потоком
 * ввода, а не аргументом: список аргументов процесса виден всей машине.
 */
async function bootInChildProcess(workdir: string, mnemonic: string): Promise<string> {
  const self = process.argv[1];
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [self, '--boot-only', workdir], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`child_boot_failed: exit ${code}`));
        return;
      }
      const line = out.split('\n').find((l) => l.startsWith('{'));
      if (!line) {
        reject(new Error(`child_boot_no_result: ${out.slice(0, 200)}`));
        return;
      }
      resolve((JSON.parse(line) as { did: string }).did);
    });
    child.stdin.end(mnemonic);
  });
}

/** Режим дочернего процесса: поднять ядро в каталоге и назвать полученный DID. */
export async function runBootOnly(workdir: string): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const mnemonic = Buffer.concat(chunks).toString('utf8').trim();
  const core = await startCore({ workdir, mnemonic });
  process.stdout.write(`${JSON.stringify({ did: core.did, pid: core.pid })}\n`);
  await stopCore();
}

/** Дождаться открытия сокета, не притворяясь, что он открыт. */
async function waitForWs(timeoutMs: number): Promise<number> {
  const t0 = Date.now();
  const transport = getInternetTransportSingleton();
  while (Date.now() - t0 < timeoutMs) {
    if (transport.getStatus().wsOpen) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 100));
  }
  return -1;
}

type RelayRecord = { id?: string; time?: number; message?: string };

/**
 * Прочитать тему получателя с релея независимым запросом.
 *
 * Это единственный шаг, который вообще не пользуется кодом транспорта: адрес
 * темы считается здесь из DID, запрос уходит обычным `fetch`, ответ разбирается
 * как построчный JSON. Если бы конверт не ушёл, здесь была бы пустая выдача —
 * и её ничем не подменить.
 */
async function readRelayTopic(topic: string, sinceSec: number): Promise<RelayRecord[]> {
  const url = `${RELAY_BASE}/${topic}/json?poll=1&since=${sinceSec}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`relay_poll_http_${res.status}`);
  const text = await res.text();
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RelayRecord);
}

export async function runProof(root: string): Promise<void> {
  const dirA = path.join(root, 'a');
  const dirB = path.join(root, 'b');

  say('=== AirChat node-host: проверка ядра вне телефона ===');
  say(`node ${process.version}, каталог проверки ${root}`);
  say('');

  // ── 1. Тестовые личности ────────────────────────────────────────────────
  say('[1] Тестовые личности (сгенерированы этим запуском)');
  const mnemonicA = generateMnemonic(256);
  const mnemonicB = generateMnemonic(256);
  const pairA = deriveKeyPairFromMnemonic(mnemonicA);
  const pairB = deriveKeyPairFromMnemonic(mnemonicB);
  const didAExpected = publicKeyToDidKey(pairA.publicKey);
  const didB = publicKeyToDidKey(pairB.publicKey);
  const peerPubB64 = Buffer.from(pairB.publicKey).toString('base64');
  say(`  фраза A: 24 слова, sha256[0:16]=${mnemonicFingerprint(mnemonicA)}`);
  say(`  фраза B: 24 слова, sha256[0:16]=${mnemonicFingerprint(mnemonicB)}`);
  say(`  DID A (ожидаемый из фразы): ${didAExpected}`);
  say(`  DID B (получатель):         ${didB}`);
  say('');

  // ── 2. Запуск ───────────────────────────────────────────────────────────
  say('[2] Запуск ядра в каталоге A');
  const t0 = Date.now();
  const core = await startCore({ workdir: dirA, mnemonic: mnemonicA });
  const bootMs = Date.now() - t0;
  say(`  startCore: ${bootMs} мс`);
  check(core.did === didAExpected, 'DID ядра совпал с выведенным из фразы', core.did);
  say(`  активный профиль: pid=${core.pid}`);
  say(`  релей из конфигурации: ${core.config.internet?.relayBase ?? RELAY_BASE}`);

  const dbFile = path.join(documentDir(), 'SQLite', 'airchat_local.db');
  const dbBytes = await sizeOf(dbFile);
  const walBytes = await sizeOf(`${dbFile}-wal`);
  check(dbBytes > 0, 'база создана', `${dbFile} = ${dbBytes} байт (wal ${walBytes})`);
  const tables = await fs.readdir(path.join(documentDir(), 'SQLite'));
  say(`  файлов в SQLite/: ${tables.length} (${tables.join(', ')})`);
  say('');

  // ── 3. Чтения ───────────────────────────────────────────────────────────
  say('[3] Чтения из базы (null = отказ чтения, [] = действительно пусто)');
  const conversations = await listConversationsRead(core.pid);
  check(
    conversations !== null,
    'listConversationsRead вернул список, а не null',
    conversations === null ? 'null' : `Array(${conversations.length})`
  );
  const contacts = await listContactsRead();
  check(
    contacts !== null,
    'listContactsRead вернул список, а не null',
    contacts === null ? 'null' : `Array(${contacts.length})`
  );
  say('');

  // ── 4. Детерминизм DID ──────────────────────────────────────────────────
  say('[4] Тот же seed во втором каталоге (отдельный процесс)');
  const didFromB = await bootInChildProcess(dirB, mnemonicA);
  check(didFromB === core.did, 'DID совпал', `${didFromB}`);
  const dbBytesB = await sizeOf(path.join(dirB, 'documents', 'SQLite', 'airchat_local.db'));
  say(`  база каталога B: ${dbBytesB} байт (своя, не общая с A)`);
  say('');

  // ── 5. Сокет релея ──────────────────────────────────────────────────────
  say('[5] WebSocket к релею на собственной теме');
  const wsMs = await waitForWs(20_000);
  const status = getInternetTransportSingleton().getStatus();
  check(status.active, 'транспорт запущен', String(status.active));
  check(wsMs >= 0, 'сокет открылся', wsMs >= 0 ? `${wsMs} мс` : 'не открылся за 20000 мс');
  const expectedTopic = topicForDid(core.did);
  check(
    status.myTopic === expectedTopic,
    'тема сокета = topicForDid(DID)',
    `${status.myTopic ?? 'null'} (пересчёт: ${expectedTopic})`
  );
  say(`  релей: ${status.relay ?? 'null'}, попыток переподключения: ${status.reconnectAttempt}`);
  say('');

  // ── 6. Отправка ─────────────────────────────────────────────────────────
  say('[6] Отправка сообщения второй тестовой личности');
  const sinceSec = Math.floor(Date.now() / 1000) - 5;
  const marker = `node-host-proof-${Date.now()}`;
  const text = `SYNTHETIC TEST MESSAGE ${marker} (automated check, no personal data)`;
  const messaging = getMessagingService();
  if (!messaging) throw new Error('messaging_service_missing');
  const tSend = Date.now();
  const sendResult = await messaging.sendMessage(peerPubB64, text);
  const sendMs = Date.now() - tSend;
  say(`  sendMessage → ${sendResult === null ? 'null' : sendResult} за ${sendMs} мс`);
  say(`  (null означал бы блокировку, часовой лимит или отсутствие маршрута)`);
  say('');

  // ── 7. Независимая проверка доставки ────────────────────────────────────
  say('[7] Чтение темы получателя с релея отдельным HTTP-запросом');
  const peerTopic = topicForDid(didB);
  say(`  GET ${RELAY_BASE}/${peerTopic}/json?poll=1&since=${sinceSec}`);
  let records: RelayRecord[] = [];
  for (let attempt = 0; attempt < 10; attempt++) {
    records = await readRelayTopic(peerTopic, sinceSec);
    if (records.length > 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  say(`  записей на теме: ${records.length}`);
  const envelopes = records
    .map((r) => {
      if (!r.message) return null;
      try {
        const raw = Buffer.from(r.message, 'base64').toString('utf8');
        return JSON.parse(raw) as {
          messageId?: string;
          senderDid?: string;
          recipientDid?: string;
          encryptedContent?: string;
          timestamp?: number;
        };
      } catch {
        return null;
      }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);
  say(`  из них разобралось как конверт AirChat: ${envelopes.length}`);
  const mine = envelopes.filter((e) => e.senderDid === core.did && e.recipientDid === didB);
  check(mine.length > 0, 'конверт от нашего DID найден на теме получателя', `${mine.length} шт.`);
  if (mine[0]) {
    const e = mine[0];
    const cipherBytes = e.encryptedContent ? Buffer.from(e.encryptedContent, 'base64').length : 0;
    say(`  messageId: ${e.messageId}`);
    say(`  senderDid: ${e.senderDid}`);
    say(`  recipientDid: ${e.recipientDid}`);
    say(`  шифротекст: ${cipherBytes} байт, timestamp ${e.timestamp}`);
    const plain = e.encryptedContent ?? '';
    check(
      !Buffer.from(plain, 'base64').toString('utf8').includes(marker),
      'текст сообщения на релее не в открытом виде',
      'метки в шифротексте нет'
    );
  }
  say('');

  // ── 8. Остановка ────────────────────────────────────────────────────────
  say('[8] Остановка');
  const tStop = Date.now();
  await stopCore();
  say(`  stopCore: ${Date.now() - tStop} мс, без ошибок`);
  const stoppedStatus = getInternetTransportSingleton().getStatus();
  check(!stoppedStatus.active, 'транспорт остановлен', `active=${stoppedStatus.active}`);
  say('');

  // ── 9. Что ядро сказало о себе ──────────────────────────────────────────
  //
  // Шаг не проверяет, а показывает. Отправка выше могла уйти двумя разными
  // путями — через IPFS или через релей, — и по возвращённому значению их не
  // различить. Различает лог: там видно, какая ступень отказала и почему.
  say('[9] Лог ядра (host пишет его в core.log, иначе в Node он молчит)');
  const logFile = path.join(dirA, 'core.log');
  const lines = (await fs.readFile(logFile, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  say(`  строк в ${logFile}: ${lines.length}`);
  const bad = lines
    .map((l) => {
      try {
        return JSON.parse(l) as { level?: string; msg?: string; meta?: Record<string, unknown> };
      } catch {
        return null;
      }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null && (e.level === 'warn' || e.level === 'error'));
  say(`  из них warn/error: ${bad.length}`);
  for (const e of bad) {
    const meta = e.meta ? ` ${JSON.stringify(e.meta)}` : '';
    say(`    ${e.level} ${e.msg}${meta}`);
  }
  say('');

  finish(`каталог проверки оставлен: ${root}`);
}

