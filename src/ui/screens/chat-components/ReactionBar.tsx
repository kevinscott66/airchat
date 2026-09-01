import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { AppPressable } from '../../components/AppPressable';
import { useTheme } from '../../ThemeContext';
import { reactionInk } from '../../theme';
import { parseReactionMap } from '../../../core/social/reactionMapPolicy';
import { UNREADABLE_REACTIONS_TEXT } from '../../../core/storage/unreadableText';

// ─── Reaction bar on a message ───────────────────────────────────────────────
export function ReactionBar({
  reactions,
  host,
  unreadable,
  onReactionTap,
}: {
  reactions: string | null;
  /**
   * Заливка поверхности, НА КОТОРОЙ лежит плашка: свой пузырь, чужой пузырь
   * или фон ленты у сообщения из одних эмодзи. Из неё считаются и заливка
   * плашки, и цвет счётчика (v4.32.395).
   */
  host: string;
  /**
   * Столбец с реакциями не открылся ключом данных (v4.32.600). Прежде он
   * приходил сюда пустой строкой и был неотличим от «на это никто не
   * реагировал»: плашки не рисовались, а нажатие на эмодзи получало отказ
   * (писать в такой столбец запрещено с v4.32.544) — будто бы из ниоткуда.
   */
  unreadable?: boolean;
  onReactionTap?: (emoji: string, dids: string[], reactions: string) => void;
}): React.ReactElement | null {
  const { colors } = useTheme();
  // v4.32.509: разбор ячейки — один на все шесть мест, где она читается
  // (core/social/reactionMapPolicy). Своя копия здесь принимала на веру, что
  // значение по эмодзи — массив строк, хотя приходит оно из базы.
  const entries = Object.entries(parseReactionMap(reactions));
  const ink = reactionInk(colors, host);
  if (!entries.length) {
    if (!unreadable) return null;
    return (
      <View style={rStyles.row}>
        <View style={[rStyles.pill, { backgroundColor: ink.fill }]}>
          <Text style={[rStyles.count, { color: colors.warning }]}>{UNREADABLE_REACTIONS_TEXT}</Text>
        </View>
      </View>
    );
  }
  return (
    <View style={rStyles.row}>
      {entries.map(([emoji, dids]) => (
        <AppPressable
          key={emoji}
          style={[rStyles.pill, { backgroundColor: ink.fill }]}
          onPress={() => onReactionTap?.(emoji, dids, reactions ?? '')}
        >
          <Text style={rStyles.emoji}>{emoji}</Text>
          {dids.length > 1 ? <Text style={[rStyles.count, { color: ink.count }]}>{dids.length}</Text> : null}
        </AppPressable>
      ))}
    </View>
  );
}

const rStyles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  // Ни заливки, ни цвета счётчика здесь нет: они зависят от поверхности под
  // плашкой, а StyleSheet считается один раз при загрузке модуля.
  pill: { flexDirection: 'row', alignItems: 'center', borderRadius: 10, paddingHorizontal: 6, paddingVertical: 2, gap: 2 },
  emoji: { fontSize: 13 },
  count: { fontSize: 11 },
});
