/**
 * Node-замена локального модуля `airchat-openflux`.
 *
 * Повторяет `web/shims/airchat-openflux.ts` буквально, и главное здесь — тип
 * отсутствия. Нативный модуль объявлен через
 * `requireOptionalNativeModule<... | null>`, а `openFluxController` написан
 * под проверку `if (!mod)`. Общая заглушка отдаёт Proxy, Proxy истинен — он
 * проскочил бы сквозь эту проверку и упал уже внутри ветки «модуль есть», то
 * есть в самом неудобном месте. Поэтому `null`, и никак иначе.
 *
 * Отсутствие туннеля при этом не молчит: `maybeStartOpenFlux` выходит по
 * `Platform.OS !== 'android'` со статусом `unsupported`.
 */
// Путь, а не имя пакета: имя `airchat-openflux` подменяется на этот же файл,
// и импорт по имени замкнулся бы сам на себя.
import type { AirChatOpenFluxNative } from '../../modules/airchat-openflux/src';

const AirChatOpenFlux: AirChatOpenFluxNative | null = null;

export default AirChatOpenFlux;
