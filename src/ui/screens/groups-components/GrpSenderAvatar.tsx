import React from 'react';
import { View, Text } from 'react-native';
import { nameInitial } from '../../../core/social/contactLabel';
import { avatarShape, identityAvatar } from '../../theme';

/**
 * Кружок отправителя в групповой переписке.
 *
 * v4.32.399: `seed` отделён от `name` намеренно. Цвет должен держаться за
 * человека, а не за подпись: имя участник меняет, и с прежним выводом «тон из
 * имени» вместе с ним менялся цвет — причём только здесь, потому что в списке
 * участников тот же кружок выводился из ключа.
 */
export function GrpSenderAvatar({ name, seed, size = 28 }: { name: string; seed: string; size?: number }): React.ReactElement {
  const letter = nameInitial(name);
  const { fill, ink } = identityAvatar(seed);
  return (
    <View style={[avatarShape(size), { backgroundColor: fill, alignItems: 'center', justifyContent: 'center', marginRight: 6, flexShrink: 0 }]}>
      <Text style={{ fontSize: size * 0.44, fontWeight: '700', color: ink }}>{letter}</Text>
    </View>
  );
}
