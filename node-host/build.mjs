/**
 * Сборка headless-ядра в один файл.
 *
 * Подмена платформы здесь устроена так же, как в `metro.config.js`: один
 * список соответствий «имя пакета → файл-шим», и ничего кроме него. Смысл тот
 * же — не дать подмене расползтись по коду условиями `Platform.OS`, чтобы на
 * вопрос «чем в Node заменён expo-sqlite» отвечала одна строка, а не поиск по
 * репозиторию.
 *
 * Сама подмена делается плагином, а не флагом `--alias:`. Причина одна:
 * `--alias:expo-file-system=...` переписал бы и `expo-file-system/legacy` в
 * `<шим>/legacy`, то есть в несуществующий путь. Плагин сопоставляет имя
 * целиком и такого не делает.
 */
import { build } from 'esbuild';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shim = (name) => path.join(here, 'shims', name);

/** Полное имя пакета → файл, который встаёт на его место. */
const SHIMS = new Map([
  // ── Перенос: в Node есть равноценная замена ──────────────────────────────
  ['expo-sqlite', shim('expo-sqlite.ts')],
  ['expo-secure-store', shim('expo-secure-store.ts')],
  ['expo-file-system/legacy', shim('expo-file-system-legacy.ts')],
  ['expo-file-system', shim('expo-file-system-legacy.ts')],
  ['expo-network', shim('expo-network.ts')],
  ['expo-constants', shim('expo-constants.ts')],
  ['react-native', shim('react-native.ts')],

  // ── Нет источника данных, но отсутствие безвредно ────────────────────────
  ['expo-battery', shim('expo-battery.ts')],

  // ── Граница платформы: заменить нечем, отказ должен быть громким ─────────
  ['expo-clipboard', shim('expo-clipboard.ts')],
  ['expo-sharing', shim('expo-sharing.ts')],
  ['expo-audio', shim('expo-audio.ts')],
  ['expo-location', shim('expo-location.ts')],
  ['react-native-webrtc', shim('unavailable-native-module.ts')],
  ['@notifee/react-native', shim('unavailable-native-module.ts')],
  ['react-native-tcp-socket', shim('unavailable-native-module.ts')],
  ['react-native-zeroconf', shim('unavailable-native-module.ts')],
  ['react-native-wifi-p2p', shim('unavailable-native-module.ts')],
  ['@react-native-firebase/messaging', shim('firebase-messaging.ts')],
  ['@react-native-firebase/app', shim('firebase-messaging.ts')],

  // ── Телеметрия: отчёты остаются на машине ────────────────────────────────
  ['@sentry/react-native', shim('sentry-react-native.ts')],

  // ── Нативные модули, чьё отсутствие описано в их же контракте как null ───
  ['airchat-openflux', shim('airchat-openflux.ts')],
  ['airchat-vpn', shim('airchat-vpn.ts')],
]);

const shimPlugin = {
  name: 'node-host-shims',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      const target = SHIMS.get(args.path);
      if (!target) return null;
      // Сами шимы импортируют настоящие модули (например, `node:fs`), поэтому
      // подмена не должна срабатывать на импортах изнутри каталога шимов.
      if (args.importer.startsWith(path.join(here, 'shims'))) return null;
      return { path: target };
    });
  },
};

const entry = process.argv[2] ?? path.join(here, 'proof.ts');
const outfile = process.argv[3] ?? path.join(here, 'dist', `${path.basename(entry, '.ts')}.mjs`);

const result = await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: 'inline',
  logLevel: 'info',
  metafile: true,
  plugins: [shimPlugin],
  // `assets/config.json` приходит в ядро через `require()` — в ESM-выводе его
  // нет, поэтому esbuild должен втянуть json в бандл, а не оставить вызов.
  loader: { '.json': 'json' },
  // Пакет `expo` в ядре не используется целиком; его подтягивают отдельные
  // модули ради типов, и в рантайме он не нужен.
  define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
  banner: {
    js: [
      "import { createRequire as __nodeHostCreateRequire } from 'node:module';",
      'const require = __nodeHostCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
process.stdout.write(`built ${outfile} (${bytes} bytes)\n`);
