/**
 * usePermissionsController — состояние и запросы экрана «Разрешения».
 *
 * Держит три правила, которые раньше жили в экране и нарушались:
 *
 * 1. Вход на экран и возвращение в приложение только ЧИТАЮТ состояние
 *    (`check`), диалогов не показывают. Выданное показывается выданным сразу,
 *    а не «Не запрошено» до первого нажатия; вернувшись из настроек системы,
 *    человек видит то, что там поменял.
 *
 * 2. Одновременно идёт не больше одного прохода запросов. Двойное нажатие на
 *    «Разрешить всё» раньше запускало два цикла: второй диалог висел поверх
 *    первого, а ответы разбирались вперемешку. Замок — ref, а не state: state
 *    виден только со следующей отрисовки, а второе нажатие приходит раньше.
 *    Пока проход идёт, `busy` = true, и кнопки экрана выключены.
 *
 * 3. Уход с экрана («Пропустить», «Готово», размонтирование) отменяет
 *    очередь. Раньше «Пропустить» во время первого диалога закрывало экран,
 *    а цикл `for … await` продолжал и показывал диалоги уже поверх
 *    следующего экрана. Уже открытый системный диалог отменить нельзя — его
 *    ответ дождёмся и запишем, а следующих запросов не будет.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking } from 'react-native';

import type { PermissionDef, PermissionId } from '../screens/permissionDefs';
import { permissionTapAction, type PermissionStatus } from '../screens/permissionStatus';

export type PermissionStatuses = Record<PermissionId, PermissionStatus>;

export interface PermissionsController {
  statuses: PermissionStatuses;
  /** Какое разрешение сейчас спрашивается (для спиннера на карточке). */
  requesting: PermissionId | null;
  /** Идёт проход запросов — кнопки должны быть выключены. */
  busy: boolean;
  /** Нажатие по карточке: спросить, открыть настройки или ничего. */
  requestOne: (id: PermissionId) => Promise<void>;
  /** «Разрешить всё»: по очереди все, у которых есть что спрашивать. */
  requestAll: () => Promise<void>;
  /** Прочитать состояние без диалогов. */
  refresh: () => Promise<void>;
  /** Отменить очередь запросов — перед уходом с экрана. */
  cancel: () => void;
}

function initialStatuses(defs: readonly PermissionDef[]): PermissionStatuses {
  const out = {} as PermissionStatuses;
  for (const d of defs) out[d.id] = 'unknown';
  return out;
}

export function usePermissionsController(defs: readonly PermissionDef[]): PermissionsController {
  const [statuses, setStatuses] = useState<PermissionStatuses>(() => initialStatuses(defs));
  const [requesting, setRequesting] = useState<PermissionId | null>(null);
  const [busy, setBusy] = useState(false);

  // Последнее известное состояние — для проверок внутри асинхронного прохода,
  // где замкнутый `statuses` уже устарел.
  const statusesRef = useRef(statuses);
  const flowRef = useRef(false);
  // Поколение: каждая отмена его увеличивает, и проход, начатый в прошлом
  // поколении, дальше не идёт.
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const refreshPendingRef = useRef(false);

  const setStatus = useCallback((id: PermissionId, status: PermissionStatus) => {
    statusesRef.current = { ...statusesRef.current, [id]: status };
    if (mountedRef.current) setStatuses(statusesRef.current);
  }, []);

  const readAll = useCallback(async () => {
    const results = await Promise.all(
      defs.map(async (d) => {
        try {
          return [d.id, await d.check(statusesRef.current[d.id])] as const;
        } catch {
          return [d.id, statusesRef.current[d.id]] as const;
        }
      })
    );
    if (!mountedRef.current) return;
    // Пока читали, мог начаться проход запросов: его ответы свежее, чем
    // прочитанное до диалога, — их не затираем.
    if (flowRef.current) {
      refreshPendingRef.current = true;
      return;
    }
    const next = { ...statusesRef.current };
    for (const [id, st] of results) next[id] = st;
    statusesRef.current = next;
    setStatuses(next);
  }, [defs]);

  const refresh = useCallback(async () => {
    if (flowRef.current) {
      // Во время прохода состояние меняют сами запросы; прочитаем после.
      refreshPendingRef.current = true;
      return;
    }
    await readAll();
  }, [readAll]);

  /** Взять замок. false — проход уже идёт, нажатие игнорируется. */
  const acquire = useCallback((): number | null => {
    if (flowRef.current) return null;
    flowRef.current = true;
    if (mountedRef.current) setBusy(true);
    return generationRef.current;
  }, []);

  const release = useCallback(() => {
    flowRef.current = false;
    if (!mountedRef.current) return;
    setBusy(false);
    setRequesting(null);
    if (refreshPendingRef.current) {
      refreshPendingRef.current = false;
      void readAll();
    }
  }, [readAll]);

  const isLive = useCallback(
    (gen: number) => mountedRef.current && generationRef.current === gen,
    []
  );

  /** Один запрос внутри уже взятого замка. */
  const runOne = useCallback(
    async (def: PermissionDef): Promise<void> => {
      const action = permissionTapAction(statusesRef.current[def.id]);
      if (action === 'none') return;
      if (action === 'open_settings') {
        void Linking.openSettings();
        return;
      }
      if (mountedRef.current) setRequesting(def.id);
      let status: PermissionStatus;
      try {
        status = await def.request();
      } catch {
        status = 'unknown';
      }
      // Ответ системного диалога — правда о разрешении, даже если экран
      // уже попросили закрыть: пишем его, но только пока есть куда.
      setStatus(def.id, status);
    },
    [setStatus]
  );

  const requestOne = useCallback(
    async (id: PermissionId) => {
      const def = defs.find((d) => d.id === id);
      if (!def) return;
      const gen = acquire();
      if (gen === null) return;
      try {
        if (isLive(gen)) await runOne(def);
      } finally {
        release();
      }
    },
    [acquire, defs, isLive, release, runOne]
  );

  const requestAll = useCallback(async () => {
    const gen = acquire();
    if (gen === null) return;
    try {
      // Только те, у которых есть что спрашивать. Иначе «Разрешить всё» посреди
      // прохода выкидывало человека в настройки системы из-за одного отклонённого.
      for (const def of defs) {
        if (!isLive(gen)) break;
        if (permissionTapAction(statusesRef.current[def.id]) !== 'request') continue;
        await runOne(def);
      }
    } finally {
      release();
    }
  }, [acquire, defs, isLive, release, runOne]);

  const cancel = useCallback(() => {
    generationRef.current += 1;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void readAll();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refresh();
    });
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      sub.remove();
    };
  }, [readAll, refresh]);

  return { statuses, requesting, busy, requestOne, requestAll, refresh, cancel };
}
