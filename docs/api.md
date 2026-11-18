# API v1

Read [OpenAPI](openapi.yaml) for the exact paths, headers, bodies and response formats. Responses have Cache-Control: private, no-store. Clients authenticate management operations using Authorization: Bearer TOKEN. A token owns its sessions. Status returns the manifestURL after upload. OTA GET/HEAD routes require the random key in the URL; iOS does not need the management token.

POST /api/v1/install/resolve performs an optional authenticated, bounded HTTPS HEAD probe; no package is downloaded. Resolve can reject a host that does not support HEAD. The reported size is null when absent. Session creation accepts metadata from the signed main bundle. An upload requires application/octet-stream, Content-Length and X-AMARYT-Upload-Consent: 1. Serve the returned manifestURL to iOS; the plist includes the matching package capability. Files support whole-body GET and HEAD. Pass the signed CFBundleVersion build string rather than the marketing version.

| HTTP | Client handling |
| --- | --- |
| 400 | Correct malformed metadata, missing consent or an unsafe source destination |
| 401 | Reprovision the API token |
| 404 | Session/capability unavailable or belongs to a different client |
| 409 | Another upload is running, or the session already has a ready package; read status |
| 410 | Upload lost its session while in progress |
| 411 / 413 / 415 | Supply length, reduce file size, or use the binary content type |
| 422 | Source rejected HEAD, package structure invalid or actual bundle ID/build differs |
| 429 | Respect Retry-After when present; release unused sessions and back off |
| 502 / 503 | Source lookup/connection failed, service disabled, or temporary storage unavailable |
| 500 | Internal error; report requestId if present |

Example error: {"error":"signed_ipa_structure_required","requestId":"req-6"}. Restart or expiry can return 404 even for a previously ready session. When a POST response is lost, query session status before retrying an upload. A lost session-creation response may leave a reservation until its TTL.
