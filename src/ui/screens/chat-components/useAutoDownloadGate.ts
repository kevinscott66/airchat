import { useEffect, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';
import { kvGet } from '../../../core/storage/local';

/**
 * Настройка «Автозагрузка медиа»: 'always' | 'wifi' | 'never'.
 *
 * Возвращает true, когда скачивать самим НЕЛЬЗЯ и вместо снимка нужно
 * показать «нажмите, чтобы загрузить».
 *
 * v4.32.178: настройка появилась в личных чатах.
 * v4.32.248: вынесена из MediaStrip. Во-первых, в группах её не спрашивали
 * вовсе — там снимки качались всегда, независимо от выбора в настройках.
 * Во-вторых (и это важнее) заглушка рисовалась ПОСЛЕ разбора адресов, то есть
 * вложение уже было скачано и расшифровано к моменту её показа: настройка
 * ничего не экономила и ни от чего не защищала, только делала вид. Теперь
 * решение принимается ДО того, как список адресов уходит в разбор.
 *
 * Режим читается один раз при появлении пузыря на экране: смена настройки
 * подхватится на следующем открытии чата. Опрашивать хранилище на каждый
 * пузырь при каждой перерисовке дороже, чем польза от мгновенной реакции.
 */
export function useAutoDownloadGate(): boolean {
  const [gated, setGated] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const mode = (await kvGet('auto_download_media')) ?? 'always';
      if (mode === 'never') {
        if (!cancelled) setGated(true);
        return;
      }
      if (mode === 'wifi') {
        try {
          const st = await NetInfo.fetch();
          if (!cancelled) setGated(st.type !== 'wifi');
        } catch {
          if (!cancelled) setGated(false);
        }
        return;
      }
      if (!cancelled) setGated(false);
    })();
    return () => { cancelled = true; };
  }, []);
  return gated;
}
