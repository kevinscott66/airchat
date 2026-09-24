/**
 * Мост для внешнего агента: включение, ключ доступа, отзыв (v4.32.723).
 *
 * Секция стоит рядом с OpenFlux не по родству темы, а по последствиям: и то и
 * другое меняет, как приложение ходит в сеть, и человек, пришедший сюда,
 * пришёл именно за этим.
 *
 * Ключ не показывается сам собой. Он даёт право включить туннель и переписать
 * настройки, и человек открывает настройки не только у себя дома — иногда
 * рядом стоят и смотрят. Показать его придётся нажатием, и это тот редкий
 * случай, когда лишний шаг оправдан.
 *
 * Про фон здесь написано без «возможно» и «в некоторых случаях». Человек
 * должен уйти отсюда, зная ответ на единственный вопрос, который у него есть:
 * ответит ли мост, когда я сверну приложение. Уклончивая формулировка на этом
 * месте хуже, чем её отсутствие: она создаёт впечатление, что ответ есть.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';

import { AppSwitch } from './AppSwitch';
import { BrandedQr } from './BrandedQr';
import { font, radius } from '../theme';
import { useThemedStyles } from '../ThemeContext';
import { showConfirm, showError, showSuccess } from './userFeedback';
import { rawErrorText, userErrorText } from './userErrorText';
import { log } from '../../core/logger';
import { COPIED_TEXT, COPY_ACTION, COPY_FAILED } from '../clipboardText';
import { loadConfig } from '../../core/config';
import { DEFAULT_RELAY_BASE } from '../../core/transport/internet/relayConfig';
import {
  formatAccessKey,
  loadBridgeSecret,
  loadOrCreateBridgeSecret,
  rotateBridgeSecret,
} from '../../core/bridge/agentBridgeKeys';
import {
  isBridgeEnabled,
  setBridgeEnabled,
  startAgentBridgeIfEnabled,
  stopAgentBridge,
} from '../../core/bridge/agentBridge';

/** Сторона QR-кода. Ключ длинный, мельче он перестаёт ловиться. */
const QR_SIZE = 200;

/**
 * Что происходит со свёрнутым приложением — по системам, без оговорок.
 *
 * iOS: выполнение JavaScript останавливается через несколько секунд после
 * сворачивания, сокет закрывается. В приложении есть фоновое удержание
 * тишиной в аудиосессии (`core/social/backgroundKeepalive`), но оно сделано
 * ради звонков, работает не всегда и не бесконечно, и обещать по нему ответ
 * моста нельзя. Обходить это фоновыми уловками мы не станем: на iOS они не
 * работают, а в App Store с ними не пускают.
 *
 * Android: пока поднят туннель OpenFlux, работает служба переднего плана, и
 * процесс живёт вместе с ней. Погас туннель — служба остановлена, и дальше
 * приложение живёт ровно столько, сколько ему отмерит система.
 */
const BACKGROUND_NOTE =
  Platform.OS === 'ios'
    ? 'Со свёрнутым приложением мост не отвечает. iOS останавливает приложение через несколько секунд после сворачивания. Чтобы агент достучался, приложение должно быть открыто на экране.'
    : Platform.OS === 'android'
      ? 'Со свёрнутым приложением мост отвечает, пока включён туннель OpenFlux: туннель держит службу переднего плана, и вместе с ней работает приложение. Без туннеля система выгружает приложение из памяти когда сочтёт нужным, и мост замолкает.'
      : 'Мост отвечает, пока приложение запущено.';

export function AgentBridgeSettingsSection(): React.ReactElement {
  const [enabled, setEnabled] = useState(false);
  const [accessKey, setAccessKey] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);

  const refreshKey = useCallback(async () => {
    const secret = await loadBridgeSecret();
    if (!secret) {
      setAccessKey(null);
      return;
    }
    const cfg = await loadConfig();
    setAccessKey(formatAccessKey(secret, cfg.internet?.relayBase ?? DEFAULT_RELAY_BASE));
  }, []);

  useEffect(() => {
    void (async () => {
      setEnabled(await isBridgeEnabled());
      await refreshKey();
    })();
  }, [refreshKey]);

  const onToggle = useCallback(
    async (on: boolean) => {
      if (busy) return;
      setBusy(true);
      // Рычажок двигаем сразу: подписка поднимается секундами, и застывший в
      // прежнем положении переключатель читается как «не нажалось».
      setEnabled(on);
      try {
        if (on) {
          // Ключ заводится при первом включении, а не при открытии экрана:
          // 32 случайных байта в хранилище у человека, который мостом
          // никогда не пользовался, — лишняя запись и лишний повод для
          // вопроса «что это».
          await loadOrCreateBridgeSecret();
          await refreshKey();
          await setBridgeEnabled(true);
          await startAgentBridgeIfEnabled();
        } else {
          await setBridgeEnabled(false);
          stopAgentBridge();
          // Спрятать обратно: выключенный мост не должен оставлять ключ
          // открытым на экране.
          setRevealed(false);
        }
      } catch (e) {
        setEnabled(!on);
        // Слова разные, потому что положение дел разное. Не включилось — канал
        // закрыт, ничего страшного не случилось. А вот сорвавшееся выключение
        // означает, что мост остался открытым: человек думает, что отозвал
        // доступ к телефону, а доступ есть. Об этом надо сказать прямо.
        showError(
          userErrorText(
            e,
            on ? 'Не удалось включить мост' : 'Мост остался включённым: настройка не сохранилась',
          ),
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, refreshKey],
  );

  const copyKey = useCallback(async () => {
    if (!accessKey) return;
    // v4.32.837: отказ буфера больше не пропадает. Зовут отсюда `void
    // copyKey()` без `.catch`, и отказ уходил в неперехваченное отклонение:
    // человек соглашался на предупреждение, ничего не происходило, и он шёл
    // вставлять агенту то, что лежало в буфере до этого.
    try {
      await Clipboard.setStringAsync(accessKey);
    } catch (e) {
      log.warn('agent_bridge_key_copy_failed', { err: rawErrorText(e) });
      showError(COPY_FAILED);
      return;
    }
    // Текст подтверждения — из общего словаря (ui/clipboardText): у копирования
    // в приложении одно слово на всех, и заводить здесь своё значит разойтись.
    showSuccess(COPIED_TEXT);
  }, [accessKey]);

  // Буфер обмена общий на всё устройство, а на Apple — ещё и общий между
  // устройствами одного Apple ID (Universal Clipboard). Ключ здесь —
  // предъявительский мандат: строка `airchat-bridge://…` содержит и секрет, и
  // адрес сервера, больше для управления ничего не нужно. Поэтому не копируем
  // молча — человек решает это сам, зная цену; рядом стоит код, через который
  // ключ вообще не покидает экран.
  const onCopyPress = useCallback(() => {
    if (!accessKey) return;
    showConfirm({
      // Глагол — из общего словаря: «Копировать» против «Скопировать» здесь
      // уже расходились, и `clipboardText.test` это ловит.
      title: `${COPY_ACTION} ключ?`,
      message:
        'Ключ уйдёт в буфер обмена: его прочитает любое приложение, которое вы откроете следом, а на iPhone и Mac с одним Apple ID он появится на всех устройствах сразу. Надёжнее показать агенту код на экране. Сразу после вставки скопируйте что-нибудь другое.',
      actions: [
        {
          label: `Всё равно ${COPY_ACTION.toLowerCase()}`,
          destructive: true,
          onPress: () => {
            void copyKey();
          },
        },
        { label: 'Отмена', cancel: true },
      ],
    });
  }, [accessKey, copyKey]);

  const revoke = useCallback(async () => {
    try {
      await rotateBridgeSecret();
      await refreshKey();
      setRevealed(false);
      if (await isBridgeEnabled()) await startAgentBridgeIfEnabled();
      showSuccess('Выдан новый ключ. Прежний больше не действует');
    } catch (e) {
      showError(userErrorText(e, 'Не удалось выдать новый ключ'));
    }
  }, [refreshKey]);

  const onRevokePress = useCallback(() => {
    showConfirm({
      title: 'Выдать новый ключ?',
      message: 'Агент, которому выдан прежний ключ, потеряет доступ немедленно.',
      actions: [
        {
          label: 'Выдать новый',
          destructive: true,
          onPress: () => {
            void revoke();
          },
        },
        { label: 'Отмена', cancel: true },
      ],
    });
  }, [revoke]);

  const styles = useThemedStyles((c) => ({
    sectionTitle: {
      color: c.textSecondary,
      fontSize: font.sm,
      fontWeight: '600' as const,
      marginTop: 16,
      marginBottom: 8,
    },
    hint: { color: c.textMuted, fontSize: font.xs, marginBottom: 8, lineHeight: 16 },
    card: {
      backgroundColor: c.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: c.border,
      padding: 12,
    },
    switchRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'space-between' as const,
      gap: 12,
    },
    switchLabel: { color: c.text, fontSize: font.md, fontWeight: '600' as const, flexShrink: 1 },
    warn: { color: c.warning, fontSize: font.xs, marginTop: 10, lineHeight: 16 },
    keyBox: {
      marginTop: 12,
      backgroundColor: c.surfaceHigh,
      borderRadius: radius.md,
      padding: 10,
    },
    keyText: { color: c.text, fontSize: font.xs, lineHeight: 16 },
    keyHidden: { color: c.textMuted, fontSize: font.xs },
    rowBtns: { flexDirection: 'row' as const, gap: 8, marginTop: 10 },
    btn: {
      flex: 1,
      backgroundColor: c.surfaceHigh,
      borderRadius: radius.md,
      paddingVertical: 10,
      alignItems: 'center' as const,
      flexDirection: 'row' as const,
      justifyContent: 'center' as const,
      gap: 6,
    },
    btnText: { color: c.text, fontSize: font.sm, fontWeight: '700' as const },
    revokeText: { color: c.error, fontSize: font.sm, fontWeight: '700' as const },
    qrWrap: { alignItems: 'center' as const, marginTop: 12 },
    qrNote: { color: c.textMuted, fontSize: font.xs, marginTop: 6, textAlign: 'center' as const },
    accent: { color: c.accent },
    errColor: { color: c.error },
  }));

  return (
    <View>
      <Text style={styles.sectionTitle}>МОСТ ДЛЯ ВНЕШНЕГО АГЕНТА</Text>
      <Text style={styles.hint}>
        Позволяет программе на компьютере узнавать состояние туннеля, включать и выключать его и
        править настройки этого устройства. Переписку мост не читает и сообщений не отправляет —
        но он правит адрес сервера доставки, а значит тот, у кого окажется ключ, может перевести
        вашу доставку на свой сервер. Ключ давайте только своей программе. Команды идут через тот
        же сервер доставки, отдельной темой; телефон ничего не слушает снаружи.
      </Text>
      <View style={styles.card}>
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>Разрешить управление извне</Text>
          <AppSwitch
            value={enabled}
            onValueChange={(v) => {
              void onToggle(v);
            }}
            disabled={busy}
            testID="agent_bridge_switch"
          />
        </View>

        <Text style={styles.warn}>{BACKGROUND_NOTE}</Text>

        {enabled && accessKey ? (
          <>
            <Pressable
              style={styles.keyBox}
              onPress={() => setRevealed((v) => !v)}
              testID="agent_bridge_reveal"
            >
              {revealed ? (
                <Text style={styles.keyText} selectable>
                  {accessKey}
                </Text>
              ) : (
                <Text style={styles.keyHidden}>Ключ доступа скрыт. Нажмите, чтобы показать.</Text>
              )}
            </Pressable>

            {revealed ? (
              <View style={styles.qrWrap}>
                <BrandedQr value={accessKey} size={QR_SIZE} />
                <Text style={styles.qrNote}>
                  Ключ и адрес сервера в одной строке: агенту больше ничего вводить не нужно.
                  Через код надёжнее, чем через буфер обмена.
                </Text>
              </View>
            ) : null}

            <View style={styles.rowBtns}>
              <Pressable style={styles.btn} onPress={onCopyPress} testID="agent_bridge_copy">
                <Ionicons name="copy-outline" size={16} color={styles.accent.color} />
                <Text style={styles.btnText}>{COPY_ACTION}</Text>
              </Pressable>
              <Pressable style={styles.btn} onPress={onRevokePress} testID="agent_bridge_revoke">
                <Ionicons name="refresh" size={16} color={styles.errColor.color} />
                <Text style={styles.revokeText}>Новый ключ</Text>
              </Pressable>
            </View>
          </>
        ) : null}
      </View>
    </View>
  );
}
