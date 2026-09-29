/**
 * Разрешения экрана «Разрешения»: что показать и как узнать/запросить каждое.
 *
 * У каждого два разных действия, и путать их нельзя:
 *   - `check` только ЧИТАЕТ текущее состояние — без диалога. Его зовут при
 *     входе на экран и при возвращении в приложение (например, из настроек
 *     системы, куда человека отправила карточка «Запрещено»);
 *   - `request` показывает системный диалог. Его зовут только по нажатию.
 *
 * До v4.32.720 `check` не было вовсе: экран при каждом входе показывал
 * «Не запрошено» даже для выданного, а «Разрешить всё» заново дёргало диалоги.
 */
import { Platform } from 'react-native';
import {
  mapAndroidPermission,
  mapExpoPermission,
  mapPushAuthorization,
  mergeAndroidCheck,
  type PermissionStatus,
} from './permissionStatus';

export type PermissionId = 'notifications' | 'microphone' | 'camera' | 'gallery' | 'location';

export interface PermissionDef {
  id: PermissionId;
  icon: string;
  title: string;
  description: string;
  required: boolean;
  /** Прочитать состояние без диалога. `known` — то, что уже известно экрану. */
  check: (known: PermissionStatus) => Promise<PermissionStatus>;
  /** Показать системный диалог. */
  request: () => Promise<PermissionStatus>;
}

function androidApi(): number {
  return typeof Platform.Version === 'string'
    ? parseInt(Platform.Version, 10)
    : (Platform.Version as number);
}

/**
 * Уведомлениям нужен runtime-запрос на Android 13+ (v4.32.720) и на iOS всегда.
 *
 * До v4.32.1060 эта проверка была единственной, и всё, что под неё не
 * попадало, объявлялось выданным. На Android до 13 это правда: разрешения
 * такого там нет, уведомления включены по умолчанию. На iOS — нет: диалог
 * показывают ровно один раз за установку, и человек мог тогда нажать
 * «Не разрешать».
 */
function notificationsNeedPrompt(): boolean {
  return Platform.OS === 'android' && androidApi() >= 33;
}

/**
 * Что система думает о наших уведомлениях — на iOS (v4.32.1060).
 *
 * До этой версии карточка «Уведомления» на iPhone писала «Разрешено ✓» не
 * спросив никого, а `request` отвечал тем же словом, не показав диалога. Цена
 * не в самой надписи: нажатие на выданную карточку не делает ничего
 * (`permissionTapAction('granted')` → `none`), то есть человек, у которого
 * уведомления не приходят, видел на экране «Разрешения» зелёную галочку и не
 * мог с этого экрана ни спросить систему, ни уйти в её настройки. Про push
 * приложение при этом знало: `pushNotifications` спрашивает ровно то же
 * `hasPermission()` и пишет ответ в журнал с v4.32.623.
 *
 * `null` — спросить не удалось; вызывающий решает, чем это назвать.
 */
async function pushAuthorization(ask: boolean): Promise<PermissionStatus | null> {
  try {
    const messaging = (await import('@react-native-firebase/messaging')).default;
    return mapPushAuthorization(
      ask ? await messaging().requestPermission() : await messaging().hasPermission()
    );
  } catch {
    return null;
  }
}

async function checkNotifications(known: PermissionStatus): Promise<PermissionStatus> {
  if (Platform.OS === 'ios') return (await pushAuthorization(false)) ?? known;
  if (!notificationsNeedPrompt()) return 'granted';
  try {
    const { PermissionsAndroid } = await import('react-native');
    return mergeAndroidCheck(
      await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS),
      known
    );
  } catch {
    return known;
  }
}

async function requestNotifications(): Promise<PermissionStatus> {
  if (Platform.OS === 'ios') return (await pushAuthorization(true)) ?? 'unknown';
  if (!notificationsNeedPrompt()) return 'granted';
  try {
    const { PermissionsAndroid } = await import('react-native');
    return mapAndroidPermission(
      await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)
    );
  } catch {
    return 'unknown';
  }
}

/**
 * Микрофон на iOS спрашивает expo-audio (v4.32.1060).
 *
 * Тот же модуль и те же две функции, которыми пользуется сам голосовой пузырь
 * (`VoiceMessage`): читает `getRecordingPermissionsAsync` при открытии, просит
 * `requestRecordingPermissionsAsync` перед записью. До этой версии карточка
 * «Микрофон» на iPhone отвечала на нажатие словом «Разрешено ✓», не показав
 * диалога, — а система в этот момент ничего не выдавала, и первый же зажим
 * кнопки записи упирался в тот самый диалог, про который карточка уже сказала,
 * что он пройден.
 */
async function checkMicrophone(known: PermissionStatus): Promise<PermissionStatus> {
  if (Platform.OS === 'ios') {
    try {
      const { getRecordingPermissionsAsync } = await import('expo-audio');
      return mapExpoPermission(await getRecordingPermissionsAsync());
    } catch {
      return known;
    }
  }
  if (Platform.OS !== 'android') return known;
  try {
    const { PermissionsAndroid } = await import('react-native');
    return mergeAndroidCheck(
      await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO),
      known
    );
  } catch {
    return known;
  }
}

async function requestMicrophone(): Promise<PermissionStatus> {
  if (Platform.OS === 'ios') {
    try {
      const { requestRecordingPermissionsAsync } = await import('expo-audio');
      return mapExpoPermission(await requestRecordingPermissionsAsync());
    } catch {
      return 'unknown';
    }
  }
  if (Platform.OS !== 'android') return 'granted';
  try {
    const { PermissionsAndroid } = await import('react-native');
    return mapAndroidPermission(
      await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, {
        title: 'Микрофон',
        message: 'Для голосовых сообщений и звонков.',
        buttonPositive: 'Разрешить',
        buttonNegative: 'Пропустить',
      })
    );
  } catch {
    return 'unknown';
  }
}

async function checkCamera(known: PermissionStatus): Promise<PermissionStatus> {
  try {
    const ImagePicker = await import('expo-image-picker');
    return mapExpoPermission(await ImagePicker.getCameraPermissionsAsync());
  } catch {
    return known;
  }
}

async function requestCamera(): Promise<PermissionStatus> {
  try {
    const ImagePicker = await import('expo-image-picker');
    return mapExpoPermission(await ImagePicker.requestCameraPermissionsAsync());
  } catch {
    return 'unknown';
  }
}

async function checkGallery(known: PermissionStatus): Promise<PermissionStatus> {
  try {
    const ImagePicker = await import('expo-image-picker');
    return mapExpoPermission(await ImagePicker.getMediaLibraryPermissionsAsync());
  } catch {
    return known;
  }
}

async function requestGallery(): Promise<PermissionStatus> {
  try {
    const ImagePicker = await import('expo-image-picker');
    return mapExpoPermission(await ImagePicker.requestMediaLibraryPermissionsAsync());
  } catch {
    return 'unknown';
  }
}

async function checkLocation(known: PermissionStatus): Promise<PermissionStatus> {
  try {
    const Location = await import('expo-location');
    return mapExpoPermission(await Location.getForegroundPermissionsAsync());
  } catch {
    return known;
  }
}

async function requestLocation(): Promise<PermissionStatus> {
  try {
    const Location = await import('expo-location');
    return mapExpoPermission(await Location.requestForegroundPermissionsAsync());
  } catch {
    // Fallback for Android < 23
    if (Platform.OS !== 'android') return 'granted';
    try {
      const { PermissionsAndroid } = await import('react-native');
      return mapAndroidPermission(
        await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION, {
          title: 'Геолокация',
          message: 'Для отправки местоположения в сообщениях.',
          buttonPositive: 'Разрешить',
          buttonNegative: 'Пропустить',
        })
      );
    } catch {
      return 'unknown';
    }
  }
}

export const PERMISSION_DEFS: readonly PermissionDef[] = [
  {
    id: 'notifications',
    icon: '🔔',
    title: 'Уведомления',
    description: 'Оповещения о новых сообщениях, когда приложение свёрнуто.',
    required: false,
    check: checkNotifications,
    request: requestNotifications,
  },
  {
    id: 'microphone',
    icon: '🎙️',
    title: 'Микрофон',
    description: 'Для голосовых сообщений и звонков.',
    required: true,
    check: checkMicrophone,
    request: requestMicrophone,
  },
  {
    id: 'camera',
    icon: '📷',
    title: 'Камера',
    description: 'Для съёмки и отправки фото прямо из чата.',
    required: false,
    check: checkCamera,
    request: requestCamera,
  },
  {
    id: 'gallery',
    icon: '🖼️',
    title: 'Галерея',
    description: 'Для прикрепления фото и видео из вашей галереи.',
    required: false,
    check: checkGallery,
    request: requestGallery,
  },
  {
    id: 'location',
    icon: '📍',
    title: 'Геолокация',
    description: 'Для отправки вашего местоположения в сообщениях.',
    required: false,
    check: checkLocation,
    request: requestLocation,
  },
];
