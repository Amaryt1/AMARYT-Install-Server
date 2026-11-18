# Architecture

Fastify routes validate JSON with Zod and authorize a client before session creation, status, upload or deletion. The installation service owns the state machine and capability expiry. FileStorage reserves random internal names in a private directory, streams bytes into a staging file and renames the fully inspected file before it becomes readable. The API never accepts a destination filesystem path. The isolated Info.plist parser supports XML and binary plists. An owner may retry after an invalid upload. Conflicting or duplicate uploads return 409.

A new session starts in awaiting_upload. During transfer it is uploading; after successful inspection it is ready. Expiry, deletion and service restart invalidate links. File fetch flags record requests. Deletion revokes access immediately and aborts an in-progress upload; unlinking follows its close. A sweep retries failed cleanup. Existing open downloads may finish. Temporary storage is single-process: restart discards sessions and sweeps service-owned orphan file names; horizontal scaling would require shared metadata, storage and leases.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| PUBLIC_ORIGIN | required | Trusted public HTTPS origin for OTA links |
| API_CLIENTS | required | Private JSON map of distinct client credentials |
| SOURCE_HOSTS | empty | Exact public DNS hostnames allowed for every HEAD hop |
| SERVICE_ENABLED | true | Accept new relay work and serve files |
| HOST / PORT | 127.0.0.1 / 8080 | Internal HTTP listener; Compose isolates it behind Caddy |
| DATA_DIR | ./sessions | Dedicated private directory |
| MAX_IPA_BYTES | 536870912 | Per uploaded or resolved package |
| MAX_SESSIONS | 8 | Total reserved, uploading and ready sessions |
| SESSION_TTL_SECONDS | 900 | Maximum session lifetime from creation |
| FILE_TTL_SECONDS | 600 | Maximum additional lifetime after a successful upload, capped by session deadline |
| CLEANUP_SECONDS | 10 | Physical deletion sweep interval |
| RATE_PER_MINUTE | 120 | Request ceiling for each socket peer IP |

The operator changes environment values and restarts the process. Compose users should recreate the backend after changing .env. Only safe settings are returned by GET /api/v1/config. Health remains available during administrative disablement. The service uses the platform's normal HTTPS trust model; it has no remote configuration write endpoint. Behind the supplied proxy the peer-IP rate limit is shared across users. For a larger deployment configure additional per-client or per-IP limits at the trusted ingress.
