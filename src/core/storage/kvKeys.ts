/**
 * Имена ключей в таблице kv. Отдельным модулем — без зависимостей от expo, —
 * чтобы соглашение об именовании лежало в одном месте и проверялось тестами:
 * разъехавшиеся копии одного и того же правила уже стоили нам и чужих заметок
 * в соседнем профиле (v4.32.278), и потерянных контактов при восстановлении
 * из резервной копии (v4.32.280).
 */

/**
 * KV с namespace профиля — для ключей, которые должны быть изолированы между аккаунтами.
 * Используйте для: contacts_index, contact:*, и любых user-scoped данных.
 * Ключи без scoping (kvGet/kvSet) остаются для системных настроек (тема, VPN, etc.).
 */
export function profileScopedKey(profileId: number, key: string): string {
  return `p${profileId}:${key}`;
}

/** Есть ли у ключа префикс профиля (`p12:...`). */
export function hasProfilePrefix(key: string): boolean {
  return /^p\d+:/.test(key);
}

/**
 * Карточка собственного профиля: имя, «о себе», аватар, ссылки, статус.
 *
 * v4.32.288: с префиксом профиля. Список лежит здесь, а не в
 * identity/ownProfile, чтобы им могла пользоваться и уборка при удалении
 * профиля (storage/local): ownProfile зависит от local, обратная зависимость
 * замкнула бы круг. Смысл ключей — там же, в ownProfile.
 */
export const OWN_PROFILE_KEYS = [
  'user_username',
  'user_bio',
  'user_handle',
  'user_pronouns',
  'user_avatar_uri',
  'user_avatar_cid',
  'user_website',
  'user_twitter',
  'user_github',
  'user_custom_status',
  'user_profile_cid',
  'account_created_at',
] as const;

export type OwnProfileKey = (typeof OWN_PROFILE_KEYS)[number];

/**
 * Решения о приватности — свои у каждого аккаунта (v4.32.311).
 *
 * Список здесь, рядом с остальными именами ключей, чтобы им пользовалась и
 * уборка при удалении профиля: она сметает `p<id>:%`, и до тех пор, пока эти
 * ключи были общими, удалённый аккаунт оставлял свои решения следующему.
 *
 * Настройки уведомлений (`notify_dm`, `notify_sound` и прочие) сюда намеренно
 * не входят: это поведение телефона — звонить ли, вибрировать, показывать ли
 * текст на замке, — и оно про устройство, а не про то, кем человек сейчас
 * представляется.
 */
export const PRIVACY_PREF_KEYS = [
  'privacy_last_seen_visibility',
  'privacy_only_contacts_msg',
  'privacy_only_contacts_group',
  'privacy_disable_read_receipts',
  // v4.32.486: отдавать ли текст переписки стороннему переводчику. Прежнее имя
  // (`allow_cloud_translate`) было общим на устройство и не записывалось вовсе
  // — см. social/translateConsent.
  'privacy_allow_cloud_translate',
] as const;

export type PrivacyPrefKey = (typeof PRIVACY_PREF_KEYS)[number];

/**
 * Мелкие следы работы человека в интерфейсе (v4.32.561).
 *
 * Недавние реакции, недавние эмодзи панели и язык, на который переводить, —
 * это не оформление и не настройка приватности, поэтому их и не заметили,
 * когда разговоры (v4.32.487) и решения о приватности (v4.32.311) уезжали в
 * namespace профиля. Между тем каждая из трёх записей — след КОНКРЕТНОГО
 * человека, а не телефона:
 *
 *  - недавние реакции показываются первой строкой в панели реакций: чужой
 *    аккаунт открывал её и видел, чем отвечал сосед по устройству;
 *  - недавние эмодзи — то же самое, только длиннее (24 против 8) и потому
 *    красноречивее: по ним видно, о чём человек вообще переписывается;
 *  - язык перевода выбирается в настройках КАЖДЫМ аккаунтом отдельно, но
 *    запись была одна на устройство, поэтому второй профиль молча получал
 *    чужой выбор и не мог оставить свой.
 *
 * И, как всегда с общими именами: уборка удалённого профиля идёт по `p<id>:%`
 * и такие записи не забирала — они доставались следующему аккаунту с тем же
 * номером. Читаются и пишутся они через storage/profileScopedKv, а список
 * нужен затем же, зачем LEGACY_GLOBAL_SYNC_KEYS ниже: запись, сделанная до
 * этой версии, принадлежит первому профилю и должна уйти вместе с ним, даже
 * если тот ни разу не успел её перечитать и мигрировать.
 */
export const RECENT_REACTIONS_KEY = 'recent_reactions';

/** Недавние эмодзи панели ввода — след того же человека, что и реакции. */
export const RECENT_EMOJIS_PANEL_KEY = 'recent_emojis_panel';

/** Язык, на который переводить входящие; выбирается в настройках аккаунта. */
export const TRANSLATION_TARGET_LANG_KEY = 'translation_target_lang';

export const PER_PROFILE_UI_KEYS = [
  RECENT_REACTIONS_KEY,
  RECENT_EMOJIS_PANEL_KEY,
  TRANSLATION_TARGET_LANG_KEY,
] as const;

export type PerProfileUiKey = (typeof PER_PROFILE_UI_KEYS)[number];

/**
 * Служебные записи рассылки профиля и решения о времени последнего входа
 * (v4.32.325).
 *
 * До этой версии лежали под общими именами, хотя внутри — открытые ключи
 * собеседников, то есть граф связей. Теперь пишутся в namespace профиля
 * (storage/profileScopedKv), а перечислены здесь по той же причине, что и
 * карточка профиля: общая запись принадлежит первому аккаунту и должна
 * уходить вместе с ним. Иначе «кому что отправлено» — а вместе с этим и
 * список адресатов — переживало бы удаление аккаунта и доставалось
 * следующему профилю с тем же номером.
 */
export const LEGACY_GLOBAL_SYNC_KEYS = [
  'profile:sent',
  'profile:changed_at',
  'profile:avatar_upload',
  'presence:pref_sent',
] as const;

/** «Сообщить, когда этот человек появится» — решение конкретного аккаунта о конкретном контакте. */
export function notifyOnlineKey(peerPubB64: string): string {
  return `notify_online_${peerPubB64}`;
}

/**
 * «Опрос завершён» — отметка о конкретном сообщении (v4.32.484).
 *
 * Имя живёт здесь, а не в pollVoteSync: его набирает и уборка следов опроса
 * при удалении сообщения (storage/local), а social зависит от storage —
 * обратная зависимость замкнула бы круг. До этой версии имя было записано в
 * обоих местах врозь.
 */
export function pollClosedKey(msgId: string): string {
  return `poll_closed_${msgId}`;
}

/**
 * Оформление и настройки отдельного разговора (v4.32.487).
 *
 * `convId` — открытый ключ собеседника для личной переписки и `grp_<id>` для
 * группы; и то и другое одинаково у обоих аккаунтов на телефоне. Пока эти
 * записи лежали без префикса профиля, фон, размер шрифта и автоперевод,
 * выбранные в одном аккаунте, применялись и во втором — по одному только
 * совпадению собеседника, — а уборка при удалении профиля (`p<id>:%`) их не
 * забирала. Читаются и пишутся они через storage/profileScopedKv.
 */
export function chatBgKey(convId: string): string {
  return `chat_bg_${convId}`;
}

/** Размер шрифта, выбранный для этого разговора. */
export function chatFontSizeKey(convId: string): string {
  return `chat_font_size_${convId}`;
}

/** Переводить ли входящие в этом разговоре (см. social/translateConsent). */
export function chatAutoTranslateKey(convId: string): string {
  return `autotranslate_${convId}`;
}

/** Имя разговора для групповых ключей: `grp_<id>`. */
export function groupConvId(groupId: string): string {
  return `grp_${groupId}`;
}

/**
 * Время последней отправки в группу — для медленного режима (v4.32.487).
 *
 * Тоже своё у каждого аккаунта: в одной группе это два разных участника, и
 * общая запись заставляла второго досиживать паузу первого.
 */
export function groupLastSentKey(groupId: string): string {
  return `grp_last_sent_${groupId}`;
}

/**
 * «Автору этой записи уже сообщено, что я её видел» (v4.32.536).
 *
 * До этой версии имя набиралось в feedService и писалось без префикса профиля.
 * Просмотр — это про КОНКРЕТНОГО зрителя: на одном телефоне два аккаунта, и
 * оба вправе сообщить автору, что видели запись. Общая отметка делала так, что
 * первый посмотревший закрывал вопрос за второго, и автор навсегда терял
 * половину просмотров. Заодно общее имя не попадало под уборку `p<id>:%`, то
 * есть переживало удаление аккаунта и доставалось следующему с тем же номером.
 */
export function feedViewSentKey(postId: string): string {
  return `feed_view_sent:${postId}`;
}

/** Список заблокированных пиров (см. rateLimiter.ts). */
export const BLOCKED_KEY_BASE = 'airchat_blocked_peer_pub_b64';

/**
 * Имя ключа блок-листа в v4.32.176…280 — суффикс `_p<id>` вместо префикса
 * `p<id>:`. Под общее правило не попадал, поэтому удаление профиля его не
 * уносило; нужен и для миграции, и для уборки за уже удалёнными профилями.
 */
export function legacySuffixBlockedKey(profileId: number): string {
  return `${BLOCKED_KEY_BASE}_p${profileId}`;
}

/**
 * Ключи kv, входящие в резервную копию, — в логическом виде (без префикса
 * профиля). v4.32.290: подсказки переписок ушли в namespace профиля, и
 * исключений в этом списке не осталось — всё, что входит в копию, принадлежит
 * профилю.
 */
const DIALOG_BACKUP_KEYS = [
  'contacts_index',
  BLOCKED_KEY_BASE,
  'conversation_tips',
  // v4.32.293: заглушённые авторы ленты. Это такое же собственное решение о
  // людях, как блок-лист рядом, и восстановление профиля без него означало бы
  // «все, кого убрал из ленты, вернулись» — молча и без способа вспомнить кто.
  'feed_muted_authors',
] as const;

/**
 * Логическое имя ключа (то, что попадает в файл копии) — или null, если такой
 * ключ в копию не входит.
 *
 * Он же и allow-list на импорте: без него подменённый файл мог бы переписать
 * ЛЮБОЙ ключ kv — profile_active_id, wallet_blocked, тему оформления.
 */
export function dialogBackupLogicalKey(storedKey: string): string | null {
  if (typeof storedKey !== 'string' || storedKey.length > 160) return null;
  const prefixStripped = storedKey.replace(/^p\d+:/, '');
  if (prefixStripped.length > 128) return null;
  // Блок-лист v4.32.176…280 назывался с суффиксом `_p<id>`. Логически это тот
  // же список: без этой строки блок-лист, не успевший мигрировать на префикс,
  // в копию не попадал бы вовсе.
  const logical = new RegExp(`^${BLOCKED_KEY_BASE}_p\\d+$`).test(prefixStripped)
    ? BLOCKED_KEY_BASE
    : prefixStripped;
  if ((DIALOG_BACKUP_KEYS as readonly string[]).includes(logical)) return logical;
  if (/^contact:[A-Za-z0-9+/=_-]{40,64}$/.test(logical)) return logical;
  return null;
}

/**
 * Какие строки kv забирать в копию профиля `profileId`.
 *
 * v4.32.289. Отбор жил в SQL-запросе экспорта и разошёлся с правилами чтения
 * сразу в две стороны:
 *
 * - блок-лист с v4.32.281 лежит под `p<id>:`, а запрос искал старое глобальное
 *   имя — которое к тому же удаляется при миграции. То есть в копию он не
 *   попадал ни разу с той версии, и после восстановления заблокированные
 *   возвращались как ни в чём не бывало;
 * - глобальные `contact:*` забирались в копию ЛЮБОГО профиля, хотя читает их
 *   только первый. В файле второго профиля оказывались контакты первого
 *   вместе с их симметричными ключами, а восстановление раскладывало их уже
 *   под `p<id>:` второго.
 *
 * Поэтому правило одно и здесь же, рядом с именами ключей.
 */
export function dialogBackupKeySelectors(profileId: number): {
  exact: string[];
  like: string[];
} {
  const exact = [
    ...DIALOG_BACKUP_KEYS.map((k) => profileScopedKey(profileId, k)),
    legacySuffixBlockedKey(profileId),
  ];
  const like = [`${profileScopedKey(profileId, 'contact:')}%`];
  if (profileId === 1) {
    // Записи без префикса писались, когда профиль был один: они принадлежат
    // первому — ровно так их читают и контакты, и блок-лист, и подсказки.
    exact.push(...DIALOG_BACKUP_KEYS);
    like.push('contact:%');
  }
  return { exact, like };
}

/**
 * Физическое имя ключа при восстановлении в профиль `profileId`. С v4.32.290
 * исключений нет: всё, что входит в копию, кладётся в namespace профиля.
 */
export function dialogBackupStoredKey(profileId: number, logicalKey: string): string {
  return profileScopedKey(profileId, logicalKey);
}
