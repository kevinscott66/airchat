import { Linking, Platform } from 'react-native';

import { log } from '../../core/logger';
import { safeExternalUrl, safeTypedUrl } from '../../core/net/externalLink';
import { appleMapsUrl, geoUri, mapLinkUrl } from '../../core/net/mapLink';
import { rawErrorText } from '../components/userErrorText';
import { showError } from '../components/userFeedback';

/**
 * openExternal — единственный выход наружу из приложения.
 *
 * v4.32.535. Проверять адрес научились в v4.32.420 (`core/net/externalLink`),
 * но само открытие осталось написанным тринадцать раз, и почти везде одинаково
 * неправильно:
 *
 *     const href = safeExternalUrl(url);
 *     if (href) void Linking.openURL(href).catch(() => {});
 *
 * Пустой перехват означает, что нажатие на подчёркнутую ссылку не делает
 * НИЧЕГО — ни перехода, ни объяснения. А `openURL` отказывает не в редких
 * случаях: на устройстве нет браузера по умолчанию, нет приложения карт, адрес
 * отвергнут системой. Человек видит зависшее приложение и жмёт ещё раз.
 * В двух местах — ссылки на профили в соцсетях — не было и пустого перехвата:
 * отказ уходил в неперехваченное отклонение обещания.
 *
 * Отдельный случай — `null` от проверки адреса. Сама проверка права молчать:
 * она отвечает на вопрос «есть ли здесь что открывать» и при отрисовке решает,
 * рисовать ли ссылку вообще. Но здесь мы уже ПОСЛЕ нажатия: ссылка нарисована,
 * подчёркнута, по ней ударили пальцем. Молчать в этот момент — то же зависшее
 * приложение, поэтому говорим прямо, что адрес открыт не будет.
 */

const OPEN_FAILED = 'Не удалось открыть ссылку: нет приложения, которое её откроет';
const NOT_A_LINK = 'Адрес не похож на ссылку — открывать его небезопасно';
const MAP_FAILED = 'Не удалось открыть карту';

function openChecked(href: string | null, where: string, failText: string): void {
  if (!href) {
    log.warn('ui_open_external_rejected', { where });
    showError(NOT_A_LINK);
    return;
  }
  void Linking.openURL(href).catch((e: unknown) => {
    log.warn('ui_open_external_failed', { where, err: rawErrorText(e) });
    showError(failText);
  });
}

/**
 * Открыть адрес, пришедший из сети или собранный приложением.
 *
 * `where` попадает только в журнал — по нему видно, какое именно место
 * приложения не смогло открыть ссылку. Сам адрес в журнал не пишем: он бывает
 * личным.
 */
export function openExternal(raw: unknown, where: string, failText: string = OPEN_FAILED): void {
  openChecked(safeExternalUrl(raw), where, failText);
}

/**
 * Открыть адрес, который ввёл сам владелец профиля: «example.com» без схемы
 * здесь опечатка удобства, а не попытка обойти правило.
 */
export function openTypedExternal(raw: unknown, where: string): void {
  openChecked(safeTypedUrl(raw), where, OPEN_FAILED);
}

/**
 * Показать точку на карте.
 *
 * Сначала — приложение карт устройства, потом браузер. Раньше так делало одно
 * место из шести, а пять остальных всегда открывали браузер, хотя карта у
 * человека установлена. Если приложения нет, `canOpenURL` отвечает «нет», и мы
 * оказываемся на прежнем пути, а не в тупике.
 */
export function openMapAt(lat: number, lon: number): void {
  const web = mapLinkUrl(lat, lon);
  if (!web) {
    log.warn('ui_open_map_bad_coords', {});
    showError(MAP_FAILED);
    return;
  }
  void (async () => {
    const preferred = Platform.OS === 'android'
      ? geoUri(lat, lon)
      : Platform.OS === 'ios' ? appleMapsUrl(lat, lon) : null;
    if (preferred) {
      try {
        if (await Linking.canOpenURL(preferred)) {
          await Linking.openURL(preferred);
          return;
        }
      } catch (e) {
        // Приложение карт отказалось — это ещё не отказ показать точку.
        log.warn('ui_open_map_app_failed', { err: rawErrorText(e) });
      }
    }
    try {
      await Linking.openURL(web);
    } catch (e) {
      log.warn('ui_open_map_failed', { err: rawErrorText(e) });
      showError(MAP_FAILED);
    }
  })();
}
