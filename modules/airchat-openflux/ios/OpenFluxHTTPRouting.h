/*
 * Тонкая прослойка к React Native для второго слоя перехвата.
 *
 * Зачем она вообще нужна, раз всё остальное на Swift. Точка подключения —
 * RCTSetCustomNSURLSessionConfigurationProvider из
 * node_modules/react-native/Libraries/Network/RCTHTTPRequestHandler.h. Это
 * обычная C-функция в заголовке React-Core, и Swift дотянулся бы до неё только
 * через модуль React, которого у пода нет. Зато Objective-C видит заголовки
 * React-Core по header search path без всяких модулей — поэтому вызов живёт
 * здесь, а сама конфигурация сессии собирается в Swift и передаётся сюда
 * блоком.
 *
 * Почему конфигурацию нельзя собрать прямо тут: proxyConfigurations и
 * ProxyConfiguration(socksv5Proxy:) существуют только в Swift-овере
 * Network.framework, в заголовках Objective-C их нет.
 */
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/** React Native и Expo fetch вызывают блок при создании своих NSURLSession. */
typedef NSURLSessionConfiguration *_Nonnull (^AirChatOpenFluxSessionConfigProvider)(void);

/**
 * Ставит общий провайдер конфигурации для React Native и Expo fetch.
 * Вызывать один раз и как можно раньше: обе сессии создаются лениво, на первом
 * запросе. Публичный setter Expo регистрируется синхронно на главном потоке.
 *
 * __BEGIN_DECLS обязателен. Реализация лежит в .mm — иначе не подключить
 * RCTHTTPRequestHandler.h, он тянет C++ из React Native. Компилятор
 * Objective-C++ без этой обёртки украсит имя по правилам C++
 * (__Z43AirChatOpenFluxInstall...), а Swift, импортирующий заголовок как C,
 * ищет ровно _AirChatOpenFluxInstallSessionConfigProvider — и линковка падает
 * на undefined symbol уже в приложении, хотя сам под собирается. Проверено.
 */
__BEGIN_DECLS
void AirChatOpenFluxInstallSessionConfigProvider(AirChatOpenFluxSessionConfigProvider provider);
__END_DECLS

NS_ASSUME_NONNULL_END
