import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { AppPressable } from '../../components/AppPressable';
import { useColors } from '../../ThemeContext';
import { primaryInk } from '../../theme';
import { groupSendProblemShort, type GroupSendProblem } from '../../../core/social/groupSendOutcome';

/**
 * Значок под собственным сообщением в группе (v4.32.951).
 *
 * До этой версии он рисовался так: у самого последнего отправленного за этот
 * заход сообщения — одна галочка, у всех остальных — двойная. Двойная в общем
 * языке переписок означает «доставлено», и в личном чате она означает ровно
 * это: там у сообщения есть настоящее состояние, которое двигают квитанции
 * (см. MessageStatusIcon). В группе никакого состояния не было — двойная
 * галочка появлялась просто оттого, что человек написал следующее сообщение.
 * То есть «доставлено» рисовалось и на сообщении, которое не ушло никому:
 * рассылка группы происходит ПОСЛЕ записи строки, и её отказ до этой версии
 * жил ровно столько, сколько висела плашка.
 *
 * Теперь значок говорит только то, что известно:
 *  • отметка о несостоявшейся рассылке — восклицательный знак, «не отправлено»;
 *  • есть квитанции о прочтении — закрашенная двойная, «прочитано»;
 *  • иначе — одна галочка, «отправлено»: конверт ушёл в рассылку и об отказе
 *    не сообщили.
 *
 * «Доставлено» не рисуется вовсе, и это намеренно: подтверждения доставки в
 * группе нет ни у кого — есть только прочтение.
 *
 * Заодно у значка появилось имя для озвучки: прежде его не было ни у одного
 * из двух состояний, и человек, который не видит экрана, о судьбе своего
 * сообщения не узнавал ничего.
 */
export function GroupMessageStatusIcon({
  problem,
  seenCount,
  onDarkFill,
  onProblemPress,
}: {
  /** Отметка «не ушло», если она есть. */
  problem: GroupSendProblem | null;
  /** Сколько участников прислали квитанцию о прочтении. */
  seenCount: number;
  /** Значок лежит на заливке своего пузыря, а не на фоне переписки. */
  onDarkFill: boolean;
  /** Нажатие на восклицательный знак — назвать причину целой фразой. */
  onProblemPress?: () => void;
}): React.ReactElement {
  const colors = useColors();
  const ink = primaryInk(colors);
  const muted = onDarkFill ? ink.muted : colors.textMuted;
  if (problem) {
    return (
      <AppPressable
        accessibilityRole="button"
        accessibilityLabel={`Не отправлено: ${groupSendProblemShort(problem)}`}
        onPress={onProblemPress}
        hitSlop={8}
      >
        <Ionicons
          name="alert-circle-outline"
          size={13}
          color={onDarkFill ? ink.error : colors.error}
          style={{ marginLeft: 2 }}
        />
      </AppPressable>
    );
  }
  if (seenCount > 0) {
    return (
      <Ionicons
        name="checkmark-done"
        size={13}
        color={onDarkFill ? ink.accent : colors.accent}
        style={{ marginLeft: 2 }}
        accessibilityLabel="Прочитано"
      />
    );
  }
  return (
    <Ionicons
      name="checkmark-outline"
      size={13}
      color={muted}
      style={{ marginLeft: 2 }}
      accessibilityLabel="Отправлено"
    />
  );
}
