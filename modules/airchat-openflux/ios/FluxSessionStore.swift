import Foundation
import Security

// Device-only, non-synchronizable, native storage. Never expose cookies to JS.
enum FluxSessionStore {
    private static let service = "OpenFlux.Yandex.LocalSession"
    static func load(document: String) -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: "current",
            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data, data.count <= 256 * 1024,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["document"] as? String == document else { return nil }
        return String(data: data, encoding: .utf8)
    }
    static func save(_ value: String) throws {
        guard let data = value.data(using: .utf8), data.count <= 256 * 1024 else {
            throw FluxSessionError.message("Сессия слишком велика")
        }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: "current"]
        let attrs: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            var add = query; attrs.forEach { add[$0.key] = $0.value }
            guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else {
                throw FluxSessionError.message("Не удалось сохранить сессию")
            }
        } else if status != errSecSuccess { throw FluxSessionError.message("Не удалось сохранить сессию") }
    }
}
