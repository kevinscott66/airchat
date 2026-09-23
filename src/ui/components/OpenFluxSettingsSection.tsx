/**
 * Туннель OpenFlux: один переключатель (v4.32.724).
 *
 * Здесь нарочно нет ни одного поля ввода — в отличие от соседней секции VPN,
 * где пользователь вбивает свой сервер. Адрес документа приходит переменной
 * сборки и является ключом (см. config.openflux), показывать и тем более
 * давать править его в интерфейсе незачем: настраивать тут нечего, решение
 * ровно одно — вести трафик через документ или не вести.
 *
 * Поэтому переключатель действует сразу, без «Сохранить»: человек включает
 * его в сети, где приложение уже не работает, и лишний шаг в этот момент —
 * это ещё одна возможность не догадаться, что нужно нажать что-то ещё.
 * Решение при этом запоминается (saveConfigOverride), иначе туннель, который
 * выключили осознанно, возвращался бы при каждом запуске.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { AppSwitch } from './AppSwitch';
import { font, radius } from '../theme';
import { useThemedStyles } from '../ThemeContext';
import { useAsyncButton } from '../../core/hooks/useAsyncButton';
import { showError, showSuccess } from './userFeedback';
import { userErrorText } from './userErrorText';
import { getConfigSync, loadConfig, saveConfigOverride, type AppConfig } from '../../core/config';
import { restartInternetTransport } from '../../core/transport/internet/restartInternetTransport';
import {
  enableOpenFluxTunnelStats,
  getOpenFluxRunning,
  getOpenFluxSocksAddr,
  getOpenFluxTunnelStats,
  retryOpenFlux,
  stopOpenFlux,
  type OpenFluxTunnelStats,
  type OpenFluxUiStatus,
} from '../../core/vpn/openFluxController';
import { addOpenFluxReviveListener } from '../../core/vpn/openFluxNetworkGuard';

/**
 * «Канал поднят», а не «Работает». Разница не косметическая: статус `on`
 * означает ровно то, что ядро поднялось и отдало локальный SOCKS5 — пошёл ли
 * в него трафик приложения, эта надпись не знает. На Android знала (прокси
 * стоит на самом сетевом стеке), на iOS перехват держится на двух отдельных
 * слоях. Ответ на «работает ли» даёт счётчик ниже, а не эта строка.
 */
const STATUS_LABEL: Record<OpenFluxUiStatus, string> = {
  off: 'Выключен',
  starting: 'Поднимаю канал…',
  on: 'Канал поднят',
  failed: 'Не удалось поднять',
  unsupported: 'Недоступно на этом устройстве',
  unconfigured: 'В этой сборке нет ссылки на документ',
};

/** Пока счётчик включён, обновляем его сами: считает ядро, событий оно не шлёт. */
const STATS_POLL_MS = 2000;

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function OpenFluxSettingsSection(): React.ReactElement {
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<OpenFluxUiStatus>('off');
  const [socks, setSocks] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** `null` — счётчика на этой платформе нет, весь блок ниже не показываем. */
  const [stats, setStats] = useState<OpenFluxTunnelStats | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const cfg = await loadConfig();
      if (!alive) return;
      setEnabled(!!cfg.openflux?.enabled);
      try {
        if (await getOpenFluxRunning()) {
          if (!alive) return;
          setStatus('on');
          setSocks(await getOpenFluxSocksAddr());
        }
      } catch {
        /* статус останется off */
      }
      const s = await getOpenFluxTunnelStats();
      if (alive) setStats(s);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Опрашиваем, только пока счёт идёт: до включения там нули, и обновлять их
  // раз в две секунды — просто будить процессор.
  useEffect(() => {
    if (!stats?.counting) return;
    const id = setInterval(() => {
      void (async () => {
        const s = await getOpenFluxTunnelStats();
        if (s) setStats(s);
      })();
    }, STATS_POLL_MS);
    return () => clearInterval(id);
  }, [stats?.counting]);

  // Экран читает состояние один раз, при открытии, а туннель за его спиной
  // переподнимается сам при смене сети — и порт у ядра каждый раз новый. Без
  // этой подписки открытый экран показывал бы номер, которого уже нет, и
  // «Работает» в ту самую секунду, когда ядро как раз не поднялось.
  useEffect(
    () =>
      addOpenFluxReviveListener(({ status: s, socks: addr }) => {
        setStatus(s);
        setSocks(addr);
      }),
    [],
  );

  /** Записать решение пользователя в override и вернуть свежий конфиг. */
  const persist = useCallback(async (on: boolean): Promise<AppConfig> => {
    const base = getConfigSync().openflux;
    return saveConfigOverride({
      openflux: { ...base, enabled: on },
    } as Partial<AppConfig>);
  }, []);

  /**
   * Переподнять интернет-транспорт после переключения туннеля.
   *
   * Сама процедура переехала в core (`restartInternetTransport`): ровно то же
   * самое понадобилось мосту внешнего агента, который переключает туннель без
   * участия этого экрана. Почему без перезапуска «нажал, и ничего не
   * изменилось» — см. шапку того модуля.
   */
  const restartTransport = useCallback(
    async (cfg: AppConfig): Promise<void> => restartInternetTransport(cfg),
    [],
  );

  const onToggle = useCallback(
    async (on: boolean) => {
      // Переключатель двигаем сразу: канал поднимается секундами, и застывший
      // в прежнем положении рычажок в этот момент читается как «не нажалось».
      setEnabled(on);
      setBusy(true);
      try {
        const cfg = await persist(on);
        if (!on) {
          await stopOpenFlux();
          setStatus('off');
          setSocks(null);
          await restartTransport(cfg);
          return;
        }
        setStatus('starting');
        const s = await retryOpenFlux(cfg);
        setStatus(s);
        if (s === 'on') {
          setSocks(await getOpenFluxSocksAddr());
          await restartTransport(cfg);
          showSuccess('Канал через документ поднят');
        } else if (s === 'failed') {
          showError('Не удалось поднять канал. Проверьте, открывается ли документ');
        }
      } catch (e) {
        setStatus('failed');
        showError(userErrorText(e, 'Не удалось переключить туннель'));
      } finally {
        setBusy(false);
      }
    },
    [persist, restartTransport],
  );

  const retryBtn = useAsyncButton(async () => {
    const cfg = await loadConfig();
    setStatus('starting');
    const s = await retryOpenFlux(cfg);
    setStatus(s);
    if (s === 'on') {
      setSocks(await getOpenFluxSocksAddr());
      await restartTransport(cfg);
      showSuccess('Канал через документ поднят');
    } else {
      showError('Снова не вышло. Проверьте документ и сеть');
    }
  });

  /**
   * Включить подсчёт соединений. Отдельной кнопкой, а не само собой, по двум
   * причинам: в ядре это отладочный режим без выключателя (до перезапуска
   * приложения), и он печатает в журнал адрес каждого соединения — включать
   * такое за спиной пользователя нельзя.
   */
  const countBtn = useAsyncButton(async () => {
    if (!(await enableOpenFluxTunnelStats())) {
      showError('В этой сборке счётчик недоступен');
      return;
    }
    setStats(await getOpenFluxTunnelStats());
  });

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
    statusRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 8,
      marginTop: 10,
    },
    statusDot: { width: 10, height: 10, borderRadius: radius.full },
    statusText: { fontSize: font.sm, fontWeight: '600' as const },
    socks: { color: c.textMuted, fontSize: font.xs, marginTop: 6 },
    retryBtn: {
      marginTop: 12,
      backgroundColor: c.surfaceHigh,
      borderRadius: radius.md,
      paddingVertical: 10,
      alignItems: 'center' as const,
      flexDirection: 'row' as const,
      justifyContent: 'center' as const,
      gap: 6,
    },
    retryText: { color: c.text, fontSize: font.sm, fontWeight: '700' as const },
    proof: {
      marginTop: 12,
      paddingTop: 10,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    proofTitle: {
      color: c.textSecondary,
      fontSize: font.xs,
      fontWeight: '700' as const,
      marginBottom: 6,
    },
    proofLine: { color: c.text, fontSize: font.sm, marginTop: 2 },
    proofNote: { color: c.textMuted, fontSize: font.xs, marginTop: 6, lineHeight: 16 },
    dotOn: { backgroundColor: c.success },
    dotWarn: { backgroundColor: c.warning },
    dotErr: { backgroundColor: c.error },
    dotOff: { backgroundColor: c.textMuted },
    onColor: { color: c.success },
    warnColor: { color: c.warning },
    errColor: { color: c.error },
    offColor: { color: c.textMuted },
    accent: { color: c.accent },
  }));

  const tone =
    status === 'on'
      ? { text: styles.onColor, dot: styles.dotOn }
      : status === 'starting'
        ? { text: styles.warnColor, dot: styles.dotWarn }
        : status === 'failed'
          ? { text: styles.errColor, dot: styles.dotErr }
          : { text: styles.offColor, dot: styles.dotOff };

  // Повтор предлагаем только там, где он может помочь. При «нет ссылки» и
  // «недоступно на устройстве» кнопка была бы обманом: сколько ни нажимай,
  // результат один и тот же.
  const canRetry = enabled && status === 'failed';

  return (
    <View>
      <Text style={styles.sectionTitle}>OPENFLUX (СЕТИ С БЕЛЫМ СПИСКОМ)</Text>
      <Text style={styles.hint}>
        Когда оператор пускает только разрешённые сайты, приложение не достучится до сервера
        доставки напрямую. OpenFlux несёт трафик внутри документа Яндекса — адрес, который в
        белый список уже входит. В обычной сети туннель можно выключить: без него быстрее.
      </Text>
      <View style={styles.card}>
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>Вести трафик через документ</Text>
          <AppSwitch
            value={enabled}
            onValueChange={(v) => {
              void onToggle(v);
            }}
            disabled={busy}
            testID="openflux_switch"
          />
        </View>

        <View style={styles.statusRow}>
          <View style={[styles.statusDot, tone.dot]} />
          <Text style={[styles.statusText, tone.text]}>{STATUS_LABEL[status]}</Text>
          {busy ? <ActivityIndicator size="small" color={styles.accent.color} /> : null}
        </View>

        {socks && status === 'on' ? (
          <Text style={styles.socks}>Локальный SOCKS5: {socks}</Text>
        ) : null}

        {canRetry ? (
          <Pressable style={styles.retryBtn} onPress={retryBtn.onPress} disabled={retryBtn.loading}>
            {retryBtn.loading ? (
              <ActivityIndicator color={styles.accent.color} />
            ) : (
              <>
                <Ionicons name="refresh" size={16} color={styles.accent.color} />
                <Text style={styles.retryText}>Повторить</Text>
              </>
            )}
          </Pressable>
        ) : null}

        {/*
          Блок существует только там, где есть чем считать (сейчас — iOS).
          Ничего не рисовать честнее, чем рисовать галочку «работает» по факту
          «ядро поднялось»: на iOS перехват идёт двумя отдельными слоями, и
          какой из них накрыл конкретное соединение, из JS не видно. Числа
          ниже приходят из самого ядра — оно считает соединения, которые
          приняло на свой SOCKS5.
        */}
        {stats ? (
          <View style={styles.proof}>
            <Text style={styles.proofTitle}>ИДЁТ ЛИ ТРАФИК ЧЕРЕЗ ТУННЕЛЬ</Text>
            {stats.counting ? (
              <>
                <Text style={styles.proofLine}>Соединений через туннель: {stats.connections}</Text>
                {stats.failures > 0 ? (
                  <Text style={[styles.proofLine, styles.errColor]}>
                    Из них не дошло до адресата: {stats.failures}
                  </Text>
                ) : null}
                {stats.lastTarget && stats.lastAt ? (
                  <Text style={styles.proofLine}>
                    Последнее: {stats.lastTarget}, в {formatTime(stats.lastAt)}
                  </Text>
                ) : null}
                <Text style={styles.proofLine}>
                  Перехват: системный {stats.systemProxy ? 'включён' : 'выключен'}, запросы
                  приложения {stats.httpProxy ? 'направлены в туннель' : 'идут напрямую'}
                </Text>
                <Text style={styles.proofNote}>
                  {stats.connections === 0
                    ? 'Ни одного соединения. Если приложение сейчас работает, значит, трафик идёт мимо туннеля. Откройте чат или отправьте сообщение и посмотрите, изменится ли число.'
                    : 'Число растёт только от соединений, которые действительно приняло ядро. Если оно стоит на месте, пока приходят сообщения, — веб-сокет идёт мимо туннеля.'}
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.proofNote}>
                  «Канал поднят» не означает, что трафик пошёл через документ. Счётчик показывает,
                  сколько соединений приняло ядро, — другого подтверждения нет. Работает до
                  перезапуска приложения и пишет в журнал адреса соединений, поэтому включается
                  вручную.
                </Text>
                <Pressable
                  style={styles.retryBtn}
                  onPress={countBtn.onPress}
                  disabled={countBtn.loading}
                  testID="openflux_count"
                >
                  {countBtn.loading ? (
                    <ActivityIndicator color={styles.accent.color} />
                  ) : (
                    <>
                      <Ionicons name="stats-chart" size={16} color={styles.accent.color} />
                      <Text style={styles.retryText}>Считать соединения</Text>
                    </>
                  )}
                </Pressable>
              </>
            )}
          </View>
        ) : null}
      </View>
    </View>
  );
}
