import React, { useCallback, useSyncExternalStore } from 'react';
import { View, Text, Image, StyleProp, ViewStyle, ImageStyle } from 'react-native';
import { nameInitial } from '../../core/social/contactLabel';
import { avatarSourceFor, subscribeAvatarsChanged } from '../../core/social/avatarRegistry';
import { useResolvedMediaUrl, useIpfsGateway } from '../screens/chat-components/useResolvedMediaUrls';
import { avatarShape, identityAvatar } from '../theme';

/**
 * Кружок человека: снимок, если он известен, иначе буква на цветном фоне.
 *
 * v4.32.565. Один и тот же человек до сих пор выглядел по-разному на каждом
 * экране: в профиле — своим снимком, в списке чатов, в ленте и в группе —
 * буквой. Здесь фото ищется по общему реестру (core/social/avatarRegistry) и
 * рисуется везде, где кружок ставится через этот компонент.
 *
 * Запасной вариант остаётся прежним: буква на тоне из `seed`. Он нужен не
 * только тем, у кого фото нет, — вложение расшифровывается асинхронно, и до
 * конца расшифровки кружок должен уже занимать своё место, иначе строка
 * списка дёргается.
 */
export function PersonAvatar({
  pub,
  did,
  name,
  size = 40,
  style,
}: {
  /** Открытый ключ собеседника (base64). */
  pub?: string | null;
  /** did:key — им подписан автор публикации в ленте. */
  did?: string | null;
  /**
   * Подпись: из неё берётся буква и тон запасного кружка. Допускается null —
   * имя участника может не открыться ключом, и кружок тогда рисуется с «?».
   */
  name: string | null | undefined;
  size?: number;
  style?: StyleProp<ViewStyle>;
}): React.ReactElement {
  const key = pub || did || '';
  // Реестр перечитывается на изменение контактов и на смену своего снимка;
  // без подписки уже открытый список чатов остался бы с прежними кружками.
  // Снимок берётся прямо из таблицы: пока её не перестроили, это одна и та же
  // ссылка, и лишней перерисовки строки не будет.
  const src = useSyncExternalStore(
    subscribeAvatarsChanged,
    useCallback(() => avatarSourceFor(key), [key]),
  );
  const gateway = useIpfsGateway();
  const resolved = useResolvedMediaUrl(src?.cid ?? null, gateway);
  const uri = src?.uri ?? resolved;

  const shape = avatarShape(size);
  if (uri) {
    // Приведение нужно из-за overflow: в ViewStyle у него есть значение
    // 'scroll', которого нет в ImageStyle. Кружку оно не пригождается, а поля и
    // размеры, ради которых style сюда и передают, у обоих одни.
    return <Image source={{ uri }} style={[shape, style as StyleProp<ImageStyle>]} />;
  }
  const { fill, ink } = identityAvatar(key || name || '?');
  return (
    <View style={[shape, { backgroundColor: fill, alignItems: 'center', justifyContent: 'center' }, style]}>
      <Text style={{ fontSize: size * 0.44, fontWeight: '700', color: ink }}>{nameInitial(name)}</Text>
    </View>
  );
}
