import { publicKeyHash4 } from '../crypto/keyManager';
import { isPubKeyB64, publicKeyFromB64 } from '../crypto/pubKeyFormat';
import {
  kvDelete,
  kvGetSecret,
  kvGetSecretUpgrading,
  kvSetSecret,
  notifyChatStorageChanged,
} from '../storage/local';
import { BLOCKED_KEY_BASE, legacySuffixBlockedKey, profileScopedKey } from '../storage/kvKeys';
import { log } from '../logger';

/**
 * v4.32.176: ключ scoped по profileId, чтобы блок-листы разных аккаунтов
 * (multi-profile) не текли друг к другу.
 *
 * v4.32.281: префикс профиля вместо суффикса. Суффикс `_p2` не попадал под
 * общее правило `p<id>:` — и удаление профиля (DELETE FROM kv WHERE k LIKE
 * 'p<id>:%') блок-лист не уносило. Он переживал сам аккаунт и доставался
 * следующему профилю с тем же номером: человек, которого никто в этом
 * аккаунте не блокировал, оставался заблокированным без всякого следа в
 * интерфейсе.
 *
 * v4.32.306: значение — шифртекст (kvSetSecret). Кого человек заблокировал, это
 * его решение о конкретных людях — такое же, как заглушённые авторы ленты
 * рядом, а те шифруются с v4.32.293. Лежал же список открытым текстом: набор
 * публичных ключей, каждый из которых сопоставляется с записью в contacts, где
 * имя зашифровано с v4.32.286. Открытая строка блок-листа отвечала на вопрос
 * «с кем человек поссорился» в базе, где само общение спрятано.
 *
 * Записанное до этой версии дошифровывает kvGetSecretUpgrading при первом же
 * чтении: список читают и на старте, и при каждом открытии настроек.
 */
function blockedKey(pid: number): string {
  return profileScopedKey(pid, BLOCKED_KEY_BASE);
}

/** Профили, за которыми старые ключи уже убраны в этом запуске. */
const legacyBlockedSwept = new Set<number>();

const MESSAGE_WINDOW_MS = 60 * 60 * 1000;
const MESSAGE_LIMIT = 50;
/**
 * Отдельный, куда более просторный лимит для служебных конвертов (v4.32.329).
 *
 * Реакция, галочка о прочтении, голос в опросе, закрепление, таймер удаления,
 * обновление профиля и КАЖДЫЙ адресат сообщения в группе уходят тем же
 * sendMessage, что и текст, набранный человеком, — и до этой версии тратили
 * ту же полусотню в час. Считалось это по собеседнику, поэтому час активной
 * переписки в группе на десять человек выбирал лимит на каждого из них
 * разом: после этого личное сообщение любому участнику отклонялось с
 * «Слишком много сообщений этому контакту», хотя человек не написал ему
 * ничего.
 *
 * Ограничение стоит на СВОЁМ устройстве и защищает от собственных циклов и
 * случайных лавин, а не от чужого клиента: тот его просто не исполняет.
 * Значит, служебному потоку нужен свой запас, соразмерный тому, сколько его
 * бывает: рассылка группы на двенадцать человек — это двенадцать конвертов
 * на одно сообщение.
 */
const CONTROL_LIMIT = 500;
const INVITE_WINDOW_MS = 60 * 1000;
const INVITE_LIMIT = 10;

/** Отметки внутри окна: будущие (часы перевели) отбрасываются. */
function withinWindow(timestamps: number[], windowMs: number, now: number): number[] {
  return timestamps.filter((t) => t <= now && now - t < windowMs);
}

/** In-memory windows + persisted block list (contact public key base64). */
export class RateLimiter {
  private readonly inviteCounts = new Map<string, number[]>();
  private readonly messageCounts = new Map<string, number[]>();
  /** Окно служебных конвертов: то же по времени, отдельное по счёту. */
  private readonly controlCounts = new Map<string, number[]>();
  private blocked = new Set<string>();
  /** Максимальное число пиров в памяти — защита от утечки при тысячах BLE-устройств. */
  private static readonly MAX_TRACKED = 2000;

  /**
   * Чтение блок-листа с диска: пока оно не закончилось, список пуст (v4.32.317).
   *
   * Конструктор отрабатывает при загрузке модуля, а чтение уходит в SQLite,
   * которую ещё надо открыть и обновить по схеме — на первом запуске это сотни
   * миллисекунд. Всё это время {@link isBlocked} отвечал «не заблокирован» на
   * кого угодно, и заблокированный контакт, чьё сообщение пришло в это окно,
   * попадал в переписку как ни в чём не бывало. Ссылку на чтение теперь можно
   * дождаться — см. {@link whenReady}.
   */
  private ready: Promise<void>;

  /**
   * Чтение сорвалось: список в памяти пуст и заведомо неверен (v4.32.498).
   *
   * Прежде сбой только писался в журнал. `ready` при этом успешно
   * резолвился, `blocked` оставался пустым множеством, и все дальнейшие
   * {@link isBlocked} отвечали «не заблокирован» — навсегда, повтора чтения
   * не было нигде. Достаточно одной неудачи (база занята соседним запросом,
   * ключ шифрования ещё не поднят при переключении профиля), чтобы
   * заблокированный контакт снова дошёл до переписки и звонков. Признака
   * сбоя человек при этом не видит.
   */
  private loadFailed = false;

  /** Идущий повтор — один на всех, кто пришёл в одно и то же окно. */
  private reloading: Promise<void> | null = null;

  constructor() {
    this.ready = this.loadBlocked();
  }

  /** Дождаться, пока блок-лист поднят с диска. Никогда не отклоняется. */
  async whenReady(): Promise<void> {
    await this.ready;
    if (this.loadFailed) await this.retryLoad();
  }

  /**
   * Повторить сорвавшееся чтение. Не отклоняется: неудачный повтор просто
   * оставляет отметку на месте, и следующий обратившийся попробует снова.
   */
  private retryLoad(): Promise<void> {
    const running = this.reloading;
    if (running) return running;
    const again = this.loadBlocked().finally(() => {
      if (this.reloading === again) this.reloading = null;
    });
    this.reloading = again;
    this.ready = again;
    return again;
  }

  /**
   * Удалить из Map записи, у которых все timestamps вышли за окно наблюдения.
   * Вызывается перед каждой проверкой, чтобы не копить мёртвые записи.
   *
   * `limit` — порог, после которого пир считается исчерпавшим лимит; такие
   * записи выбывают последними, см. ниже.
   */
  private static evictStale(
    map: Map<string, number[]>,
    windowMs: number,
    limit: number
  ): void {
    const now = Date.now();
    // v4.32.194 (Round-24 #5): drop future timestamps (clock rolled back) —
    // `now - t < windowMs` is ALSO true for negative values, so a ts from the
    // future would pin the user as rate-limited until wall-clock caught up.
    for (const [key, ts] of map) {
      const fresh = ts.filter((t) => t <= now + 60_000 && now - t < windowMs);
      if (fresh.length === 0) {
        map.delete(key);
      } else {
        map.set(key, fresh);
      }
    }
    // Потолок на число отслеживаемых пиров.
    //
    // v4.32.317: раньше перебор шёл в порядке ДОБАВЛЕНИЯ — первым вылетал пир,
    // замеченный раньше остальных. Забыть счётчик того, кто уже упёрся в лимит,
    // значит снять с него лимит: следующее сообщение снова первое из пятидесяти.
    // А место в таблице покупается дёшево — достаточно привести с собой две
    // тысячи новых ключей, и самые давние записи вытесняются. Своей же записью
    // среди них.
    //
    // Теперь порядок выбывания такой: сначала те, кто лимит не выбрал (терять у
    // них нечего — счётчик неполный), внутри группы — кто дольше молчит.
    // Записи на лимите уходят последними и только если места не хватает совсем.
    // Последняя отметка в списке самая свежая: отметки складываются по
    // возрастанию, а фильтр выше порядок сохраняет.
    if (map.size > RateLimiter.MAX_TRACKED) {
      const excess = map.size - RateLimiter.MAX_TRACKED;
      const order = [...map.entries()]
        .map(([key, ts]) => ({
          key,
          atLimit: ts.length >= limit,
          last: ts[ts.length - 1] ?? 0,
        }))
        .sort((a, b) => (a.atLimit === b.atLimit ? a.last - b.last : a.atLimit ? 1 : -1));
      for (let i = 0; i < excess; i++) map.delete(order[i].key);
    }
  }

  private async currentPid(): Promise<number> {
    try {
      const { profileManager } = await import('../identity/profileManager');
      return profileManager.getActiveProfile()?.id ?? 1;
    } catch {
      return 1;
    }
  }

  private async loadBlocked(): Promise<void> {
    try {
      await this.loadBlockedOnce();
      this.loadFailed = false;
    } catch (e) {
      this.loadFailed = true;
      log.warn('rate_limiter_block_load_failed', {
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private async loadBlockedOnce(): Promise<void> {
    const pid = await this.currentPid();
    let raw = await kvGetSecretUpgrading(blockedKey(pid));
    if (!raw) {
      // Миграция со старых имён — один раз, с удалением исходного ключа.
      // Без удаления «разовая» миграция повторялась бы у каждого следующего
      // профиля: второй аккаунт на том же устройстве поднимал бы чужой
      // блок-лист как свой (та же ошибка, что в v4.32.277 с журналом
      // звонков). Глобальный ключ наследует только первый профиль — он
      // писался тогда, когда профиль был один, и это был профиль 1.
      const suffixKey = legacySuffixBlockedKey(pid);
      const legacy =
        (await kvGetSecret(suffixKey)) ?? (pid === 1 ? await kvGetSecret(BLOCKED_KEY_BASE) : null);
      let copied = true;
      if (legacy) {
        raw = legacy;
        // v4.32.293: не легла копия — старые ключи не трогаем и в память
        // список всё равно поднимаем. Иначе разблокировались бы все разом,
        // причём безвозвратно: исходную запись мы бы уже стёрли.
        copied = await kvSetSecret(blockedKey(pid), legacy);
        if (!copied) log.warn('rate_limiter_block_migrate_failed', { pid });
      }
      // Уборка один раз за запуск: у большинства блок-лист пуст, и без этой
      // отметки два DELETE уходили бы в базу при каждом открытии настроек.
      if (copied && !legacyBlockedSwept.has(pid)) {
        legacyBlockedSwept.add(pid);
        await kvDelete(suffixKey);
        if (pid === 1) await kvDelete(BLOCKED_KEY_BASE);
      }
    }
    if (!raw) { this.blocked = new Set(); return; }
    const arr = JSON.parse(raw) as unknown;
    // v4.32.317: не массив — значит списка нет, как и при пустой записи.
    // Прежде такое значение уходило в исключение ниже (`arr.filter` не
    // функция) и в журнал как сбой чтения — хотя читать просто нечего.
    if (!Array.isArray(arr)) { this.blocked = new Set(); return; }
    // v4.32.187 (Round-17 #8): filter persisted list to valid base64
    // pubkeys (32 bytes → 44 chars padded). Guards against corrupted disk
    // or future migration writing garbage — otherwise isBlocked returns
    // wrong answers and getBlockedPubKeys leaks junk into Settings UI.
    // v4.32.368: проверка формы общая (crypto/pubKeyFormat) — длины мало,
    // под неё подходили и 43 управляющих символа.
    this.blocked = new Set(arr.filter(isPubKeyB64));
  }

  /**
   * Сбросить in-memory state при wipe/profile switch.
   *
   * Чистятся ВСЕ окна: ключуются они публичным ключом собеседника, а не
   * профилем, и один и тот же контакт может быть в обоих аккаунтах. Что
   * израсходовано под одной личностью, не должно ограничивать другую.
   */
  async resetForProfileSwitch(): Promise<void> {
    this.blocked = new Set();
    // v4.32.498: повтор от прошлой личности до новой не относится.
    this.reloading = null;
    this.inviteCounts.clear();
    this.messageCounts.clear();
    // v4.32.497: окно служебных конвертов забывали. Общий с прошлым аккаунтом
    // контакт начинал в новом уже с израсходованным запасом — квитанции о
    // прочтении и «печатает» до него не доходили с первого же сообщения.
    this.controlCounts.clear();
    this.ready = this.loadBlocked();
    await this.ready;
  }

  /** True if this contact pubkey (base64) is blocked. */
  isBlocked(peerPubKeyB64: string): boolean {
    // v4.32.498: этот ответ уже не исправить — список не поднят. Но повтор
    // запускается прямо отсюда, и следующий вопрос получит верный ответ.
    // Спрашивают чаще всего из мест, где `whenReady` не дождёшься: приём
    // звонка, mesh-фильтр, ворота отправки.
    if (this.loadFailed) void this.retryLoad();
    return this.blocked.has(peerPubKeyB64);
  }

  private isBlockedInviteHash(senderHashHex: string): boolean {
    for (const pubB64 of this.blocked) {
      // v4.32.427: try/catch был мёртвым — Buffer.from не бросает. Отсев
      // негодных строк даёт проверка длины и алфавита, а не отсутствие
      // исключения: хэш от 31 байта совпал бы с хэшем от 31 байта.
      const pub = publicKeyFromB64(pubB64);
      if (!pub) continue;
      if (Buffer.from(publicKeyHash4(pub)).toString('hex') === senderHashHex) return true;
    }
    return false;
  }

  async blockContact(peerPubKeyB64: string): Promise<void> {
    // v4.32.187 (Round-17 #8): reject garbage shapes at the entry point so
    // we never persist invalid strings that later leak through
    // getBlockedPubKeys / Settings UI.
    if (
      typeof peerPubKeyB64 !== 'string' ||
      peerPubKeyB64.length < 43 ||
      peerPubKeyB64.length > 48
    ) {
      log.warn('rate_limiter_block_invalid_shape', { len: peerPubKeyB64?.length ?? -1 });
      return;
    }
    this.blocked.add(peerPubKeyB64);
    this.inviteCounts.delete(peerPubKeyB64);
    this.messageCounts.delete(peerPubKeyB64);
    const pid = await this.currentPid();
    await this.persistBlocked(pid);
    notifyChatStorageChanged();
  }

  async unblockContact(peerPubKeyB64: string): Promise<void> {
    this.blocked.delete(peerPubKeyB64);
    const pid = await this.currentPid();
    await this.persistBlocked(pid);
    notifyChatStorageChanged();
  }

  /**
   * Записать список. Провал шифрования не откатываем: в памяти список уже
   * изменён, и блокировка действует до перезапуска — потерять её на диске
   * заметнее, чем не применить вовсе, но применить и промолчать хуже всего.
   */
  private async persistBlocked(pid: number): Promise<void> {
    if (!(await kvSetSecret(blockedKey(pid), JSON.stringify([...this.blocked])))) {
      log.warn('rate_limiter_block_save_failed', { pid, size: this.blocked.size });
    }
  }

  /**
   * Список для настроек.
   *
   * v4.32.317: отдаёт то, что в памяти, а не перечитывает диск. Перечитывание
   * отменяло блокировку, которую не удалось записать: рядом, в
   * {@link persistBlocked}, сказано, что при сбое записи блокировка действует
   * хотя бы до перезапуска, — а открытие настроек её тихо снимало, потому что
   * на диске её нет. Диск и так авторитетен ровно в двух местах: при первом
   * чтении и при смене профиля, и оба явные.
   */
  async getBlockedPubKeys(): Promise<string[]> {
    await this.ready;
    return [...this.blocked];
  }

  canSendInvite(senderHashHex: string): boolean {
    if (this.isBlockedInviteHash(senderHashHex)) return false;
    RateLimiter.evictStale(this.inviteCounts, INVITE_WINDOW_MS, INVITE_LIMIT);
    const now = Date.now();
    const recent = withinWindow(this.inviteCounts.get(senderHashHex) ?? [], INVITE_WINDOW_MS, now);
    if (recent.length >= INVITE_LIMIT) {
      return false;
    }
    recent.push(now);
    this.inviteCounts.set(senderHashHex, recent);
    return true;
  }

  canSendMessage(contactPubB64: string): boolean {
    if (this.blocked.has(contactPubB64)) return false;
    RateLimiter.evictStale(this.messageCounts, MESSAGE_WINDOW_MS, MESSAGE_LIMIT);
    const now = Date.now();
    const recent = withinWindow(this.messageCounts.get(contactPubB64) ?? [], MESSAGE_WINDOW_MS, now);
    if (recent.length >= MESSAGE_LIMIT) {
      return false;
    }
    recent.push(now);
    this.messageCounts.set(contactPubB64, recent);
    return true;
  }

  /**
   * Часовой лимит на этого собеседника уже выбран? (v4.32.319)
   *
   * В отличие от {@link canSendMessage} ничего не расходует: это вопрос, а не
   * попытка. Нужен там, где отказ значит «отложить и повторить», а не
   * «сообщение потеряно»: спросить canSendMessage «можно ли» нельзя — сам
   * вопрос забирает одну из пятидесяти.
   */
  /**
   * Разрешить служебный конверт этому собеседнику. Тратит из отдельного
   * запаса (см. CONTROL_LIMIT) — человеческие сообщения он не задевает.
   *
   * Блокировка действует и здесь: заблокированному не уходит ничего, включая
   * галочку о прочтении и обновление профиля.
   */
  canSendControl(contactPubB64: string): boolean {
    if (this.blocked.has(contactPubB64)) return false;
    RateLimiter.evictStale(this.controlCounts, MESSAGE_WINDOW_MS, CONTROL_LIMIT);
    const now = Date.now();
    const recent = withinWindow(this.controlCounts.get(contactPubB64) ?? [], MESSAGE_WINDOW_MS, now);
    if (recent.length >= CONTROL_LIMIT) {
      return false;
    }
    recent.push(now);
    this.controlCounts.set(contactPubB64, recent);
    return true;
  }

  messageLimitReached(contactPubB64: string): boolean {
    const now = Date.now();
    const recent = withinWindow(this.messageCounts.get(contactPubB64) ?? [], MESSAGE_WINDOW_MS, now);
    return recent.length >= MESSAGE_LIMIT;
  }
}

export const rateLimiter = new RateLimiter();
