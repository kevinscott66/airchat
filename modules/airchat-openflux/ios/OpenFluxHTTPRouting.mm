#import "OpenFluxHTTPRouting.h"

#import <React/RCTHTTPRequestHandler.h>

void AirChatOpenFluxInstallSessionConfigProvider(AirChatOpenFluxSessionConfigProvider provider)
{
  if (provider == nil) {
    return;
  }
  // Своего состояния у прослойки нет: React Native хранит блок в статической
  // переменной (RCTHTTPRequestHandler.mm), а всё решение о прокси принимается
  // внутри блока, на стороне Swift.
  RCTSetCustomNSURLSessionConfigurationProvider(^NSURLSessionConfiguration *{
    return provider();
  });
}
