import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, FlatList, StyleSheet, ActivityIndicator } from 'react-native';
import { AppPressable } from './AppPressable';
import { listContacts, type Contact } from '../../core/social/contacts';
import { rateLimiter } from '../../core/security/rateLimiter';
import { useTheme } from '../ThemeContext';
import { readableInk } from '../theme';
import { contactLabel } from '../../core/social/contactLabel';
import { shortIdentity } from '../identity/shortId';

export function BlockedContactsList(): React.ReactElement {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [blocked, setBlocked] = useState<string[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [keys, all] = await Promise.all([rateLimiter.getBlockedPubKeys(), listContacts()]);
      setBlocked(keys);
      setContacts(all);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const nameFor = (pubB64: string): string => {
    const c = contacts.find((x) => x.peerPublicKey === pubB64);
    return contactLabel(c?.displayName, shortIdentity(pubB64));
  };

  if (loading) {
    return (
      <View style={styles.center} testID="blocked_list_loading">
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (!blocked.length) {
    return (
      <Text style={styles.empty} testID="blocked_list_empty">
        Нет заблокированных контактов
      </Text>
    );
  }

  return (
    <FlatList
      testID="blocked_contacts_list"
      data={blocked}
      keyExtractor={(k) => k}
      renderItem={({ item }) => (
        <View style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.name}>{nameFor(item)}</Text>
            <Text style={styles.mono} numberOfLines={1}>
              {item.slice(0, 24)}…
            </Text>
          </View>
          <AppPressable
            style={styles.unblock}
            onPress={() => {
              void (async () => {
                await rateLimiter.unblockContact(item);
                await reload();
              })();
            }}
          >
            <Text style={styles.unblockText}>Разблокировать</Text>
          </AppPressable>
        </View>
      )}
    />
  );
}

// v4.32.171: style factory respects active theme (iOS HIG light/dark) — раньше
// цвета были захардкожены под тёмную тему, текст читался невидимым на светлой.
function makeStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    center: { padding: 24 },
    empty: { color: colors.textMuted, padding: 12 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderColor: colors.border,
    },
    rowText: { flex: 1, marginRight: 8 },
    name: { color: colors.text, fontWeight: '600' },
    mono: { color: colors.textMuted, fontSize: 11, marginTop: 4 },
    unblock: { backgroundColor: colors.primaryMuted, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
    // v4.32.407: `accent` подобран под ФОН страницы, а надпись лежит на
    // приглушённой заливке — на ней он давал 3.4–4.4:1 при любом акценте.
    unblockText: { color: readableInk(colors.accent, colors.primaryMuted, 4.5), fontWeight: '600', fontSize: 13 },
  });
}
