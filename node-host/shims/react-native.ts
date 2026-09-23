/**
 * Node-замена `react-native` для ядра AirChat.
 *
 * Из всего React Native ядро берёт семь имён — `Platform`, `AppState`,
 * `InteractionManager`, `BackHandler`, `PermissionsAndroid`, `Alert` и тип
 * `NativeEventSubscription`. Ни одного компонента: экранов здесь нет, и
 * отрисовывать нечего. Поэтому это не урезанный React Native, а маленький
 * набор ответов на вопросы, которые ядро задаёт о своём окружении.
 *
 * ─── Почему `Platform.OS === 'ios'` ─────────────────────────────────────────
 *
 * Значение выбирается не «поближе к правде», а по тому, в какие ветки ядра
 * оно уводит. Веток три, и годится только одна.
 *
 *   'web' — ветки веба написаны под браузер: `dbLease` идёт за
 *     `navigator.locks` и `BroadcastChannel`, хранилища — за OPFS и
 *     IndexedDB, часть кода — за `document`. В Node из этого нет почти
 *     ничего, и подставить нечем: браузерные API — не нативные модули,
 *     шимом их не выдать. Ветка увела бы ядро туда, где его ждёт пустота.
 *
 *   'android' — наоборот, включает то, чего в Node нет по железу:
 *     `openFluxController` поднимает туннель на Go в нативном процессе,
 *     `wifiMesh` — Wi-Fi Direct, `lanTransport` — mDNS-обзор подсети. Все
 *     три модуля здесь отсутствуют (см. `unavailable-native-module.ts`), и
 *     ядро полезло бы в них, вместо того чтобы обойти.
 *
 *   'ios' — ветка «нативная платформа, но не Android». Ровно то, чем Node с
 *     этими шимами и является: файловая система, SQLite и сеть — настоящие,
 *     а специфика Android и специфика браузера — обе мимо. `dbLease` при
 *     этом сам отключает выбор вкладки-держателя (`hasLeaseSupport` требует
 *     web) и остаётся простой очередью операторов — именно то, что нужно
 *     одиночному процессу.
 *
 * Обратная сторона выбора названа прямо: ядро считает, что работает на
 * iPhone, и iOS-специфичные обходные пути (поведение Keychain, ограничения
 * фона) будут включены. Ни один из них в Node не вредит — они сводятся к
 * более осторожному порядку действий, — но знать об этом надо.
 */

/** Подписка на событие в терминах React Native: снимается вызовом `remove`. */
export type NativeEventSubscription = { remove: () => void };

export type AppStateStatus = 'active' | 'background' | 'inactive';

type PlatformSelectSpec<T> = {
  ios?: T;
  android?: T;
  native?: T;
  web?: T;
  default?: T;
};

export const Platform = {
  OS: 'ios' as const,
  /**
   * Версия — число, как на настоящем iOS (на Android это тоже число, а на web
   * строка). Значение взято из версии Node не для красоты: код, который на
   * него смотрит, сравнивает с порогами вроде `>= 13`, и любое разумное число
   * попадёт в современную ветку.
   */
  Version: Number(process.versions.node.split('.')[0]),
  isPad: false,
  isTV: false,
  isTesting: false,
  select<T>(spec: PlatformSelectSpec<T>): T | undefined {
    if ('ios' in spec) return spec.ios;
    if ('native' in spec) return spec.native;
    return spec.default;
  },
};

/**
 * Состояние приложения.
 *
 * Процесс без окна всегда «на переднем плане»: он не сворачивается и не
 * уходит в фон, а когда его останавливают — он заканчивается. Ядро смотрит на
 * это состояние, чтобы решить, можно ли сейчас работать с сетью и стоит ли
 * откладывать тяжёлую уборку; для headless-запуска верный ответ — «можно
 * всегда».
 *
 * Подписка принимается и честно ничего не шлёт: переходов, о которых стоило
 * бы сообщить, здесь не бывает. Это не пустая заглушка, а описание
 * действительности — отписаться тоже можно.
 */
const appStateListeners = new Set<(state: AppStateStatus) => void>();

export const AppState = {
  currentState: 'active' as AppStateStatus,
  addEventListener(
    type: string,
    listener: (state: AppStateStatus) => void
  ): NativeEventSubscription {
    if (type !== 'change') return { remove: () => undefined };
    appStateListeners.add(listener);
    return {
      remove: () => {
        appStateListeners.delete(listener);
      },
    };
  },
};

/**
 * Планировщик «после того, как отрисуется кадр».
 *
 * Кадров здесь не бывает, и ждать нечего — но выполнять сразу, синхронно,
 * тоже неверно: вызывающий отдаёт сюда работу именно затем, чтобы она не шла
 * в том же тике. `setImmediate` сохраняет это свойство, отдавая очередь
 * событий другим, и ровно так же ведёт себя настоящий InteractionManager,
 * когда очередь взаимодействий пуста.
 */
export const InteractionManager = {
  runAfterInteractions(task?: () => void): {
    then: (onFulfilled?: () => unknown) => Promise<unknown>;
    done: (...args: unknown[]) => void;
    cancel: () => void;
  } {
    let cancelled = false;
    const promise = new Promise<void>((resolve) => {
      setImmediate(() => {
        if (cancelled) return;
        try {
          task?.();
        } finally {
          resolve();
        }
      });
    });
    return {
      then: (onFulfilled) => promise.then(onFulfilled),
      done: (...args: unknown[]) => void promise.then(...(args as [])),
      cancel: () => {
        cancelled = true;
      },
    };
  },
  createInteractionHandle: () => 0,
  clearInteractionHandle: () => undefined,
};

/**
 * Аппаратная кнопка «назад» есть только на Android и только при живом окне.
 * Подписка принимается, чтобы вызывающему не приходилось знать о платформе, и
 * не срабатывает никогда — нажать здесь нечего.
 */
export const BackHandler = {
  addEventListener(_type: string, _handler: () => boolean): NativeEventSubscription {
    return { remove: () => undefined };
  },
  removeEventListener: () => undefined,
  exitApp: () => undefined,
};

/**
 * Разрешения Android. Ответ «отказано», а не «выдано», и это важно: выдача
 * означала бы «спрашивать больше не надо, можно пользоваться», и вызывающий
 * пошёл бы к нативному модулю, которого нет. Отказ уводит его в ту же ветку,
 * что и человек, нажавший «Запретить», — она в ядре написана и работает.
 */
export const PermissionsAndroid = {
  RESULTS: { GRANTED: 'granted', DENIED: 'denied', NEVER_ASK_AGAIN: 'never_ask_again' } as const,
  PERMISSIONS: new Proxy({} as Record<string, string>, {
    get: (_t, prop) => (typeof prop === 'string' ? prop : undefined),
  }),
  async request(): Promise<string> {
    return 'denied';
  },
  async requestMultiple(): Promise<Record<string, string>> {
    return {};
  },
  async check(): Promise<boolean> {
    return false;
  },
};

/**
 * Диалог, которого никто не увидит.
 *
 * Молчать нельзя: `Alert.alert` в ядре — это сообщение человеку о том, что
 * что-то пошло не так, и тихо съеденное оно превратило бы отказ в загадку.
 * Здесь оно уходит в stderr вместе с кнопками, а обработчики кнопок не
 * вызываются: нажать было некому, и выдумывать за человека ответ — худшее,
 * что можно сделать.
 */
export const Alert = {
  alert(
    title: string,
    message?: string,
    buttons?: Array<{ text?: string }>,
  ): void {
    const choices = buttons?.map((b) => b.text ?? '?').join(' | ');
    process.stderr.write(
      `[alert] ${title}${message ? `: ${message}` : ''}${choices ? ` [${choices}]` : ''}\n`
    );
  },
  prompt(title: string, message?: string): void {
    process.stderr.write(`[alert:prompt] ${title}${message ? `: ${message}` : ''}\n`);
  },
};


/**
 * ─── Мост к нативному коду ──────────────────────────────────────────────────
 *
 * Эти четыре имени ядро не берёт ни разу — их спрашивает `expo-modules-core`,
 * через который проходит любой expo-модуль. Мост в Node пуст, и это ровно та
 * правда, которую от него ждут: `requireOptionalNativeModule` на пустом мосте
 * отвечает `null`, а именно `null` описан в контрактах `airchat-vpn` и
 * `airchat-openflux` как «нативной части нет». Отдай мост что-нибудь похожее
 * на модуль — и отсутствие превратилось бы в поломку при первом же вызове.
 */
export const NativeModules: Record<string, unknown> = {};

export const TurboModuleRegistry = {
  /** Необязательный модуль: его отсутствие — законный ответ. */
  get(_name: string): null {
    return null;
  },
  /**
   * `getEnforcing` — это «модуль обязан быть». Его здесь нет, и молчать об
   * этом нельзя: вызывающий на `null` не рассчитывает и упадёт позже и
   * непонятнее, чем упал бы тут.
   */
  getEnforcing(name: string): never {
    throw new Error(`native_module_unavailable_on_node: TurboModuleRegistry.getEnforcing(${name})`);
  },
};

/**
 * Эмиттер событий нативного модуля. Событий не бывает — их источник в
 * нативном процессе, которого нет, — поэтому подписки принимаются и не
 * срабатывают. Класс, а не объект: `expo-modules-core` наследуется от него.
 */
export class NativeEventEmitter {
  addListener(_event: string, _listener: (...args: unknown[]) => void): NativeEventSubscription {
    return { remove: () => undefined };
  }

  removeAllListeners(_event?: string): void {
    /* подписок нет */
  }

  removeSubscription(_sub: NativeEventSubscription): void {
    /* подписок нет */
  }

  listenerCount(_event: string): number {
    return 0;
  }

  emit(_event: string, ..._args: unknown[]): void {
    /* некому слушать */
  }
}

/**
 * Плотность экрана. Экрана нет, поэтому единица — не «заглушка на всякий
 * случай», а единственное значение, при котором «точки» и «пиксели»
 * совпадают и пересчёт ничего не искажает.
 */
export const PixelRatio = {
  get: () => 1,
  getFontScale: () => 1,
  getPixelSizeForLayoutSize: (size: number) => Math.round(size),
  roundToNearestPixel: (size: number) => Math.round(size),
};

export default { Platform, AppState, InteractionManager, BackHandler, PermissionsAndroid, Alert };
