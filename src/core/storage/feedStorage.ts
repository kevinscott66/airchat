/**
 * Локальная лента в отдельной SQLite на профиль (id из profileManager).
 *
 * v4.32.305: содержимое ленты лежит здесь шифртекстом — что именно и почему,
 * см. feedAtRest.ts. Ключ тот же общий DEK, что и у переписки: отдельный
 * ничего бы не добавил, оба файла лежат в одной песочнице и открываются одним
 * секретом из хранилища ключей устройства.
 */
import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import { log } from '../logger';
import { FEED_AT_REST_COLUMNS, parseJsonColumn, parseStringArrayColumn } from './feedAtRest';
import { isSafeSqlIdentifier } from './atRestColumns';
import { mayOverwrite, cellTextOrNull } from './atRestCell';
import { unreadableFromCellState } from './unreadableText';
import {
  AT_REST_PREFIX,
  decryptAtRestNullable,
  encryptAtRestNullable,
  encryptAtRestString,
  getOrCreateDataEncryptionKey,
  readAtRestCell,
} from './localEncryption';

export type FeedCommentRow = {
  id: string;
  postId: string;
  authorDid: string;
  authorName: string | null;
  text: string;
  timestamp: number;
  /** emoji → list of authorDids that reacted */
  reactions?: Record<string, string[]> | null;
  /** v4.32.588: текст комментария есть в базе, но ключ его не открывает. */
  textUnreadable?: boolean;
  /** v4.32.589: имя автора комментария есть в базе, но ключ его не открывает. */
  nameUnreadable?: boolean;
};

export type FeedSyncTombstone = {
  commentId: string;
  postId: string;
  deletedAt: number;
};

export type FeedSyncSnapshot = {
  posts: FeedPostRow[];
  comments: FeedCommentRow[];
  commentTombstones: FeedSyncTombstone[];
};

export type FeedPostRow = {
  id: string;
  authorDid: string;
  authorName: string | null;
  text: string;
  mediaCids: string[] | null;
  timestamp: number;
  read: number;
  cid: string | null;
  /** emoji → list of authorDids that reacted */
  reactions: Record<string, string[]> | null;
  /** Если это репост — CID / id оригинального поста */
  repostOf?: string | null;
  /** Имя автора оригинального поста при репосте */
  repostAuthorName?: string | null;
  /** DID автора оригинального поста */
  repostAuthorDid?: string | null;
  /** 1 — сохранено в закладки */
  bookmarked?: number;
  /** 1 — локально архивировано (скрыто из основной ленты, видно в «Архиве») */
  archived?: number;
  /** Timestamp of last local edit (ms). Null/undefined if never edited. */
  editedAt?: number | null;
  /** v4.32.48: прикреплённые документы. Массив метаданных (base64 хранится в kvStore
   *  под `feed_inline_doc:<postId>:<i>`), чтобы SQLite-строки не раздувались
   *  мегабайтами на каждый SELECT. */
  documents?: FeedDocumentMeta[] | null;
  /** v4.32.587: текст записи есть в базе, но ключ его не открывает. */
  textUnreadable?: boolean;
  /** v4.32.587: список вложений есть в базе, но ключ его не открывает. */
  mediaUnreadable?: boolean;
  /** v4.32.587: список документов есть в базе, но ключ его не открывает. */
  documentsUnreadable?: boolean;
  /** v4.32.589: имя автора есть в базе, но ключ его не открывает. */
  nameUnreadable?: boolean;
  /** v4.32.589: то же про имя автора оригинала у репоста. */
  repostNameUnreadable?: boolean;
};

/** v4.32.48: метаданные документа поста. Без base64 — он живёт в kvStore. */
export type FeedDocumentMeta = {
  name: string;
  mime: string;
  size: number;
};

/** v4.32.68: строка просмотра поста из таблицы feed_post_views. Трекинг реальных
 *  просмотров: каждый получатель при `markFeedPostRead` шлёт feed_view envelope
 *  автору поста (только один раз, флаг в kvStore), автор сохраняет viewer у себя
 *  в БД. Только для СВОИХ постов — чужие посты своих просмотров не трекают. */
export type FeedViewerRow = {
  viewerDid: string;
  viewerName: string | null;
  viewedAt: number;
  /** v4.32.589: имя просмотревшего есть в базе, но ключ его не открывает. */
  nameUnreadable?: boolean;
};

/**
 * Строка таблицы `feed` как её отдаёт SQLite. Раньше этот же набор полей был
 * выписан заново в каждом из четырёх методов, которые достают посты, — и
 * четыре раза же был скопирован разбор JSON-колонок. С v4.32.305 к разбору
 * добавилась расшифровка, и четыре копии стали бы четырьмя местами, где её
 * можно забыть.
 */
type FeedDbRow = {
  id: string;
  author_did: string;
  author_name: string | null;
  text: string | null;
  media_cids: string | null;
  timestamp: number;
  read: number;
  cid: string | null;
  reactions: string | null;
  repost_of: string | null;
  repost_author_name: string | null;
  repost_author_did: string | null;
  bookmarked?: number | null;
  archived?: number | null;
  edited_at: number | null;
  documents: string | null;
};

function toPost(r: FeedDbRow, dek: Uint8Array): FeedPostRow {
  // v4.32.587: читаем состоянием, а не строкой. Столбец, не открывшийся
  // ключом, приходил пустотой, и запись рисовалась карточкой без содержимого
  // — неотличимо от поста из одного снимка. Признак живёт рядом со значением.
  const textCell = readAtRestCell(r.text ?? '', dek);
  const mediaCell = readAtRestCell(r.media_cids, dek);
  const docsCell = readAtRestCell(r.documents, dek);
  // v4.32.589: имя автора — такой же зашифрованный столбец, как текст.
  // Читалось двухсостоянийно, и не открывшееся ключом имя приходило пустой
  // строкой: `?? 'Контакт'` её не ловит, и заголовок становился пустым.
  const nameCell = readAtRestCell(r.author_name, dek);
  const repostNameCell = readAtRestCell(r.repost_author_name ?? null, dek);
  return {
    id: r.id,
    authorDid: r.author_did,
    authorName: cellTextOrNull(nameCell),
    text: cellTextOrNull(textCell) ?? '',
    mediaCids: parseStringArrayColumn(cellTextOrNull(mediaCell)),
    timestamp: r.timestamp,
    read: r.read,
    cid: r.cid,
    reactions: parseJsonColumn<Record<string, string[]>>(decryptAtRestNullable(r.reactions, dek)),
    repostOf: r.repost_of ?? null,
    repostAuthorName: cellTextOrNull(repostNameCell),
    repostAuthorDid: r.repost_author_did ?? null,
    bookmarked: r.bookmarked ?? 0,
    archived: r.archived ?? 0,
    editedAt: r.edited_at ?? null,
    documents: parseJsonColumn<FeedDocumentMeta[]>(cellTextOrNull(docsCell)),
    textUnreadable: unreadableFromCellState(textCell.state),
    mediaUnreadable: unreadableFromCellState(mediaCell.state),
    documentsUnreadable: unreadableFromCellState(docsCell.state),
    nameUnreadable: unreadableFromCellState(nameCell.state),
    repostNameUnreadable: unreadableFromCellState(repostNameCell.state),
  };
}

export class FeedStorage {
  private db: SQLite.SQLiteDatabase | null = null;
  private readonly profileId: number;
  private readonly dbName: string;
  /**
   * v4.32.22: мемоизация init-promise. При смене профиля (`setPair` → 4 параллельных
   * useEffect в App.tsx) разные call-sites могли одновременно вызвать `ensureStorage`
   * → `setFeedProfileContext` → `new FeedStorage(pid).init()`. Каждый инстанс открывал
   * БД и гонял 7 ALTER TABLE. Итог: write-lock на 30-50с (виден в логах как
   * `feed_storage_init` 5× в 1с + `js_thread_blocked` 30-50с). Теперь параллельные
   * вызовы `init()` ждут один и тот же Promise.
   */
  private initPromise: Promise<void> | null = null;

  constructor(profileId: number) {
    this.profileId = profileId;
    this.dbName = `airchat_feed_p${profileId}.db`;
  }

  async init(): Promise<void> {
    if (this.db) return;
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

  private async runInitOnce(): Promise<void> {
    try {
      const database = await SQLite.openDatabaseAsync(this.dbName);
      // v4.32.47: PRAGMA'ы до любых DDL. WAL-журнал — crash-resilience и параллельные
      // читатели не блокируют писателя. synchronous=NORMAL — компромисс: почти полная
      // durability при power-cut (WAL rollback от последнего checkpoint) и 2-3× быстрее
      // записи на Android flash storage против FULL.
      try {
        await database.execAsync('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
      } catch (e) {
        log.warn('feed_storage_pragma_failed', { err: e instanceof Error ? e.message : String(e) });
      }
      // v4.32.47: начальный DDL (CREATE TABLE/INDEX) — атомарно в транзакции. Если
      // процесс упал посередине, БД остаётся либо пустая, либо полностью готовая
      // к работе. ALTER TABLE миграции идут отдельно, каждая со своим try/catch,
      // потому что SQLite не позволяет батчить «IF NOT EXISTS COLUMN» — дубликаты
      // должны отловиться per-stmt.
      await database.withTransactionAsync(async () => {
        await database.execAsync(`
          CREATE TABLE IF NOT EXISTS feed (
            id TEXT PRIMARY KEY NOT NULL,
            author_did TEXT NOT NULL,
            author_name TEXT,
            text TEXT,
            media_cids TEXT,
            timestamp INTEGER NOT NULL,
            read INTEGER NOT NULL DEFAULT 0,
            cid TEXT,
            reactions TEXT,
            repost_of TEXT,
            repost_author_name TEXT,
            repost_author_did TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_feed_ts ON feed(timestamp);
          CREATE INDEX IF NOT EXISTS idx_feed_author ON feed(author_did);
          CREATE TABLE IF NOT EXISTS feed_comments (
            id TEXT PRIMARY KEY NOT NULL,
            post_id TEXT NOT NULL,
            author_did TEXT NOT NULL,
            author_name TEXT,
            text TEXT NOT NULL,
            timestamp INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_fc_post ON feed_comments(post_id, timestamp);
          CREATE TABLE IF NOT EXISTS feed_comment_tombstones (
            comment_id TEXT PRIMARY KEY NOT NULL,
            post_id TEXT NOT NULL,
            deleted_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_fct_post ON feed_comment_tombstones(post_id);
          CREATE TABLE IF NOT EXISTS feed_post_tombstones (
            post_id TEXT PRIMARY KEY NOT NULL,
            author_did TEXT NOT NULL,
            deleted_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_fpt_at ON feed_post_tombstones(deleted_at);
          CREATE TABLE IF NOT EXISTS feed_post_views (
            post_id TEXT NOT NULL,
            viewer_did TEXT NOT NULL,
            viewer_name TEXT,
            viewed_at INTEGER NOT NULL,
            PRIMARY KEY (post_id, viewer_did)
          );
          CREATE INDEX IF NOT EXISTS idx_fpv_post ON feed_post_views(post_id);
          CREATE TABLE IF NOT EXISTS feed_meta (
            k TEXT PRIMARY KEY NOT NULL,
            v TEXT NOT NULL
          );
        `);
      });
      // Migrations: add columns to existing databases (вне транзакции — ALTER TABLE
      // на уже существующую колонку выбросит исключение, которое развалит всю tx).
      for (const col of ['reactions TEXT', 'repost_of TEXT', 'repost_author_name TEXT', 'repost_author_did TEXT', 'bookmarked INTEGER NOT NULL DEFAULT 0', 'edited_at INTEGER', 'archived INTEGER NOT NULL DEFAULT 0', 'documents TEXT']) {
        try {
          await database.execAsync(`ALTER TABLE feed ADD COLUMN ${col}`);
        } catch {
          // Column already exists — ignore
        }
      }
      // Migrations: feed_comments reactions column
      try {
        await database.execAsync('ALTER TABLE feed_comments ADD COLUMN reactions TEXT');
      } catch {
        // Column already exists — ignore
      }
      // v4.32.305: разовый перевод уже накопленной ленты в шифртекст. Строго
      // после ALTER TABLE — иначе колонок documents/reactions в старой базе
      // ещё нет и половина списка молча пропустилась бы.
      await this.encryptExistingRowsOnce(database);
      this.db = database;
      log.info('feed_storage_init', { profileId: this.profileId, db: this.dbName });
    } catch (e) {
      log.warn('feed_storage_init_failed', { err: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }

  private async ensureDb(): Promise<SQLite.SQLiteDatabase> {
    if (!this.db) await this.init();
    return this.db!;
  }

  /** Close this profile's connection after checkpointing its WAL. */
  async close(): Promise<void> {
    const database = this.db;
    this.db = null;
    this.initPromise = null;
    if (!database) return;
    try {
      await database.execAsync('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      // The connection can still be closed when checkpoint is unavailable.
    }
    await database.closeAsync();
  }

  /**
   * v4.32.305: колонки, которые в этой базе реально есть. Часть списка
   * добавлялась через ALTER TABLE (documents, reactions у комментариев), и у
   * базы, созданной старой версией и ни разу с тех пор не открывавшейся,
   * их может не быть. SELECT по несуществующей колонке уронил бы весь разовый
   * проход — а вместе с ним и открытие ленты.
   */
  private async existingColumns(
    database: SQLite.SQLiteDatabase,
    table: string,
    wanted: readonly string[]
  ): Promise<string[]> {
    if (!isSafeSqlIdentifier(table)) return [];
    const info = await database.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
    const have = new Set(info.map((c) => c.name));
    return wanted.filter((c) => isSafeSqlIdentifier(c) && have.has(c));
  }

  /**
   * v4.32.305: разовый перевод открытого текста в шифртекст.
   *
   * Нужен потому, что строки ленты почти никогда не переписываются: пост
   * приходит один раз и живёт, пока его не удалят. Без этого прохода всё
   * написанное до обновления так и осталось бы открытым, а зашифрованными
   * оказались бы только новые посты.
   *
   * Отметка — в самой базе ленты, а не в kv главной: базы ленты у каждого
   * профиля своя, и общий флаг означал бы, что второй профиль считает свой
   * проход выполненным по чужому.
   *
   * Провал не отмечается: следующее открытие ленты попробует снова. Читать
   * это не мешает — readAtRestCell пропускает строку без префикса
   * насквозь, поэтому наполовину переведённая база работает так же, как
   * полностью переведённая.
   */
  private async encryptExistingRowsOnce(database: SQLite.SQLiteDatabase): Promise<void> {
    const FLAG = 'at_rest_v1';
    try {
      const flag = await database.getFirstAsync<{ v: string }>(
        'SELECT v FROM feed_meta WHERE k = ?',
        [FLAG]
      );
      if (flag?.v === 'true') return;
      let migrated = 0;
      for (const spec of FEED_AT_REST_COLUMNS) {
        const cols = await this.existingColumns(database, spec.table, spec.columns);
        if (cols.length === 0) continue;
        // rowid, а не первичный ключ: у feed_post_views он составной, а rowid
        // есть у всех трёх таблиц и однозначен.
        const where = cols
          .map((c) => `(${c} IS NOT NULL AND ${c} NOT IN ('', '{}', '[]') AND ${c} NOT LIKE '${AT_REST_PREFIX}%')`)
          .join(' OR ');
        const rows = await database.getAllAsync<Record<string, string | number | null>>(
          `SELECT rowid AS feed_rowid, ${cols.join(', ')} FROM ${spec.table} WHERE ${where}`
        );
        if (rows.length === 0) continue;
        const dek = await getOrCreateDataEncryptionKey();
        await database.withTransactionAsync(async () => {
          for (const r of rows) {
            const sets: string[] = [];
            const vals: Array<string | number> = [];
            for (const c of cols) {
              const cur = r[c];
              if (typeof cur !== 'string' || cur === '' || cur.startsWith(AT_REST_PREFIX)) continue;
              sets.push(`${c} = ?`);
              vals.push(encryptAtRestString(cur, dek));
            }
            if (sets.length === 0) continue;
            vals.push(r.feed_rowid as number);
            await database.runAsync(
              `UPDATE ${spec.table} SET ${sets.join(', ')} WHERE rowid = ?`,
              vals
            );
            migrated++;
          }
        });
      }
      await database.runAsync('INSERT OR REPLACE INTO feed_meta (k, v) VALUES (?, ?)', [FLAG, 'true']);
      log.info('feed_at_rest_encrypted', { profileId: this.profileId, migrated });
    } catch (e) {
      log.warn('feed_at_rest_encrypt_failed', {
        profileId: this.profileId,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async savePost(row: Omit<FeedPostRow, 'read' | 'reactions'> & { read?: number }): Promise<void> {
    const d = await this.ensureDb();
    // v4.32.546: надгробие поста. Автор удаляет публикацию «у всех» — envelope
    // `feed_delete` уходит каждому контакту, но сам пост мог не доехать раньше
    // удаления: с 4.32.545 сокет переигрывает до 12 часов накопленного, и в этом
    // окне ретрай `feed_post` спокойно приходит после `feed_delete` (или тем же
    // окном, но другим транспортом — LAN против интернета). Без надгробия
    // удалённая публикация воскресала у получателя.
    // Надгробие подавляет только пост ТОГО ЖЕ автора: post_id генерирует
    // отправитель, и без сверки автора чужое надгробие блокировало бы чужой пост.
    if (await this.postTombstoned(d, row.id, row.authorDid)) return;
    // v4.32.31: idempotent insert only. UPDATE был убран: он затирал read и text
    // у получателя при retry feed_post envelope (автор повторно слал после offline
    // окна → у B пост становился непрочитанным снова + свежая локальная
    // feed_edit-правка откатывалась к оригинальному тексту).
    // Правка контента приходит отдельным feed_edit envelope → updatePostText,
    // поэтому savePost не должна мутировать существующие строки.
    const dek = await getOrCreateDataEncryptionKey();
    await d.runAsync(
      `INSERT OR IGNORE INTO feed (id, author_did, author_name, text, media_cids, timestamp, read, cid, reactions, repost_of, repost_author_name, repost_author_did, documents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      [
        row.id,
        row.authorDid,
        encryptAtRestNullable(row.authorName ?? null, dek),
        encryptAtRestString(row.text, dek),
        encryptAtRestNullable(row.mediaCids ? JSON.stringify(row.mediaCids) : null, dek),
        row.timestamp,
        row.read ?? 0,
        row.cid ?? null,
        row.repostOf ?? null,
        encryptAtRestNullable(row.repostAuthorName ?? null, dek),
        row.repostAuthorDid ?? null,
        encryptAtRestNullable(
          row.documents && row.documents.length > 0 ? JSON.stringify(row.documents) : null,
          dek
        ),
      ]
    );
  }

  async addReaction(postId: string, emoji: string, authorDid: string): Promise<void> {
    const d = await this.ensureDb();
    const row = await d.getFirstAsync<{ reactions: string | null }>(
      'SELECT reactions FROM feed WHERE id = ?',
      [postId]
    );
    if (!row) return; // post not found locally
    const dek = await getOrCreateDataEncryptionKey();
    let reactions: Record<string, string[]> = {};
    // v4.32.544: столбец, который не открылся ключом, раньше читался пустой
    // строкой — как «реакций не было». Дальше в него записывалась одна новая
    // реакция, и прежние пропадали безвозвратно.
    const cell = readAtRestCell(row.reactions, dek);
    if (!mayOverwrite(cell)) {
      log.warn('feed_reaction_column_unreadable', {});
      return;
    }
    const parsed = parseJsonColumn<unknown>(cellTextOrNull(cell));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      reactions = parsed as Record<string, string[]>;
    }
    // v4.32.205 (Round-35 #1): cap distinct emoji keys at 64. A malicious peer
    // could otherwise send 10_000 distinct "emoji" strings and bloat the row.
    if (!reactions[emoji] && Object.keys(reactions).length >= 64) return;
    if (!reactions[emoji]) reactions[emoji] = [];
    // v4.32.205 (Round-35 #4): cap authors per emoji at 512.
    if (!Array.isArray(reactions[emoji])) reactions[emoji] = [];
    if (!reactions[emoji].includes(authorDid)) {
      if (reactions[emoji].length >= 512) return;
      reactions[emoji].push(authorDid);
    }
    await d.runAsync(
      'UPDATE feed SET reactions = ? WHERE id = ?',
      [encryptAtRestString(JSON.stringify(reactions), dek), postId]
    );
  }

  async getReactions(postId: string): Promise<Record<string, string[]>> {
    const d = await this.ensureDb();
    const row = await d.getFirstAsync<{ reactions: string | null }>(
      'SELECT reactions FROM feed WHERE id = ?',
      [postId]
    );
    if (!row?.reactions) return {};
    const dek = await getOrCreateDataEncryptionKey();
    return parseJsonColumn<Record<string, string[]>>(decryptAtRestNullable(row.reactions, dek)) ?? {};
  }

  async getFeed(limit = 50, offset = 0): Promise<FeedPostRow[]> {
    const d = await this.ensureDb();
    // v4.32.34: архивированные посты исключаются из основной ленты.
    // v4.32.503: id в порядке — не украшение. Одного timestamp мало: посты,
    // пришедшие пачкой (восстановление из копии, догон после сети), делят
    // миллисекунду, и SQLite вправе вернуть их в любом порядке. Выборка
    // страницами по LIMIT/OFFSET тогда невоспроизводима, и при подгрузке
    // следующей страницы один пост показывается дважды, а другой не
    // показывается вовсе.
    const rows = await d.getAllAsync<FeedDbRow>(
      'SELECT * FROM feed WHERE COALESCE(archived, 0) = 0 ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?',
      [limit, offset]
    );
    const dek = await getOrCreateDataEncryptionKey();
    return rows.map((r) => toPost(r, dek));
  }

  /**
   * v4.32.29: получить один пост по id — нужен для auth-проверки в feed_delete/feed_edit,
   * чтобы чужой контакт не мог удалить/отредактировать не-свой пост.
   */
  async getPost(postId: string): Promise<FeedPostRow | null> {
    const d = await this.ensureDb();
    const r = await d.getFirstAsync<FeedDbRow>('SELECT * FROM feed WHERE id = ?', [postId]);
    if (!r) return null;
    const dek = await getOrCreateDataEncryptionKey();
    return toPost(r, dek);
  }

  /** Export decrypted entity rows; the sync layer encrypts each row again. */
  async exportSyncSnapshot(): Promise<FeedSyncSnapshot> {
    const d = await this.ensureDb();
    const dek = await getOrCreateDataEncryptionKey();
    const posts = await d.getAllAsync<FeedDbRow>(
      'SELECT * FROM feed ORDER BY timestamp ASC, id ASC',
    );
    const comments = await d.getAllAsync<{
      id: string;
      post_id: string;
      author_did: string;
      author_name: string | null;
      text: string;
      timestamp: number;
      reactions: string | null;
    }>('SELECT id, post_id, author_did, author_name, text, timestamp, reactions FROM feed_comments ORDER BY timestamp ASC, id ASC');
    const commentTombstones = await d.getAllAsync<{
      comment_id: string;
      post_id: string;
      deleted_at: number;
    }>('SELECT comment_id, post_id, deleted_at FROM feed_comment_tombstones ORDER BY deleted_at ASC, comment_id ASC');
    return {
      posts: posts.map((row) => toPost(row, dek)),
      // v4.32.588: тот же признак, что и на показе. Выгрузка отдаёт строки
      // расшифрованными, и придержать непрочитанную должна та сторона,
      // которая знает, что прочитать не удалось.
      comments: comments.map((row) => {
        const textCell = readAtRestCell(row.text ?? '', dek);
        const nameCell = readAtRestCell(row.author_name, dek);
        return {
          id: row.id,
          postId: row.post_id,
          authorDid: row.author_did,
          authorName: cellTextOrNull(nameCell),
          text: cellTextOrNull(textCell) ?? '',
          timestamp: row.timestamp,
          reactions: parseJsonColumn<Record<string, string[]>>(decryptAtRestNullable(row.reactions, dek)),
          textUnreadable: unreadableFromCellState(textCell.state),
          nameUnreadable: unreadableFromCellState(nameCell.state),
        };
      }),
      commentTombstones: commentTombstones.map((row) => ({
        commentId: row.comment_id,
        postId: row.post_id,
        deletedAt: row.deleted_at,
      })),
    };
  }

  /** Apply one authenticated remote post without changing unrelated local rows. */
  async upsertSyncPost(row: FeedPostRow): Promise<void> {
    const d = await this.ensureDb();
    // v4.32.546: то же надгробие, что и в savePost. Облачный снимок второго
    // устройства ещё какое-то время содержит удалённый пост, и без проверки
    // он приезжал обратно ближайшим pull'ом.
    if (await this.postTombstoned(d, row.id, row.authorDid)) return;
    const dek = await getOrCreateDataEncryptionKey();
    await d.runAsync(
      `INSERT INTO feed
         (id, author_did, author_name, text, media_cids, timestamp, read, cid, reactions,
          repost_of, repost_author_name, repost_author_did, bookmarked, edited_at, archived, documents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         author_did = excluded.author_did,
         author_name = excluded.author_name,
         text = excluded.text,
         media_cids = excluded.media_cids,
         timestamp = excluded.timestamp,
         read = excluded.read,
         cid = excluded.cid,
         reactions = excluded.reactions,
         repost_of = excluded.repost_of,
         repost_author_name = excluded.repost_author_name,
         repost_author_did = excluded.repost_author_did,
         bookmarked = excluded.bookmarked,
         edited_at = excluded.edited_at,
         archived = excluded.archived,
         documents = excluded.documents`,
      [
        row.id,
        row.authorDid,
        encryptAtRestNullable(row.authorName ?? null, dek),
        encryptAtRestString(row.text, dek),
        encryptAtRestNullable(row.mediaCids ? JSON.stringify(row.mediaCids) : null, dek),
        row.timestamp,
        row.read,
        row.cid,
        encryptAtRestNullable(row.reactions ? JSON.stringify(row.reactions) : null, dek),
        row.repostOf ?? null,
        encryptAtRestNullable(row.repostAuthorName ?? null, dek),
        row.repostAuthorDid ?? null,
        row.bookmarked ?? 0,
        row.editedAt ?? null,
        row.archived ?? 0,
        encryptAtRestNullable(row.documents ? JSON.stringify(row.documents) : null, dek),
      ],
    );
  }

  /** Apply one authenticated remote comment, respecting a prior tombstone. */
  async upsertSyncComment(row: FeedCommentRow): Promise<void> {
    const d = await this.ensureDb();
    const tombstone = await d.getFirstAsync<{ comment_id: string }>(
      'SELECT comment_id FROM feed_comment_tombstones WHERE comment_id = ?',
      [row.id],
    );
    if (tombstone) return;
    const dek = await getOrCreateDataEncryptionKey();
    await d.runAsync(
      `INSERT INTO feed_comments (id, post_id, author_did, author_name, text, timestamp, reactions)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         post_id = excluded.post_id,
         author_did = excluded.author_did,
         author_name = excluded.author_name,
         text = excluded.text,
         timestamp = excluded.timestamp,
         reactions = excluded.reactions`,
      [
        row.id,
        row.postId,
        row.authorDid,
        encryptAtRestNullable(row.authorName ?? null, dek),
        encryptAtRestString(row.text, dek),
        row.timestamp,
        encryptAtRestNullable(row.reactions ? JSON.stringify(row.reactions) : null, dek),
      ],
    );
  }

  /** v4.32.546: удаление с другого устройства аккаунта — тоже с надгробием. */
  async deleteSyncPost(postId: string, deletedAt: number = Date.now()): Promise<void> {
    await this.deletePost(postId, deletedAt);
  }

  async deleteSyncComment(commentId: string, postId: string, deletedAt: number): Promise<void> {
    const d = await this.ensureDb();
    await d.runAsync('DELETE FROM feed_comments WHERE id = ?', [commentId]);
    await d.runAsync(
      `INSERT INTO feed_comment_tombstones (comment_id, post_id, deleted_at)
       VALUES (?, ?, ?)
       ON CONFLICT (comment_id) DO UPDATE SET post_id = excluded.post_id, deleted_at = excluded.deleted_at`,
      [commentId, postId, deletedAt],
    );
  }

  /**
   * v4.32.29: удалить реакцию конкретного DID по эмодзи (unreact). Если ни одного did
   * не осталось для этого emoji, запись emoji удаляется целиком.
   */
  async removeReaction(postId: string, emoji: string, authorDid: string): Promise<void> {
    const d = await this.ensureDb();
    const row = await d.getFirstAsync<{ reactions: string | null }>(
      'SELECT reactions FROM feed WHERE id = ?',
      [postId]
    );
    if (!row?.reactions) return;
    const dek = await getOrCreateDataEncryptionKey();
    // v4.32.544: здесь перезапись и раньше не случалась (пустая строка даёт
    // null и ранний выход), но молча — теперь причина видна в журнале, а
    // условие выхода записано явно, а не выводится из поведения парсера.
    const cell = readAtRestCell(row.reactions, dek);
    if (!mayOverwrite(cell)) {
      log.warn('feed_reaction_column_unreadable', {});
      return;
    }
    const reactions = parseJsonColumn<Record<string, string[]>>(cellTextOrNull(cell));
    if (!reactions) return;
    const list = reactions[emoji];
    if (!list || !list.includes(authorDid)) return;
    const filtered = list.filter((x) => x !== authorDid);
    if (filtered.length > 0) reactions[emoji] = filtered;
    else delete reactions[emoji];
    await d.runAsync('UPDATE feed SET reactions = ? WHERE id = ?', [
      encryptAtRestString(JSON.stringify(reactions), dek),
      postId,
    ]);
  }

  async setBookmarked(postId: string, bookmarked: boolean): Promise<void> {
    const d = await this.ensureDb();
    await d.runAsync('UPDATE feed SET bookmarked = ? WHERE id = ?', [bookmarked ? 1 : 0, postId]);
  }

  async listBookmarked(limit = 200): Promise<FeedPostRow[]> {
    const d = await this.ensureDb();
    const rows = await d.getAllAsync<FeedDbRow>(
      'SELECT * FROM feed WHERE bookmarked = 1 ORDER BY timestamp DESC LIMIT ?',
      [limit]
    );
    const dek = await getOrCreateDataEncryptionKey();
    return rows.map((r) => toPost(r, dek));
  }

  /**
   * v4.32.34: локальная архивация — скрывает пост из основной ленты (getFeed),
   * но оставляет его в БД. Работает для ЛЮБОГО поста (своего и чужого).
   * В отличие от deletePost, pass-через к сети не делается — операция чисто локальная.
   */
  async setArchived(postId: string, archived: boolean): Promise<void> {
    const d = await this.ensureDb();
    await d.runAsync('UPDATE feed SET archived = ? WHERE id = ?', [archived ? 1 : 0, postId]);
  }

  /**
   * v4.32.47: пагинация — раньше было hard-coded limit=500, что грузило огромный
   * набор base64 в память при открытии экрана «Архив». Теперь FeedScreen зовёт
   * первую страницу (40) и через onEndReached подтягивает следующие.
   */
  async listArchived(limit = 40, offset = 0): Promise<FeedPostRow[]> {
    const d = await this.ensureDb();
    const rows = await d.getAllAsync<FeedDbRow>(
      'SELECT * FROM feed WHERE archived = 1 ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?',
      [limit, offset]
    );
    const dek = await getOrCreateDataEncryptionKey();
    return rows.map((r) => toPost(r, dek));
  }

  async markAsRead(postId: string): Promise<void> {
    const d = await this.ensureDb();
    await d.runAsync('UPDATE feed SET read = 1 WHERE id = ?', [postId]);
  }

  async getUnreadCount(): Promise<number> {
    const d = await this.ensureDb();
    const row = await d.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) as count FROM feed WHERE read = 0'
    );
    return row?.count ?? 0;
  }

  /**
   * v4.32.546: удаление ставит надгробие, чтобы запоздавший `feed_post` не
   * воскресил публикацию. Автора берём из самой строки — так одна и та же
   * запись покрывает и своё удаление «у всех», и локальное скрытие чужого поста.
   * Комментарии и просмотры удалённого поста больше ниоткуда не достижимы,
   * поэтому уходят вместе с ним, а не остаются сиротами в базе.
   */
  async deletePost(postId: string, deletedAt: number = Date.now()): Promise<void> {
    const d = await this.ensureDb();
    const row = await d.getFirstAsync<{ author_did: string }>(
      'SELECT author_did FROM feed WHERE id = ?',
      [postId]
    );
    if (row) await this.savePostTombstone(postId, row.author_did, deletedAt);
    await d.runAsync('DELETE FROM feed WHERE id = ?', [postId]);
    await d.runAsync('DELETE FROM feed_comments WHERE post_id = ?', [postId]);
    await d.runAsync('DELETE FROM feed_post_views WHERE post_id = ?', [postId]);
  }

  /**
   * v4.32.546: надгробие без строки поста — случай, когда `feed_delete` пришёл
   * раньше самого `feed_post`. Автор здесь берётся из подписанного конверта:
   * `parseAndVerifyFeedEnvelope` уже сверил подпись и то, что
   * `payload.authorDid === senderDid`, так что подделать чужое надгробие нельзя.
   * INSERT OR IGNORE — первое удаление и есть настоящее время удаления.
   */
  async savePostTombstone(postId: string, authorDid: string, deletedAt: number): Promise<void> {
    const d = await this.ensureDb();
    await d.runAsync(
      'INSERT OR IGNORE INTO feed_post_tombstones (post_id, author_did, deleted_at) VALUES (?, ?, ?)',
      [postId, authorDid, deletedAt]
    );
  }

  /** Есть ли надгробие этого автора на этот post_id. */
  private async postTombstoned(
    d: SQLite.SQLiteDatabase,
    postId: string,
    authorDid: string
  ): Promise<boolean> {
    const t = await d.getFirstAsync<{ author_did: string }>(
      'SELECT author_did FROM feed_post_tombstones WHERE post_id = ?',
      [postId]
    );
    return t != null && t.author_did === authorDid;
  }

  /** v4.32.65: editedAt опционален — receiver передаёт payload.ts envelope'а,
   *  sender (editFeedPost) оставляет undefined → Date.now(). Позволяет корректно
   *  отфильтровать out-of-order доставку feed_edit (last-write-wins по ts). */
  async updatePostText(postId: string, newText: string, editedAt?: number): Promise<void> {
    const d = await this.ensureDb();
    const dek = await getOrCreateDataEncryptionKey();
    await d.runAsync('UPDATE feed SET text = ?, edited_at = ? WHERE id = ?', [
      encryptAtRestString(newText, dek),
      editedAt ?? Date.now(),
      postId,
    ]);
  }

  async clear(): Promise<void> {
    const d = await this.ensureDb();
    await d.runAsync('DELETE FROM feed');
  }

  // ─── Comments ──────────────────────────────────────────────────────────────

  async addComment(row: FeedCommentRow): Promise<void> {
    const d = await this.ensureDb();
    // v4.32.163 P2#3 fix: проверяем tombstone. Если envelope `feed_comment_delete`
    // пришёл раньше самого `feed_comment` (out-of-order доставка через разные
    // транспорты: pubsub vs LAN broadcast), то без tombstone коммент «воскреснет»
    // когда прилетит с опозданием. INSERT OR IGNORE не защищает — ряд ещё не
    // существует, запись пройдёт.
    const tombstone = await d.getFirstAsync<{ comment_id: string }>(
      'SELECT comment_id FROM feed_comment_tombstones WHERE comment_id = ?',
      [row.id]
    );
    if (tombstone) return;
    const dek = await getOrCreateDataEncryptionKey();
    await d.runAsync(
      `INSERT OR IGNORE INTO feed_comments (id, post_id, author_did, author_name, text, timestamp, reactions)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.postId,
        row.authorDid,
        encryptAtRestNullable(row.authorName ?? null, dek),
        encryptAtRestString(row.text, dek),
        row.timestamp,
        encryptAtRestNullable(row.reactions ? JSON.stringify(row.reactions) : null, dek),
      ]
    );
  }

  async getComments(postId: string): Promise<FeedCommentRow[]> {
    const d = await this.ensureDb();
    const rows = await d.getAllAsync<{
      id: string;
      post_id: string;
      author_did: string;
      author_name: string | null;
      text: string;
      timestamp: number;
      reactions: string | null;
    }>('SELECT * FROM feed_comments WHERE post_id = ? ORDER BY timestamp ASC', [postId]);
    const dek = await getOrCreateDataEncryptionKey();
    // v4.32.588: читаем состоянием, а не строкой. Непрочитанный комментарий
    // приходил пустым пузырём — и таким же уезжал в синхронизацию.
    return rows.map((r) => {
      const textCell = readAtRestCell(r.text ?? '', dek);
      const nameCell = readAtRestCell(r.author_name, dek);
      return {
        id: r.id,
        postId: r.post_id,
        authorDid: r.author_did,
        authorName: cellTextOrNull(nameCell),
        text: cellTextOrNull(textCell) ?? '',
        timestamp: r.timestamp,
        reactions: parseJsonColumn<Record<string, string[]>>(decryptAtRestNullable(r.reactions, dek)),
        textUnreadable: unreadableFromCellState(textCell.state),
        nameUnreadable: unreadableFromCellState(nameCell.state),
      };
    });
  }

  /**
   * v4.32.544: оба зовущих (свой тап по реакции и пришедший от собеседника
   * конверт) собирают карту заново из прочитанного столбца. Если он не
   * открылся ключом, читатели видят «реакций нет» и присылают сюда карту из
   * одной реакции. Проверка стоит на самой записи, а не у каждого из них:
   * места, где чтение нужно для слияния, guard'ятся у чтения, а здесь карта
   * приходит готовой — отказать правильнее всего прямо перед UPDATE.
   */
  async updateCommentReactions(commentId: string, reactions: Record<string, string[]>): Promise<void> {
    const d = await this.ensureDb();
    const dek = await getOrCreateDataEncryptionKey();
    const row = await d.getFirstAsync<{ reactions: string | null }>(
      'SELECT reactions FROM feed_comments WHERE id = ?',
      [commentId],
    );
    if (row && !mayOverwrite(readAtRestCell(row.reactions, dek))) {
      log.warn('feed_comment_reaction_column_unreadable', { commentId: commentId.slice(0, 16) });
      return;
    }
    await d.runAsync('UPDATE feed_comments SET reactions = ? WHERE id = ?', [
      encryptAtRestString(JSON.stringify(reactions), dek),
      commentId,
    ]);
  }

  async getCommentCount(postId: string): Promise<number> {
    const d = await this.ensureDb();
    const row = await d.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) as count FROM feed_comments WHERE post_id = ?',
      [postId]
    );
    return row?.count ?? 0;
  }

  async deleteComment(commentId: string): Promise<void> {
    const d = await this.ensureDb();
    // v4.32.163 P2#3 fix: перед удалением читаем postId (если ряд ещё существует),
    // чтобы сохранить tombstone с корректным post_id. Если ряда уже нет (повторный
    // delete по сети), всё равно сохраняем tombstone (без postId — получим из meta
    // caller'а через addCommentTombstone).
    const row = await d.getFirstAsync<{ post_id: string }>(
      'SELECT post_id FROM feed_comments WHERE id = ?',
      [commentId]
    );
    await d.runAsync('DELETE FROM feed_comments WHERE id = ?', [commentId]);
    if (row) {
      await d.runAsync(
        'INSERT OR IGNORE INTO feed_comment_tombstones (comment_id, post_id, deleted_at) VALUES (?, ?, ?)',
        [commentId, row.post_id, Date.now()]
      );
    }
  }

  /**
   * v4.32.163 P2#3: upsert tombstone когда `feed_comment_delete` envelope пришёл
   * ДО самого `feed_comment`. postId берётся из envelope.postId (у delete-envelope
   * он всегда присутствует — caller из receiveFeedEnvelope знает postId).
   * Когда опоздавший `feed_comment` добавляется через addComment(), он увидит
   * tombstone и не запишется.
   */
  async addCommentTombstone(commentId: string, postId: string): Promise<void> {
    const d = await this.ensureDb();
    await d.runAsync(
      'INSERT OR IGNORE INTO feed_comment_tombstones (comment_id, post_id, deleted_at) VALUES (?, ?, ?)',
      [commentId, postId, Date.now()]
    );
  }

  /**
   * v4.32.64: лёгкое чтение метаданных комментария (authorDid + postId) для
   * auth-guard в deleteFeedComment / toggleCommentReaction. Вместо полного
   * getComments(postId) возвращает одну строку.
   */
  async getCommentMeta(commentId: string): Promise<{ authorDid: string; postId: string; reactions: Record<string, string[]> | null } | null> {
    const d = await this.ensureDb();
    const row = await d.getFirstAsync<{ author_did: string; post_id: string; reactions: string | null }>(
      'SELECT author_did, post_id, reactions FROM feed_comments WHERE id = ?',
      [commentId],
    );
    if (!row) return null;
    const dek = await getOrCreateDataEncryptionKey();
    const reactions = parseJsonColumn<Record<string, string[]>>(decryptAtRestNullable(row.reactions, dek));
    return { authorDid: row.author_did, postId: row.post_id, reactions };
  }

  // ─── Views (v4.32.68) ──────────────────────────────────────────────────────

  /**
   * v4.32.68: зафиксировать просмотр поста конкретным viewer'ом. PRIMARY KEY
   * (post_id, viewer_did) гарантирует что один пользователь считается один раз,
   * даже если он несколько раз откроет ленту (envelope шлётся только при первом
   * open — guard-флаг в kvStore, но и на receiver'е защита дубликата).
   */
  async recordView(postId: string, viewerDid: string, viewerName: string | null, viewedAt: number): Promise<void> {
    const d = await this.ensureDb();
    const dek = await getOrCreateDataEncryptionKey();
    const encName = encryptAtRestNullable(viewerName, dek);
    await d.runAsync(
      `INSERT OR IGNORE INTO feed_post_views (post_id, viewer_did, viewer_name, viewed_at)
       VALUES (?, ?, ?, ?)`,
      [postId, viewerDid, encName, viewedAt]
    );
    // Если имя viewer'а изменилось (контакт сменил displayName) — обновим. INSERT OR IGNORE
    // не апдейтит, поэтому отдельный UPDATE на no-op-safe path.
    if (viewerName) {
      await d.runAsync(
        'UPDATE feed_post_views SET viewer_name = ? WHERE post_id = ? AND viewer_did = ?',
        [encName, postId, viewerDid]
      );
    }
  }

  /**
   * v4.32.68: список просмотревших пост, в обратном порядке (самые свежие сверху).
   */
  async getViewers(postId: string, limit = 500): Promise<FeedViewerRow[]> {
    const d = await this.ensureDb();
    const rows = await d.getAllAsync<{
      viewer_did: string;
      viewer_name: string | null;
      viewed_at: number;
    }>('SELECT viewer_did, viewer_name, viewed_at FROM feed_post_views WHERE post_id = ? ORDER BY viewed_at DESC LIMIT ?', [postId, limit]);
    const dek = await getOrCreateDataEncryptionKey();
    // v4.32.589: то же про имя просмотревшего — оно зашифровано так же.
    return rows.map((r) => {
      const nameCell = readAtRestCell(r.viewer_name, dek);
      return {
        viewerDid: r.viewer_did,
        viewerName: cellTextOrNull(nameCell),
        viewedAt: r.viewed_at,
        nameUnreadable: unreadableFromCellState(nameCell.state),
      };
    });
  }

  /**
   * v4.32.68: быстрое число просмотров — для eye-icon счётчика в ленте.
   */
  async getViewCount(postId: string): Promise<number> {
    const d = await this.ensureDb();
    const row = await d.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) as count FROM feed_post_views WHERE post_id = ?',
      [postId]
    );
    return row?.count ?? 0;
  }

  /**
   * v4.32.68: батч-счётчики просмотров для списка постов — одна SQL вместо N.
   * Используется в FeedScreen.loadFeed для пре-подгрузки в Map<postId, count>.
   */
  async getViewCountsForPosts(postIds: string[]): Promise<Record<string, number>> {
    if (postIds.length === 0) return {};
    const d = await this.ensureDb();
    const placeholders = postIds.map(() => '?').join(',');
    const rows = await d.getAllAsync<{ post_id: string; count: number }>(
      `SELECT post_id, COUNT(*) as count FROM feed_post_views WHERE post_id IN (${placeholders}) GROUP BY post_id`,
      postIds
    );
    const out: Record<string, number> = {};
    for (const r of rows) out[r.post_id] = r.count;
    return out;
  }

  /**
   * v4.32.49: вернуть все postId'ы профиля — используется при deleteProfile
   * для очистки orphaned kv-записей (`feed_inline_media:<postId>:*`,
   * `feed_inline_doc:<postId>:*`) ДО того как feed DB будет удалена.
   */
  async listAllPostIds(): Promise<string[]> {
    const d = await this.ensureDb();
    const rows = await d.getAllAsync<{ id: string }>('SELECT id FROM feed');
    return rows.map((r) => r.id);
  }
}

/**
 * v4.32.49: полностью удалить feed DB для профиля. Вызывается из
 * profileManager.deleteProfile после того как соответствующие kv inline-записи
 * уже подчищены (в feedService.cleanupFeedStorageForProfile).
 *
 * v4.32.521: прежнее описание — «deleteDatabaseAsync закрывает и удаляет
 * файл» — было неверным, и на нём держалась вся уборка. Открытую базу
 * expo-sqlite не удаляет, а отказывает: «Unable to delete database … that is
 * currently open. Close it prior to deletion.» Закрыть соединение обязан
 * вызывающий (FeedStorage.close), здесь остаётся только удаление и проверка,
 * что файлы действительно исчезли.
 */
export async function deleteFeedDbForProfile(profileId: number): Promise<void> {
  const name = `airchat_feed_p${profileId}.db`;
  try {
    await SQLite.deleteDatabaseAsync(name);
  } catch (e) {
    log.warn('feed_db_delete_failed', { profileId, err: e instanceof Error ? e.message : String(e) });
    throw e;
  }
  const base = FileSystem.documentDirectory;
  if (!base) return;
  for (const suffix of ['', '-wal', '-shm']) {
    const uri = `${base}SQLite/${name}${suffix}`;
    if ((await FileSystem.getInfoAsync(uri)).exists) {
      throw new Error(`Локальная база ленты не удалена: ${name}`);
    }
  }
}

/** Имя файла базы ленты → номер профиля, либо null. */
export function feedDbProfileId(fileName: string): number | null {
  const m = fileName.match(/^airchat_feed_p(\d+)\.db$/);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Удалить базы ленты ВСЕХ профилей — для полного сброса устройства (v4.32.308).
 *
 * Сброс кошелька удалял главную базу и ключ, а базы ленты не трогал вовсе:
 * их удаление жило только в удалении отдельного профиля. Последствий два, и
 * второе хуже первого.
 *
 * Файл переживал сброс, и имя у него не случайное, а по номеру профиля. То
 * есть следующий владелец устройства (или тот же человек с другой сид-фразой)
 * получал профиль 1 поверх ЧУЖОГО `airchat_feed_p1.db`: строки на месте, но
 * DEK уже другой, и лента расшифровывалась в пустые записи — ровно та беззвучная
 * порча, ради которой в своё время завели список AT_REST_COLUMNS.
 *
 * А при возврате прежней сид-фразы DEK совпадал снова, и лента, которую человек
 * только что удалил вместе с данными устройства, возвращалась целиком.
 *
 * Список профилей к этому моменту уже стёрт, поэтому идём от файлов: номера
 * профилей растут монотонно (nextProfileId), и перебором «от 1 до предела»
 * базу профиля с номером 7 не найти. Переданные номера принимаем сверх того —
 * на случай, если каталог не читается.
 */
export async function deleteAllFeedDbs(knownProfileIds: readonly number[] = []): Promise<number> {
  const ids = new Set<number>(knownProfileIds.filter((id) => Number.isSafeInteger(id) && id > 0));
  try {
    const dir = `${FileSystem.documentDirectory ?? ''}SQLite/`;
    if (FileSystem.documentDirectory && (await FileSystem.getInfoAsync(dir)).exists) {
      for (const name of await FileSystem.readDirectoryAsync(dir)) {
        const id = feedDbProfileId(name);
        if (id !== null) ids.add(id);
      }
    }
  } catch (e) {
    // Каталог не прочитался — остаются переданные номера: это лучше, чем ничего.
    log.warn('feed_db_scan_failed', { err: e instanceof Error ? e.message : String(e) });
  }
  const failed: number[] = [];
  for (const id of ids) {
    try {
      await deleteFeedDbForProfile(id);
    } catch (e) {
      failed.push(id);
      log.warn('feed_db_delete_failed', { profileId: id, err: e instanceof Error ? e.message : String(e) });
    }
  }
  if (failed.length > 0) {
    throw new Error(`Не удалены базы ленты профилей: ${failed.join(', ')}`);
  }
  if (ids.size > 0) log.info('feed_db_wiped_all', { count: ids.size });
  return ids.size;
}
