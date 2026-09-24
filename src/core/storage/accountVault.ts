/**
 * Seed-bound local vault for account data.
 *
 * SQLite rows are already encrypted with the deterministic DEK derived from
 * the mnemonic. The vault keeps the database files and the small profile
 * registry together under a seed fingerprint, so a local wallet wipe can be
 * followed by a restore of the same account without mixing identities.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { validateMnemonic } from 'bip39';
import { sha256 } from '@noble/hashes/sha2.js';
import { deriveLocalDekFromMnemonic } from './dekDerivation';
import { mnemonicSeedCached } from '../crypto/mnemonicSeed';
import { ED25519_PUBLIC_KEY_BYTES } from '../crypto/pubKeyFormat';
import { encryptSymmetric, decryptSymmetric } from '../crypto/encrypt';
import { observeStoredDek } from './localEncryption';
import * as SecureStore from './secureStoreQueued';
import { PROFILE_STATE_KEY } from '../identity/profileStateKey';
import { log } from '../logger';

const VAULT_ROOT = 'airchat_account_vault_v1';
const MANIFEST_FILE = 'manifest.json';
const DB_FILE_RE = /^(?:airchat_local\.db|airchat_feed_p\d+\.db)(?:-(?:wal|shm))?$/;
const AVATAR_FILE_RE = /^avatar_\d+\.jpg$/;

type VaultManifestV1 = {
  v: 1;
  accountId: string;
  savedAt: number;
  dbFiles: string[];
  avatarFiles: string[];
  profileStateB64: string | null;
  /**
   * Отпечаток ключа, которым зашифрованы строки в снятых файлах (v4.32.615).
   *
   * Не секрет: по нему ключ не восстановить. Нужен, чтобы отличить копию,
   * которую это устройство сможет прочитать, от копии с чужим ключом —
   * вторая ложится поверх рабочей базы и молча превращает переписку в
   * нечитаемые ячейки. Копии старых сборок поля не имеют; для них проверить
   * нечего, и восстановление идёт как раньше.
   */
  dekFp?: string | null;
};

export type AccountVaultManifest = VaultManifestV1;

export type AccountVaultFile = {
  name: string;
  /** Base64 of the original file bytes. */
  dataB64: string;
};

export type AccountVaultArchive = {
  v: 1;
  accountId: string;
  savedAt: number;
  manifest: VaultManifestV1;
  files: AccountVaultFile[];
};

function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().split(/\s+/).join(' ');
}

/** Public, non-secret directory id. It cannot be reversed into the mnemonic. */
export function accountVaultIdFromMnemonic(mnemonic: string): string {
  const normalized = normalizeMnemonic(mnemonic);
  if (!validateMnemonic(normalized)) throw new Error('Секретные слова не проходят проверку.');
  return Buffer.from(sha256(mnemonicSeedCached(normalized))).toString('hex').slice(0, 32);
}

/**
 * Versioned cloud/sync account id. Unlike the legacy seed fingerprint, this
 * id is independently verifiable by the server from the signed account
 * public key, so an uninitialized account cannot be claimed by a first writer.
 */
export function accountIdFromPublicKey(publicKey: Uint8Array): string {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new Error('Invalid account public key');
  }
  return Buffer.from(sha256(publicKey)).toString('hex').slice(0, 32);
}

function vaultRootUri(): string | null {
  const base = FileSystem.documentDirectory;
  return base ? `${base}${VAULT_ROOT}/` : null;
}

function vaultUri(accountId: string): string | null {
  const root = vaultRootUri();
  return root ? `${root}${accountId}/` : null;
}

async function exists(uri: string): Promise<boolean> {
  try {
    return (await FileSystem.getInfoAsync(uri)).exists;
  } catch {
    return false;
  }
}

function isSafeVaultFile(name: string): boolean {
  return DB_FILE_RE.test(name) || AVATAR_FILE_RE.test(name);
}

function encryptedProfileStateB64(raw: string, mnemonic: string): string {
  const encrypted = encryptSymmetric(
    deriveLocalDekFromMnemonic(mnemonic),
    new TextEncoder().encode(raw),
  );
  return Buffer.from(encrypted).toString('base64');
}

/** Отпечаток ключа: сам ключ по нему не восстановить. */
function dekFingerprint(dek: Uint8Array): string {
  return Buffer.from(sha256(dek)).toString('hex').slice(0, 16);
}

/**
 * Совпадает ли ключ копии с ключом этого устройства.
 *
 * Проверять надо ДО первой записи: восстановление затирает и базу, и список
 * профилей, так что отказ после записи оставил бы устройство без обеих копий.
 */
async function vaultKeyMatches(manifest: VaultManifestV1, accountId: string): Promise<boolean> {
  const fingerprint = manifest.dekFp;
  if (typeof fingerprint !== 'string' || !fingerprint) return true;
  const stored = await observeStoredDek();
  // Чистая установка: ключа нет и данных под ним тоже — сверять не с чем.
  if (stored.state === 'absent') return true;
  // v4.32.617: «Keychain не ответил» — это НЕ «ключа нет». Раньше оба случая
  // читались как разрешение, и восстановление, которое затирает базу, шло
  // вслепую на запертом устройстве. Отказ здесь ничего не портит: человек
  // повторит восстановление, когда телефон разблокирован.
  if (stored.state !== 'valid' || !stored.dek) {
    log.warn('account_vault_dek_unverifiable', { accountId, state: stored.state });
    return false;
  }
  if (dekFingerprint(stored.dek) === fingerprint) return true;
  log.warn('account_vault_dek_mismatch', { accountId });
  return false;
}

/**
 * Список профилей из копии: `null` — копия испорчена, `''` — профилей нет.
 *
 * Раньше нечитаемый список молча пропускали, и восстановление докладывало об
 * успехе, оставив на устройстве список профилей от прошлого владельца: базу
 * со всеми профилями восстановили, а видно только первый.
 */
function vaultProfileState(manifest: VaultManifestV1, mnemonic: string): string | null {
  const raw = manifest.profileStateB64;
  if (!raw) return '';
  return decryptProfileState(raw, normalizeMnemonic(mnemonic));
}

function decryptProfileState(raw: string, mnemonic: string): string | null {
  try {
    const encrypted = new Uint8Array(Buffer.from(raw, 'base64'));
    const plain = decryptSymmetric(deriveLocalDekFromMnemonic(mnemonic), encrypted);
    return plain ? new TextDecoder().decode(plain) : null;
  } catch {
    return null;
  }
}

async function copyFiles(
  sourceDir: string,
  destinationDir: string,
  names: readonly string[],
): Promise<string[]> {
  const copied: string[] = [];
  for (const name of names) {
    const source = `${sourceDir}${name}`;
    if (!(await exists(source))) continue;
    await FileSystem.copyAsync({ from: source, to: `${destinationDir}${name}` });
    copied.push(name);
  }
  return copied;
}

async function replaceFile(source: string, destination: string): Promise<void> {
  await FileSystem.deleteAsync(destination, { idempotent: true });
  await FileSystem.copyAsync({ from: source, to: destination });
}

/**
 * Отложить текущие файлы устройства в сторону — так, чтобы их можно было
 * вернуть.
 *
 * v4.32.617: восстановление СНАЧАЛА стирало рабочие файлы, а потом копировало
 * файлы копии, и между этими шагами нет ничего, что вернуло бы стёртое:
 * кончилось место, отказала файловая система, приложение убили — на устройстве
 * не остаётся ни рабочей базы, ни восстановленной. Снимок копии эту защиту уже
 * имеет (`replaceVaultDirectory` уводит прежнюю копию в `.previous-` и
 * возвращает при отказе), а восстановление — самое разрушительное действие
 * приложения — не имело.
 */
type StashedFiles = { dir: string; names: { from: string; name: string }[] };

async function stashFiles(
  stashDir: string,
  sources: readonly { dir: string; pattern: RegExp }[],
): Promise<StashedFiles> {
  const stash: StashedFiles = { dir: stashDir, names: [] };
  await FileSystem.makeDirectoryAsync(stashDir, { intermediates: true });
  try {
    for (const source of sources) {
      if (!(await exists(source.dir))) continue;
      for (const name of await FileSystem.readDirectoryAsync(source.dir)) {
        if (!source.pattern.test(name)) continue;
        await FileSystem.moveAsync({ from: `${source.dir}${name}`, to: `${stashDir}${name}` });
        stash.names.push({ from: source.dir, name });
      }
    }
  } catch (error) {
    // v4.32.725: сама раскладка тоже бывает неполной. Список каталога снимают
    // один раз, а переносят по файлу: SQLite успевает убрать `-wal`/`-shm`
    // чекпойнтом, и `moveAsync` по имени из списка не проходит. К этому моменту
    // рабочая база уже лежит в отложенном каталоге.
    //
    // Откат у вызывающих начинается ПОСЛЕ этого вызова, то есть сюда он не
    // доставал: отказ уходил во внешний catch, тот писал «восстановление не
    // удалось» и возвращал false. Рабочие файлы оставались в
    // `.restore-stash-<accountId>-<время>/`, на который во всём коде больше нет
    // ни одной ссылки, — вернуть их было нечем и некогда. Человеку при этом
    // предлагали повторить попытку, и повтор уводил в отложенное уже пустоту.
    //
    // Теперь раскладка отвечает за себя сама: либо переложено всё, либо ничего.
    if (!(await unstashFiles(stash))) {
      log.error('account_vault_stash_rollback_incomplete', { stashDir });
    }
    throw error;
  }
  return stash;
}

/**
 * Вернуть отложенное на место, затирая то, что успело лечь поверх.
 *
 * v4.32.724: отказ возврата больше не гасится вместе с уборкой. Оба шага были
 * под `.catch(() => {})`, а каталог отложенного удалялся следом безусловно —
 * то есть файл, который не удалось вернуть, оставался единственной копией
 * рабочей базы и стирался в ту же секунду. Причина отказа не выдуманная: файл
 * базы бывает занят (SQLite успел открыть его снова), и тогда `deleteAsync`
 * целевого пути не проходит, а `moveAsync` поверх существующего — тем более.
 * Наружу это выглядело как «восстановление не удалось», после чего человек
 * обнаруживал, что и прежней переписки на устройстве больше нет.
 *
 * @returns вернулось ли ВСЁ. `false` — каталог `stash.dir` НЕ удалён: в нём
 * лежит единственная копия невозвращённых файлов, и удалять её нельзя.
 */
async function unstashFiles(stash: StashedFiles): Promise<boolean> {
  let complete = true;
  for (const entry of stash.names) {
    const destination = `${entry.from}${entry.name}`;
    try {
      await FileSystem.deleteAsync(destination, { idempotent: true });
      await FileSystem.moveAsync({ from: `${stash.dir}${entry.name}`, to: destination });
    } catch (error) {
      complete = false;
      log.error('account_vault_unstash_file_failed', {
        name: entry.name,
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (!complete) {
    log.error('account_vault_unstash_incomplete', { stashDir: stash.dir });
    return false;
  }
  await FileSystem.deleteAsync(stash.dir, { idempotent: true }).catch(() => {});
  return true;
}

async function replaceVaultDirectory(stageDir: string, finalDir: string, root: string, accountId: string): Promise<void> {
  const previousDir = `${root}.previous-${accountId}-${Date.now()}/`;
  const hadPrevious = await exists(finalDir);
  if (hadPrevious) await FileSystem.moveAsync({ from: finalDir, to: previousDir });
  try {
    await FileSystem.moveAsync({ from: stageDir, to: finalDir });
  } catch (error) {
    await FileSystem.deleteAsync(finalDir, { idempotent: true }).catch(() => {});
    if (hadPrevious) {
      await FileSystem.moveAsync({ from: previousDir, to: finalDir }).catch(() => {});
    }
    throw error;
  }
  if (hadPrevious) await FileSystem.deleteAsync(previousDir, { idempotent: true });
}

/** Snapshot closed local databases before the wallet wipe removes them. */
export async function snapshotAccountVault(
  mnemonic: string,
  profileStateRaw: string | null,
): Promise<boolean> {
  const accountId = accountVaultIdFromMnemonic(mnemonic);
  const root = vaultRootUri();
  const finalDir = vaultUri(accountId);
  const base = FileSystem.documentDirectory;
  if (!root || !finalDir || !base) return false;

  const stageDir = `${root}.staging-${accountId}-${Date.now()}/`;
  await FileSystem.makeDirectoryAsync(`${stageDir}SQLite/`, { intermediates: true });
  await FileSystem.makeDirectoryAsync(`${stageDir}avatars/`, { intermediates: true });

  try {
    // v4.32.617: отпечаток либо честный, либо копии не будет. Раньше отказ
    // Keychain'а давал `dekFp: null`, а `null` в манифесте снимает сверку при
    // восстановлении вовсе — копия молча теряла свою единственную защиту от
    // затирания чужих данных.
    const storedDek = await observeStoredDek();
    if (storedDek.state !== 'absent' && storedDek.state !== 'valid') {
      throw new Error(`account vault snapshot: dek ${storedDek.state}`);
    }
    const snapshotDek = storedDek.dek;
    const dbDir = `${base}SQLite/`;
    const dbNames = (await exists(dbDir) ? await FileSystem.readDirectoryAsync(dbDir) : [])
      .filter((name) => DB_FILE_RE.test(name));
    const avatarNames = (await FileSystem.readDirectoryAsync(base))
      .filter((name) => AVATAR_FILE_RE.test(name));
    const copiedDbFiles = await copyFiles(dbDir, `${stageDir}SQLite/`, dbNames);
    const copiedAvatarFiles = await copyFiles(base, `${stageDir}avatars/`, avatarNames);
    const manifest: VaultManifestV1 = {
      v: 1,
      accountId,
      savedAt: Date.now(),
      dbFiles: copiedDbFiles,
      avatarFiles: copiedAvatarFiles,
      profileStateB64: profileStateRaw
        ? encryptedProfileStateB64(profileStateRaw, normalizeMnemonic(mnemonic))
        : null,
      dekFp: snapshotDek ? dekFingerprint(snapshotDek) : null,
    };
    await FileSystem.writeAsStringAsync(`${stageDir}${MANIFEST_FILE}`, JSON.stringify(manifest));
    await replaceVaultDirectory(stageDir, finalDir, root, accountId);
    log.info('account_vault_snapshot_saved', {
      accountId,
      dbFiles: copiedDbFiles.length,
      avatarFiles: copiedAvatarFiles.length,
    });
    return true;
  } catch (e) {
    log.warn('account_vault_snapshot_failed', {
      accountId,
      err: e instanceof Error ? e.message : String(e),
    });
    await FileSystem.deleteAsync(stageDir, { idempotent: true });
    return false;
  }
}

/** Delete the seed-bound local restore point as part of a full wallet wipe. */
export async function deleteAccountVault(mnemonic: string): Promise<void> {
  const accountId = accountVaultIdFromMnemonic(mnemonic);
  const dir = vaultUri(accountId);
  if (!dir) return;
  await FileSystem.deleteAsync(dir, { idempotent: true });
  log.info('account_vault_deleted', { accountId });
}

/** Restore the seed-bound snapshot, if one exists on this installation. */
export async function hasAccountVaultSnapshot(mnemonic: string): Promise<boolean> {
  const accountId = accountVaultIdFromMnemonic(mnemonic);
  const dir = vaultUri(accountId);
  return !!dir && (await exists(`${dir}${MANIFEST_FILE}`));
}

/** Restore the seed-bound snapshot, if one exists on this installation. */
export async function restoreAccountVault(mnemonic: string): Promise<boolean> {
  const accountId = accountVaultIdFromMnemonic(mnemonic);
  const dir = vaultUri(accountId);
  const base = FileSystem.documentDirectory;
  if (!dir || !base) return false;
  const manifestUri = `${dir}${MANIFEST_FILE}`;
  if (!(await exists(manifestUri))) return false;

  try {
    const raw = await FileSystem.readAsStringAsync(manifestUri);
    const manifest = JSON.parse(raw) as VaultManifestV1;
    if (
      manifest?.v !== 1 ||
      manifest.accountId !== accountId ||
      !Array.isArray(manifest.dbFiles) ||
      !Array.isArray(manifest.avatarFiles)
    ) return false;

    const profileState = vaultProfileState(manifest, mnemonic);
    if (profileState === null) {
      log.warn('account_vault_profile_state_unreadable', { accountId });
      return false;
    }
    if (!(await vaultKeyMatches(manifest, accountId))) return false;

    const dbDir = `${base}SQLite/`;
    await FileSystem.makeDirectoryAsync(dbDir, { intermediates: true });

    // v4.32.847: сначала убедиться, что снимок цел, и только потом трогать
    // рабочие файлы.
    //
    // Прежде проверки не было вовсе: файл, названный в манифесте, но пропавший
    // с диска, тихо пропускался (`if (await exists(...))`). А рабочие файлы к
    // этому времени уже уведены в отложенный каталог, и он на успехе
    // удаляется. То есть восстановление из щербатого снимка стирало рабочую
    // базу и НЕ клало на её место ничего — и возвращало `true`, то есть
    // «восстановлено».
    const dbNames = manifest.dbFiles.filter(
      (value) => typeof value === 'string' && DB_FILE_RE.test(value),
    );
    const avatarNames = manifest.avatarFiles.filter(
      (value) => typeof value === 'string' && AVATAR_FILE_RE.test(value),
    );
    const absentDb: string[] = [];
    for (const name of dbNames) {
      if (!(await exists(`${dir}SQLite/${name}`))) absentDb.push(name);
    }
    if (absentDb.length > 0) {
      log.error('account_vault_restore_incomplete', { accountId, names: absentDb });
      return false;
    }

    // Прежний список профилей тоже надо уметь вернуть: без него база
    // восстановлена, а видно только первый профиль.
    const previousProfileState = await SecureStore.getItemAsync(PROFILE_STATE_KEY);
    const stash = await stashFiles(`${base}.restore-stash-${accountId}-${Date.now()}/`, [
      { dir: dbDir, pattern: DB_FILE_RE },
      { dir: base, pattern: AVATAR_FILE_RE },
    ]);
    try {
      for (const name of dbNames) {
        await replaceFile(`${dir}SQLite/${name}`, `${dbDir}${name}`);
      }
      // Картинка — не переписка: из-за пропавшего аватара отменять возврат
      // базы незачем. Но и молчать нельзя: этот аватар сейчас пропадёт с
      // устройства вместе с отложенным каталогом.
      let absentAvatars = 0;
      for (const name of avatarNames) {
        const source = `${dir}avatars/${name}`;
        if (!(await exists(source))) {
          absentAvatars += 1;
          continue;
        }
        await replaceFile(source, `${base}${name}`);
      }
      if (absentAvatars > 0) {
        log.warn('account_vault_restore_avatars_absent', { accountId, count: absentAvatars });
      }
      if (profileState) await SecureStore.setItemAsync(PROFILE_STATE_KEY, profileState);
      else await SecureStore.deleteItemAsync(PROFILE_STATE_KEY);
    } catch (error) {
      // v4.32.724: вернулось не всё — каталог отложенного остался на месте, и
      // удалять его нельзя: это единственная копия того, что не вернулось.
      if (!(await unstashFiles(stash))) {
        log.error('account_vault_restore_rollback_incomplete', { accountId, stashDir: stash.dir });
      }
      if (previousProfileState) {
        await SecureStore.setItemAsync(PROFILE_STATE_KEY, previousProfileState).catch(() => {});
      } else {
        await SecureStore.deleteItemAsync(PROFILE_STATE_KEY).catch(() => {});
      }
      throw error;
    }
    await FileSystem.deleteAsync(stash.dir, { idempotent: true }).catch(() => {});
    log.info('account_vault_restored', {
      accountId,
      dbFiles: manifest.dbFiles.length,
      avatarFiles: manifest.avatarFiles.length,
    });
    return true;
  } catch (e) {
    log.warn('account_vault_restore_failed', {
      accountId,
      err: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/**
 * Базы, которые манифест архива обещает, а сам архив не везёт (v4.32.847).
 *
 * Проверка того же направления, которого не хватало и в облаке:
 * `validateArchiveFileList` сверяла только `files ⊆ manifest`, то есть ловила
 * лишний файл и пропускала недостающий. Архив без базы переписки проходил как
 * исправный — и «восстанавливался», стирая ту базу, что была.
 */
export function missingArchiveDbFiles(archive: AccountVaultArchive): string[] {
  const manifest = archive?.manifest;
  if (!manifest || !Array.isArray(manifest.dbFiles)) return [];
  const carried = new Set(
    (Array.isArray(archive.files) ? archive.files : [])
      .filter((file) => file && typeof file.name === 'string' && typeof file.dataB64 === 'string')
      .map((file) => file.name),
  );
  return manifest.dbFiles.filter(
    (name) => typeof name === 'string' && DB_FILE_RE.test(name) && !carried.has(name),
  );
}

/**
 * Read the local seed-bound snapshot as a transport-neutral archive. The
 * caller encrypts this object before it leaves the device.
 */
export async function readAccountVaultArchive(mnemonic: string): Promise<AccountVaultArchive | null> {
  const accountId = accountVaultIdFromMnemonic(mnemonic);
  const dir = vaultUri(accountId);
  if (!dir) return null;
  const manifestUri = `${dir}${MANIFEST_FILE}`;
  if (!(await exists(manifestUri))) return null;

  try {
    const manifest = JSON.parse(await FileSystem.readAsStringAsync(manifestUri)) as VaultManifestV1;
    if (
      manifest?.v !== 1 ||
      manifest.accountId !== accountId ||
      !Array.isArray(manifest.dbFiles) ||
      !Array.isArray(manifest.avatarFiles)
    ) return null;

    const files: AccountVaultFile[] = [];
    const absentDb: string[] = [];
    const absentAvatars: string[] = [];
    for (const name of [...manifest.dbFiles, ...manifest.avatarFiles]) {
      if (typeof name !== 'string' || !isSafeVaultFile(name)) {
        // Манифест перечисляет то, чего в снимке быть не может. Чего в такой
        // копии не хватает ещё — неизвестно, и отдавать её наружу нельзя.
        log.error('account_vault_archive_manifest_bad_name', { accountId });
        return null;
      }
      const uri = DB_FILE_RE.test(name) ? `${dir}SQLite/${name}` : `${dir}avatars/${name}`;
      if (!(await exists(uri))) {
        (DB_FILE_RE.test(name) ? absentDb : absentAvatars).push(name);
        continue;
      }
      files.push({
        name,
        dataB64: await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 }),
      });
    }
    // v4.32.847: пропущенный файл больше не уезжает в облако молча.
    //
    // Прежде отсутствие файла на диске было просто `continue`: архив уходил
    // короче манифеста, сервер отвечал «принято», а человеку говорили
    // «Зашифрованная копия отправлена в облако». Возвращать такую копию
    // некуда — восстановление стирает рабочую базу и не кладёт на её место
    // ничего.
    if (absentDb.length > 0) {
      log.error('account_vault_archive_db_absent', { accountId, names: absentDb });
      return null;
    }
    if (absentAvatars.length === 0) {
      return { v: 1, accountId, savedAt: manifest.savedAt, manifest, files };
    }
    // Аватара нет — переписку из-за этого не отдавать глупо. Но манифест
    // обязан описывать ровно то, что внутри: иначе при возврате копии её
    // сочтут неполной и откажут по-настоящему.
    log.warn('account_vault_archive_avatars_absent', { accountId, count: absentAvatars.length });
    const lost = new Set(absentAvatars);
    return {
      v: 1,
      accountId,
      savedAt: manifest.savedAt,
      manifest: { ...manifest, avatarFiles: manifest.avatarFiles.filter((name) => !lost.has(name)) },
      files,
    };
  } catch (e) {
    log.warn('account_vault_archive_read_failed', {
      accountId,
      err: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/** Restore an already decrypted archive without allowing path traversal. */
export async function restoreAccountVaultArchive(
  mnemonic: string,
  archive: AccountVaultArchive,
): Promise<boolean> {
  const accountId = accountVaultIdFromMnemonic(mnemonic);
  const base = FileSystem.documentDirectory;
  if (
    !base ||
    archive?.v !== 1 ||
    archive.accountId !== accountId ||
    archive.manifest?.v !== 1 ||
    archive.manifest.accountId !== accountId ||
    !Array.isArray(archive.files)
  ) return false;

  try {
    const profileState = vaultProfileState(archive.manifest, mnemonic);
    if (profileState === null) {
      log.warn('account_vault_profile_state_unreadable', { accountId });
      return false;
    }
    if (!(await vaultKeyMatches(archive.manifest, accountId))) return false;

    await FileSystem.makeDirectoryAsync(`${base}SQLite/`, { intermediates: true });
    const manifestDbFiles = Array.isArray(archive.manifest.dbFiles) ? archive.manifest.dbFiles : [];
    const manifestAvatarFiles = Array.isArray(archive.manifest.avatarFiles) ? archive.manifest.avatarFiles : [];
    const manifestFiles = new Set([...manifestDbFiles, ...manifestAvatarFiles]);
    // v4.32.847: щербатый архив отвергается ДО того, как рабочие файлы уведены
    // в сторону, — иначе отказ сам по себе и есть потеря переписки.
    const absentDb = missingArchiveDbFiles(archive);
    if (absentDb.length > 0) {
      log.error('account_vault_archive_incomplete', { accountId, names: absentDb });
      return false;
    }
    // v4.32.617: как и восстановление из копии на устройстве, разбор архива
    // сначала уводит текущие файлы в сторону. Оборвётся на середине — вернём.
    const previousProfileState = await SecureStore.getItemAsync(PROFILE_STATE_KEY);
    const stash = await stashFiles(`${base}.archive-stash-${accountId}-${Date.now()}/`, [
      { dir: `${base}SQLite/`, pattern: DB_FILE_RE },
      { dir: base, pattern: AVATAR_FILE_RE },
    ]);
    try {
      for (const file of archive.files) {
        if (!file || typeof file.name !== 'string' || !manifestFiles.has(file.name)
          || !isSafeVaultFile(file.name) || typeof file.dataB64 !== 'string') continue;
        const destination = DB_FILE_RE.test(file.name)
          ? `${base}SQLite/${file.name}`
          : `${base}${file.name}`;
        const temporary = `${destination}.restore-${Date.now()}`;
        await FileSystem.deleteAsync(temporary, { idempotent: true });
        await FileSystem.writeAsStringAsync(temporary, file.dataB64, {
          encoding: FileSystem.EncodingType.Base64,
        });
        await FileSystem.deleteAsync(destination, { idempotent: true });
        await FileSystem.moveAsync({ from: temporary, to: destination });
      }
      if (profileState) await SecureStore.setItemAsync(PROFILE_STATE_KEY, profileState);
      else await SecureStore.deleteItemAsync(PROFILE_STATE_KEY);
    } catch (error) {
      // v4.32.724: вернулось не всё — каталог отложенного остался на месте, и
      // удалять его нельзя: это единственная копия того, что не вернулось.
      if (!(await unstashFiles(stash))) {
        log.error('account_vault_archive_rollback_incomplete', { accountId, stashDir: stash.dir });
      }
      if (previousProfileState) {
        await SecureStore.setItemAsync(PROFILE_STATE_KEY, previousProfileState).catch(() => {});
      } else {
        await SecureStore.deleteItemAsync(PROFILE_STATE_KEY).catch(() => {});
      }
      throw error;
    }
    await FileSystem.deleteAsync(stash.dir, { idempotent: true }).catch(() => {});
    log.info('account_vault_archive_restored', {
      accountId,
      files: archive.files.length,
    });
    return true;
  } catch (e) {
    log.warn('account_vault_archive_restore_failed', {
      accountId,
      err: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}
