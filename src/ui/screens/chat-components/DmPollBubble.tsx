import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Clipboard, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppPressable } from '../../components/AppPressable';
import { showError, showSuccess } from '../../components/userFeedback';
import { useTheme } from '../../ThemeContext';
import { pollInk } from '../../theme';
import {
  getPollVotes,
  parsePollText,
  subscribeChatWrites,
} from '../../../core/storage/local';
import { castAndSyncPollVote, pollClosedKey } from '../../../core/social/pollVoteSync';
import { scopedKvGetFor } from '../../../core/storage/profileScopedKv';
import { votesLabel } from '../../utils/plural';
import { COPIED_POLL_RESULTS } from '../../clipboardText';

// ─── Poll bubble (DM chats) ───────────────────────────────────────────────────
export function DmPollBubble({
  messageId,
  pollText,
  isOut,
  myPubB64,
  peerPubB64,
  pid,
}: {
  messageId: string;
  pollText: string;
  isOut: boolean;
  myPubB64: string;
  /** Собеседник, которому уходит голос. */
  peerPubB64: string;
  pid: number;
}): React.ReactElement {
  const { colors } = useTheme();
  // v4.32.492: как и в ленте — разбор на каждый рендер не нужен; здесь он
  // в зависимостях не стоит, поэтому речь только о лишней работе.
  const poll = useMemo(() => parsePollText(pollText), [pollText]);
  const [votes, setVotes] = useState<Array<{ voterPubB64: string; optionIndex: number }>>([]);
  const [isClosed, setIsClosed] = useState(false);
  const reload = useCallback(async () => {
    const [v, closed] = await Promise.all([
      getPollVotes(messageId, pid),
      // v4.32.251: флаг завершения перечитывается вместе с голосами — раньше он
      // читался один раз при монтировании, и присланное автором «Опрос
      // завершён» доходило до экрана только после перезахода в чат.
      // v4.32.484: отметка о завершении принадлежит профилю — читается из
      // его namespace, а не общая на всю установку.
      scopedKvGetFor(pid, pollClosedKey(messageId)),
    ]);
    setVotes(v);
    if (closed === '1') setIsClosed(true);
  }, [messageId, pid]);
  useEffect(() => { void reload(); }, [reload]);
  // v4.32.250: голос собеседника приходит отдельным конвертом и пишется в
  // poll_votes мимо этого компонента — без подписки цифры обновлялись бы
  // только при повторном открытии чата.
  useEffect(() => subscribeChatWrites(() => { void reload(); }), [reload]);
  const ink = pollInk(colors, isOut);
  if (!poll) return <Text style={{ color: ink.text }}>Опрос</Text>;
  const isQuiz = poll.correctAnswer !== undefined;
  const allowMultiple = poll.allowMultiple ?? false;
  const myVotedIndices = new Set(votes.filter((v) => v.voterPubB64 === myPubB64).map((v) => v.optionIndex));
  const hasVoted = myVotedIndices.size > 0;
  // v4.32.250: при нескольких ответах один человек даёт несколько строк, и
  // «всего голосов» превращалось в «всего галочек» — считаем людей, как в
  // групповом пузыре.
  const total = allowMultiple
    ? new Set(votes.map((v) => v.voterPubB64)).size
    : votes.length;
  // v4.32.254: счёт по вариантам считался в двух местах по-разному — в списке
  // по уникальным голосующим, а в «скопировать результаты» по строкам таблицы.
  // Сейчас это одно и то же число, но расходиться им незачем.
  const optionVoterCounts = poll.options.map((_, idx) =>
    new Set(votes.filter((v) => v.optionIndex === idx).map((v) => v.voterPubB64)).size
  );

  /** Ставит или снимает голос и рассылает его собеседнику. */
  const castVote = (idx: number): void => {
    if (isClosed) return;
    if (isQuiz && hasVoted) return; // викторина: переголосовать нельзя
    // Повторное нажатие по своему варианту снимает голос; при одиночном
    // выборе нажатие по другому варианту его переносит (это делает setPollVote).
    const on = !myVotedIndices.has(idx);
    void castAndSyncPollVote({
      msgId: messageId,
      idx,
      on,
      multi: allowMultiple,
      myPubB64,
      peerPubB64,
    }).then((res) => {
      // v4.32.273: отказ проговаривается. Кнопку блокирует isClosed, но
      // «Опрос завершён» могло прийти уже после отрисовки пузыря — и нажатие
      // тогда просто не давало ничего, без единого слова почему.
      if (!res.ok) showError(res.reason);
      void reload();
    });
  };

  return (
    <View style={{ minWidth: 200 }}>
      <Text style={{ color: ink.text, fontWeight: '600', marginBottom: 8 }}>{isQuiz ? '🧠 ' : allowMultiple ? '☑️ ' : '📊 '}{poll.question}</Text>
      {isQuiz && hasVoted ? (
        myVotedIndices.has(poll.correctAnswer ?? -1)
          ? <Text style={{ color: ink.correct, fontWeight: '700', fontSize: 13, marginBottom: 6 }}>✅ Правильно!</Text>
          : <Text style={{ color: ink.wrong, fontWeight: '700', fontSize: 13, marginBottom: 6 }}>❌ Неверно</Text>
      ) : null}
      {poll.options.map((opt, idx) => {
        const count = optionVoterCounts[idx];
        const pct = total > 0 ? count / total : 0;
        const isMine = myVotedIndices.has(idx);
        const isCorrect = isQuiz && poll.correctAnswer === idx;
        // Полоса цвета дорожки — это отсутствие полосы: доля голосов у варианта
        // не читалась бы вовсе. Невыбранный неверный вариант приглушается
        // слабой полосой, а не стирается.
        let barColor = isMine ? ink.barMine : ink.bar;
        if (isQuiz && hasVoted) barColor = isCorrect ? ink.correctBar : (isMine ? ink.wrongBar : ink.bar);
        return (
          <AppPressable key={idx} onPress={() => castVote(idx)} disabled={(hasVoted && isQuiz) || isClosed}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
              <Text style={{ color: isMine ? ink.accent : (isQuiz && hasVoted && isCorrect ? ink.correct : ink.text), fontWeight: isMine || (isQuiz && isCorrect) ? '700' : '400', flex: 1 }}>
                {isMine ? '✓ ' : (isQuiz && hasVoted && isCorrect ? '✓ ' : '')}{opt}
              </Text>
              <Text style={{ color: ink.muted, fontSize: 11 }}>{count}</Text>
            </View>
            <View style={{ height: 4, borderRadius: 2, backgroundColor: ink.track, overflow: 'hidden', marginBottom: 6 }}>
              <View style={{ height: 4, borderRadius: 2, backgroundColor: barColor, width: `${pct * 100}%` }} />
            </View>
          </AppPressable>
        );
      })}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 8 }}>
        {isClosed ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', padding: 4, borderRadius: 6, backgroundColor: ink.track }}>
            <Ionicons name="lock-closed" size={11} color={ink.onTrack} style={{ marginRight: 3 }} />
            <Text style={{ color: ink.onTrack, fontSize: 11, fontWeight: '600' }}>Завершён</Text>
          </View>
        ) : null}
        <Text style={{ color: ink.muted, fontSize: 11, flex: 1 }}>{isQuiz ? 'Викторина · ' : ''}{allowMultiple ? '☑️ Несколько · ' : ''}{poll.anonymous ? '🔒 Без имён · ' : ''}{votesLabel(total)}</Text>
        {total > 0 ? (
          <AppPressable
            onPress={() => {
              const optCounts = poll.options.map((opt, idx) => {
                const cnt = optionVoterCounts[idx];
                const pct = total > 0 ? Math.round(cnt / total * 100) : 0;
                const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
                return `${opt}: ${cnt} (${pct}%) ${bar}`;
              });
              const resultText = [`📊 ${poll.question}`, '', ...optCounts, '', `Всего голосов: ${total}`].join('\n');
              Clipboard.setString(resultText);
              showSuccess(COPIED_POLL_RESULTS);
            }}
            hitSlop={8}
          >
            <Ionicons name="copy-outline" size={13} color={ink.muted} />
          </AppPressable>
        ) : null}
      </View>
    </View>
  );
}
