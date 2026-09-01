import React, { memo, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { useTheme } from '../../../ThemeContext';

const EMOJIS: ReadonlyArray<string> = [
  '😀','😃','😄','😁','😆','😅','😂','🤣','😊','😇','🥰','😍','🤩','😘','😗','😚','😋','😛','😜','🤪','😝','🤑','🤗','🤔','🤐','😐','😑','😶','😏','😒','🙄','😬','😌','😔','😪','😴','😷','🤒','🤢','🤧','🥵','🥶','😵','🤯','🤠','🥳','😎','🤓',
  '😕','😟','🙁','☹️','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😤','😡','😠','🤬','😈','👿','💀','💩','🤡',
  '👋','✋','👌','✌️','🤞','🤟','👍','👎','✊','👊','👏','🙌','🤝','🙏','💪','🦵','🦶','👀','💋','🩸',
  '❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','☮️','✝️','☯️','🕎','🔯',
  '🎵','🎶','🎤','🎸','🥁','🎹','🎺','🎻','🪗','🎷','🎙️','🎚️','🎛️','📻','📺','📱','💻','⌨️','🖥️','🖨️','🖱️',
  '🔥','⭐','🌟','✨','💫','☀️','🌤️','⛅','🌦️','🌧️','⛈️','🌩️','❄️','🌈','💧','🌊',
  '🎉','🎊','🎈','🎁','🎀','🏆','🥇','🥈','🥉','🏅','🎯','🎮','🕹️','🃏','🎲','♟️','🧩','🪄','🎭','🎨','🖼️',
  '👻','💀','☠️','👽','🤖','🦊','🐱','🐶','🐻','🐼','🐨','🦁','🐯','🦊','🐺','🦝','🐧','🐦','🦆','🦅','🦉','🦇','🐝','🦋','🐌','🐞','🐜',
  '🍎','🍊','🍋','🍇','🍓','🫐','🍑','🍒','🥝','🥭','🍍','🥥','🍌','🍉','🍈','🍄','🌽','🥦','🥬','🥒','🌶️','🫑','🧄','🧅','🥔','🍠','🥐','🥯','🍞','🥖','🍕','🌮','🌯','🥙','🥚','🍳','🧀','🥞','🧇','🥓','🥩','🍗','🍖','🌭','🍔','🍟','🥨',
  '🚀','✈️','🚂','🚗','🚕','🚌','🚎','🏎️','🚓','🚑','🚒','🚐','🛻','🚚','🚛','🚜','🏍️','🛵','🚲','🛴','🛺','🚁','⛵','🚢','⚓','🗺️','🧭','⛽',
  '🏠','🏡','🏢','🏣','🏤','🏥','🏦','🏨','🏩','🏪','🏫','🏬','🏭','🏯','🏰','💒','🗼','⛪','🕌','🕍','⛩️','🕋',
  '💯','💢','💥','💫','💦','💨','🕳️','💣','💬','💭','💤','🔔','🔕','🎵','🎶','🎼','🔇','🔈','🔉','🔊','📣','📢','📯',
  '1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','0️⃣','🔟','#️⃣','*️⃣','⏫','⏬','⬆️','⬇️','⬅️','➡️','↕️','↔️','↩️','↪️','⤴️','⤵️','🔄','🔃','🔙','🔚','🔛','🔜','🔝',
];

export interface GroupReactionsMoreModalProps {
  visible: boolean;
  onClose: () => void;
  onReact: (emoji: string) => void;
}

function GroupReactionsMoreModalImpl({ visible, onClose, onReact }: GroupReactionsMoreModalProps) {
  const { colors } = useTheme();
  const stopPropagation = useCallback(() => {}, []);

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <AppPressable style={styles.backdrop} onPress={onClose}>
        <View style={styles.sheetWrap}>
          <AppPressable onPress={stopPropagation}>
            <View style={[styles.header, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
              <Text style={[styles.title, { color: colors.text }]}>Выбрать реакцию</Text>
              <AppPressable onPress={onClose}>
                <Ionicons name="close" size={22} color={colors.text} />
              </AppPressable>
            </View>
            <View style={[styles.body, { backgroundColor: colors.surface }]}>
              <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="always">
                <View style={styles.grid}>
                  {EMOJIS.map((e, idx) => (
                    <AppPressable
                      key={`${e}_${idx}`}
                      style={styles.emojiBtn}
                      onPress={() => {
                        onReact(e);
                        onClose();
                      }}
                    >
                      <Text style={styles.emojiText}>{e}</Text>
                    </AppPressable>
                  ))}
                </View>
              </ScrollView>
            </View>
          </AppPressable>
        </View>
      </AppPressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1 },
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { flex: 1, fontSize: 16, fontWeight: '700' },
  body: { height: 280 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', padding: 6 },
  emojiBtn: { width: 46, height: 46, alignItems: 'center', justifyContent: 'center' },
  emojiText: { fontSize: 26 },
});

export const GroupReactionsMoreModal = memo(GroupReactionsMoreModalImpl);
