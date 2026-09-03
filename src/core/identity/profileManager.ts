/**
 * Несколько профилей (аккаунтов) из одной BIP39 seed: отдельные ключи через HKDF (см. seedPhrase).
 *
 * Локальная SQLite одна; сообщения чата помечены `owner_profile_id` и при смене профиля не смешиваются.
 * Полезная нагрузка сообщений шифруется (DEK в SecureStore, см. localEncryption / local.ts).
 */
import * as SecureStore from '../storage/secureStoreQueued';
import { publicKeyToDidKey } from './did';
import type { KeyPairBytes } from '../crypto/keyManager';
import { loadKeyPair, persistKeyPair } from '../crypto/keyManager';
import {
  deriveKeyPairFromMnemonicForProfile,
  getStoredMnemonic,
} from '../backup/seedPhrase';
import { log } from '../logger';
import { bytesEqualConstTime } from '../storage/dekDerivation';
import { PROFILE_STATE_KEY } from './profileStateKey';

const PROFILES_STATE_KEY = PROFILE_STATE_KEY;
/**
 * Имя ключа-зеркала должно совпадать с тем, что читает фоновый обработчик
 * (src/notifications/backgroundNotifyPrefs.ts). Импортировать его оттуда нельзя
 * — это модуль слоя уведомлений, а сюда он потянул бы expo-sqlite.
 */
const ACTIVE_PROFILE_MIRROR_KEY = 'active_profile_id';

/**
 * v4.32.22: лимит профилей на устройстве = 4.
 *
 * Почему именно 4 (а не «сколько угодно»):
 * - Каждый профиль держит свою SQLite feed-БД (`airchat_feed_p${id}.db`) и
 *   свой owner_profile_id-скоупинг в общей `airchat_local.db`. При смене
 *   профиля identity-effect в `App.tsx` (v4.32.22) пересоздаёт messaging +
 *   LAN transport + mesh + feed inbox listener + push + scheduler. Даже
 *   серийно это ~300-600мс работы на switch. При 4 профилях пользователь
 *   физически не успевает «устроить шторм» — интерфейс перетыкать дольше,
 *   чем identity-effect завершается.
 * - WebRTC-signaling через pubsub и LAN-mDNS объявляют один `myDid` на
 *   устройство. 4+ частых переключений могут приводить к stale-объявлениям
 *   на пире: он видит «то один did, то другой, то снова первый». На 4
 *   профилях это реже и UX приемлемый; больше — начинает деградировать.
 * - Android Keystore при `persistKeyPair` для каждого profile pair делает
 *   отдельный keystore entry + `SecureStore.setItemAsync`. Чем больше
 *   entries — тем медленнее cold boot (KeyStore под капотом линейно ищет).
 */
export const MAX_PROFILES = 4;

export type Profile = {
  id: number;
  name: string;
  did: string;
  derivationIndex: number;
  createdAt: number;
  lastUsed: number;
};

type ProfileStateV1 = {
  v: 1;
  activeProfileId: number;
  nextProfileId: number;
  /** Следующий свободный индекс деривации (монотонно растёт, не переиспользуется). */
  nextDerivationIndex: number;
  profiles: Array<{
    id: number;
    derivationIndex: number;
    name: string;
    createdAt: number;
    lastUsed: number;
  }>;
};

// v4.32.132 (AUDIT P3): switched to constant-time compare (imported above).
// Only caller (line ~179) compares an in-memory secret key against a freshly
// derived one on boot — no external timing side-channel is practically
// reachable, but making this constant-time keeps the pattern consistent
// with other secret-key compares in the codebase.
const bytesEqual = bytesEqualConstTime;

function toProfile(row: ProfileStateV1['profiles'][0], pair: KeyPairBytes): Profile {
  return {
    id: row.id,
    name: row.name,
    did: publicKeyToDidKey(pair.publicKey),
    derivationIndex: row.derivationIndex,
    createdAt: row.createdAt,
    lastUsed: row.lastUsed,
  };
}

class ProfileManager {
  private state: ProfileStateV1 | null = null;
  private initialized = false;
  /** Все вызовы `init()` ждут одну и ту же работу (раньше `initialized=true` ставился до await — второй вызов «успевал» раньше первого). */
  private initPromise: Promise<void> | null = null;
  private mnemonicCache: string | null = null;
  private profileMem: { profile: Profile; at: number } | null = null;
  private readonly profileMemTtlMs = 5000;
  /**
   * v4.32.49: serialization queue for switchProfile.
   * Без mutex'а быстрый double-tap на разные профили в ProfileSelector давал
   * race: два параллельных switchProfile() писали state + Keystore одновременно,
   * результирующий activeProfileId мог оказаться неконсистентным. Теперь каждый
   * следующий вызов ждёт предыдущий через chain, результат строго последовательный.
   */
  private switchPromise: Promise<Profile | null> | null = null;

  private invalidateProfileCache(): void {
    this.profileMem = null;
  }

  /** Есть seed в SecureStore — можно вести несколько профилей. */
  isEnabled(): boolean {
    return this.mnemonicCache !== null && this.state !== null && this.state.profiles.length > 0;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = this.runInitOnce();
    }
    try {
      await this.initPromise;
    } catch (e) {
      this.initPromise = null;
      throw e;
    }
  }

  /**
   * Если boot оборвал `withTimeout`, а `runInitOnce` ещё ждёт Keystore — сбросить promise,
   * иначе следующий `init()` будет вечно ждать тот же зависший Future.
   */
  resetStalledInit(): void {
    if (this.initialized) return;
    this.initPromise = null;
  }

  private async runInitOnce(): Promise<void> {
    log.debug('profile_manager_step', { step: 'get_stored_mnemonic' });
    const mnemonic = await getStoredMnemonic();
    if (!mnemonic?.trim()) {
      this.mnemonicCache = null;
      this.state = null;
      this.initialized = true;
      log.debug('profile_manager_step', { step: 'no_mnemonic_done' });
      return;
    }
    this.mnemonicCache = mnemonic.trim().split(/\s+/).join(' ');

    log.debug('profile_manager_step', { step: 'profiles_state_key' });
    const raw = await SecureStore.getItemAsync(PROFILES_STATE_KEY);
    if (raw) {
      try {
        // v4.32.203 (Round-33 #5): cap raw before JSON.parse. SecureStore is
        // usually trusted but import/backup flows can write attacker-influenced
        // snapshots there; a 100MB value would stall JS thread on parse.
        if (raw.length > 256 * 1024) {
          log.warn('profile_manager_raw_oversize', { len: raw.length });
          this.state = null;
        } else {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          this.state = null;
        } else {
        this.state = parsed as ProfileStateV1;
        if (this.state.v !== 1 || !Array.isArray(this.state.profiles)) {
          this.state = null;
        } else {
          // v4.32.196 (Round-26 #7): validate each profile row. A corrupt
          // SecureStore value with `id: "foo"` / `derivationIndex: -1` / NaN
          // would flow into deriveKeyPairFromMnemonicForProfile and produce a
          // wrong-identity keypair — silent compromise of DM ownership.
          const clean = this.state.profiles.filter((p) =>
            !!p &&
            typeof p.id === 'number' && Number.isInteger(p.id) && p.id > 0 &&
            typeof p.derivationIndex === 'number' && Number.isInteger(p.derivationIndex) && p.derivationIndex >= 0 && p.derivationIndex < 1000 &&
            typeof p.name === 'string' && p.name.length > 0 && p.name.length <= 64 &&
            typeof p.createdAt === 'number' && Number.isFinite(p.createdAt) &&
            typeof p.lastUsed === 'number' && Number.isFinite(p.lastUsed)
          );
          if (clean.length === 0) {
            this.state = null;
          } else if (clean.length !== this.state.profiles.length) {
            log.warn('profile_manager_dropped_invalid_rows', { before: this.state.profiles.length, after: clean.length });
            this.state = { ...this.state, profiles: clean };
          }
        }
        }
        }
      } catch {
        this.state = null;
      }
    }

    if (!this.state) {
      log.debug('profile_manager_step', { step: 'migrate_or_create_default' });
      await this.migrateOrCreateDefault();
    }
    this.invalidateProfileCache();
    this.initialized = true;
    log.debug('profile_manager_step', { step: 'done' });
  }

  /** После первого создания кошелька (онбординг) — зафиксировать один профиль. */
  async ensureAfterNewWallet(): Promise<void> {
    await this.init();
    if (!this.mnemonicCache) return;
    if (this.state && this.state.profiles.length > 0) return;
    await this.migrateOrCreateDefault();
  }

  private async migrateOrCreateDefault(): Promise<void> {
    if (!this.mnemonicCache) return;

    const now = Date.now();
    const pair0 = deriveKeyPairFromMnemonicForProfile(this.mnemonicCache, 0);
    const current = await loadKeyPair();
    if (current && !bytesEqual(current.secretKey, pair0.secretKey)) {
      log.warn('profile_migrate_keys_overwritten_to_match_seed');
    }

    this.state = {
      v: 1,
      activeProfileId: 1,
      nextProfileId: 2,
      nextDerivationIndex: 1,
      profiles: [
        {
          id: 1,
          derivationIndex: 0,
          name: 'Личный',
          createdAt: now,
          lastUsed: now,
        },
      ],
    };
    await persistKeyPair(pair0);
    await this.persistState();
  }

  private async persistState(): Promise<void> {
    if (!this.state) return;
    await SecureStore.setItemAsync(PROFILES_STATE_KEY, JSON.stringify(this.state));
    this.invalidateProfileCache();
    await this.mirrorActiveProfileId();
  }

  /**
   * Зеркало номера активного профиля в таблицу kv (v4.32.502).
   *
   * Состояние профилей лежит в SecureStore и поднимается вместе со всем слоем
   * хранилища — фоновому обработчику push этот путь недоступен, а решать, кого
   * заглушили, ему надо: записи «без звука» лежат в namespace профиля. Одно
   * целое число в kv — это всё, что ему нужно, чтобы собрать имя ключа.
   *
   * Пишется здесь, потому что persistState — единственное место, через которое
   * проходит любая смена активного профиля. Зеркало необязательное: не удалось
   * записать — фон прочитает первый профиль и в худшем случае покажет баннер,
   * который был бы заглушён. Показать лишнее лучше, чем промолчать.
   */
  private async mirrorActiveProfileId(): Promise<void> {
    const id = this.state?.activeProfileId;
    if (typeof id !== 'number') return;
    try {
      const { kvSet } = await import('../storage/local');
      await kvSet(ACTIVE_PROFILE_MIRROR_KEY, String(id));
    } catch {
      /* зеркало необязательно — фон переживёт его отсутствие */
    }
  }

  private rowById(id: number): ProfileStateV1['profiles'][0] | undefined {
    return this.state?.profiles.find((p) => p.id === id);
  }

  getActiveKeyPair(): KeyPairBytes {
    if (!this.mnemonicCache || !this.state) {
      throw new Error('Profile manager not ready');
    }
    const row = this.rowById(this.state.activeProfileId);
    if (!row) {
      throw new Error('No active profile');
    }
    return deriveKeyPairFromMnemonicForProfile(this.mnemonicCache, row.derivationIndex);
  }

  /**
   * Номер активного профиля и его открытый ключ — одним чтением (v4.32.480).
   *
   * Пары «pid отсюда, открытый ключ из loadKeyPair()» разъезжаются: устройство
   * хранит ключ, который переключение аккаунта перезаписывает ОТДЕЛЬНЫМ
   * await'ом, и между двумя чтениями помещается целое переключение. Так
   * закрепление сообщения уходило в группу под номером одного профиля и
   * открытым ключом другого — то есть связывало два аккаунта одного человека
   * на глазах у участников, а своё же закрепление у них отбрасывал
   * анти-спуф-фильтр. Здесь оба значения берутся из одного состояния, между
   * ними нет await, и подмениться нечему.
   */
  getActiveIdentity(): { pid: number; myPubB64: string } | null {
    if (!this.mnemonicCache || !this.state) return null;
    const row = this.rowById(this.state.activeProfileId);
    if (!row) return null;
    const pair = deriveKeyPairFromMnemonicForProfile(this.mnemonicCache, row.derivationIndex);
    return { pid: row.id, myPubB64: Buffer.from(pair.publicKey).toString('base64') };
  }

  async applyActiveKeyPairToDevice(): Promise<KeyPairBytes> {
    const pair = this.getActiveKeyPair();
    await persistKeyPair(pair);
    return pair;
  }

  /** v4.32.129 (AUDIT P3): throttle flag so we only warn once per process boot
   * when callers hit us before init. Used by `getActiveProfile` below. */
  private warnedNotReady = false;

  getActiveProfile(): Profile | null {
    if (!this.mnemonicCache || !this.state) {
      // v4.32.129 (AUDIT P3): 19 call-sites use `getActiveProfile()?.id ?? 1`
      // and silently fall back to profile 1 when we return null. That's benign
      // in a single-profile install but quietly mis-attributes writes during
      // boot/wipe/logout transitions on multi-profile installs. Emit a warn
      // once per process so the fallback becomes observable in logs without
      // spamming hot paths.
      if (!this.warnedNotReady) {
        this.warnedNotReady = true;
        log.warn('profile_manager_not_ready', {
          hasMnemonic: !!this.mnemonicCache,
          hasState: !!this.state,
        });
      }
      return null;
    }
    const now = Date.now();
    if (this.profileMem && now - this.profileMem.at < this.profileMemTtlMs) {
      return this.profileMem.profile;
    }
    const row = this.rowById(this.state.activeProfileId);
    if (!row) return null;
    const pair = deriveKeyPairFromMnemonicForProfile(this.mnemonicCache, row.derivationIndex);
    const p = toProfile(row, pair);
    this.profileMem = { profile: p, at: now };
    return p;
  }

  /**
   * Только номера профилей.
   *
   * v4.32.433: отдельно от getAllProfiles, потому что тот на КАЖДЫЙ профиль
   * заново выводит ключевую пару — mnemonicToSeedSync это PBKDF2-HMAC-SHA512
   * на 2048 итераций, без кеша. Вызывающим, которым нужен один int, платить
   * за это незачем. Список номеров есть и до того, как поднялась мнемоника.
   */
  getProfileIds(): number[] {
    return this.state?.profiles.map((row) => row.id) ?? [];
  }

  /**
   * Имя профиля по его номеру — без вывода ключей.
   *
   * v4.32.478: то же соображение, что у getProfileIds. Имя нужно там, где
   * профиль ещё не заполнил свою карточку и представляться приходится тем
   * именем, под которым его завели, — и брать ради одной строки getAllProfiles
   * значит заново вывести ключевую пару КАЖДОГО профиля (PBKDF2-HMAC-SHA512,
   * 2048 итераций, без кеша). Имя лежит в состоянии и доступно до того, как
   * поднялась мнемоника.
   */
  getProfileName(pid: number): string | null {
    return this.state?.profiles.find((row) => row.id === pid)?.name ?? null;
  }

  getAllProfiles(): Profile[] {
    if (!this.mnemonicCache || !this.state) return [];
    return this.state.profiles.map((row) => {
      const pair = deriveKeyPairFromMnemonicForProfile(this.mnemonicCache!, row.derivationIndex);
      return toProfile(row, pair);
    });
  }

  /**
   * v4.32.22: fast-path если переключают на уже активный профиль — просто
   * обновляем `lastUsed` без `persistKeyPair` (который лезет в Android Keystore
   * на 100-300мс) и без re-derive. UI вызовет `onIdentityUpdated`, но в
   * identity-effect (App.tsx) есть проверка равенства bytes — каскада не будет.
   * v4.32.49: обёрнут serialization-queue'ом `switchPromise` — параллельные
   * вызовы цепочкой ждут предыдущий; одновременная запись state/Keystore
   * невозможна, результат детерминированный.
   */
  async switchProfile(profileId: number): Promise<Profile | null> {
    const prev = this.switchPromise ?? Promise.resolve(null);
    const next = prev.then(() => this.switchProfileInner(profileId), () => this.switchProfileInner(profileId));
    this.switchPromise = next.finally(() => {
      if (this.switchPromise === next) this.switchPromise = null;
    });
    return next;
  }

  private async switchProfileInner(profileId: number): Promise<Profile | null> {
    await this.init();
    if (!this.state || !this.mnemonicCache) return null;
    const row = this.rowById(profileId);
    if (!row) return null;
    const isSame = this.state.activeProfileId === profileId;
    // v4.32.180 (Round-10 #5): dispose services BEFORE mutating identity so
    // in-flight publishes/pushes can't race the pair swap and mis-sign under
    // new identity / leak old FCM token.
    if (!isSame) {
      try {
        const { cancelLiveAccountSync } = await import('../sync/liveAccountSync');
        cancelLiveAccountSync();
      } catch { /* ignore */ }
      try {
        const { disposeMessagingService } = await import('../social/messaging');
        disposeMessagingService();
      } catch { /* ignore */ }
      try {
        const { disposeCallService } = await import('../social/callService');
        await disposeCallService();
      } catch { /* ignore */ }
      try {
        const { disposePushNotificationService } = await import('../../notifications/pushNotifications');
        await disposePushNotificationService();
      } catch { /* ignore */ }
      try {
        const { rateLimiter } = await import('../security/rateLimiter');
        await rateLimiter.resetForProfileSwitch();
      } catch { /* ignore */ }
      // v4.32.187 (Round-17 #2): stop any live-location sessions from the
      // prior profile so their setInterval closures don't broadcast under
      // the new identity after switch.
      try {
        const { stopAllLiveLocSessions } = await import('../social/liveLocationService');
        stopAllLiveLocSessions();
      } catch { /* ignore */ }
    }
    // v4.32.480: номер профиля и сброс кеша — одним синхронным шагом, без
    // await между ними. Раньше между записью номера и сбросом стоял поход в
    // SecureStore, и всё это время getActiveProfile() отвечал из кеша старым
    // профилем, а getActiveKeyPair() читал state и отвечал новым ключом: один
    // и тот же вопрос имел два ответа, а какой достанется — решал возраст
    // кеша.
    this.state.activeProfileId = profileId;
    row.lastUsed = Date.now();
    this.invalidateProfileCache();
    await this.persistState();
    const pair = deriveKeyPairFromMnemonicForProfile(this.mnemonicCache, row.derivationIndex);
    if (!isSame) {
      await persistKeyPair(pair);
    }
    this.invalidateProfileCache();
    return toProfile(row, pair);
  }

  /** Сколько ещё профилей можно создать (0 — лимит достигнут). */
  getRemainingSlots(): number {
    if (!this.state) return MAX_PROFILES;
    return Math.max(0, MAX_PROFILES - this.state.profiles.length);
  }

  canAddProfile(): boolean {
    return this.getRemainingSlots() > 0;
  }

  async addProfile(name: string): Promise<Profile> {
    await this.init();
    if (!this.mnemonicCache || !this.state) {
      throw new Error('Нет сохранённой seed-фразы');
    }
    // v4.32.22: hard cap на 4 профиля — см. MAX_PROFILES выше. UI прячет
    // форму создания, но проверяем и здесь, чтобы нельзя было обойти через
    // прямой вызов API.
    if (this.state.profiles.length >= MAX_PROFILES) {
      throw new Error(
        `Лимит профилей на устройстве: ${MAX_PROFILES}. Удалите один, чтобы создать новый.`
      );
    }
    // Защита от дубликатов по имени (регистронезависимо, trim) — 4 одинаковых
    // «Личный» запутают пользователя, особенно в peer-jump UI где видно только имя.
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('Введите имя профиля');
    }
    const nameLower = trimmed.toLowerCase();
    if (this.state.profiles.some((p) => p.name.trim().toLowerCase() === nameLower)) {
      throw new Error('Профиль с таким именем уже есть');
    }
    const now = Date.now();
    const derivationIndex = this.state.nextDerivationIndex;
    const id = this.state.nextProfileId;
    this.state.nextDerivationIndex += 1;
    this.state.nextProfileId += 1;
    const row = {
      id,
      derivationIndex,
      name: trimmed,
      createdAt: now,
      lastUsed: now,
    };
    this.state.profiles.push(row);
    this.state.activeProfileId = id;
    await this.persistState();
    const pair = deriveKeyPairFromMnemonicForProfile(this.mnemonicCache, derivationIndex);
    await persistKeyPair(pair);
    return toProfile(row, pair);
  }

  async renameProfile(profileId: number, newName: string): Promise<boolean> {
    await this.init();
    if (!this.state) return false;
    const row = this.rowById(profileId);
    if (!row) return false;
    // v4.32.187 (Round-17 #9): mirror `addProfile` validation — empty name
    // silently keeps the old name (expected), but duplicates (regardless of
    // case) and multi-KB paste should be rejected, otherwise the profile
    // selector shows indistinguishable entries.
    const trimmed = newName.trim();
    if (!trimmed) return false;
    const capped = trimmed.slice(0, 64);
    const lower = capped.toLowerCase();
    const collision = this.state.profiles.some(
      (p) => p.id !== profileId && p.name.trim().toLowerCase() === lower
    );
    if (collision) return false;
    row.name = capped;
    await this.persistState();
    return true;
  }

  /** После удаления seed/ключей на устройстве — сброс кэша и состояния профилей. */
  async clearForWalletWipe(): Promise<void> {
    // v4.32.187 (Round-17 #2): also drop any live-location sessions so
    // their timers don't keep firing after wipe.
    try {
      const { stopAllLiveLocSessions } = await import('../social/liveLocationService');
      stopAllLiveLocSessions();
    } catch { /* ignore */ }
    try {
      await SecureStore.deleteItemAsync(PROFILES_STATE_KEY);
    } catch {
      /* ignore */
    }
    this.state = null;
    this.mnemonicCache = null;
    this.initPromise = null;
    this.initialized = false;
    this.invalidateProfileCache();
  }

  async deleteProfile(profileId: number): Promise<boolean> {
    await this.init();
    if (!this.state || !this.mnemonicCache) return false;
    if (this.state.profiles.length <= 1) {
      throw new Error('Нельзя удалить единственный профиль');
    }
    const idx = this.state.profiles.findIndex((p) => p.id === profileId);
    if (idx === -1) return false;
    // v4.32.49: если удаляем активный профиль — сначала переключаемся на
    // другой, ЗАТЕМ чистим данные. Иначе на момент cleanup ctx feedService
    // ещё указывает на удаляемую БД → возможна гонка SQLite lock при
    // deleteDatabaseAsync vs активный query из UI.
    const wasActive = this.state.activeProfileId === profileId;
    // v4.32.292: did удаляемого профиля нужен до splice — по нему лежит
    // черновик публикации, записанный версиями до v4.32.292 (ключ с did, без
    // namespace профиля). Общая уборка сметает `p<id>:%` и такой ключ не
    // заберёт: незаконченный пост пережил бы сам аккаунт.
    let removedDid: string | null = null;
    try {
      const removed = this.state.profiles[idx];
      const removedPair = deriveKeyPairFromMnemonicForProfile(this.mnemonicCache, removed.derivationIndex);
      removedDid = publicKeyToDidKey(removedPair.publicKey);
    } catch (e) {
      log.warn('delete_profile_did_failed', { profileId, err: e instanceof Error ? e.message : String(e) });
    }
    this.state.profiles.splice(idx, 1);
    if (wasActive) {
      this.state.activeProfileId = this.state.profiles[0].id;
    }
    await this.persistState();
    const active = this.rowById(this.state.activeProfileId);
    if (active) {
      const pair = deriveKeyPairFromMnemonicForProfile(this.mnemonicCache, active.derivationIndex);
      await persistKeyPair(pair);
    }
    // v4.32.49: очистка данных удалённого профиля. Если тут упадёт — профиль
    // уже исключён из state, поэтому orphaned данные не приведут к UI-регрессу
    // (ни один код их больше не прочтёт), но место на диске будет занято до
    // следующего ручного cleanup'а / переустановки.
    try {
      const { deleteProfileDataFromLocalDb } = await import('../storage/local');
      await deleteProfileDataFromLocalDb(profileId);
    } catch (e) {
      log.warn('delete_profile_local_cleanup_failed', {
        profileId,
        err: e instanceof Error ? e.message : String(e),
      });
    }
    if (removedDid) {
      try {
        const { deleteLegacyComposeDraft } = await import('../social/composeDraft');
        await deleteLegacyComposeDraft(removedDid);
      } catch (e) {
        log.warn('delete_profile_compose_draft_failed', {
          profileId,
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }
    try {
      const { cleanupFeedStorageForProfile } = await import('../social/feedService');
      await cleanupFeedStorageForProfile(profileId);
    } catch (e) {
      log.warn('delete_profile_feed_cleanup_failed', {
        profileId,
        err: e instanceof Error ? e.message : String(e),
      });
    }
    // v4.32.309: файлы на диске уборка выше не трогает — она про базу.
    try {
      const { deleteDialogBackupForProfile } = await import('../storage/dialogBackup');
      await deleteDialogBackupForProfile(profileId);
    } catch (e) {
      log.warn('delete_profile_backup_cleanup_failed', {
        profileId,
        err: e instanceof Error ? e.message : String(e),
      });
    }
    await this.sweepOrphanedAvatars();
    return true;
  }

  /**
   * Убрать файлы аватаров, за которыми не осталось профиля (v4.32.309).
   *
   * Аватар — это файл в documentDirectory, а запись о нём лежала в kv
   * удалённого профиля и уже стёрта вместе с ним. Поэтому идём от живых:
   * собираем их записи и сносим всё остальное. Заодно подбираются файлы,
   * осиротевшие в версиях до этой, — до сих пор снимок лица удалённого
   * аккаунта оставался на устройстве навсегда.
   *
   * Записи берутся как есть: до v4.32.556 там лежал абсолютный путь, теперь
   * имя файла, и сверяет их sweepAvatarFiles по имени. Сверка по пути была
   * ошибкой — путь прошлой установки не совпадает ни с одним файлом на диске,
   * и уборка сносила аватары живых профилей после каждого обновления.
   *
   * Если хоть один путь прочитать не удалось, не удаляем ничего: неполный
   * список «оставить» здесь неотличим от «этих аватаров больше нет», и уборка
   * снесла бы аватар живого профиля.
   */
  private async sweepOrphanedAvatars(): Promise<void> {
    try {
      const { kvGetSecretScoped, kvGetSecret } = await import('../storage/local');
      const { sweepAvatarFiles } = await import('../media/avatarFiles');
      const keep: (string | null)[] = [];
      for (const p of this.state?.profiles ?? []) {
        keep.push(await kvGetSecretScoped(p.id, 'user_avatar_uri'));
        // Общая запись до v4.32.288 принадлежит первому профилю и до его
        // первого захода в карточку так и лежит неперенесённой.
        if (p.id === 1) keep.push(await kvGetSecret('user_avatar_uri'));
      }
      await sweepAvatarFiles(keep);
    } catch (e) {
      log.warn('delete_profile_avatar_sweep_failed', {
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

export const profileManager = new ProfileManager();
