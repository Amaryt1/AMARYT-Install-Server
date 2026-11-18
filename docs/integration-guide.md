# Integrating AMARYT STORE with API v1

## SwiftUI flow

1. Store the operator's HTTPS origin, relay enablement, and optional upload preference separately from Feather's existing methods. Default upload permission to off. Bind the API credential to this origin in Keychain. Use HTTPS system trust and reject redirects on management requests.
2. Read GET /health and GET /api/v1/config. Example config: {"apiVersion":1,"enabled":true,"uploadOptional":true,"maxIpaBytes":536870912,"sessionTTLSeconds":900,"fileTTLSeconds":600}. A disabled service should suppress relay operations. A local-only installation can use device-hosted delivery independently.
3. Optionally POST /api/v1/install/resolve with {"url":"https://cdn.example.org/app.ipa"}. Example response: {"url":"https://cdn.example.org/app.ipa","sizeBytes":12345}. Download on device with progress, limits and safe redirect validation. Sign with the selected certificate and provisioning profile locally. Read the resulting CFBundleIdentifier and CFBundleVersion.
4. Present the signed app's icon, title and readiness. Wait for Install Now. Local delivery needs no server upload. For external delivery present an additional explicit consent prompt naming the host and the signed app.
5. Create a relay session with POST /api/v1/install/sessions and {"title":"Demo","bundleIdentifier":"org.example.demo","bundleVersion":"42"}. Example 201 response (illustrative ID): {"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","state":"awaiting_upload","expiresAt":"2026-11-18T20:15:00Z","sizeBytes":0,"manifestRequested":false,"packageRequested":false,"manifestURL":null}.
6. POST the file bytes to /api/v1/install/sessions/{id}/upload. Use the management token, application/octet-stream, Content-Length and X-AMARYT-Upload-Consent: 1. A 200 response contains state ready and a temporary manifestURL. The sizeBytes field is the signed file size. A subsequent owner-authenticated GET .../{id}/status returns the same session format. Never log its manifestURL.
7. Build itms-services using URLComponents with the returned manifestURL, after checking HTTPS, expected origin, port and path. iOS reads the manifest and IPA. Present “تم إرسال طلب التثبيت إلى iOS” only when opening the URL was accepted. Neither a file fetch nor acceptance of the URL establishes installation success.
8. On cancel before handoff, send DELETE /api/v1/install/sessions/{id}. After handoff allow the service TTL to expire so iOS can finish fetching. If a capability expires before handoff, discard it and create another session with fresh user consent. On interrupted upload read status first; retry only from awaiting_upload. Use bounded backoff with 429/temporary errors, stop on 401, and surface storage/profile errors separately.

## Swift request examples

These examples belong in the future client. Supply the user's selected HTTPS origin and Keychain token. Only call upload after presenting the per-package consent prompt.

```swift
import Foundation
import UIKit

final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

struct RelaySession: Decodable {
    let id: String
    let state: String
    let manifestURL: URL?
}

struct Relay {
    let origin: URL
    let token: String
    let http = URLSession(configuration: .ephemeral, delegate: NoRedirect(), delegateQueue: nil)

    func checked(_ pair: (Data, URLResponse), code: Int) throws -> RelaySession {
        guard (pair.1 as? HTTPURLResponse)?.statusCode == code else { throw URLError(.badServerResponse) }
        return try JSONDecoder().decode(RelaySession.self, from: pair.0)
    }
    func create(title: String, bundle: String, build: String) async throws -> RelaySession {
        var req = URLRequest(url: origin.appendingPathComponent("api/v1/install/sessions"))
        req.httpMethod = "POST"
        req.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["title": title, "bundleIdentifier": bundle, "bundleVersion": build])
        return try checked(try await http.data(for: req), code: 201)
    }
    func upload(file: URL, session: RelaySession) async throws -> RelaySession {
        guard session.id.range(of: "^[a-f0-9]{48}$", options: .regularExpression) != nil else { throw URLError(.badServerResponse) }
        let path = "api/v1/install/sessions/" + session.id + "/upload"
        var req = URLRequest(url: origin.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        req.setValue("1", forHTTPHeaderField: "X-AMARYT-Upload-Consent")
        let length = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize
        guard let length else { throw URLError(.fileDoesNotExist) }
        req.setValue(String(length), forHTTPHeaderField: "Content-Length")
        return try checked(try await http.upload(for: req, fromFile: file), code: 200)
    }
    @MainActor func submit(_ session: RelaySession) async throws -> Bool {
        guard let manifest = session.manifestURL, manifest.scheme == "https",
              manifest.host == origin.host, manifest.port == origin.port,
              manifest.user == nil, manifest.password == nil,
              manifest.path == "/api/v1/install/sessions/" + session.id + "/manifest.plist"
        else { throw URLError(.badServerResponse) }
        var link = URLComponents()
        link.scheme = "itms-services"
        link.host = ""
        link.queryItems = [.init(name: "action", value: "download-manifest"),
                           .init(name: "url", value: manifest.absoluteString)]
        guard let url = link.url else { throw URLError(.badURL) }
        return await UIApplication.shared.open(url)
    }
}
```

## Acceptance on a real device

Serve from an Internet-reachable host with a trusted TLS certificate. Check config and create/upload/status using a test identity, then verify the manifest and package are both reachable over HTTPS from the iPhone. Test accept, decline, expired session, offline mode and an ineligible profile. Record the actual iOS version, provisioning type and whether the installed app opens. A server test fixture exercises the API without representing an installable application.
