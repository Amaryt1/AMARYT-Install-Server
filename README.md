# AMARYT Direct Install Server

Optional relay for **AMARYT STORE**. The device downloads and signs its IPA locally. After explicit consent it may upload the signed package to this service, which creates a short-lived HTTPS manifest and serves the package to iOS. An installation using local file delivery requires no relay session. The server reports file requests; the device controls installation.

## Start locally

Use Node.js 24 LTS and npm. Run these commands from the repository root.

    npm ci
    cp .env.example .env
    openssl rand -hex 32

Put the generated credential in the private .env as an API_CLIENTS JSON object mapping a client ID to that credential. Each installation/client should receive its own identifier and high-entropy secret through a trusted provisioning channel. Keep .env readable only by its owner. Set PUBLIC_ORIGIN to your HTTPS origin. SOURCE_HOSTS is an exact comma-separated allowlist for optional source probes; an empty list disables probing of all hosts.

    npm run typecheck
    npm test
    npm run build
    npm start
    curl http://127.0.0.1:8080/health

## Deploy with HTTPS

Point a public DNS name to a host with Docker Compose, allow inbound TCP 80 and 443, and configure .env with the same HTTPS origin (no path or trailing slash). Run **docker compose up --build -d**. Caddy obtains and renews a trusted certificate; only the proxy publishes ports. Check **docker compose ps** and **curl https://YOUR-DOMAIN/health**. Keep the Caddy volumes across restarts. Use one backend replica per data directory. Provision disk for MAX_SESSIONS × MAX_IPA_BYTES plus overhead and enforce a filesystem quota. The defaults need about 4 GiB plus overhead. For an existing proxy, run the Node process on loopback and stream requests through that proxy instead. GitHub hosts the code and CI; deployment requires the operator's host, DNS and credentials.

## Documentation

- [Architecture and settings](docs/architecture.md)
- [API and errors](docs/api.md)
- [OpenAPI 3.0 contract](docs/openapi.yaml)
- [SwiftUI integration guide](docs/integration-guide.md)
- [Security and validation boundaries](docs/security.md)

CI runs TypeScript, Vitest, an unsigned service build, a Docker build and a container health check. No workflow deploys to a production host.
