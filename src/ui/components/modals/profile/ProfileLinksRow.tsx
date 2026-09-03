/**
 * ProfileLinksRow — привязанные учётные записи в карточке профиля
 * (v4.32.575).
 *
 * До этой версии GitHub и X были видны только их владельцу: привязка
 * доказывалась и записывалась на одном устройстве, а собеседник не видел ни
 * имени, ни того, что оно подтверждено. Теперь имя и адрес публикации едут
 * конвертом профиля (core/identity/profileLinks), и здесь они показываются
 * так, как есть на самом деле:
 *
 *  - у СВОЕЙ карточки подтверждение уже сделано — это оно и записано рядом;
 *  - у ЧУЖОЙ галочка появляется только после того, как её проверило это
 *    устройство. До проверки имя показывается заявленным, даже если адрес
 *    публикации приехал: конверт сообщает, где смотреть, а не что там лежит.
 *
 * Проверка — по нажатию, отдельным пунктом, и это не лишний шаг ради строгости.
 * Проверить значит сходить на github.com или x.com с IP человека, открывшего
 * карточку. Делать это самому при каждом тапе по имени в чате — значит
 * рассказывать двум чужим площадкам, кого он смотрит и когда.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { AppPressable } from '../../AppPressable';
import { useColors } from '../../../ThemeContext';
import { font, glass, radius, spacing, withAlpha } from '../../../theme';
import { openExternal } from '../../../utils/openExternal';
import { showError, showSuccess } from '../../userFeedback';
import { PLATFORM_LABEL, profileUrl, proofFailureText } from '../../../../core/identity/linkProof';
import type { ProfileLink } from '../../../../core/identity/profileLinks';
import { peerLinkVerifiedAt, verifyPeerLink } from '../../../../core/identity/peerLinkVerify';
import { rawErrorText } from '../../userErrorText';
import { log } from '../../../../core/logger';
import { dayMonthShortYear } from '../../../../core/time/ruDateTime';

export function ProfileLinksRow({
  links,
  peerPubB64,
  isSelf,
}: {
  links: ProfileLink[];
  peerPubB64: string;
  isSelf: boolean;
}): React.ReactElement | null {
  const colors = useColors();
  // Когда эта привязка проверена ЭТИМ устройством. null — ещё нет.
  const [checked, setChecked] = useState<Record<string, number | null>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setChecked({});
    if (isSelf) return;
    void (async () => {
      const out: Record<string, number | null> = {};
      for (const l of links) {
        out[l.p] = await peerLinkVerifiedAt(peerPubB64, l);
      }
      if (!cancelled) setChecked(out);
    })().catch((e: unknown) => {
      log.warn('peer_link_state_failed', { err: rawErrorText(e) });
    });
    return () => {
      cancelled = true;
    };
  }, [links, peerPubB64, isSelf]);

  const runCheck = useCallback(
    async (link: ProfileLink) => {
      setBusy(link.p);
      try {
        const res = await verifyPeerLink(peerPubB64, link);
        if (res.ok) {
          setChecked((prev) => ({ ...prev, [link.p]: res.verifiedAt }));
          showSuccess(`${PLATFORM_LABEL[link.p]} подтверждён: публикация принадлежит @${link.h}`);
        } else {
          showError(proofFailureText(res.reason, link.p));
        }
      } catch (e) {
        showError(proofFailureText('network', link.p));
        log.warn('peer_link_check_error', { err: rawErrorText(e) });
      } finally {
        setBusy(null);
      }
    },
    [peerPubB64]
  );

  const onPress = useCallback(
    (link: ProfileLink) => {
      const label = PLATFORM_LABEL[link.p];
      const url = profileUrl(link.p, link.h);
      const at = checked[link.p] ?? null;
      const verified = isSelf ? !!link.u : at !== null;
      const buttons: { text: string; style?: 'cancel'; onPress?: () => void }[] = [];
      if (url) {
        buttons.push({ text: `Открыть ${label}`, onPress: () => openExternal(url, 'profile_link') });
      }
      if (link.u) {
        buttons.push({
          text: 'Открыть публикацию',
          onPress: () => openExternal(link.u ?? '', 'profile_link_proof'),
        });
      }
      if (!isSelf && link.u && !verified) {
        buttons.push({ text: 'Проверить привязку', onPress: () => void runCheck(link) });
      }
      buttons.push({ text: 'Отмена', style: 'cancel' });
      Alert.alert(
        `${label}: @${link.h}`,
        verified
          ? isSelf
            ? 'Подтверждено вашей публикацией.'
            : `Вы проверили это ${dayMonthShortYear(at ?? 0)}: публикация по указанному адресу принадлежит @${link.h}, и подписана она ключом этого аккаунта.`
          : link.u
            ? 'Имя заявлено, и указан адрес публикации с доказательством. Пока вы её не проверили, это остаётся словами: проверка сходит по адресу с вашего устройства.'
            : 'Имя указано владельцем аккаунта и ничем не подтверждено.',
        buttons
      );
    },
    [checked, isSelf, runCheck]
  );

  if (links.length === 0) return null;

  return (
    <View style={styles.row}>
      {links.map((l) => {
        const at = checked[l.p] ?? null;
        const verified = isSelf ? !!l.u : at !== null;
        return (
          <AppPressable
            key={l.p}
            style={[
              styles.chip,
              {
                backgroundColor: withAlpha(colors.text, 0.06),
                borderColor: withAlpha(verified ? colors.success : colors.text, glass.rim),
              },
            ]}
            onPress={() => onPress(l)}
            disabled={busy === l.p}
            accessibilityRole="button"
            accessibilityLabel={`${PLATFORM_LABEL[l.p]}: @${l.h}, ${verified ? 'подтверждено' : 'без подтверждения'}`}
          >
            <Ionicons
              name={l.p === 'x' ? 'logo-twitter' : 'logo-github'}
              size={14}
              color={colors.textSecondary}
            />
            <Text style={[styles.handle, { color: colors.text }]} numberOfLines={1}>
              @{l.h}
            </Text>
            {verified ? (
              <Ionicons name="checkmark-circle" size={14} color={colors.success} />
            ) : (
              <Text style={[styles.state, { color: colors.textSecondary }]} numberOfLines={1}>
                {busy === l.p ? 'проверка…' : l.u && !isSelf ? 'проверить' : 'заявлено'}
              </Text>
            )}
          </AppPressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: '100%',
  },
  handle: { fontSize: font.xs, flexShrink: 1 },
  state: { fontSize: font.xs },
});
