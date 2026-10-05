import SwiftUI
import WebKit

// Pure policy shared with the regression runner. Never log full navigation URLs.
enum FluxSessionError: Error { case message(String) }

enum FluxBrowserNavigationPolicy {
    static func yandexHost(_ host: String) -> Bool {
        let host = host.lowercased()
        return host == "yandex.ru" || host.hasSuffix(".yandex.ru")
    }
    static let editorHosts = ["office.disk.yandex.net", "office-online.disk.yandex.net"]
    static func editorHost(_ host: String) -> Bool {
        let host = host.lowercased()
        return editorHosts.contains(host) || host == "onlyoffice.disk.yandex.net" || host.hasSuffix(".onlyoffice.disk.yandex.net")
    }
    static func allowed(_ url: URL, mainFrame: Bool, sourceHost: String, sourceProtocol: String) -> Bool {
        let trustedSource = sourceProtocol == "https" && (yandexHost(sourceHost) || editorHost(sourceHost))
        if !mainFrame && trustedSource && ["about:blank", "about:srcdoc"].contains(url.absoluteString) { return true }
        if !mainFrame && trustedSource && url.scheme == "blob",
           let inner = URL(string: String(url.absoluteString.dropFirst(5))), inner.scheme == "https" {
            return allowed(inner, mainFrame: false, sourceHost: "", sourceProtocol: "")
        }
        guard url.scheme == "https", url.user == nil, url.password == nil,
              url.port == nil || url.port == 443, let host = url.host?.lowercased() else { return false }
        if yandexHost(host) { return true }
        // Official Yandex 360 network-settings list names these editor hosts.
        return !mainFrame && editorHost(host)
    }
    static func ignoredError(_ error: NSError) -> Bool {
        (error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled) ||
        (error.domain == "WebKitErrorDomain" && error.code == 102)
    }
    static func destination(_ url: URL?) -> String {
        guard let url else { return "неизвестный адрес" }
        return url.host ?? ((url.scheme ?? "неизвестная схема") + ":")
    }
}

/// Dedicated local cookie store. No cookies are sent to the Agent backend.
@available(iOS 17.0, *)
@MainActor
final class FluxBrowserModel: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate {
    @Published var message = "Войдите в Яндекс и откройте документ. Если появится проверка, пройдите её здесь."
    @Published var canUseSession = false
    @Published var loading = false
    let document: URL
    let webView: WKWebView
    private var navigationGeneration = 0

    init(document: URL) {
        self.document = document
        let config = WKWebViewConfiguration()
        config.websiteDataStore = WKWebsiteDataStore(forIdentifier: UUID(uuidString: "0BA0D62E-398A-49A3-8C38-F7DEEEACF07A")!)
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        openLogin()
    }
    func openLogin() {
        // Explicit first-party login; no document URL/token is added to retpath.
        webView.load(URLRequest(url: URL(string: "https://passport.yandex.ru/auth")!))
    }
    func openDocument() { webView.load(URLRequest(url: document)) }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let main = navigationAction.targetFrame?.isMainFrame ?? true
        let origin = navigationAction.sourceFrame.securityOrigin
        guard let url = navigationAction.request.url,
              FluxBrowserNavigationPolicy.allowed(url, mainFrame: main, sourceHost: origin.host, sourceProtocol: origin.protocol) else {
            message = "Остановлен переход: " + FluxBrowserNavigationPolicy.destination(navigationAction.request.url) + "."
            if main { canUseSession = false; loading = false }
            decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        let origin = navigationAction.sourceFrame.securityOrigin
        if navigationAction.targetFrame == nil, let url = navigationAction.request.url,
           FluxBrowserNavigationPolicy.allowed(url, mainFrame: true, sourceHost: origin.host, sourceProtocol: origin.protocol) {
            webView.load(navigationAction.request)
        }
        return nil
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        navigationGeneration += 1
        canUseSession = false; loading = true
        message = "Загружаем страницу Яндекса…"
    }
    private func failed(_ error: Error) {
        let e = error as NSError
        guard !FluxBrowserNavigationPolicy.ignoredError(e) else { return }
        loading = false; canUseSession = false
        // Only a numeric code, never localizedDescription/userInfo (may contain tokens).
        message = "Страница не загрузилась (код \(e.code)). Нажмите «К документу», чтобы повторить."
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        loading = false; canUseSession = false
        message = "Браузер был остановлен системой. Нажмите «К документу»."
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loading = false
        canUseSession = sessionPageAllowed()
        message = "Войдите в аккаунт при необходимости. Затем примените сессию и проверьте подключение в настройках. Открытый документ сам по себе не подтверждает вход."
    }
    func stop() { webView.stopLoading() }
    private func sessionPageAllowed() -> Bool {
        guard let url = webView.url, !webView.isLoading else { return false }
        return FluxBrowserNavigationPolicy.allowed(url, mainFrame: true, sourceHost: "", sourceProtocol: "")
    }
    func session() async throws -> String {
        let generation = navigationGeneration
        let page = webView.url
        guard canUseSession, sessionPageAllowed() else {
            throw FluxSessionError.message("Дождитесь загрузки страницы Яндекса.")
        }
        guard let ua = try await webView.evaluateJavaScript("navigator.userAgent") as? String else {
            throw FluxSessionError.message("Не удалось прочитать состояние браузера")
        }
        let cookies = await webView.configuration.websiteDataStore.httpCookieStore.allCookies()
        guard generation == navigationGeneration, page == webView.url, sessionPageAllowed() else {
            throw FluxSessionError.message("Страница изменилась. Дождитесь открытия документа и повторите.")
        }
        let local: [[String: Any]] = cookies.filter {
            let host = $0.domain.hasPrefix(".") ? String($0.domain.dropFirst()) : $0.domain
            return $0.isSecure && (host == "yandex.ru" || host.hasSuffix(".yandex.ru"))
        }.map {
            ["name": $0.name, "value": $0.value, "domain": $0.domain, "path": $0.path,
             "secure": $0.isSecure, "httpOnly": $0.isHTTPOnly,
             "expires": $0.expiresDate?.timeIntervalSince1970 ?? 0]
        }
        let data = try JSONSerialization.data(withJSONObject: ["document": document.absoluteString, "userAgent": ua, "cookies": local])
        guard data.count <= 256 * 1024, local.count <= 256 else { throw FluxSessionError.message("Сессия Яндекса слишком велика") }
        return String(decoding: data, as: UTF8.self)
    }
}

@available(iOS 17.0, *)
private struct FluxBrowserPage: UIViewRepresentable {
    let model: FluxBrowserModel
    func makeUIView(context: Context) -> WKWebView { model.webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
    static func dismantleUIView(_ view: WKWebView, coordinator: ()) { view.stopLoading() }
}

@available(iOS 17.0, *)
struct FluxBrowserView: View {
    @StateObject private var model: FluxBrowserModel
    @State private var busy = false
    @Environment(\.dismiss) private var dismiss
    let onSession: (String) async throws -> Void
    init(document: URL, onSession: @escaping (String) async throws -> Void) {
        _model = StateObject(wrappedValue: FluxBrowserModel(document: document))
        self.onSession = onSession
    }
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack {
                    Button("Войти в Яндекс") { model.openLogin() }
                    Spacer()
                    Button("К документу") { model.openDocument() }
                }.padding(.horizontal).padding(.top, 8).disabled(busy)
                Text(model.message).font(.footnote).padding()
                if model.loading { ProgressView("Загрузка…").padding(.bottom, 8) }
                FluxBrowserPage(model: model)
                Button(busy ? "Подключаем…" : "Применить сессию") {
                    busy = true
                    Task {
                        do {
                            let session = try await model.session()
                            try await onSession(session)
                            dismiss()
                        } catch { model.message = "Не удалось применить сессию. Откройте документ и повторите проверку подключения в настройках." }
                        busy = false
                    }
                }.buttonStyle(.borderedProminent).padding().disabled(busy || !model.canUseSession)
            }.navigationTitle("Яндекс").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Закрыть") { dismiss() }.disabled(busy) }

                }.interactiveDismissDisabled(busy)
                .onDisappear { model.stop() }
        }
    }
}
