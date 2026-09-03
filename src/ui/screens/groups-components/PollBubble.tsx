import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Clipboard } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppPressable } from '../../components/AppPressable';
import { AppModal as Modal } from '../../components/AppModal';
import { showError, showSuccess } from '../../components/userFeedback';
import { useTheme } from '../../ThemeContext';
import { bubbleSurface, font, pollInk, radius, scrim } from '../../theme';
import {
  parsePollText,
  getPollVotes,
  subscribeChatWrites,
  type GroupMemberRow,
} from '../../../core/storage/local';
import { castAndSyncPollVote, pollClosedKey } from '../../../core/social/pollVoteSync';
import { scopedKvGetFor } from '../../../core/storage/profileScopedKv';
import { votesLabel } from '../../utils/plural';
import { shortIdentity } from '../../identity/shortId';
import { COPIED_POLL_RESULTS } from '../../clipboardText';
import { PersonAvatar } from '../../components/PersonAvatar';

export function PollBubble({
  messageId,
  pollText,
  isMe,
  myPubB64,
  groupId,
  pid,
  members,
}: {
  messageId: string;
  pollText: string;
  isMe: boolean;
  myPubB64: string;
  /** Группа, по участникам которой рассылается голос. */
  groupId: string;
  pid: number;
  members?: GroupMemberRow[];
}): React.ReactElement {
  const { colors } = useTheme();
  // v4.32.492: см. DmPollBubble — разбор запоминается по тексту конверта.
  const poll = useMemo(() => parsePollText(pollText), [pollText]);
  const [votes, setVotes] = useState<Array<{ voterPubB64: string; optionIndex: number }>>([]);
  const [isClosed, setIsClosed] = useState(false);
  const [voterListOpt, setVoterListOpt] = useState<number | null>(null);

  const reload = useCallback(async () => {
    const [v, closed] = await Promise.all([
      getPollVotes(messageId, pid),
      // v4.32.251: флаг завершения перечитывается вместе с голосами — раньше он
      // читался один раз при монтировании, и присланное автором «Опрос
      // завершён» доходило до экрана только после перезахода в группу.
      // v4.32.484: отметка о завершении принадлежит профилю — читается из
      // его namespace, а не общая на всю установку.
      scopedKvGetFor(pid, pollClosedKey(messageId)),
    ]);
    setVotes(v);
    if (closed === '1') setIsClosed(true);
  }, [messageId, pid]);

  useEffect(() => { void reload(); }, [reload]);
  // v4.32.250: голоса участников приходят отдельными конвертами и пишутся в
  // poll_votes мимо этого компонента — без подписки цифры обновлялись бы
  // только при повторном открытии группы.
  useEffect(() => subscribeChatWrites(() => { void reload(); }), [reload]);

  // v4.32.411: запасная надпись брала белый руками — как и всё остальное,
  // она считается от заливки пузыря.
  if (!poll) return <Text style={{ color: bubbleSurface(colors, isMe, 'group').ink.text }}>Опрос</Text>;

  const isQuiz = poll.correctAnswer !== undefined;
  const allowMultiple = poll.allowMultiple ?? false;
  const myVotes = votes.filter((v) => v.voterPubB64 === myPubB64);
  const myVotedIndices = new Set(myVotes.map((v) => v.optionIndex));
  const hasVoted = myVotes.length > 0;
  // For unique voter count: count unique voters
  const uniqueVoterCount = new Set(votes.map((v) => v.voterPubB64)).size;
  // For per-option counts, count unique voters per option
  const optionVoterCounts = poll.options.map((_, idx) =>
    new Set(votes.filter((v) => v.optionIndex === idx).map((v) => v.voterPubB64)).size
  );
  const totalVotes = allowMultiple ? uniqueVoterCount : votes.length;

  const castVote = async (idx: number) => {
    if (isClosed) return; // poll is closed
    if (isQuiz && hasVoted) return; // quiz: can't revote
    // Повторное нажатие по своему варианту снимает голос. При одиночном выборе
    // нажатие по другому варианту его переносит — прошлый option удаляет сам
    // setPollVote (v4.32.48), отдельный DELETE не нужен.
    //
    // v4.32.250: раньше всё это писалось только в локальную БД, поэтому голоса
    // участников не сходились ни у кого. Теперь тот же голос уходит конвертом
    // всем участникам группы.
    const on = !myVotedIndices.has(idx);
    // v4.32.273: отказ проговаривается. Права могли ограничить уже после того,
    // как опрос отрисовался, — read-only участник иначе жал по варианту и не
    // получал ничего: ни голоса, ни объяснения.
    const res = await castAndSyncPollVote({
      msgId: messageId,
      idx,
      on,
      multi: allowMultiple,
      myPubB64,
      groupId,
    });
    if (!res.ok) showError(res.reason);
    await reload();
  };

  const ink = pollInk(colors, isMe);

  return (
    <View style={{ minWidth: 200 }}>
      <Text style={{ color: ink.text, fontWeight: '600', marginBottom: 8 }}>
        {isQuiz ? '🧠 ' : allowMultiple ? '☑️ ' : '📊 '}{poll.question}
      </Text>
      {isQuiz && hasVoted ? (
        myVotedIndices.has(poll.correctAnswer ?? -1)
          ? <Text style={{ color: ink.correct, fontWeight: '700', fontSize: 13, marginBottom: 6 }}>✅ Правильно!</Text>
          : <Text style={{ color: ink.wrong, fontWeight: '700', fontSize: 13, marginBottom: 6 }}>❌ Неверно</Text>
      ) : null}
      {poll.options.map((opt, idx) => {
        const count = optionVoterCounts[idx];
        const pct = totalVotes > 0 ? count / totalVotes : 0;
        const isMyChoice = myVotedIndices.has(idx);
        const isCorrect = isQuiz && poll.correctAnswer === idx;
        const showResult = hasVoted || !isQuiz;
        // Полоса цвета дорожки — это отсутствие полосы: доля голосов у варианта
        // не читалась бы вовсе. Невыбранный неверный вариант приглушается
        // слабой полосой, а не стирается.
        let barColor = isMyChoice ? ink.barMine : ink.bar;
        if (isQuiz && hasVoted) {
          barColor = isCorrect ? ink.correctBar : (isMyChoice ? ink.wrongBar : ink.bar);
        }
        return (
          <AppPressable key={idx} onPress={() => void castVote(idx)} style={{ marginBottom: 6 }} disabled={(isQuiz && hasVoted) || isClosed}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
              {allowMultiple ? (
                <View style={{ width: 18, height: 18, borderRadius: radius.sm, borderWidth: 1.5, borderColor: isMyChoice ? ink.accentFill : ink.muted, backgroundColor: isMyChoice ? ink.accentFill : 'transparent', alignItems: 'center', justifyContent: 'center', marginRight: 8 }}>
                  {isMyChoice ? <Ionicons name="checkmark" size={12} color={ink.onAccent} /> : null}
                </View>
              ) : null}
              <Text style={{ color: isMyChoice ? ink.accent : (isQuiz && hasVoted && isCorrect ? ink.correct : ink.text), fontWeight: isMyChoice || (isQuiz && isCorrect) ? '700' : '400', flex: 1 }}>
                {!allowMultiple && isMyChoice ? '✓ ' : (!allowMultiple && isQuiz && hasVoted && isCorrect ? '✓ ' : '')}{opt}
              </Text>
              {showResult ? (
                !poll.anonymous && count > 0 ? (
                  <AppPressable hitSlop={6} onPress={(e) => { e.stopPropagation(); setVoterListOpt(idx); }}>
                    <Text style={{ color: ink.muted, fontSize: font.xs, textDecorationLine: 'underline' }}>{count}</Text>
                  </AppPressable>
                ) : (
                  <Text style={{ color: ink.muted, fontSize: font.xs }}>{count}</Text>
                )
              ) : null}
            </View>
            {showResult ? (
              <View style={{ height: 4, borderRadius: 2, backgroundColor: ink.track, overflow: 'hidden' }}>
                <View style={{ height: 4, borderRadius: 2, backgroundColor: barColor, width: `${pct * 100}%` }} />
              </View>
            ) : null}
          </AppPressable>
        );
      })}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 8 }}>
        {isClosed ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', padding: 4, borderRadius: radius.md, backgroundColor: ink.track }}>
            <Ionicons name="lock-closed" size={11} color={ink.onTrack} style={{ marginRight: 3 }} />
            <Text style={{ color: ink.onTrack, fontSize: font.xs, fontWeight: '600' }}>Завершён</Text>
          </View>
        ) : null}
        <Text style={{ color: ink.muted, fontSize: font.xs, flex: 1 }}>
          {isQuiz ? 'Викторина · ' : ''}
          {allowMultiple ? '☑️ Несколько · ' : ''}
          {poll.anonymous ? '🔒 Без имён · ' : ''}
          {votesLabel(totalVotes)}
        </Text>
        {totalVotes > 0 ? (
          <AppPressable
            onPress={() => {
              const lines2 = [`📊 ${poll.question}`, ''];
              poll.options.forEach((opt, idx) => {
                const cnt = optionVoterCounts[idx];
                const pct = totalVotes > 0 ? Math.round(cnt / totalVotes * 100) : 0;
                const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
                lines2.push(`${opt}: ${cnt} (${pct}%) ${bar}`);
              });
              lines2.push('', `Всего голосов: ${totalVotes}`);
              Clipboard.setString(lines2.join('\n'));
              showSuccess(COPIED_POLL_RESULTS);
            }}
            hitSlop={8}
          >
            <Ionicons name="copy-outline" size={13} color={ink.muted} />
          </AppPressable>
        ) : null}
      </View>

      {/* Voter list modal for non-anonymous polls */}
      <Modal
        visible={voterListOpt !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setVoterListOpt(null)}
      >
        <AppPressable
          style={{ flex: 1, backgroundColor: scrim.modal, justifyContent: 'center', padding: 24 }}
          onPress={() => setVoterListOpt(null)}
        >
          <AppPressable
            onPress={(e) => e.stopPropagation()}
            style={{ backgroundColor: colors.surface, borderRadius: radius.xl, maxHeight: '70%', overflow: 'hidden' }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
              <Ionicons name="people-outline" size={18} color={colors.accent} style={{ marginRight: 8 }} />
              <Text style={{ flex: 1, fontSize: 16, fontWeight: '700', color: colors.text }} numberOfLines={1}>
                {voterListOpt !== null ? poll.options[voterListOpt] : ''}
              </Text>
              <AppPressable onPress={() => setVoterListOpt(null)}>
                <Ionicons name="close" size={20} color={colors.textMuted} />
              </AppPressable>
            </View>
            {(() => {
              if (voterListOpt === null) return null;
              // v4.32.254: список схлопывался по ИМЕНИ, а не по ключу. Имя
              // участник задаёт сам, поэтому двое с одинаковым displayName
              // сливались в одну строку — список расходился со счётчиком рядом
              // с вариантом (тот считает по ключам), и достаточно было взять
              // себе чужое имя, чтобы спрятать свой голос за ним. По той же
              // причине «Вы» искали сравнением имён и вешали метку на однофамильца.
              const uniqueVoters = [
                ...new Set(votes.filter((v) => v.optionIndex === voterListOpt).map((v) => v.voterPubB64)),
              ];
              if (uniqueVoters.length === 0) {
                return (
                  <Text style={{ color: colors.textMuted, textAlign: 'center', padding: 24, fontSize: 14 }}>
                    Нет голосов
                  </Text>
                );
              }
              return (
                <ScrollView style={{ maxHeight: 300 }}>
                  {uniqueVoters.map((pub, i) => {
                    const name = members?.find((mb) => mb.peerPubB64 === pub)?.displayName ?? shortIdentity(pub);
                    return (
                      <View key={pub} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: i < uniqueVoters.length - 1 ? StyleSheet.hairlineWidth : 0, borderBottomColor: colors.border }}>
                        {/* v4.32.565: лицо голосовавшего, если оно известно.
                            v4.32.409: иначе — тот же различитель, что везде,
                            а не столбец одинаковых акцентных точек. */}
                        <PersonAvatar pub={pub} name={name} size={32} style={{ marginRight: 12 }} />
                        <Text style={{ color: colors.text, fontSize: 14, flex: 1 }} numberOfLines={1}>{name}</Text>
                        {pub === myPubB64 ? (
                          <Text style={{ color: colors.textMuted, fontSize: 12 }}>Вы</Text>
                        ) : null}
                      </View>
                    );
                  })}
                </ScrollView>
              );
            })()}
          </AppPressable>
        </AppPressable>
      </Modal>
    </View>
  );
}
