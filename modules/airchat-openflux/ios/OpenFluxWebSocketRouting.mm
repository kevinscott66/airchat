#import "OpenFluxWebSocketRouting.h"

#import <Network/Network.h>
// Отдельным импортом: зонтичный Network.h категорию с proxyConfigurations в
// себя не включает, а без неё свойство просто не видно компилятору.
#import <Network/NSURLSession+Network.h>
#import <React/RCTWebSocketModule.h>
#import <SocketRocket/SRSecurityPolicy.h>
#import <SocketRocket/SRWebSocket.h>
#import <os/log.h>

/// Своя подсистема, а не общая лента приложения: пошёл ли сокет через туннель,
/// видно только в os_log — на экране «канал поднят» горит одинаково в обоих
/// случаях. Строк здесь ровно две, обе редкие: открытие и обрыв приёма.
static os_log_t OpenFluxWebSocketLog(void)
{
  static os_log_t log;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    log = os_log_create("tech.airchat.openflux", "websocket");
  });
  return log;
}

/**
 * Веб-сокет поверх NSURLSessionWebSocketTask, притворяющийся SRWebSocket.
 *
 * Наследование здесь — не переиспользование, а требование типа: провайдер
 * React Native объявлен как `SRWebSocket *(^)(NSURLRequest *)`, протокола в
 * этом месте нет. Поэтому от предка берётся только он сам — ни один его метод
 * не вызывается после инициализатора, и ни одно его поле не читается.
 * Инициализатор безопасен: он раскладывает запрос по полям и создаёт очереди,
 * в сеть не ходит.
 *
 * Что должно совпасть с прежним поведением — ровно то, чего React Native
 * касается (RCTWebSocketModule.mm): -open, -close, -closeWithCode:reason:,
 * -sendString:error:, -sendData:error:, -sendPing:error:, свойство protocol и
 * четыре метода делегата (didReceiveMessage:, webSocketDidOpen:,
 * didFailWithError:, didCloseWithCode:reason:wasClean:). Остальное из
 * SRWebSocket приложением не используется.
 */
API_AVAILABLE(ios(17.0))
@interface OpenFluxProxiedWebSocket : SRWebSocket <NSURLSessionWebSocketDelegate>

/// Адрес SOCKS5 ядра. Ставится сразу после создания и до -open.
- (void)routeThroughSocksHost:(NSString *)host port:(NSString *)port;

@end

@implementation OpenFluxProxiedWebSocket {
  NSURLRequest *_ofRequest;
  NSString *_ofSocksHost;
  NSString *_ofSocksPort;

  NSURLSession *_ofSession;
  NSURLSessionWebSocketTask *_ofTask;

  NSLock *_ofLock;
  SRReadyState _ofState;
  NSString *_ofProtocol;
  /// Сокет уже досказал свою историю делегату (открылся и закрылся, или упал).
  /// Терминальных путей три — кадр close от сервера, ошибка задачи и наш
  /// собственный cancel, — и все три приводят к -URLSession:task:didComplete…,
  /// поэтому без этого флага делегат получил бы «закрылся» дважды.
  BOOL _ofFinished;
}

#pragma mark - жизненный цикл

- (instancetype)initWithURLRequest:(NSURLRequest *)request
                         protocols:(NSArray<NSString *> *)protocols
                    securityPolicy:(SRSecurityPolicy *)securityPolicy
{
  self = [super initWithURLRequest:request protocols:protocols securityPolicy:securityPolicy];
  if (!self) {
    return nil;
  }

  NSMutableURLRequest *prepared = [request mutableCopy];

  // Веб-сокет живёт часами, и таймаут запроса здесь — не про запрос, а про то,
  // сколько соединению позволено молчать. Штатные 60 секунд опасно близки к
  // паузе между keepalive ntfy (≈45 с): одна задержка сети — и сокет падает на
  // ровном месте, транспорт уходит в переподключение с нарастающей паузой, а
  // пользователь видит задержку доставки. Берём с запасом. Цена — мёртвое
  // рукопожатие обнаружится не через минуту, а через две; переподключением
  // всё равно заведует транспорт со своим отсчётом.
  prepared.timeoutInterval = 120;
  _ofRequest = [prepared copy];

  _ofLock = [NSLock new];
  _ofState = SR_CONNECTING;
  return self;
}

- (void)routeThroughSocksHost:(NSString *)host port:(NSString *)port
{
  _ofSocksHost = [host copy];
  _ofSocksPort = [port copy];
}

- (void)dealloc
{
  // Здесь мы оказываемся только до -open: пока сессии нет, никто нас не держит.
  //
  // После -open рассчитывать на dealloc нельзя, и прежний комментарий на этом
  // месте утверждал обратное. NSURLSession держит делегата СИЛЬНО до самой
  // инвалидации, а делегат — это мы; значит пока сессия жива, счётчик ссылок
  // на нас не дойдёт до нуля и dealloc не позовут никогда. Кольцо разрывает
  // -URLSession:task:didCompleteWithError:, где стоит finishTasksAndInvalidate,
  // и туда приходят все три конца жизни задачи: кадр close от сервера, ошибка
  // и наш собственный cancel из -closeWithCode:. Поэтому строчка ниже — не
  // подстраховка «если сокет умер, не дойдя до этого» (такой случай сюда и не
  // попадёт), а уборка за сокетом, который создали и не открыли.
  [_ofSession invalidateAndCancel];
}

#pragma mark - состояние, которое читает React Native

- (SRReadyState)readyState
{
  [_ofLock lock];
  SRReadyState state = _ofState;
  [_ofLock unlock];
  return state;
}

- (NSURL *)url
{
  return _ofRequest.URL;
}

/// Согласованный подпротокол. React Native читает его в webSocketDidOpen:.
- (NSString *)protocol
{
  [_ofLock lock];
  NSString *protocol = _ofProtocol;
  [_ofLock unlock];
  return protocol;
}

/// KVO у SRWebSocket ручное (+automaticallyNotifiesObserversOfReadyState = NO),
/// поэтому смену состояния приходится объявлять самим.
- (void)ofSetState:(SRReadyState)state
{
  [self willChangeValueForKey:@"readyState"];
  [_ofLock lock];
  _ofState = state;
  [_ofLock unlock];
  [self didChangeValueForKey:@"readyState"];
}

#pragma mark - открытие

- (void)open
{
  NSURLSessionConfiguration *configuration = [NSURLSessionConfiguration defaultSessionConfiguration];

  // Куки в запрос уже положил RCTWebSocketModule, вручную и из общего
  // хранилища. Пусть сессия не добавляет свои поверх: SocketRocket тоже
  // отправлял ровно тот заголовок, который ему дали, и расхождение здесь
  // означало бы другой набор куки на рукопожатии, чем был до перехвата.
  configuration.HTTPShouldSetCookies = NO;
  configuration.HTTPCookieStorage = nil;
  // Ждать появления сети не надо: у транспорта свой отсчёт переподключения
  // (экспоненциальный 2→30 с), и молчаливое ожидание внутри задачи только
  // спрятало бы от него разрыв.
  configuration.waitsForConnectivity = NO;

  nw_endpoint_t endpoint = nw_endpoint_create_host(_ofSocksHost.UTF8String, _ofSocksPort.UTF8String);
  nw_proxy_config_t proxy = nw_proxy_config_create_socksv5(endpoint);
  // Обход прокси запрещён — и это осознанно другое решение, чем у слоя 2.
  // Там конфигурация ставится один раз на всю жизнь сессии, в том числе при
  // выключенном туннеле, поэтому без обхода приложение вообще не вышло бы в
  // сеть. Здесь объект создаётся только когда туннель поднят, а в сети с
  // белым списком «не дошло» честнее, чем «ушло мимо туннеля, и молча».
  nw_proxy_config_set_failover_allowed(proxy, false);
  configuration.proxyConfigurations = @[ proxy ];

  _ofSession = [NSURLSession sessionWithConfiguration:configuration delegate:self delegateQueue:nil];
  _ofTask = [_ofSession webSocketTaskWithRequest:_ofRequest];
  // Потолок кадра у задачи — 1 МиБ, у SocketRocket его не было вовсе. Кадры
  // ntfy на порядок меньше (JS отбрасывает всё крупнее 256 КБ), но обрыв сокета
  // из-за размера выглядел бы как случайная поломка сети, а не как отказ.
  _ofTask.maximumMessageSize = 4 * 1024 * 1024;
  [_ofTask resume];
  os_log(OpenFluxWebSocketLog(), "open через socks %{public}@:%{public}@", _ofSocksHost, _ofSocksPort);
  [self ofReceiveNext];
}

/**
 * Приём. Задача отдаёт по одному сообщению за вызов, поэтому после каждого
 * надо просить следующее — иначе сокет откроется и замолчит.
 */
- (void)ofReceiveNext
{
  // __typeof__, а не typeof: файл компилируется как Objective-C++ по стандарту
  // c++20, где короткого написания просто нет.
  __weak __typeof__(self) weakSelf = self;
  [_ofTask receiveMessageWithCompletionHandler:^(NSURLSessionWebSocketMessage *message, NSError *error) {
    __typeof__(self) self_ = weakSelf;
    if (!self_) {
      return;
    }
    if (error) {
      // Разрыв разберёт -URLSession:task:didCompleteWithError:, у него есть
      // всё для выбора между «упал» и «закрылся». Здесь просто перестаём
      // просить следующее сообщение.
      os_log(OpenFluxWebSocketLog(), "приём прекращён: %{public}@", error.localizedDescription);
      return;
    }
    [self_ ofDeliverMessage:message];
    [self_ ofReceiveNext];
  }];
}

- (void)ofDeliverMessage:(NSURLSessionWebSocketMessage *)message
{
  if (message.type == NSURLSessionWebSocketMessageTypeData) {
    NSData *data = message.data;
    if (!data) {
      return;
    }
    [self ofDispatchToDelegate:^(id<SRWebSocketDelegate> delegate, SRWebSocket *socket) {
      if ([delegate respondsToSelector:@selector(webSocket:didReceiveMessage:)]) {
        [delegate webSocket:socket didReceiveMessage:data];
      }
      if ([delegate respondsToSelector:@selector(webSocket:didReceiveMessageWithData:)]) {
        [delegate webSocket:socket didReceiveMessageWithData:data];
      }
    }];
    return;
  }

  NSString *string = message.string;
  if (!string) {
    return;
  }
  [self ofDispatchToDelegate:^(id<SRWebSocketDelegate> delegate, SRWebSocket *socket) {
    // Делегат вправе попросить текстовый кадр байтами — так устроен
    // SocketRocket, и RCTBlobManager этим пользуется для сокетов с
    // content handler'ом.
    BOOL asString = YES;
    if ([delegate respondsToSelector:@selector(webSocketShouldConvertTextFrameToString:)]) {
      asString = [delegate webSocketShouldConvertTextFrameToString:socket];
    }
    id payload = asString ? (id)string : (id)[string dataUsingEncoding:NSUTF8StringEncoding];
    if ([delegate respondsToSelector:@selector(webSocket:didReceiveMessage:)]) {
      [delegate webSocket:socket didReceiveMessage:payload];
    }
    if (asString && [delegate respondsToSelector:@selector(webSocket:didReceiveMessageWithString:)]) {
      [delegate webSocket:socket didReceiveMessageWithString:string];
    }
  }];
}

#pragma mark - отправка

- (BOOL)sendString:(NSString *)string error:(NSError **)error
{
  NSURLSessionWebSocketMessage *message = [[NSURLSessionWebSocketMessage alloc] initWithString:string ?: @""];
  return [self ofSend:message error:error];
}

- (BOOL)sendData:(NSData *)data error:(NSError **)error
{
  return [self sendDataNoCopy:[data copy] error:error];
}

- (BOOL)sendDataNoCopy:(NSData *)data error:(NSError **)error
{
  NSURLSessionWebSocketMessage *message = [[NSURLSessionWebSocketMessage alloc] initWithData:data ?: [NSData data]];
  return [self ofSend:message error:error];
}

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-implementations"
/// Старый нетипизированный вход. React Native им не пользуется, но он всё ещё
/// часть публичного лица SRWebSocket, и оставлять его на машинерию предка
/// нельзя — она не инициализирована.
- (void)send:(id)message
{
  if ([message isKindOfClass:[NSData class]]) {
    [self sendData:(NSData *)message error:nil];
  } else if ([message isKindOfClass:[NSString class]]) {
    [self sendString:(NSString *)message error:nil];
  }
}
#pragma clang diagnostic pop

/// Задача, в которую можно писать прямо сейчас, или nil с тем же отказом, каким
/// отвечал SocketRocket на попытку отправки в неоткрытый сокет.
- (NSURLSessionWebSocketTask *)ofTaskForSendingWithError:(NSError **)error
{
  NSURLSessionWebSocketTask *task = _ofTask;
  if (task && self.readyState == SR_OPEN) {
    return task;
  }
  if (error) {
    *error = [NSError errorWithDomain:SRWebSocketErrorDomain
                                 code:2134
                             userInfo:@{NSLocalizedDescriptionKey : @"Сокет не открыт"}];
  }
  return nil;
}

- (BOOL)ofSend:(NSURLSessionWebSocketMessage *)message error:(NSError **)error
{
  NSURLSessionWebSocketTask *task = [self ofTaskForSendingWithError:error];
  if (!task) {
    return NO;
  }
  // Отправка асинхронная, поэтому «да» здесь означает «поставлено в очередь» —
  // ровно то же, что обещает SocketRocket своим возвращаемым значением.
  [task sendMessage:message
      completionHandler:^(NSError *sendError) {
        (void)sendError;
      }];
  return YES;
}

- (BOOL)sendPing:(NSData *)data error:(NSError **)error
{
  NSURLSessionWebSocketTask *task = [self ofTaskForSendingWithError:error];
  if (!task) {
    return NO;
  }
  // Полезная нагрузка ping'а задаче недоступна — она шлёт свой пустой кадр.
  // Для приложения это неважно: pong нигде не сверяется с отправленным телом.
  [task sendPingWithPongReceiveHandler:^(NSError *pingError) {
    (void)pingError;
  }];
  return YES;
}

#pragma mark - закрытие

- (void)close
{
  [self closeWithCode:SRStatusCodeNormal reason:nil];
}

- (void)closeWithCode:(NSInteger)code reason:(NSString *)reason
{
  [self ofSetState:SR_CLOSING];

  // React Native прокидывает код из JS как есть, а `ws.close()` без аргументов
  // доезжает сюда нулём. Ноль — не код закрытия, задача на нём падает; для
  // SocketRocket это было «обычное закрытие», им и остаётся.
  NSInteger effective = (code >= 1000) ? code : SRStatusCodeNormal;
  NSData *reasonData = [reason dataUsingEncoding:NSUTF8StringEncoding];
  [_ofTask cancelWithCloseCode:(NSURLSessionWebSocketCloseCode)effective reason:reasonData];
}

- (void)scheduleInRunLoop:(NSRunLoop *)runLoop forMode:(NSString *)mode
{
  // Приёмом заведует сессия на своей очереди; цикла выполнения, который можно
  // было бы куда-то поставить, у нас просто нет.
}

- (void)unscheduleFromRunLoop:(NSRunLoop *)runLoop forMode:(NSString *)mode
{
}

#pragma mark - делегат сессии

- (void)URLSession:(NSURLSession *)session
    webSocketTask:(NSURLSessionWebSocketTask *)webSocketTask
    didOpenWithProtocol:(NSString *)protocol
{
  [_ofLock lock];
  _ofProtocol = [protocol copy];
  [_ofLock unlock];
  [self ofSetState:SR_OPEN];

  [self ofDispatchToDelegate:^(id<SRWebSocketDelegate> delegate, SRWebSocket *socket) {
    if ([delegate respondsToSelector:@selector(webSocketDidOpen:)]) {
      [delegate webSocketDidOpen:socket];
    }
  }];
}

- (void)URLSession:(NSURLSession *)session
       webSocketTask:(NSURLSessionWebSocketTask *)webSocketTask
    didCloseWithCode:(NSURLSessionWebSocketCloseCode)closeCode
              reason:(NSData *)reason
{
  NSString *text = reason.length ? [[NSString alloc] initWithData:reason encoding:NSUTF8StringEncoding] : nil;
  // Кадр close от сервера — единственное по-настоящему чистое закрытие.
  [self ofFinishWithCloseCode:(NSInteger)closeCode reason:text clean:YES error:nil];
}

- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error
{
  if (error) {
    [self ofFinishWithCloseCode:SRStatusCodeAbnormal reason:nil clean:NO error:error];
  } else {
    // Ни кадра close, ни ошибки: соединение просто кончилось. Для WebSocket
    // это код 1005 «статус не получен» и закрытие нечистое — так же, как это
    // видел бы SocketRocket.
    [self ofFinishWithCloseCode:SRStatusNoStatusReceived reason:nil clean:NO error:nil];
  }
  // Сессия наша личная, на один сокет: без инвалидации она навсегда удержит
  // делегата, то есть сам сокет, и каждое переподключение оставляло бы за
  // собой ещё один.
  [session finishTasksAndInvalidate];
}

/**
 * Единственный выход из жизни сокета. Первый пришедший терминальный повод
 * выигрывает: сервер прислал close — рассказываем про закрытие, задача упала —
 * про ошибку. Двойного рассказа быть не должно, иначе React Native дважды
 * снимет сокет со своего учёта.
 */
- (void)ofFinishWithCloseCode:(NSInteger)code
                       reason:(NSString *)reason
                        clean:(BOOL)clean
                        error:(NSError *)error
{
  [_ofLock lock];
  BOOL already = _ofFinished;
  _ofFinished = YES;
  [_ofLock unlock];
  if (already) {
    return;
  }
  [self ofSetState:SR_CLOSED];

  if (error) {
    [self ofDispatchToDelegate:^(id<SRWebSocketDelegate> delegate, SRWebSocket *socket) {
      if ([delegate respondsToSelector:@selector(webSocket:didFailWithError:)]) {
        [delegate webSocket:socket didFailWithError:error];
      }
    }];
    return;
  }

  [self ofDispatchToDelegate:^(id<SRWebSocketDelegate> delegate, SRWebSocket *socket) {
    if ([delegate respondsToSelector:@selector(webSocket:didCloseWithCode:reason:wasClean:)]) {
      [delegate webSocket:socket didCloseWithCode:code reason:reason wasClean:clean];
    }
  }];
}

/**
 * Куда звать делегата. Порядок предпочтений — как у SocketRocket: сначала
 * очередь GCD, затем очередь операций, иначе главный поток. React Native
 * ставит сюда главную очередь и ждёт вызовов именно на ней.
 */
- (void)ofDispatchToDelegate:(void (^)(id<SRWebSocketDelegate> delegate, SRWebSocket *socket))block
{
  id<SRWebSocketDelegate> delegate = self.delegate;
  if (!delegate) {
    // React Native отпускает делегата, когда закрывает сокет со своей стороны;
    // догоняющие вызовы после этого — норма, а не потеря.
    return;
  }
  dispatch_queue_t queue = self.delegateDispatchQueue;
  NSOperationQueue *operationQueue = self.delegateOperationQueue;
  if (queue) {
    dispatch_async(queue, ^{
      block(delegate, self);
    });
  } else if (operationQueue) {
    [operationQueue addOperationWithBlock:^{
      block(delegate, self);
    }];
  } else {
    dispatch_async(dispatch_get_main_queue(), ^{
      block(delegate, self);
    });
  }
}

@end

#pragma mark - установка слоя

void AirChatOpenFluxInstallWebSocketProvider(AirChatOpenFluxSocksEndpointProvider provider)
{
  if (provider == nil) {
    return;
  }
  if (@available(iOS 17.0, *)) {
    // Своего состояния у слоя нет: React Native хранит блок в статической
    // переменной (RCTWebSocketModule.mm) и спрашивает его на каждое открытие
    // сокета, а туннель поднят или нет — решает Swift внутри блока.
    RCTSetCustomSRWebSocketProvider(^SRWebSocket *(NSURLRequest *request) {
      NSString *endpoint = provider();
      // Туннеля нет — возвращаем nil, и React Native создаст обычный
      // SRWebSocket. Это и есть гарантия, что при выключенном туннеле ничего
      // не изменилось: наш код в этой ветке не участвует.
      if (endpoint.length == 0) {
        return nil;
      }
      NSRange separator = [endpoint rangeOfString:@":" options:NSBackwardsSearch];
      if (separator.location == NSNotFound) {
        return nil;
      }
      NSString *host = [endpoint substringToIndex:separator.location];
      NSString *port = [endpoint substringFromIndex:separator.location + 1];
      if (host.length == 0 || port.length == 0) {
        return nil;
      }

      // Петлю через туннель не гоняем — то же правило, что у слоёв 1 и 2
      // (OpenFluxRouting.excludedHosts). Свой же SOCKS5 и всё остальное на
      // localhost обязано ходить напрямую: завернуть петлю в туннель значит в
      // лучшем случае отправить её наружу и потерять, в худшем — замкнуть ядро
      // на самоё себя. В dev-сборке сюда же попадает веб-сокет перезагрузки
      // бандла Metro.
      NSString *target = request.URL.host.lowercaseString;
      if ([target isEqualToString:@"localhost"] || [target isEqualToString:@"127.0.0.1"] ||
          [target isEqualToString:@"::1"] || [target isEqualToString:@"[::1]"] ||
          [target hasSuffix:@".localhost"]) {
        return nil;
      }

      OpenFluxProxiedWebSocket *socket =
          [[OpenFluxProxiedWebSocket alloc] initWithURLRequest:request
                                                     protocols:nil
                                                securityPolicy:[SRSecurityPolicy defaultPolicy]];
      [socket routeThroughSocksHost:host port:port];
      return socket;
    });
  }
}
