/**
 * ProfileChatBlock — часть карточки профиля, которая относится к переписке
 * именно с этим человеком (v4.32.574).
 *
 * До этой версии у собеседника было ДВА профиля. Один — карточка
 * (UserProfilePeek): лицо, юзернейм, «О себе», быстрые действия, разделы
 * содержимого. Второй — шторка из шапки диалога (ChatContactInfoModal): своё
 * лицо, своё имя, свои строки, своя вёрстка. Открывались они из разных мест,
 * показывали одного и того же человека по-разному и расходились с каждой
 * правкой: обои, QR, привязанные аккаунты и «Ещё» появились только в первой,
 * ключ безопасности и заметка жили только во второй.
 *
 * Профиль остался один — карточка. Сюда переехало то, чего в ней не было и
 * что действительно про переписку, а не про человека: счёт сообщений, дата
 * первого, ключ безопасности, «уведомить когда онлайн», личная заметка,
 * выгрузка переписки и общие группы. Всё остальное из шторки в карточке уже
 * было и заводить его второй раз незачем.
 *
 * Блок рисуется только у чужого профиля: со своей перепиской с самим собой
 * сверять ключ безопасности не с кем.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { AppModal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { useColors } from '../../../ThemeContext';
import { avatarShape, font, glass, identityAvatar, mono, radius, scrim, spacing, withAlpha } from '../../../theme';
import { showError, showSuccess } from '../../userFeedback';
import { userErrorText } from '../../userErrorText';
import { usePresence } from '../../../hooks/usePresence';
import { membersLabel } from '../../../utils/plural';
import { nameInitial } from '../../../../core/social/contactLabel';
import { computeSafetyCode } from '../../../../core/social/safetyCode';
import { exportBody } from '../../../../core/social/exportLine';
import { shouldApplyRows } from '../../../../core/storage/readResult';
import { SECRET_UNREADABLE_TEXT } from '../../../../core/storage/secretUpdate';
import { readableMediaCount } from '../../../../core/media/sharedMediaScan';
import { shareTextExport } from '../../../../core/media/cacheFiles';
import { dayMonthLongYear, fullDateTime, numericDate } from '../../../../core/time/ruDateTime';
import {
  listConversationMedia,
  listGroupMembers,
  listGroups,
  type GroupRow,
} from '../../../../core/storage/local';

export function ProfileChatBlock({
  peerB64,
  myPubB64,
  displayName,
  activeProfileId,
  onOpenMedia,
}: {
  /** Открытый ключ собеседника. */
  peerB64: string;
  /** Свой открытый ключ: без него ключ безопасности не из чего собрать. */
  myPubB64: string | null;
  /** Имя, под которым человек записан здесь: им подписывается выгрузка. */
  displayName: string;
  activeProfileId: number;
  /** Открыть общие медиа — тем же окном, что и плашка «Медиа» в карточке. */
  onOpenMedia: () => void;
}): React.ReactElement {
  const colors = useColors();
  const presence = usePresence(peerB64);

  const [msgCount, setMsgCount] = useState(0);
  const [sentCount, setSentCount] = useState(0);
  const [firstMsgDate, setFirstMsgDate] = useState<number | null>(null);
  const [mediaCount, setMediaCount] = useState(0);
  const [mutualGroups, setMutualGroups] = useState<GroupRow[]>([]);
  const [contactNote, setContactNote] = useState('');
  const [noteEditVisible, setNoteEditVisible] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [notifyOnline, setNotifyOnline] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // v4.32.584: счётчик считает только то, что и правда покажем, а о
    // непрочитанном говорит подпись в самой галерее.
    void listConversationMedia(peerB64, activeProfileId)
      .then((m) => { if (!cancelled) setMediaCount(readableMediaCount(m)); })
      .catch(() => { /* галерея переживёт неизвестный счёт */ });
    void import('../../../../core/storage/local')
      .then((m) => m.getChatMessageStats(peerB64, activeProfileId))
      .then((stats) => {
        if (cancelled) return;
        setMsgCount(stats.messageCount);
        setSentCount(stats.sentCount);
        setFirstMsgDate(stats.firstMessageAt);
      })
      .catch(() => { /* счёт неизвестен — покажем нули, а не сломаемся */ });
    // v4.32.277: заметка о человеке — такой же личный текст, как и переписка,
    // и лежит она в той же БД. Читается и пишется через секретный kv.
    // v4.32.278: и в пространстве имён профиля — заметка про этого человека у
    // каждого аккаунта своя.
    void import('../../../../core/storage/local')
      .then((m) => m.kvGetSecretScoped(activeProfileId, m.contactNoteKey(peerB64)))
      .then((n) => { if (!cancelled) setContactNote(n ?? ''); })
      .catch(() => { /* заметки нет — строка предложит её завести */ });
    void import('../../../../core/settings/privacyPrefs')
      .then((m) => m.notifyOnlineGet(peerB64))
      .then((v) => { if (!cancelled) setNotifyOnline(v); })
      .catch(() => { /* настройка неизвестна — считаем выключенной */ });
    void (async () => {
      try {
        const groups = await listGroups(activeProfileId);
        const mutual: GroupRow[] = [];
        for (const g of groups) {
          const members = await listGroupMembers(g.id, activeProfileId);
          if (members.some((m) => m.peerPubB64 === peerB64)) mutual.push(g);
        }
        if (!cancelled) setMutualGroups(mutual);
      } catch { /* общие группы — справка, без неё карточка живёт */ }
    })();
    return () => { cancelled = true; };
  }, [peerB64, activeProfileId]);

  const safetyCode = useMemo(
    () => (myPubB64 && myPubB64 !== peerB64 ? computeSafetyCode(myPubB64, peerB64) : null),
    [myPubB64, peerB64]
  );

  const showSafetyCode = useCallback(() => {
    if (!safetyCode) return;
    Alert.alert(
      'Ключ безопасности',
      `Сравните этот код с кодом собеседника. Если коды совпадают — соединение защищено.\n\n${safetyCode}`,
      [{ text: 'OK' }]
    );
  }, [safetyCode]);

  const toggleNotifyOnline = useCallback(() => {
    const next = !notifyOnline;
    setNotifyOnline(next);
    void import('../../../../core/settings/privacyPrefs')
      .then((m) => m.notifyOnlineSet(peerB64, next))
      .catch(() => {
        // Настройка не записалась — вернуть переключатель обратно честнее,
        // чем оставить включённым то, чего не будет.
        setNotifyOnline(!next);
        showError('Не удалось изменить уведомление');
      });
    if (next) showSuccess(`Уведомим, когда ${displayName} появится онлайн`);
  }, [notifyOnline, peerB64, displayName]);

  const exportChat = useCallback(() => {
    void (async () => {
      try {
        const { listAllChatMessages } = await import('../../../../core/storage/local');
        const msgs = await listAllChatMessages({ contactPubB64: peerB64, ownerProfileId: activeProfileId });
        // v4.32.604: заголовок обещает число сообщений, поэтому усечённая
        // выгрузка врёт дважды. Либо всё, либо ничего.
        if (!shouldApplyRows(msgs)) { showError('Не удалось прочитать переписку для экспорта'); return; }
        const lines: string[] = [`Экспорт чата с ${displayName}`, `Дата: ${numericDate(Date.now())}`, `Сообщений: ${msgs.length}`, '─'.repeat(40), ''];
        for (const m of msgs.slice().reverse()) {
          const ts = fullDateTime(m.createdAt);
          const sender = m.direction === 'out' ? 'Я' : displayName;
          lines.push(`[${ts}] ${sender}: ${exportBody(m)}`);
        }
        // v4.32.310: имя `chat_<время>.txt` не подходило ни под один список
        // уборки — расшифрованная переписка оседала в кэше навсегда.
        // v4.32.313: и сама отдача теперь общая, см. cacheFiles.
        const shared = await shareTextExport('chat', lines.join('\n'), `Чат с ${displayName}`, Date.now());
        if (!shared) showError('Системное «Поделиться» недоступно');
      } catch (e) {
        showError(userErrorText(e, 'Ошибка экспорта'));
      }
    })();
  }, [peerB64, activeProfileId, displayName]);

  const saveNote = useCallback(() => {
    // v4.32.552: раньше «Заметка сохранена» показывалось, не дожидаясь
    // записи, — и было неправдой всякий раз, когда запись не удалась. Хуже
    // того: не открывшаяся заметка показывалась пустым полем, и сохранение
    // пустоты уничтожало текст. Теперь запись отклоняется, а человеку это
    // сказано.
    const draft = noteDraft.trim();
    setNoteEditVisible(false);
    void (async () => {
      const m = await import('../../../../core/storage/local');
      const res = await m.kvUpdateSecretScoped(
        activeProfileId,
        m.contactNoteKey(peerB64),
        () => draft
      );
      if (res === 'unreadable') { showError(SECRET_UNREADABLE_TEXT); return; }
      if (res === 'failed') { showError('Не удалось сохранить заметку'); return; }
      setContactNote(draft);
      showSuccess('Заметка сохранена');
    })();
  }, [noteDraft, activeProfileId, peerB64]);

  const deleteNote = useCallback(() => {
    // Строка удаляется целиком, а не затирается пустой: пустое значение —
    // это всё ещё запись «здесь была заметка».
    void import('../../../../core/storage/local')
      .then((m) => m.kvDeleteScoped(activeProfileId, m.contactNoteKey(peerB64)));
    setContactNote('');
    setNoteEditVisible(false);
  }, [activeProfileId, peerB64]);

  const rowBorder = { borderTopColor: withAlpha(colors.text, glass.rim) };
  const tile = {
    backgroundColor: withAlpha(colors.text, 0.06),
    borderColor: withAlpha(colors.text, glass.rim),
  };

  return (
    <View>
      <Text style={[styles.groupLabel, { color: colors.textSecondary }]}>Переписка</Text>

      {/* Счёт переписки: три числа в ряд. «Медиа» ведёт в ту же галерею, что
          и плашка в карточке, — второго списка рядом нет. */}
      <View style={[styles.statsRow, tile]}>
        <View style={styles.statCell}>
          <Text style={[styles.statNum, { color: colors.text }]}>{msgCount}</Text>
          <Text style={[styles.statLabel, { color: colors.textSecondary }]}>всего</Text>
        </View>
        <View style={[styles.statDivider, { backgroundColor: withAlpha(colors.text, glass.rim) }]} />
        <View style={styles.statCell}>
          <Text style={[styles.statNum, { color: colors.text }]}>{sentCount}</Text>
          <Text style={[styles.statLabel, { color: colors.textSecondary }]}>отправлено</Text>
        </View>
        <View style={[styles.statDivider, { backgroundColor: withAlpha(colors.text, glass.rim) }]} />
        <AppPressable
          style={styles.statCell}
          onPress={onOpenMedia}
          accessibilityRole="button"
          accessibilityLabel="Общие медиа"
        >
          <Text style={[styles.statNum, { color: mediaCount > 0 ? colors.accent : colors.text }]}>
            {mediaCount}
          </Text>
          <Text style={[styles.statLabel, { color: colors.textSecondary }]}>медиа</Text>
        </AppPressable>
      </View>
      {firstMsgDate ? (
        <Text style={[styles.since, { color: colors.textSecondary }]}>
          Первое сообщение — {dayMonthLongYear(firstMsgDate)}
        </Text>
      ) : null}

      {/* Ключ безопасности: строка, которую сверяют голосом. Оставлен на
          виду, а не спрятан в «Ещё»: спрятанный код не сверяет никто. */}
      {safetyCode ? (
        <AppPressable
          style={[styles.safetyBox, tile]}
          onPress={showSafetyCode}
          accessibilityRole="button"
          accessibilityLabel="Ключ безопасности"
          testID="profile_safety_code"
        >
          <Text style={[styles.safetyLabel, { color: colors.textSecondary }]}>КЛЮЧ БЕЗОПАСНОСТИ</Text>
          <Text style={[styles.safetyCode, { color: colors.text }]}>{safetyCode}</Text>
        </AppPressable>
      ) : null}

      <AppPressable
        style={[styles.row, rowBorder]}
        onPress={toggleNotifyOnline}
        accessibilityRole="button"
        accessibilityLabel="Уведомить когда онлайн"
        testID="profile_notify_online"
      >
        <Ionicons
          name={notifyOnline ? 'notifications' : 'notifications-outline'}
          size={20}
          color={notifyOnline ? colors.accent : colors.text}
        />
        <View style={styles.rowBody}>
          <Text style={[styles.rowText, { color: colors.text }]}>
            {notifyOnline ? 'Уведомление: онлайн вкл.' : 'Уведомить когда онлайн'}
          </Text>
          {presence.bucket === 'online' ? (
            <Text style={[styles.rowHint, { color: colors.success }]}>Сейчас онлайн</Text>
          ) : (
            <Text style={[styles.rowHint, { color: colors.textSecondary }]}>
              {notifyOnline ? 'Получите уведомление при входе' : presence.bucket === 'never' ? 'Не в сети' : presence.label}
            </Text>
          )}
        </View>
        {notifyOnline ? <Ionicons name="checkmark-circle" size={20} color={colors.accent} /> : null}
      </AppPressable>

      <AppPressable
        style={[styles.row, rowBorder]}
        onPress={() => { setNoteDraft(contactNote); setNoteEditVisible(true); }}
        accessibilityRole="button"
        accessibilityLabel="Заметка"
        testID="profile_contact_note"
      >
        <Ionicons name="document-text-outline" size={20} color={colors.text} />
        <View style={styles.rowBody}>
          <Text style={[styles.rowText, { color: colors.text }]}>Заметка</Text>
          <Text style={[styles.rowHint, { color: colors.textSecondary }]} numberOfLines={2}>
            {contactNote || 'Личная заметка — видна только вам'}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
      </AppPressable>

      <AppPressable
        style={[styles.row, rowBorder]}
        onPress={exportChat}
        accessibilityRole="button"
        accessibilityLabel="Экспорт чата"
        testID="profile_export_chat"
      >
        <Ionicons name="download-outline" size={20} color={colors.text} />
        <View style={styles.rowBody}>
          <Text style={[styles.rowText, { color: colors.text }]}>Экспорт чата</Text>
        </View>
      </AppPressable>

      {mutualGroups.length > 0 ? (
        <View style={styles.groupsBox}>
          <Text style={[styles.groupLabel, { color: colors.textSecondary }]}>Общие группы</Text>
          {mutualGroups.slice(0, 5).map((g) => (
            <View key={g.id} style={styles.groupRow}>
              <View style={[avatarShape(36), styles.groupAvatar, { backgroundColor: identityAvatar(g.id).fill }]}>
                <Text style={[styles.groupInitial, { color: identityAvatar(g.id).ink }]}>{nameInitial(g.name)}</Text>
              </View>
              <View style={styles.rowBody}>
                <Text style={[styles.rowText, { color: colors.text }]} numberOfLines={1}>{g.name}</Text>
                <Text style={[styles.rowHint, { color: colors.textSecondary }]}>{membersLabel(g.memberCount)}</Text>
              </View>
            </View>
          ))}
          {mutualGroups.length > 5 ? (
            <Text style={[styles.rowHint, { color: colors.textSecondary }]}>
              ещё {mutualGroups.length - 5}…
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* Заметка правится отдельным окном: многострочное поле в карточке
          отодвинуло бы всё, ради чего её открыли. */}
      <AppModal visible={noteEditVisible} transparent animationType="fade" onRequestClose={() => setNoteEditVisible(false)}>
        <KeyboardAvoidingView
          style={styles.noteHost}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={[styles.noteCard, { backgroundColor: colors.surface }]}>
            <Text style={[styles.noteTitle, { color: colors.text }]}>Заметка о контакте</Text>
            <TextInput
              style={[styles.noteInput, { borderColor: colors.border, color: colors.text }]}
              value={noteDraft}
              onChangeText={setNoteDraft}
              autoFocus
              multiline
              placeholderTextColor={colors.textSecondary}
              placeholder="Личная заметка (видна только вам)…"
            />
            <View style={styles.noteActions}>
              <AppPressable onPress={() => setNoteEditVisible(false)}>
                <Text style={[styles.noteBtn, { color: colors.textSecondary }]}>Отмена</Text>
              </AppPressable>
              {contactNote ? (
                <AppPressable onPress={deleteNote}>
                  <Text style={[styles.noteBtn, { color: colors.error }]}>Удалить</Text>
                </AppPressable>
              ) : null}
              <AppPressable onPress={saveNote}>
                <Text style={[styles.noteBtn, styles.noteSave, { color: colors.accent }]}>Сохранить</Text>
              </AppPressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </AppModal>
    </View>
  );
}

const styles = StyleSheet.create({
  groupLabel: {
    fontSize: font.xs,
    fontWeight: '600',
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
  },
  statCell: { flex: 1, alignItems: 'center' },
  statDivider: { width: StyleSheet.hairlineWidth, alignSelf: 'stretch' },
  statNum: { fontSize: font.lg, fontWeight: '700' },
  statLabel: { fontSize: font.xs, marginTop: spacing.xs / 2 },
  since: { fontSize: font.xs, marginTop: spacing.sm, textAlign: 'center' },
  safetyBox: {
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    marginTop: spacing.md,
  },
  safetyLabel: { fontSize: font.xs, fontWeight: '600' },
  safetyCode: { fontSize: font.md, fontFamily: mono, letterSpacing: 1.5, marginTop: spacing.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  rowBody: { flex: 1 },
  rowText: { fontSize: font.md },
  rowHint: { fontSize: font.xs, marginTop: spacing.xs / 2 },
  groupsBox: { marginTop: spacing.xs },
  groupRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.sm },
  groupAvatar: { alignItems: 'center', justifyContent: 'center' },
  groupInitial: { fontSize: font.sm, fontWeight: '700' },
  noteHost: { flex: 1, justifyContent: 'center', padding: spacing.xl, backgroundColor: scrim.modal },
  noteCard: { borderRadius: radius.xl, padding: spacing.lg },
  noteTitle: { fontSize: font.lg, fontWeight: '700', marginBottom: spacing.md },
  noteInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    fontSize: font.md,
    marginBottom: spacing.lg,
    minHeight: 80,
    textAlignVertical: 'top',
  },
  noteActions: { flexDirection: 'row', gap: spacing.md, justifyContent: 'flex-end' },
  noteBtn: { fontSize: font.md },
  noteSave: { fontWeight: '600' },
});
