/**
 * Без react-native. RN 0.76+ читает `global.__FUSEBOX_HAS_FULL_CONSOLE_SUPPORT__`;
 * простое присваивание false может быть перезаписано до первого warn — фиксируем getter.
 */
const KEY = '__FUSEBOX_HAS_FULL_CONSOLE_SUPPORT__';
const PIN = '__airchat_fusebox_pinned';

function defineFuseboxOff(target: object): void {
  try {
    Reflect.deleteProperty(target, KEY);
  } catch {
    /* */
  }
  try {
    Object.defineProperty(target, KEY, {
      /** true — чтобы в Jest между resetModules можно было снять дескриптор; чтение всё равно всегда false. */
      configurable: true,
      enumerable: false,
      get: () => false,
      set: () => {
        /* игнорируем попытки выставить true */
      },
    });
  } catch {
    /* свойство уже задано иначе */
  }
}

export function pinFuseboxMigrationBannerOff(): void {
  const g = globalThis as Record<string, unknown>;
  if (g[PIN]) return;
  /** LogBoxData читает `global` — в Hermes обычно тот же объект, что globalThis; фиксируем оба. */
  defineFuseboxOff(globalThis);
  if (typeof global !== 'undefined' && global !== globalThis) {
    defineFuseboxOff(global as object);
  }
  g[PIN] = true;
}

pinFuseboxMigrationBannerOff();
