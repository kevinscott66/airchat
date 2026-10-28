#import "OpenFluxHTTPRouting.h"

#import <React/RCTHTTPRequestHandler.h>

// Expo exposes this Objective-C entry point publicly in
// ExpoFetchCustomExtension.swift. Resolve the class at runtime so this bridge
// does not need to import Expo's generated Swift header or add a pod cycle.
@protocol AirChatExpoFetchConfigurationExtension <NSObject>
+ (void)setCustomURLSessionConfigurationProvider:(AirChatOpenFluxSessionConfigProvider)provider;
@end

void AirChatOpenFluxInstallSessionConfigProvider(AirChatOpenFluxSessionConfigProvider provider)
{
  if (provider == nil) {
    return;
  }
  AirChatOpenFluxSessionConfigProvider configurationProvider = ^NSURLSessionConfiguration *{
    return provider();
  };
  RCTSetCustomNSURLSessionConfigurationProvider(configurationProvider);

  // expo/fetch owns a separate lazy URLSession. Its public provider setter is
  // @MainActor, and registration must finish before the first fetch can start.
  void (^installExpoProvider)(void) = ^{
    Class<AirChatExpoFetchConfigurationExtension> extension =
        (Class<AirChatExpoFetchConfigurationExtension>)NSClassFromString(@"EXFetchCustomExtension");
    if ([extension respondsToSelector:@selector(setCustomURLSessionConfigurationProvider:)]) {
      [extension setCustomURLSessionConfigurationProvider:configurationProvider];
      NSLog(@"[AirChatOpenFlux] Expo fetch configuration provider installed");
    } else {
      NSLog(@"[AirChatOpenFlux] Expo fetch configuration extension unavailable");
    }
  };
  if ([NSThread isMainThread]) {
    installExpoProvider();
  } else {
    dispatch_sync(dispatch_get_main_queue(), installExpoProvider);
  }
}
