require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

# ─────────────────────────────────────────────────────────────────────────────
# Ядро (OpenFlux.xcframework) в git не лежит: 29 МБ, которые целиком
# получаются из исходников — scripts/build-openflux-ios.sh. Значит в свежем
# клоне его нет, и podspec обязан это пережить: иначе приложение не собиралось
# бы вовсе у того, кто просто склонировал репозиторий.
#
# Решение — условная линковка плюс флаг компиляции Swift:
#   • архив на месте → vendored_frameworks + AIRCHAT_OPENFLUX_CORE, код
#     туннеля компилируется целиком;
#   • архива нет → флага нет, вызовы C-API обёрнуты в #if и не компилируются,
#     линковщику искать нечего, isSupported() отвечает false, приложение
#     показывает «недоступно».
#
# Почему именно флаг компиляции, а не проверка в рантайме. Символы ядра
# статические: одного объявления в заголовке мало — если Swift их ВЫЗЫВАЕТ,
# линковка падает на undefined symbol, дойдёт туда выполнение или нет. Для
# статического архива нет аналога dlopen/dlsym, которым можно было бы спросить
# «а ты вообще в сборке?».
#
# Цена решения: состав сборки фиксируется в момент `pod install`. Собрал ядро
# после — переустанови поды. Об этом написано и в README.md рядом, и в конце
# скрипта сборки.
# ─────────────────────────────────────────────────────────────────────────────
core_xcframework = File.join(__dir__, 'OpenFlux.xcframework')
has_core = File.directory?(core_xcframework)

Pod::Spec.new do |s|
  s.name           = 'AirChatOpenFlux'
  s.version        = package['version']
  s.summary        = 'Туннель OpenFlux: трафик приложения внутри документа'
  s.description    = 'Ядро OpenFlux (Go) и перехват трафика iOS — чтобы приложение работало в сетях с белым списком'
  s.license        = package['license']
  s.author         = 'kevinscott66'
  s.homepage       = 'https://github.com/kevinscott66/airchat'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # React-Core нужен ради двух заголовков: RCTHTTPRequestHandler.h (слой 2,
  # RCTSetCustomNSURLSessionConfigurationProvider) и RCTWebSocketModule.h
  # (слой 3, RCTSetCustomSRWebSocketProvider). Он же приносит в пути поиска
  # заголовки ReactNativeDependencies, откуда берётся SocketRocket/SRWebSocket.h:
  # наследовать от SRWebSocket приходится потому, что провайдер веб-сокетов
  # объявлен через конкретный класс, а не через протокол.
  s.dependency 'React-Core'

  # Network.framework — первый слой (nw_privacy_context / nw_proxy_config).
  s.frameworks = 'Network'

  xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  if has_core
    s.vendored_frameworks = 'OpenFlux.xcframework'
    xcconfig['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = '$(inherited) AIRCHAT_OPENFLUX_CORE'

    # У ядра два среза: устройство arm64 и симулятор arm64. Срез симулятора под
    # Intel (x86_64) не собирается — Go его умеет, но такой симулятор бывает
    # только на Intel-маке, где всё равно нет arm64-симулятора для запуска.
    #
    # Исключение нужно в обоих местах, и каждое лечит свою поломку:
    #   • у приложения — иначе `xcodebuild -destination
    #     'generic/platform=iOS Simulator'` линкует и x86_64 и падает на
    #     `ld: library 'oflux' not found`;
    #   • у самого пода — иначе фаза «Copy XCFrameworks» видит ARCHS из двух
    #     архитектур, не находит среза под обе сразу и молча ничего не
    #     копирует; ядро не доезжает до сборки, и ошибка та же, но уже без
    #     видимой причины. Оба случая проверены на настоящей сборке.
    excluded = { 'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'x86_64' }
    xcconfig.merge!(excluded)
    s.user_target_xcconfig = excluded
  else
    Pod::UI.warn '[AirChatOpenFlux] ядро не собрано — туннель в сборку не попадёт. ' \
                 'Собрать: bash scripts/build-openflux-ios.sh, затем pod install заново.'
  end

  s.pod_target_xcconfig = xcconfig

  # Маска без ** намеренно: рекурсивная затянула бы в сборку содержимое
  # OpenFlux.xcframework, который лежит в этой же папке.
  s.source_files = '*.{h,m,mm,swift}'
end
