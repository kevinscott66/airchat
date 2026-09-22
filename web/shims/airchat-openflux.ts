/**
 * Веб-замена локального модуля `airchat-openflux`.
 *
 * OpenFlux — это ядро на Go в нативном процессе и локальный SOCKS5 на
 * loopback. Страница не умеет ни того, ни другого: слушающий сокет ей не
 * дадут, а подменить прокси у собственных запросов браузер не позволит.
 * Так что модуля на web нет и быть не может.
 *
 * Здесь `null`, а не общая заглушка `unavailable-native-module`, ровно по той
 * же причине, что и в шиме `airchat-vpn`: нативный модуль объявлен через
 * `requireOptionalNativeModule<... | null>`, и все потребители
 * (`openFluxController`) написаны под проверку `if (!mod)`. Общая заглушка
 * отдаёт Proxy, а Proxy истинен — он проскочил бы мимо этой проверки и упал
 * бы уже внутри ветки «модуль есть», то есть в самом неудобном месте.
 *
 * Отсутствие туннеля на web не молчит: `maybeStartOpenFlux` выходит по
 * `Platform.OS !== 'android'` со статусом `unsupported`, и интерфейс говорит
 * «недоступно здесь», а не «ошибка подключения».
 */
// Путь, а не имя пакета: на web имя `airchat-openflux` резолвится Metro в
// этот же файл (WEB_SHIMS), и импорт по имени замкнулся бы сам на себя.
import type { AirChatOpenFluxNative } from '../../modules/airchat-openflux/src';

const AirChatOpenFlux: AirChatOpenFluxNative | null = null;

export default AirChatOpenFlux;
