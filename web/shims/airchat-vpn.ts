/**
 * Веб-замена локального модуля `airchat-vpn`.
 *
 * Встроенный VPN — это Xray в нативном процессе и системный tun-интерфейс.
 * Страница ничем подобным не управляет, так что на web модуля нет и быть не
 * может. Вопрос только в том, как именно его нет.
 *
 * Нативный `modules/airchat-vpn/src/index.ts` экспортирует
 * `requireOptionalNativeModule<AirChatVpnNative | null>('AirChatVpn')` — то
 * есть при отсутствии нативной части отдаёт `null`, и все потребители уже
 * написаны под это: `airChatVpnController` и `ipfsFetch` делают `const mod =
 * AirChatVpn; if (!mod) ...`. Поэтому здесь тоже `null`, а не общая заглушка
 * `unavailable-native-module`: та отдаёт Proxy, а Proxy — истинное значение,
 * оно прошло бы сквозь `if (!mod)` и упало бы уже на вызове метода, внутри
 * ветки «модуль есть». Тихий `null` попадает ровно в ту ветку, которую для
 * этого случая и писали.
 *
 * Отличие от `unavailable-native-module` содержательное: там граница платформы
 * без готового обработчика, и падение — единственный способ её показать; здесь
 * обработчик отсутствия уже есть в самом контракте модуля.
 */
// Путь, а не имя пакета: на web имя `airchat-vpn` резолвится Metro в этот же
// файл (WEB_SHIMS), и импорт по имени замкнулся бы сам на себя.
import type { AirChatVpnNative } from '../../modules/airchat-vpn/src';

const AirChatVpn: AirChatVpnNative | null = null;

export default AirChatVpn;
