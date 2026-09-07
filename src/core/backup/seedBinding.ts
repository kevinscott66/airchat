/**
 * Привязка секретных слов к Apple ID / Google (v4.32.595).
 *
 * Двадцать четыре слова — честная, но недобрая штука: их теряют. Привязка
 * даёт второй путь домой: слова уходят на сервер шифртекстом, ключ выводится
 * здесь из пароля приложения, а вход через Apple/Google отвечает только на
 * вопрос «кто пришёл». Ни одной стороны по отдельности не хватает: сервер
 * пароля не знает, а провайдер не знает конверта.
 *
 * Поэтому пароль обязателен и здесь. Планка у него общая (см.
 * passwordPolicy), а KDF намеренно тяжелее облачного: там в ключ подмешаны
 * сами слова, здесь их подмешать не из чего — пароль остаётся один.
 */
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { validateMnemonic } from 'bip39';
import { decryptSymmetric, encryptSymmetric, SYMMETRIC_KEY_BYTES } from '../crypto/encrypt';
import { passwordPolicyError } from '../security/passwordPolicy';
import { log } from '../logger';
import { fetchWithDeadline } from '../net/timedFetch';
import { cloudBaseUrl } from './cloudVault';

export const SEED_BINDING_VERSION = 1;
/**
 * Единственная защита конверта — пароль, поэтому итераций втрое больше, чем
 * у облачной копии. Сервер требует того же минимума и завышенный конверт не
 * примет: иначе клиент с поблажкой обесценил бы планку для всех.
 */
export const SEED_BINDING_KDF_ITERS = 600_000;
export const SEED_BINDING_SALT_BYTES = 16;
const SEED_BINDING_AAD = new TextEncoder().encode('airchat-seed-binding-v1');
const SEED_BINDING_TIMEOUT_MS = 15_000;

export type SeedBindingProvider = 'apple' | 'google';

export type SeedBindingEnvelope = {
  v: number;
  saltB64: string;
  iters: number;
  dataB64: string;
  savedAt: number;
};

function deriveBindingKey(password: string, salt: Uint8Array, iters: number): Uint8Array {
  const material = new TextEncoder().encode(password.normalize('NFC'));
  return pbkdf2(sha256, material, salt, {
    c: Math.max(iters, SEED_BINDING_KDF_ITERS),
    dkLen: SYMMETRIC_KEY_BYTES,
  });
}

function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.normalize('NFKD').trim().toLowerCase().split(/\s+/).join(' ');
}

/** Зашифровать слова паролем приложения. Чистая функция — её и проверяют тесты. */
export function encryptSeedBinding(
  mnemonic: string,
  password: string,
  now: number = Date.now(),
): SeedBindingEnvelope {
  const normalized = normalizeMnemonic(mnemonic);
  if (!validateMnemonic(normalized)) throw new Error('Секретные слова не распознаны.');
  const policyError = passwordPolicyError(password);
  if (policyError) throw new Error(policyError);
  const salt = randomBytes(SEED_BINDING_SALT_BYTES);
  const key = deriveBindingKey(password, salt, SEED_BINDING_KDF_ITERS);
  const blob = encryptSymmetric(key, new TextEncoder().encode(normalized), SEED_BINDING_AAD);
  return {
    v: SEED_BINDING_VERSION,
    saltB64: Buffer.from(salt).toString('base64'),
    iters: SEED_BINDING_KDF_ITERS,
    dataB64: Buffer.from(blob).toString('base64'),
    savedAt: now,
  };
}

/** Открыть конверт. `null` — неверный пароль или порченая запись, без разницы. */
export function decryptSeedBinding(
  envelope: SeedBindingEnvelope | null | undefined,
  password: string,
): string | null {
  if (!envelope || envelope.v !== SEED_BINDING_VERSION) return null;
  if (!Number.isSafeInteger(envelope.iters) || envelope.iters < SEED_BINDING_KDF_ITERS) return null;
  if (typeof envelope.saltB64 !== 'string' || typeof envelope.dataB64 !== 'string') return null;
  const salt = Buffer.from(envelope.saltB64, 'base64');
  if (salt.length !== SEED_BINDING_SALT_BYTES) return null;
  const key = deriveBindingKey(password, new Uint8Array(salt), envelope.iters);
  const plain = decryptSymmetric(key, new Uint8Array(Buffer.from(envelope.dataB64, 'base64')), SEED_BINDING_AAD);
  if (!plain) return null;
  const mnemonic = normalizeMnemonic(new TextDecoder().decode(plain));
  return validateMnemonic(mnemonic) ? mnemonic : null;
}

/**
 * Запрос привязки со сроком на весь обмен (v4.32.614). Тело читает переданная
 * функция: раньше срок снимался на заголовках, и разбор ответа оставался без
 * предела — на этом пути человек ждёт вход в аккаунт.
 */
function fetchBinding<T>(
  path: string,
  body: unknown,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  const base = cloudBaseUrl();
  if (!base) throw new Error('Облачное хранилище не настроено.');
  return fetchWithDeadline(
    `${base}/v1/seed-binding/${path}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    {
      timeoutMs: SEED_BINDING_TIMEOUT_MS,
      onTimeout: () => new Error('Облачный сервер не отвечает.'),
    },
    read,
  );
}

function bindingError(status: number): Error {
  if (status === 401) return new Error('Сервис не подтвердил вход. Попробуйте ещё раз.');
  if (status === 429) return new Error('Слишком много попыток. Подождите пять минут.');
  if (status === 503) return new Error('Этот способ входа сейчас недоступен.');
  return new Error(`Облачный сервер недоступен (HTTP ${status}).`);
}

/** Какие входы включены на сервере. Пустой список — кнопок не рисуем. */
export async function listSeedBindingProviders(): Promise<SeedBindingProvider[]> {
  const base = cloudBaseUrl();
  if (!base) return [];
  try {
    // v4.32.623: тот же срок, что у fetchBinding выше. Здесь его не
    // было: соседние три запроса привязки переехали на общий срок в v4.32.614,
    // а этот остался на голом fetch. Список читается при открытии «Привязать
    // к Apple ID» — молчащий сервер оставлял экран без кнопок навсегда.
    const providers = await fetchWithDeadline(
      `${base}/v1/seed-binding/providers`,
      {},
      { timeoutMs: SEED_BINDING_TIMEOUT_MS },
      async (response) => {
        if (!response.ok) return null;
        const body = (await response.json()) as { providers?: unknown };
        return Array.isArray(body.providers) ? body.providers : null;
      },
    );
    if (!providers) return [];
    return providers.filter(
      (value): value is SeedBindingProvider => value === 'apple' || value === 'google',
    );
  } catch {
    return [];
  }
}

export async function putSeedBinding(
  provider: SeedBindingProvider,
  idToken: string,
  mnemonic: string,
  password: string,
): Promise<void> {
  const envelope = encryptSeedBinding(mnemonic, password);
  await fetchBinding('put', { provider, idToken, envelope }, async (response) => {
    if (!response.ok) throw bindingError(response.status);
  });
  log.info('seed_binding_saved', { provider });
}

/** Конверт с сервера. `null` — привязки нет. */
export async function fetchSeedBinding(
  provider: SeedBindingProvider,
  idToken: string,
): Promise<SeedBindingEnvelope | null> {
  return fetchBinding('get', { provider, idToken }, async (response) => {
    if (response.status === 404) return null;
    if (!response.ok) throw bindingError(response.status);
    const body = (await response.json()) as { envelope?: SeedBindingEnvelope };
    return body?.envelope ?? null;
  });
}

export async function deleteSeedBinding(
  provider: SeedBindingProvider,
  idToken: string,
): Promise<boolean> {
  const ok = await fetchBinding('delete', { provider, idToken }, async (response) => {
    if (!response.ok) throw bindingError(response.status);
    const body = (await response.json()) as { ok?: boolean };
    return body?.ok === true;
  });
  log.info('seed_binding_deleted', { provider });
  return ok;
}
