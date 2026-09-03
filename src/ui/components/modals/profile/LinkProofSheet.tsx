/**
 * LinkProofSheet — привязка X и GitHub через подтверждение владения (v4.32.573).
 *
 * Раньше это были два обычных поля: человек писал «@durov» — и приложение
 * показывало «@durov». Написать туда можно было что угодно, и ровно поэтому
 * такая строка не значила ничего: она сообщала не «вот мой X», а «вот что я
 * набрал». Ссылка, которой нельзя верить, хуже отсутствующей — по ней ведь
 * переходят.
 *
 * Здесь имя не набирается, а привязывается. Приложение подписывает своим
 * ключом строку «этот GitHub принадлежит владельцу такого-то аккаунта»,
 * человек публикует её у себя — в gist или в посте, — а приложение читает
 * публикацию и сверяет две вещи: подпись (значит, строку выпустил этот
 * аккаунт) и автора публикации по API площадки (значит, её выложил владелец
 * имени). Порознь ни одна половина не доказывает ничего: подписанную строку
 * можно скопировать в чужую публикацию, а свою публикацию — сделать с чужой
 * строкой. Сходятся обе — имя привязано.
 *
 * Остаётся и путь «указать без подтверждения»: человек вправе назвать своё
 * имя на площадке, ничего не публикуя. Такое имя показывается без галочки и
 * так и подписано — «не подтверждено». Отказ площадки отвечать (`network`)
 * отделён от несовпадения умышленно: «мы не смогли проверить» и «это не
 * сходится» — разные новости, и вести они должны в разные стороны.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';

import { AppPressable } from '../../AppPressable';
import { SheetShell } from '../../SheetShell';
import { showError, showSuccess } from '../../userFeedback';
import { COPIED_TEXT, COPY_ACTION } from '../../../clipboardText';
import { openExternal } from '../../../utils/openExternal';
import { useColors } from '../../../ThemeContext';
import { font, glass, radius, spacing, withAlpha } from '../../../theme';
import { loadKeyPair } from '../../../../core/crypto/keyManager';
import { signJson } from '../../../../core/crypto/signature';
import { ownAccountRef } from '../../../../core/identity/accountRef';
import {
  PLATFORM_LABEL,
  encodeProofToken,
  normalizeHandle,
  proofFailureText,
  proofStatementText,
  type LinkPlatform,
  type LinkRecord,
} from '../../../../core/identity/linkProof';
import { checkLinkProof } from '../../../../core/identity/linkProofCheck';

/** Куда человека отправляют публиковать строку. */
const PUBLISH_URL: Record<LinkPlatform, string> = {
  github: 'https://gist.github.com/',
  x: 'https://x.com/compose/post',
};

const PUBLISH_HINT: Record<LinkPlatform, string> = {
  github: 'Создайте публичный gist с этим текстом и вставьте сюда его адрес.',
  x: 'Опубликуйте этот текст постом и вставьте сюда его адрес.',
};

export function LinkProofSheet({
  visible,
  platform,
  publicKeyB64,
  initialHandle,
  linked,
  onClose,
  onLinked,
  onUnlinked,
}: {
  visible: boolean;
  platform: LinkPlatform;
  publicKeyB64: string;
  initialHandle: string;
  /** Уже привязано — тогда лист начинается с состояния «подтверждено». */
  linked: boolean;
  onClose: () => void;
  onLinked: (handle: string, record: LinkRecord | null) => void;
  onUnlinked: () => void;
}): React.ReactElement {
  const colors = useColors();
  const label = PLATFORM_LABEL[platform];

  const [handle, setHandle] = useState(initialHandle);
  const [statement, setStatement] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Площадка не ответила: предложить сохранить без подтверждения честно. */
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setHandle(initialHandle);
    setStatement(null);
    setUrl('');
    setError(null);
    setOffline(false);
    setBusy(false);
  }, [visible, initialHandle]);

  /** Выпустить строку: подписать имя своим ключом. */
  const issue = useCallback(async () => {
    const h = normalizeHandle(platform, handle);
    if (!h) {
      setError(`Такого имени на ${label} не бывает. Проверьте написание.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const pair = await loadKeyPair();
      if (!pair) {
        setError('Ключ аккаунта недоступен — перезапустите приложение.');
        return;
      }
      const signed = await signJson(pair, { v: 1, p: platform, h, k: publicKeyB64, t: Date.now() });
      setHandle(h);
      setStatement(proofStatementText(encodeProofToken(signed.payload, signed.signature), ownAccountRef(), platform));
    } catch {
      setError('Не удалось подготовить строку подтверждения.');
    } finally {
      setBusy(false);
    }
  }, [handle, label, platform, publicKeyB64]);

  /** Прочитать публикацию и сверить обе половины. */
  const verify = useCallback(async () => {
    setBusy(true);
    setError(null);
    setOffline(false);
    try {
      const res = await checkLinkProof(url.trim(), { platform, handle, publicKeyB64 });
      if (res.ok) {
        onLinked(handle, { url: url.trim(), verifiedAt: Date.now() });
        showSuccess(`${label} привязан`);
        onClose();
        return;
      }
      setError(proofFailureText(res.reason, platform));
      setOffline(res.reason === 'network');
    } finally {
      setBusy(false);
    }
  }, [handle, label, onClose, onLinked, platform, publicKeyB64, url]);

  const copy = useCallback(async () => {
    if (!statement) return;
    try {
      await Clipboard.setStringAsync(statement);
      showSuccess(COPIED_TEXT);
    } catch {
      showError('Не удалось скопировать');
    }
  }, [statement]);

  const saveClaimed = useCallback(() => {
    const h = normalizeHandle(platform, handle);
    if (!h) {
      setError(`Такого имени на ${label} не бывает. Проверьте написание.`);
      return;
    }
    onLinked(h, null);
    onClose();
  }, [handle, label, onClose, onLinked, platform]);

  const fieldStyle = [
    styles.input,
    { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface },
  ];

  return (
    <SheetShell visible={visible} onClose={onClose} testID="link_proof_sheet">
      <ScrollView keyboardShouldPersistTaps="handled" style={styles.scroll}>
        <Text style={[styles.title, { color: colors.text }]}>Привязать {label}</Text>
        <Text style={[styles.lead, { color: colors.textSecondary }]}>
          Имя подтверждается публикацией: так рядом с ним появляется галочка, а не просто текст.
        </Text>

        <Text style={[styles.label, { color: colors.textSecondary }]}>Имя на {label}</Text>
        <TextInput
          style={fieldStyle}
          value={handle}
          onChangeText={(v) => {
            setHandle(v);
            setStatement(null);
            setError(null);
          }}
          placeholder={platform === 'x' ? '@username' : 'username'}
          placeholderTextColor={colors.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!busy}
          testID="link_proof_handle"
        />

        {statement === null ? (
          <AppPressable
            style={[styles.primary, { backgroundColor: colors.accent }]}
            onPress={() => void issue()}
            disabled={busy}
            accessibilityRole="button"
            testID="link_proof_issue"
          >
            <Text style={[styles.primaryText, { color: colors.background }]}>Продолжить</Text>
          </AppPressable>
        ) : (
          <>
            <Text style={[styles.label, { color: colors.textSecondary }]}>Опубликуйте этот текст</Text>
            <View style={[styles.statement, { borderColor: colors.border }]}>
              <Text style={[styles.statementText, { color: colors.text }]} selectable>
                {statement}
              </Text>
            </View>
            <View style={styles.row}>
              <AppPressable
                style={[styles.secondary, { borderColor: colors.border }]}
                onPress={() => void copy()}
                accessibilityRole="button"
                testID="link_proof_copy"
              >
                <Ionicons name="copy-outline" size={16} color={colors.text} />
                <Text style={[styles.secondaryText, { color: colors.text }]}>{COPY_ACTION}</Text>
              </AppPressable>
              <AppPressable
                style={[styles.secondary, { borderColor: colors.border }]}
                onPress={() => openExternal(PUBLISH_URL[platform], 'link_proof_publish')}
                accessibilityRole="button"
                testID="link_proof_open"
              >
                <Ionicons name="open-outline" size={16} color={colors.text} />
                <Text style={[styles.secondaryText, { color: colors.text }]}>Открыть {label}</Text>
              </AppPressable>
            </View>
            <Text style={[styles.hint, { color: colors.textSecondary }]}>{PUBLISH_HINT[platform]}</Text>

            <Text style={[styles.label, { color: colors.textSecondary }]}>Адрес публикации</Text>
            <TextInput
              style={fieldStyle}
              value={url}
              onChangeText={(v) => {
                setUrl(v);
                setError(null);
              }}
              placeholder={platform === 'github' ? 'https://gist.github.com/…' : 'https://x.com/…/status/…'}
              placeholderTextColor={colors.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              editable={!busy}
              testID="link_proof_url"
            />
            <AppPressable
              style={[styles.primary, { backgroundColor: colors.accent }]}
              onPress={() => void verify()}
              disabled={busy || url.trim().length === 0}
              accessibilityRole="button"
              testID="link_proof_verify"
            >
              <Text style={[styles.primaryText, { color: colors.background }]}>
                {busy ? 'Проверяем…' : 'Проверить'}
              </Text>
            </AppPressable>
          </>
        )}

        {error ? (
          <Text style={[styles.error, { color: colors.error }]} testID="link_proof_error">
            {error}
          </Text>
        ) : null}

        {/* Путь без подтверждения не спрятан, но и не предлагается первым: он
            даёт имя без галочки, и человек должен видеть, чем платит. */}
        {offline || statement === null ? (
          <AppPressable
            style={styles.plain}
            onPress={saveClaimed}
            accessibilityRole="button"
            testID="link_proof_claim"
          >
            <Text style={[styles.plainText, { color: colors.textSecondary }]}>
              Указать без подтверждения
            </Text>
          </AppPressable>
        ) : null}

        {linked || initialHandle ? (
          <AppPressable
            style={styles.plain}
            onPress={() => {
              onUnlinked();
              onClose();
            }}
            accessibilityRole="button"
            testID="link_proof_unlink"
          >
            <Text style={[styles.plainText, { color: colors.error }]}>Отвязать {label}</Text>
          </AppPressable>
        ) : null}
      </ScrollView>
    </SheetShell>
  );
}

const styles = StyleSheet.create({
  scroll: { maxHeight: 520 },
  title: { fontSize: font.md, fontWeight: '700', textAlign: 'center' },
  lead: { fontSize: font.sm, textAlign: 'center', marginTop: spacing.xs },
  label: {
    fontSize: font.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    fontSize: font.md,
  },
  statement: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.sm,
    backgroundColor: withAlpha(glass.shadeInk, glass.shade),
  },
  statementText: { fontSize: font.xs },
  row: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  secondary: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
  },
  secondaryText: { fontSize: font.sm, fontWeight: '600' },
  primary: {
    alignItems: 'center',
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    marginTop: spacing.md,
  },
  primaryText: { fontSize: font.md, fontWeight: '700' },
  hint: { fontSize: font.xs, marginTop: spacing.xs },
  error: { fontSize: font.sm, marginTop: spacing.sm },
  plain: { alignItems: 'center', paddingVertical: spacing.sm, marginTop: spacing.xs },
  plainText: { fontSize: font.sm, fontWeight: '600' },
});

export default LinkProofSheet;
