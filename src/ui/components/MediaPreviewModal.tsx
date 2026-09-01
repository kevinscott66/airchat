// @stable  НЕ ИЗМЕНЯТЬ без явного запроса пользователя.
// Причина: единый Telegram-style preview для выбора/отправки фото в DM (ChatScreen)
//          и групповых чатах (GroupsScreen). Нумерованные бейджи 1..N, "+Добавить"-плитка,
//          счётчик «N / MAX», «Очистить», view-once toggle, caption над клавиатурой.
//          Работает как bottom-sheet Modal + KeyboardAvoidingView — Android adjustResize +
//          behavior="padding" на iOS удерживают caption-input над клавиатурой.
//          Тот же UX использован в FeedScreen compose (inline-превью) — см. v4.32.54.
import React from 'react';
import {
  View,
  Text,
  TextInput,
  Image,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppPressable } from './AppPressable';
import { AppModal as Modal } from './AppModal';
import { useColors } from '../ThemeContext';
import { badgeTint, contrastingInk, scrim } from '../theme';

const THUMB = 88;

export type MediaPreviewModalProps = {
  visible: boolean;
  uris: string[];
  caption: string;
  viewOnce?: boolean;
  viewOnceAvailable?: boolean; // можно ли вообще показывать toggle view-once
  maxImages?: number; // default 10
  title?: string; // header override (по умолчанию "N фото")
  captionPlaceholder?: string;
  sendLabel?: string; // "Отправить" / "Опубликовать"
  onCaptionChange: (text: string) => void;
  onViewOnceChange?: (value: boolean) => void;
  onRemoveAt: (index: number) => void;
  onClearAll: () => void;
  onAddMore?: () => void; // тап по "+Добавить" плитке
  onCancel: () => void; // закрыть без отправки
  onSend: () => void;
};

/**
 * Telegram-style preview для multi-select фото/видео.
 * Рендерится как bottom-sheet Modal; caption всегда над клавиатурой.
 */
export function MediaPreviewModal(props: MediaPreviewModalProps) {
  const colors = useColors();
  // v4.32.409: три плашки листа предпросмотра подмешивались прозрачностью на
  // месте вызова, а надписи на них брались из палитры. Лист — поверхность.
  const tint = badgeTint(colors, 'accent', colors.surface);
  const {
    visible,
    uris,
    caption,
    viewOnce = false,
    viewOnceAvailable = true,
    maxImages = 10,
    title,
    captionPlaceholder = 'Добавить подпись…',
    sendLabel = 'Отправить',
    onCaptionChange,
    onViewOnceChange,
    onRemoveAt,
    onClearAll,
    onAddMore,
    onCancel,
    onSend,
  } = props;

  const headerTitle = title ?? (uris.length > 1 ? `${uris.length} фото` : 'Фото');
  const canAddMore = !!onAddMore && uris.length < maxImages;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onCancel}
    >
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: scrim.viewer, justifyContent: 'flex-end' }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View
          style={{
            backgroundColor: colors.surface,
            borderTopLeftRadius: 18,
            borderTopRightRadius: 18,
            paddingBottom: 20,
          }}
        >
          {/* Header: закрыть / заголовок / view-once / Отправить */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 16,
              paddingVertical: 12,
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: colors.border,
            }}
          >
            <AppPressable onPress={onCancel} style={{ marginRight: 16 }} hitSlop={8}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </AppPressable>
            <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700', flex: 1 }} numberOfLines={1}>
              {headerTitle}
            </Text>
            {viewOnceAvailable && onViewOnceChange ? (
              <AppPressable
                onPress={() => onViewOnceChange(!viewOnce)}
                style={{
                  marginRight: 10,
                  padding: 6,
                  borderRadius: 18,
                  backgroundColor: viewOnce ? tint.fill : 'transparent',
                }}
                hitSlop={8}
              >
                <Ionicons
                  name={viewOnce ? 'eye' : 'eye-outline'}
                  size={22}
                  color={viewOnce ? tint.ink : colors.textMuted}
                />
              </AppPressable>
            ) : null}
            <AppPressable
              style={{
                backgroundColor: colors.primary,
                borderRadius: 20,
                paddingHorizontal: 16,
                paddingVertical: 8,
              }}
              onPress={onSend}
            >
              <Text style={{ color: contrastingInk(colors.primary), fontWeight: '700' }}>{sendLabel}</Text>
            </AppPressable>
          </View>

          {/* Подсказка view-once */}
          {viewOnce ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 16,
                paddingVertical: 6,
                backgroundColor: tint.fill,
              }}
            >
              <Ionicons name="eye-outline" size={14} color={tint.ink} style={{ marginRight: 6 }} />
              <Text style={{ color: tint.ink, fontSize: 12, fontWeight: '500' }}>
                Одноразовый просмотр — фото исчезнет после открытия
              </Text>
            </View>
          ) : null}

          {/* Counter + Очистить */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 16,
              paddingTop: 10,
              paddingBottom: 4,
            }}
          >
            <Text style={{ fontSize: 13, color: colors.textSecondary }}>
              Выбрано: <Text style={{ fontWeight: '600', color: colors.text }}>{uris.length}</Text>
              {' / '}
              {maxImages}
            </Text>
            {uris.length >= maxImages ? (
              <Text style={{ fontSize: 12, color: colors.accent, fontWeight: '600', marginLeft: 6 }}>
                · максимум
              </Text>
            ) : null}
            <View style={{ flex: 1 }} />
            {uris.length > 1 ? (
              <AppPressable
                onPress={onClearAll}
                hitSlop={8}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  borderRadius: 10,
                }}
              >
                <Ionicons name="trash-outline" size={14} color={colors.error} />
                <Text style={{ fontSize: 12, color: colors.error, fontWeight: '600', marginLeft: 4 }}>
                  Очистить
                </Text>
              </AppPressable>
            ) : null}
          </View>

          {/* Нумерованные превью + "+ Добавить" */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            style={{ maxHeight: THUMB + 28 }}
            contentContainerStyle={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingVertical: 10,
              paddingHorizontal: 12,
            }}
          >
            {uris.map((uri, i) => (
              <View
                key={`media-preview-${uri}-${i}`}
                style={{
                  marginRight: 10,
                  position: 'relative',
                  width: THUMB,
                  height: THUMB,
                  borderRadius: 14,
                  backgroundColor: colors.primaryMuted,
                }}
              >
                <Image
                  source={{ uri }}
                  style={{ width: THUMB, height: THUMB, borderRadius: 14, backgroundColor: colors.primaryMuted }}
                  resizeMode="cover"
                />
                {/* Синий нумерованный бейдж 1/2/3 — Telegram-style */}
                <View
                  style={{
                    position: 'absolute',
                    right: 4,
                    top: 4,
                    minWidth: 22,
                    height: 22,
                    paddingHorizontal: 6,
                    borderRadius: 11,
                    backgroundColor: colors.primary,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderWidth: 2,
                    borderColor: contrastingInk(colors.primary),
                  }}
                >
                  <Text style={{ color: contrastingInk(colors.primary), fontSize: 11, fontWeight: '700' }}>{i + 1}</Text>
                </View>
                {/* Кнопка удаления ×  */}
                <AppPressable
                  style={{
                    position: 'absolute',
                    top: -6,
                    left: -6,
                    backgroundColor: colors.background,
                    borderRadius: 12,
                  }}
                  onPress={() => onRemoveAt(i)}
                  hitSlop={8}
                >
                  <Ionicons name="close-circle" size={24} color={colors.error} />
                </AppPressable>
              </View>
            ))}
            {/* "+ Добавить" плитка в конце, если лимит не достигнут */}
            {canAddMore ? (
              <AppPressable
                style={{
                  width: THUMB,
                  height: THUMB,
                  borderRadius: 14,
                  borderWidth: 2,
                  borderColor: colors.accent,
                  borderStyle: 'dashed',
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: tint.fill,
                }}
                onPress={onAddMore}
                hitSlop={4}
              >
                <Ionicons name="add" size={32} color={tint.ink} />
                <Text style={{ fontSize: 11, color: tint.ink, marginTop: 2, fontWeight: '600' }}>
                  Добавить
                </Text>
              </AppPressable>
            ) : null}
          </ScrollView>

          {/* Caption input — всегда над клавиатурой (KAV + adjustResize) */}
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 8 }}>
            <TextInput
              style={{
                flex: 1,
                color: colors.text,
                fontSize: 15,
                backgroundColor: colors.surfaceHigh,
                borderRadius: 20,
                paddingHorizontal: 14,
                paddingVertical: 10,
                maxHeight: 100,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: colors.border,
              }}
              value={caption}
              onChangeText={onCaptionChange}
              placeholder={captionPlaceholder}
              placeholderTextColor={colors.textMuted}
              multiline
              maxLength={500}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
