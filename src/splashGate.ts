import * as SplashScreen from 'expo-splash-screen';

/**
 * Единственный вызов preventAutoHideAsync на процесс. hideAsync нужно вызывать только
 * после await этого Promise — иначе на части Android (Vivo и др.) возможна гонка и
 * ошибки/некорректное снятие нативного splash.
 */
export const nativeSplashPreventReady: Promise<void> = SplashScreen.preventAutoHideAsync().then(
  () => undefined,
  () => undefined
);
