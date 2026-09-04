import React, { useEffect } from 'react';
import { Platform, type ViewProps } from 'react-native';
import { SecureContent, isSecureContentSupported, setWindowSecure } from '../../../modules/airchat-screen-guard/src';

/**
 * Щит вокруг того, что нельзя снимать: секретные слова.
 *
 * v4.32.581. Нативная часть щита существует с v4.32.570, но подключена была
 * только к переписке — к экрану, который человек и так согласился показывать
 * собеседнику. Двадцать четыре слова, по которым восстанавливается весь
 * аккаунт со всей историей, оставались единственным по-настоящему дорогим
 * кадром в приложении, ничем не закрытым: на Android любое приложение с
 * выданным разрешением на запись экрана (записывалка, «трансляция на
 * телевизор», да и просто вредонос, которому разрешение однажды дали) снимало
 * их открытым текстом, на iOS — обычный снимок экрана.
 *
 * Различие платформ ровно то же, что в самом модуле: на iOS прячется кусок
 * экрана, на Android закрывается окно целиком, а в сборке без нативной части
 * (web, тесты) обёртка остаётся обычным View. Поэтому разметка от щита не
 * зависит: `SecureContent` без нативной вьюхи — это `View` со всеми теми же
 * пропсами.
 *
 * Счётчик тут не для красоты. Флаг окна на Android один на приложение, а
 * поставить его может не только этот компонент (переписка ставит его сама,
 * ChatScreen), и два таких участка на экране сразу — обычное дело: слова и
 * поле ввода слов. Снятие по `false` от одного из них погасило бы щит у
 * остальных, поэтому окно открывается только когда закрылся последний.
 */
let secureWindowRefs = 0;

export function SecretScreenGuard({ children, ...rest }: ViewProps): React.ReactElement {
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    secureWindowRefs += 1;
    if (secureWindowRefs === 1) void setWindowSecure(true);
    return () => {
      secureWindowRefs -= 1;
      if (secureWindowRefs === 0) void setWindowSecure(false);
    };
  }, []);
  return <SecureContent {...rest}>{children}</SecureContent>;
}

/** Скрывается ли содержимое щита со снимка на этом устройстве. */
export function isSecretScreenGuardSupported(): boolean {
  return isSecureContentSupported();
}
