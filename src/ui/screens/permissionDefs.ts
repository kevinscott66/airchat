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

/** Уведомлениям нужен runtime-запрос только на Android 13+. */
function notificationsNeedPrompt(): boolean {
  return Platform.OS === 'android' && androidApi() >= 33;
}

async function checkNotifications(known: PermissionStatus): Promise<PermissionStatus> {
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

async function checkMicrophone(known: PermissionStatus): Promise<PermissionStatus> {
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
