import React from 'react';
import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { GroupType } from '../../../core/storage/local';
import { nameInitial } from '../../../core/social/contactLabel';
import { identityAvatar } from '../../theme';

/** Тон канала задан, а не выведен: канал узнаётся как канал, а не как «этот». */
const CHANNEL_HUE = 200;

export function GroupAvatar({ name, size = 48, type }: { name: string; size?: number; type?: GroupType }): React.ReactElement {
  const letter = nameInitial(name);
  const { fill, ink } = identityAvatar(type === 'channel' ? CHANNEL_HUE : (name || '?'));
  const icon = type === 'channel' ? 'megaphone' : 'people';
  return (
    <View style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: fill, alignItems: 'center', justifyContent: 'center' }]}>
      {name ? (
        <Text style={{ color: ink, fontSize: size * 0.42, fontWeight: '600' }}>{letter}</Text>
      ) : (
        <Ionicons name={icon} size={size * 0.5} color={ink} />
      )}
    </View>
  );
}
