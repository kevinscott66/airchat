import SwiftUI
import UIKit

@available(iOS 17.0, *)
@MainActor
final class FluxSessionPresenter {
    static let shared = FluxSessionPresenter()
    private var presenting = false
    func authorize(document: String) async -> Bool {
        guard !presenting, let url = URL(string: document), url.scheme == "https",
              url.user == nil, url.password == nil, url.port == nil,
              ["docs.yandex.ru", "disk.yandex.ru"].contains(url.host ?? ""),
              let scene = UIApplication.shared.connectedScenes.first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene,
              var parent = scene.windows.first(where: { $0.isKeyWindow })?.rootViewController else { return false }
        while let next = parent.presentedViewController { parent = next }
        guard !parent.isBeingDismissed, !parent.isBeingPresented, parent.viewIfLoaded?.window != nil else { return false }
        presenting = true
        return await withCheckedContinuation { continuation in
            var applied = false
            var finished = false
            @MainActor func finish(_ success: Bool) {
                guard !finished else { return }
                finished = true
                self.presenting = false
                continuation.resume(returning: success)
            }
            let page = FluxBrowserView(document: url) { value in
                try FluxSessionStore.save(value)
                applied = true
            }.onDisappear { finish(applied) }
            let controller = UIHostingController(rootView: page)
            parent.present(controller, animated: true)
            // UIKit may refuse a presentation without invoking its completion.
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if controller.presentingViewController == nil { finish(false) }
            }
        }
    }
}
