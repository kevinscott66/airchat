/**
 * Ключ доступа внешнего агента и всё, что из него выводится (v4.32.723).
 *
 * Зачем отдельный секрет, а не seed-фраза. Ключ агента — это право включить
 * туннель и переписать настройки, и его придётся отзывать: агент сменился,
 * ноутбук потеряли, ключ показали не тому. Производная от seed отзывалась бы
 * только вместе с самой seed, то есть вместе с личностью и всей перепиской.
 * Поэтому здесь ровно 32 случайных байта: отзыв — это новые 32 байта, и
 * личность при этом не трогается вовсе.
 *
 * Зачем HKDF, а не «секрет сам по себе». Из одного секрета нужны три разные
 * вещи — куда агент пишет, куда отвечает телефон и чем это шифруется. Брать
 * один и тот же материал под разные задачи нельзя: тема уезжает на сервер в
 * открытом виде, и будь она самим секретом, ретранслятор получил бы ключ
 * шифрования просто из адреса, по которому к нему пришли.
 *
 * Почему тема НЕ выводится из DID. Темы переписки выводятся именно так
 * (`topicForDid`), и это правильно: собеседнику нужно уметь вычислить, куда
 * писать, зная только DID. Здесь наоборот — знать тему должен ровно один
 * агент. DID публичен, он раздаётся ссылкой и печатается на QR-коде, и тема,
 * выведенная из него, была бы известна всякому, кому этот DID показали.
 * Подписаться на неё и слушать ответы телефона (версия, адрес ретранслятора,
 * состав настроек) смог бы кто угодно.
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';

import * as SecureStore from '../storage/secureStoreQueued';
import { log } from '../logger';
import { bytesToBase64Url, base64UrlToBytes } from '../utils/base64url';

/** Длина секрета моста. XChaCha20-Poly1305 ниже берёт ключ такой же длины. */
export const BRIDGE_SECRET_BYTES = 32;

/**
 * Записи в SecureStore.
 *
 * Счётчик принятых команд лежит РЯДОМ с секретом, а не в kv, намеренно — см.
 * `agentBridgeGuard`: у секрета и счётчика должна быть общая судьба. Переживёт
 * переустановку одно — переживёт и другое.
 */
const SECRET_KEY = 'airchat_agent_bridge_secret';
const SEQ_KEY = 'airchat_agent_bridge_seq';

/**
 * Что здесь лежит в SecureStore — для тех, кто обязан это стереть.
 *
 * Список нужен наружу ровно затем, чтобы сброс кошелька не переписывал имена
 * ключей у себя: переписанный, он молча перестал бы замечать новый ключ, и
 * именно про этот ключ никто бы не узнал.
 */
export const AGENT_BRIDGE_SECURE_KEYS = [SECRET_KEY, SEQ_KEY] as const;

/** Соль HKDF. Версия в ней затем, чтобы смена формата сменила и темы. */
const HKDF_SALT = new TextEncoder().encode('airchat-agent-bridge-v1');

/** Длина темы в шестнадцатеричных символах — как у тем переписки. */
const TOPIC_HEX_CHARS = 24;

export type BridgeKeys = {
  /** Тема, на которую подписывается телефон: сюда агент кладёт команды. */
  commandTopic: string;
  /** Тема, в которую телефон кладёт ответы. */
  replyTopic: string;
  /** Ключ AEAD для обеих сторон. */
  aeadKey: Uint8Array;
};

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function derive(secret: Uint8Array, info: string, length: number): Uint8Array {
  return hkdf(sha256, secret, HKDF_SALT, new TextEncoder().encode(info), length);
}

/**
 * Три производные от секрета.
 *
 * Обе темы начинаются с `airchat-ab1-`: приставка нужна не для узнаваемости, а
 * чтобы тема моста никогда не совпала по форме с темой переписки
 * (`airchat1-`) — иначе разбор входящего кадра зависел бы от того, на какой
 * сокет он пришёл, а это ровно тот вид зависимости, который ломается при
 * первой же правке транспорта.
 */
export function deriveBridgeKeys(secret: Uint8Array): BridgeKeys {
  if (secret.length !== BRIDGE_SECRET_BYTES) {
    throw new Error(`bridge_secret_length_${secret.length}`);
  }
  return {
    commandTopic:
      'airchat-ab1-' + toHex(derive(secret, 'topic/command', 16)).slice(0, TOPIC_HEX_CHARS),
    replyTopic:
      'airchat-ab1-' + toHex(derive(secret, 'topic/reply', 16)).slice(0, TOPIC_HEX_CHARS),
    aeadKey: derive(secret, 'aead/frame', 32),
  };
}

/**
 * Ключ доступа в том виде, в каком его получает человек.
 *
 * Адрес ретранслятора входит в строку намеренно: без него агент знает секрет,
 * но не знает, куда с ним идти, а спрашивать адрес отдельно значит собирать
 * две строки вместо одной и получать в ответ «я ввёл ключ, и ничего не
 * работает». Секретом адрес не является — он и так виден в настройках.
 */
export function formatAccessKey(secret: Uint8Array, relayBase: string): string {
  return `airchat-bridge://v1?k=${bytesToBase64Url(secret)}&r=${encodeURIComponent(relayBase)}`;
}

export type ParsedAccessKey = { secret: Uint8Array; relayBase: string };

/** Разбор той же строки. Нужен агенту и тестам; телефон её только печатает. */
export function parseAccessKey(raw: string): ParsedAccessKey | null {
  const m = /^airchat-bridge:\/\/v1\?k=([A-Za-z0-9_-]+)&r=(.+)$/.exec(raw.trim());
  if (!m) return null;
  try {
    const secret = base64UrlToBytes(m[1]);
    if (secret.length !== BRIDGE_SECRET_BYTES) return null;
    const relayBase = decodeURIComponent(m[2]);
    if (!relayBase) return null;
    return { secret, relayBase };
  } catch {
    return null;
  }
}

/** Секрет из хранилища. `null` — моста на этом устройстве ещё не заводили. */
export async function loadBridgeSecret(): Promise<Uint8Array | null> {
  const raw = await SecureStore.getItemAsync(SECRET_KEY);
  if (!raw) return null;
  try {
    const bytes = base64UrlToBytes(raw);
    if (bytes.length !== BRIDGE_SECRET_BYTES) {
      // Запись есть, но она не годится. Молча завести новую нельзя: старый
      // агент продолжал бы стучаться в тему, которой больше нет, и причины
      // этого не увидел бы никто.
      log.warn('agent_bridge_secret_malformed', { bytes: bytes.length });
      return null;
    }
    return bytes;
  } catch {
    log.warn('agent_bridge_secret_unreadable');
    return null;
  }
}

/**
 * Новый секрет — он же отзыв старого.
 *
 * Счётчик принятых команд сбрасывается той же операцией и обязательно ПОСЛЕ
 * секрета: между двумя записями помещается смерть процесса, и порядок решает,
 * что останется. Новый секрет со старым счётчиком — это просто завышенная
 * нижняя граница на новой теме, первая же команда агента её перешагнёт.
 * Обратный порядок оставил бы старый секрет с нулевым счётчиком, то есть
 * ровно ту дыру, от которой счётчик и защищает.
 */
export async function rotateBridgeSecret(): Promise<Uint8Array> {
  const secret = randomBytes(BRIDGE_SECRET_BYTES);
  await SecureStore.setItemAsync(SECRET_KEY, bytesToBase64Url(secret));
  await SecureStore.setItemAsync(SEQ_KEY, '0');
  // Ни секрета, ни выведенных из него тем в журнале быть не должно: файл
  // журнала уезжает в отчёт о неполадке целиком.
  log.info('agent_bridge_secret_rotated');
  return secret;
}

/** Секрет, заводя его при первом обращении. */
export async function loadOrCreateBridgeSecret(): Promise<Uint8Array> {
  const existing = await loadBridgeSecret();
  return existing ?? (await rotateBridgeSecret());
}

/** Номер последней принятой команды. Отсутствие записи — это ноль. */
export async function readAcceptedSeq(): Promise<number> {
  const raw = await SecureStore.getItemAsync(SEQ_KEY);
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export async function writeAcceptedSeq(seq: number): Promise<void> {
  await SecureStore.setItemAsync(SEQ_KEY, String(seq));
}

/**
 * Забыть ключ агента совсем.
 *
 * Это не отзыв: отзыв — это `rotateBridgeSecret`, после которого мост работает
 * с новым ключом. Здесь моста не остаётся вовсе, и зовут это со сброса
 * кошелька, где у устройства меняется владелец. Счётчик уходит вместе с
 * секретом: он имеет смысл только при нём, а оставшись, встретил бы следующий
 * секрет с чужим номером и отверг бы первые команды нового хозяина.
 */
export async function clearBridgeSecrets(): Promise<void> {
  for (const key of AGENT_BRIDGE_SECURE_KEYS) await SecureStore.deleteItemAsync(key);
}
