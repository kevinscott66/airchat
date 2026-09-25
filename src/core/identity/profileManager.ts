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

/**
 * Что осталось на устройстве от профиля, которого удалили (v4.32.741).
 *
 * Обе эти уборки идут «от живых»: собирают файлы, принадлежащие оставшимся
 * профилям, и сносят всё прочее. Работать до вычёркивания строки они не умеют,
 * поэтому их отказ удаление уже не отменяет — но и молчать о нём нельзя: на
 * устройстве остаётся снимок лица и копии историй удалённого аккаунта.
 */
export type ProfileLeftover = 'avatars' | 'albums' | 'row';

/**
 * Исход удаления профиля (v4.32.741). Прежний `boolean` сводил к одному `false`
 * «такой строки нет» и «нечего удалять», а успех говорил только о том, что
 * строка вычеркнута, — про данные он не знал ничего и сообщал `true` даже
 * тогда, когда на устройстве оставалась вся переписка.
 */
export type ProfileDeletion =
  | { removed: true; leftovers: ProfileLeftover[] }
  | { removed: false; reason: 'not_found' }
  | { removed: false; reason: 'cleanup_failed'; err: string }
  | { removed: false; reason: 'switch_failed'; err: string };

/**
 * Исход переименования профиля (v4.32.743).
 *
 * Прежний `boolean` сводил к одному `false` четыре разные беды: менеджер не
 * поднялся, строки с таким номером нет, имя пустое, имя уже носит соседний
 * профиль. Человеку они говорят противоположное — одно имя надо дозаполнить,
 * другое поменять, а третье сохранить ровно тем же самым ещё раз, — и экран,
 * получивший одно «нет», выбирал одну фразу на все случаи.
 */
export type ProfileRename =
  | { renamed: true }
  | { renamed: false; reason: 'not_found' | 'empty' | 'name_taken' }
  | { renamed: false; reason: 'save_failed'; err: string };

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
  /**
   * Снимок профилей на диске принят не целиком (v4.32.704).
   *
   * Разбор снимка отбрасывает строки, которые не прошли проверку, и молча
   * продолжает работу с остатком: испорченная строка не вправе подсунуть чужую
   * ключевую пару. Но список профилей после этого КОРОЧЕ настоящего, а по нему
   * решают, чьи вложения на устройстве считать брошенными. Отметка держится до
   * конца работы приложения: строки уже не восстановить, и делать вид, что
   * список полон, нельзя.
   */
  private snapshotIncomplete = false;
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
            this.snapshotIncomplete = true;
            this.state = { ...this.state, profiles: clean };
          }
        }
        }
        }
      } catch {
        this.state = null;
      }
    }

    // v4.32.704: снимок на диске был, а состояние из него не собралось — размер,
    // разбор, версия или все строки сразу. Дальше создастся один профиль по
    // умолчанию, и его номер ничего не говорит о том, сколько их было на самом
    // деле.
    if (raw && !this.state) this.snapshotIncomplete = true;

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
    // v4.32.731: снимок, который не удалось прочитать, не затирается профилем
    // по умолчанию.
    //
    // Раньше запись шла безусловно, и единственная запись о том, сколько
    // профилей было, как они назывались и какой был активен, стиралась своей
    // же неудачей чтения — навсегда. Причины у неудачи разные: снимок пришёл
    // от более новой сборки (`v !== 1` — это откат установки, а не порча),
    // Keystore вернул мусор, значение не разобралось. В первом случае снимок
    // целый и его прочтёт та же новая сборка, если поставить её обратно, — но
    // только если мы его не затёрли.
    //
    // Профиль по умолчанию остаётся в памяти: приложение работает, ключ на
    // устройстве приведён к нему (выше), зеркало номера обновлено — не
    // записан только сам снимок. Любая осознанная правка списка профилей
    // (завести, переименовать, переключить, удалить) пишет его как обычно:
    // к этому моменту человек уже действовал, и хранить прежнее незачем.
    if (this.snapshotIncomplete) log.warn('profile_manager_default_kept_in_memory');
    await this.persistState({ keepDiskSnapshot: this.snapshotIncomplete });
  }

  /**
   * @param keepDiskSnapshot не трогать запись на диске — состояние живёт
   *   только в памяти. Единственный случай: снимок на диске есть, но принять
   *   его не вышло (см. migrateOrCreateDefault). Зеркало номера при этом
   *   обновляется: приложение действительно работает под этим профилем, и
   *   фоновый обработчик должен знать, чьи настройки читать.
   */
  private async persistState(opts?: { keepDiskSnapshot?: boolean }): Promise<void> {
    if (!this.state) return;
    if (!opts?.keepDiskSnapshot) {
      await SecureStore.setItemAsync(PROFILES_STATE_KEY, JSON.stringify(this.state));
    }
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
   * Те же номера, но со словом о полноте списка (v4.32.704).
   *
   * `complete: false` значит «на диске лежал снимок, и принять его целиком не
   * вышло». Тем, кто по списку профилей решает судьбу данных — чьи вложения
   * брошены, кому нести общий секрет, — короткий список молча выдавать нельзя.
   */
  getProfileIdsComplete(): { ids: number[]; complete: boolean } {
    return { ids: this.getProfileIds(), complete: !this.snapshotIncomplete };
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
    const prevActiveId = this.state.activeProfileId;
    const prevLastUsed = row.lastUsed;
    this.state.activeProfileId = profileId;
    row.lastUsed = Date.now();
    this.invalidateProfileCache();
    try {
      await this.persistState();
    } catch (e) {
      // v4.32.849: запись состояния отказывает тем же концом, что и запись
      // ключа ниже, — и до v4.32.849 её звали без try. SecureStore на iOS
      // отвечает отказом при заблокированном устройстве (фоновое
      // переключение), на Android — при сорвавшемся keystore; место на диске
      // кончается там и там. Исключение улетало вызывающему, а в памяти
      // оставался НОВЫЙ профиль при СТАРОМ снимке на диске и старом ключе:
      // getActiveIdentity отвечал новой личностью, подписывалось прежней, и
      // всё написанное до перезапуска ложилось под чужим owner_profile_id и
      // чужим префиксом `p<id>:` — то есть в переписку другого аккаунта.
      // Откат тот же, что у ключа: вернуть номер и отвечать null.
      log.warn('switch_profile_persist_failed', {
        profileId,
        err: e instanceof Error ? e.message : String(e),
      });
      this.state.activeProfileId = prevActiveId;
      row.lastUsed = prevLastUsed;
      this.invalidateProfileCache();
      return null;
    }
    const pair = deriveKeyPairFromMnemonicForProfile(this.mnemonicCache, row.derivationIndex);
    if (!isSame) {
      try {
        await persistKeyPair(pair);
      } catch (e) {
        // v4.32.637: ключ устройства не лёг — откатываем и номер профиля.
        // Состояние к этому моменту уже записано, и без отката устройство
        // остаётся с новым профилем в state и СТАРЫМ ключом в SecureStore, а
        // вызывающий получает исключение, которого не ждёт: onIdentityUpdated
        // он не позовёт, все службы продолжат работать под прежней личностью,
        // тогда как getActiveIdentity ответит новой. Это ровно то расхождение
        // «кто я», которое v4.32.480 закрыла внутри этого метода — здесь оно
        // возвращалось, только уже на всё приложение. null единственный
        // вызывающий показать умеет.
        log.warn('switch_profile_key_persist_failed', {
          profileId,
          err: e instanceof Error ? e.message : String(e),
        });
        this.state.activeProfileId = prevActiveId;
        row.lastUsed = prevLastUsed;
        this.invalidateProfileCache();
        try {
          await this.persistState();
        } catch (e2) {
          // Откат не записался: в памяти прежний профиль, на диске новый.
          // Следующий запуск поднимет записанный и приведёт к нему ключ сам
          // (App.tsx, applyActiveKeyPairToDevice) — расхождение не переживёт
          // перезапуска, а сделать отсюда больше нечего.
          log.warn('switch_profile_rollback_failed', {
            profileId,
            err: e2 instanceof Error ? e2.message : String(e2),
          });
        }
        this.invalidateProfileCache();
        return null;
      }
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
      // v4.32.952: текст кириллический, а значит userErrorText пускает его
      // на экран как есть. «Seed-фраза» — слово разработчика; в доме это
      // «секретные слова», и говорит их весь онбординг.
      throw new Error('На устройстве нет секретных слов.');
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
    const prevActiveId = this.state.activeProfileId;
    this.state.profiles.push(row);
    this.state.activeProfileId = id;
    try {
      await this.persistState();
    } catch (e) {
      // v4.32.849: без записи профиля нет — но до v4.32.849 он оставался в
      // памяти и объявленным активным. Человеку показывали «Ошибка создания»,
      // а приложение до перезапуска работало под номером, которого на диске
      // не существует: записанное уходило в namespace `p<id>:` и под
      // owner_profile_id несуществующего профиля, а уборка сирот
      // (sweepOrphanedAvatars, sweepOrphanAlbumFiles) сносила его файлы как
      // ничьи. Откат — тот же, что при отказе ключа ниже.
      const at = this.state.profiles.indexOf(row);
      if (at !== -1) this.state.profiles.splice(at, 1);
      this.state.activeProfileId = prevActiveId;
      this.invalidateProfileCache();
      log.warn('add_profile_persist_failed', {
        err: e instanceof Error ? e.message : String(e),
      });
      throw new Error('Не удалось сохранить список профилей');
    }
    const pair = deriveKeyPairFromMnemonicForProfile(this.mnemonicCache, derivationIndex);
    try {
      await persistKeyPair(pair);
    } catch (e) {
      // v4.32.637: не лёг ключ — профиля не будет. Иначе человеку говорят
      // «Ошибка создания» (единственный вызывающий показывает именно это), а
      // профиль при этом создан и объявлен активным, только под ключом
      // прежнего: сообщения ушли бы подписанными не тем аккаунтом, который
      // показан в шапке. Счётчики nextProfileId/nextDerivationIndex обратно не
      // откручиваем — под этим номером ничего не писалось, а сжечь номер
      // дешевле, чем рискнуть выдать его дважды.
      const at = this.state.profiles.indexOf(row);
      if (at !== -1) this.state.profiles.splice(at, 1);
      this.state.activeProfileId = prevActiveId;
      this.invalidateProfileCache();
      try {
        await this.persistState();
      } catch (e2) {
        log.warn('add_profile_rollback_failed', {
          err: e2 instanceof Error ? e2.message : String(e2),
        });
      }
      this.invalidateProfileCache();
      throw e;
    }
    return toProfile(row, pair);
  }

  /**
   * Переименовать профиль.
   *
   * v4.32.743: отвечает исходом, а не «да/нет», — см. `ProfileRename`.
   *
   * И запись состояния больше не оставляет менеджер с именем, которого на
   * диске нет. Имя в памяти менялось ДО `persistState`, а его отказ уходил
   * наверх исключением: список профилей уже показывал новое имя, экран
   * говорил про ошибку — и до ближайшего запуска приложения оба были правы,
   * каждый о своём. После запуска возвращалось прежнее имя, и о том, что
   * переименование не состоялось, не оставалось никакого следа.
   */
  async renameProfile(profileId: number, newName: string): Promise<ProfileRename> {
    await this.init();
    // Строки нет и не поднялась — для вызывающего это одно и то же: имени,
    // которое просили сменить, в списке профилей не существует.
    if (!this.state) return { renamed: false, reason: 'not_found' };
    const row = this.rowById(profileId);
    if (!row) return { renamed: false, reason: 'not_found' };
    // v4.32.187 (Round-17 #9): mirror `addProfile` validation — empty name
    // silently keeps the old name (expected), but duplicates (regardless of
    // case) and multi-KB paste should be rejected, otherwise the profile
    // selector shows indistinguishable entries.
    const trimmed = newName.trim();
    if (!trimmed) return { renamed: false, reason: 'empty' };
    const capped = trimmed.slice(0, 64);
    const lower = capped.toLowerCase();
    const collision = this.state.profiles.some(
      (p) => p.id !== profileId && p.name.trim().toLowerCase() === lower
    );
    if (collision) return { renamed: false, reason: 'name_taken' };
    const previous = row.name;
    row.name = capped;
    try {
      await this.persistState();
    } catch (e) {
      row.name = previous;
      const err = e instanceof Error ? e.message : String(e);
      log.warn('rename_profile_persist_failed', { profileId, err });
      return { renamed: false, reason: 'save_failed', err };
    }
    // Снимок активного профиля сбрасывать не нужно: `persistState` делает это
    // сам, и новое имя видно под таб-баром сразу, а не через пять секунд.
    return { renamed: true };
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
    this.snapshotIncomplete = false;
    this.mnemonicCache = null;
    this.initPromise = null;
    this.initialized = false;
    this.invalidateProfileCache();
  }

  /**
   * Удалить профиль вместе со всеми его данными на устройстве (v4.32.741).
   *
   * Порядок здесь и есть суть. До этой версии строка профиля вычёркивалась и
   * записывалась на диск ПЕРВОЙ, а семь уборок шли следом, и каждая была
   * обёрнута в `try/catch { log.warn }`. Функция после этого возвращала `true`
   * безусловно, а экран говорил «Профиль удалён».
   *
   * Отказ любой из уборок — заблокированная база (SQLite lock от живого
   * запроса UI), нехватка места, сбой файловой системы — означал, что вся
   * переписка, копия диалогов, лента, файлы историй и снимок лица остаются
   * лежать на устройстве. Узнать об этом было нельзя ничем: из списка профиль
   * исчез, зайти в него нечем, повторить удаление невозможно (строки уже нет,
   * `idx === -1`), фоновой уборки для таких остатков в приложении не
   * существует. Удаляют профиль ровно затем, чтобы этого на телефоне не
   * осталось, — и телефон отдают, продают, теряют.
   *
   * Теперь уборки, бьющие по номеру профиля, идут ДО вычёркивания строки и
   * гасят удаление: не убралось — профиль остаётся в списке, человеку сказано,
   * и повторить можно. Две оставшиеся — уборки файлов «от живых» (аватары,
   * копии историй из альбомов) — работают только после того, как строки не
   * стало, поэтому идут следом и удаление уже не отменяют; о них сообщается
   * отдельно.
   *
   * Освобождение `@имени` в общем реестре остаётся необязательным: оно ходит в
   * сеть, а профили удаляют и в самолёте. Его собственная беда — что отказ не
   * переживает выход из функции — лечится не здесь.
   */
  async deleteProfile(profileId: number): Promise<ProfileDeletion> {
    await this.init();
    if (!this.state || !this.mnemonicCache) return { removed: false, reason: 'not_found' };
    if (this.state.profiles.length <= 1) {
      throw new Error('Нельзя удалить единственный профиль');
    }
    const idx = this.state.profiles.findIndex((p) => p.id === profileId);
    if (idx === -1) return { removed: false, reason: 'not_found' };
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
    // v4.32.741: активность уводится отдельно от вычёркивания строки. Причина
    // прежняя (v4.32.49): пока профиль активен, feedService держит его базу, и
    // уборка упрётся в SQLite lock. Но строка остаётся на месте до тех пор,
    // пока данные не убраны, — иначе отменить неудавшееся удаление нечем.
    if (wasActive) {
      const next = this.state.profiles.find((p) => p.id !== profileId);
      if (!next) return { removed: false, reason: 'not_found' };
      // v4.32.849: увод активности — единственный шаг удаления, который ещё
      // можно отменить целиком: ниже не стёрто ничего. Раньше отказ записи
      // улетал исключением, и человек читал «Не удалось удалить профиль»,
      // оставаясь при этом ПОД ДРУГИМ аккаунтом: номер в памяти уже уехал, а
      // invalidateProfileCache сюда даже не доходил. Дальше он продолжал
      // переписку, не заметив подмены.
      const prevActiveId = this.state.activeProfileId;
      this.state.activeProfileId = next.id;
      try {
        await this.persistState();
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        log.warn('delete_profile_switch_failed', { profileId, err });
        this.state.activeProfileId = prevActiveId;
        this.invalidateProfileCache();
        return { removed: false, reason: 'switch_failed', err };
      }
    }
    const active = this.rowById(this.state.activeProfileId);
    if (active) {
      // v4.32.637: сюда нельзя ронять весь deleteProfile. Ниже идут уборки —
      // база, лента, копия диалогов, файлы аватаров и историй, — и исключение
      // отсюда пропускало их все разом. Ключ же приведёт к активному профилю
      // следующий запуск (App.tsx, applyActiveKeyPairToDevice), как и любое
      // другое расхождение.
      try {
        const pair = deriveKeyPairFromMnemonicForProfile(this.mnemonicCache, active.derivationIndex);
        await persistKeyPair(pair);
      } catch (e) {
        log.warn('delete_profile_key_persist_failed', {
          profileId,
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }
    // v4.32.731: отпустить `@имя` в общем реестре. Вызова не было вовсе —
    // функция releaseOwnUsernameGlobally писалась ровно для этого места и
    // стояла ненужной. Имя удалённого профиля оставалось занятым навсегда и
    // продолжало указывать на ключ, которым больше никто не пользуется: чужие
    // сообщения на `@имя` уходили в никуда, а вернуть имя себе было нельзя.
    // Делается до уборки базы: реестру нужен только номер профиля, а порядок
    // важен для памяти о публикации, которую эта же функция сбрасывает.
    try {
      const { releaseOwnUsernameGlobally } = await import('./usernameRegistry');
      await releaseOwnUsernameGlobally(profileId);
    } catch (e) {
      log.warn('delete_profile_username_release_failed', {
        profileId,
        err: e instanceof Error ? e.message : String(e),
      });
    }
    // v4.32.857: отложенные напоминания этой личности. Живут они не в базе, а
    // в системе, и уборка базы до них не достаёт: напоминание, поставленное
    // «через неделю», срабатывало после удаления личности и показывало текст
    // её сообщения. Снимаются только свои — напоминания остальных личностей
    // человек ставил себе сам, и удаление соседней не повод их отменять.
    // Не удалось — только в журнал: удаление личности из-за этого не рушим,
    // а сработавшее напоминание приведёт в приложение, где этой личности уже
    // нет, и покажет нейтральный текст, если он был скрыт при постановке.
    try {
      const { cancelRemindersForProfile } = await import('../../notifications/reminderNotifications');
      await cancelRemindersForProfile(profileId);
    } catch (e) {
      log.warn('delete_profile_reminders_cancel_failed', {
        profileId,
        err: e instanceof Error ? e.message : String(e),
      });
    }
    // v4.32.49: очистка данных удалённого профиля.
    // v4.32.741: и она же — условие удаления. Все четыре уборки бьют по номеру
    // профиля (или по его did), то есть работают, пока строка на месте, и
    // сообщают об отказе: `deleteProfileDataFromLocalDb` и
    // `deleteFeedDbForProfile` умели это и раньше, остальные научились в этой
    // же версии. Не убралось — профиль остаётся в списке целиком, и человек
    // может повторить; повторный проход безвреден, все четыре идемпотентны.
    //
    // Одно исключение внутри уборки ленты оставлено намеренно: неудача обхода
    // kv-вложений там по-прежнему только пишется в журнал (см. её докблок) —
    // байты без поста подберёт сверка сирот на ближайшей привязке личности,
    // так что гасить удаление из-за них значило бы звать человека чинить то,
    // что чинится само. Отказ удаления самого файла базы оттуда доходит сюда.
    try {
      const { deleteProfileDataFromLocalDb } = await import('../storage/local');
      await deleteProfileDataFromLocalDb(profileId);
      if (removedDid) {
        const { deleteLegacyComposeDraft } = await import('../social/composeDraft');
        await deleteLegacyComposeDraft(removedDid);
      }
      const { cleanupFeedStorageForProfile } = await import('../social/feedService');
      await cleanupFeedStorageForProfile(profileId);
      // v4.32.309: файлы на диске уборка базы не трогает.
      const { deleteDialogBackupForProfile } = await import('../storage/dialogBackup');
      await deleteDialogBackupForProfile(profileId);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      log.warn('delete_profile_cleanup_failed', { profileId, err });
      return { removed: false, reason: 'cleanup_failed', err };
    }

    // Данных профиля на устройстве больше нет — теперь можно вычеркнуть строку.
    // Позицию ищем заново: выше был `await`, и хотя список между ними никто не
    // трогает, полагаться на старый номер в массиве незачем.
    const at = this.state.profiles.findIndex((p) => p.id === profileId);
    if (at !== -1) this.state.profiles.splice(at, 1);
    const leftovers: ProfileLeftover[] = [];
    try {
      await this.persistState();
    } catch (e) {
      // v4.32.849: данных профиля на устройстве уже нет, и вернуть строку в
      // список значило бы показать профиль, за которым пусто. Поэтому в
      // памяти его не воскрешаем — но и молчать нельзя: запись на диске
      // осталась прежней, и следующий запуск поднимет строку обратно. Человек
      // увидит пустой профиль, который считал удалённым. Это такой же
      // остаток, как неубранные файлы, и сообщается тем же путём.
      log.warn('delete_profile_row_persist_failed', {
        profileId,
        err: e instanceof Error ? e.message : String(e),
      });
      this.invalidateProfileCache();
      leftovers.push('row');
    }

    // Уборки «от живых»: собирают то, что принадлежит оставшимся профилям, и
    // сносят остальное. Работать до вычёркивания строки они не могут — файлы
    // удаляемого профиля выглядели бы нужными, — поэтому удаление уже не
    // отменяют. Об их отказе человеку говорится отдельно.
    if (!(await this.sweepOrphanedAvatars())) leftovers.push('avatars');
    // v4.32.576: копии историй из альбомов. Строки удалённого профиля ушли
    // вместе с базой, а файлы лежат в общем каталоге, и адресов их больше нет
    // нигде — как и с аватарами до v4.32.309.
    try {
      const { sweepOrphanAlbumFiles } = await import('../social/storyAlbums');
      await sweepOrphanAlbumFiles();
    } catch (e) {
      log.warn('delete_profile_album_sweep_failed', {
        profileId,
        err: e instanceof Error ? e.message : String(e),
      });
      leftovers.push('albums');
    }
    return { removed: true, leftovers };
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
   * Если хоть одну запись прочитать не удалось, не удаляем ничего: неполный
   * список «оставить» здесь неотличим от «этих аватаров больше нет», и уборка
   * снесла бы аватар живого профиля. v4.32.636: за это отвечает
   * collectAvatarsToKeep — строковое чтение, стоявшее здесь, сводило «не
   * открылось» к «записи нет», и правило не действовало ровно тогда, когда
   * было нужно.
   */
  private async sweepOrphanedAvatars(): Promise<boolean> {
    // v4.32.741: список профилей берётся различающей формой. `collectAvatarsToKeep`
    // закрывает нечитаемую ячейку и пустой список, но не третий случай: снимок
    // профилей умеет молча укорачиваться — невалидную строку разбор отбрасывает
    // и поднимает `snapshotIncomplete` (runInitOnce). Урезанный список тут
    // неотличим от «этих аватаров больше нет», и уборка снесла бы лицо живого
    // профиля — ровно то, что запрещает докблок выше. Так же поступают
    // ownProfile, profileSharedKv и сверка сирот ленты.
    const { ids, complete } = this.getProfileIdsComplete();
    if (!complete) {
      log.warn('avatar_sweep_profile_list_incomplete', { ids: ids.length });
      return false;
    }
    try {
      const { collectAvatarsToKeep } = await import('./avatarKeep');
      const { sweepAvatarFiles } = await import('../media/avatarFiles');
      const keep = await collectAvatarsToKeep(ids);
      await sweepAvatarFiles(keep);
      return true;
    } catch (e) {
      log.warn('delete_profile_avatar_sweep_failed', {
        err: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }
}

export const profileManager = new ProfileManager();
