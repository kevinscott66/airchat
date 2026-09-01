import { Platform, type TextStyle } from 'react-native';

/**
 * Вложенный `<Text style={…}>` только для символа эмодзи.
 * На iOS основной `fontFamily` в родителе часто ломает цветные эмодзи → «квадраты с ?».
 * @see https://developer.apple.com/fonts/
 */
export function appleColorEmojiTextStyle(): TextStyle {
  return Platform.OS === 'ios' ? { fontFamily: 'Apple Color Emoji' } : {};
}
