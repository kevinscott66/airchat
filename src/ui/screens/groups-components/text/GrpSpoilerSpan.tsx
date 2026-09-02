import React, { useState } from 'react';
import { Text } from 'react-native';
import { radius, spoilerPlate } from '../../../theme';

/**
 * Спойлер — плашка, скрывающая текст до нажатия.
 *
 * v4.32.417: цвет плашки был вписан как '#888' — тот же литерал, что и в двух
 * других копиях этого компонента. Спойлер лежит НА пузыре, и на исходящем
 * пузыре светлой темы серединный серый давал 1.44:1: то, что текст закрыт,
 * почти не читалось. Теперь цвет считается от пузыря (см. `spoilerPlate`).
 */
export function GrpSpoilerSpan({ text, style, host }: { text: string; style?: object; host: string }): React.ReactElement {
  const [revealed, setRevealed] = useState(false);
  if (revealed) return <Text style={style}>{text}</Text>;
  return (
    <Text
      style={[style, { backgroundColor: spoilerPlate(host), color: 'transparent', borderRadius: radius.sm }]}
      onPress={() => setRevealed(true)}
    >{text}</Text>
  );
}
