import Fastify, { LogController } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import type { Readable } from "node:stream";
import type { Config } from "./config/index.js";
import { ApiError, authenticator } from "./security/auth.js";
import { resolveSource } from "./security/source.js";
import { FileStorage } from "./storage/files.js";
import { Sessions } from "./services/sessions.js";
import { metadataSchema, manifest } from "./services/manifest.js";

const idParams = z.object({ id: z.string().regex(/^[0-9a-f]{48}$/) });
const keyQuery = z.strictObject({ key: z.string().length(43) });
type Deps = {
  storage?: FileStorage;
  now?: () => number;
  resolve?: typeof resolveSource;
  logger?: boolean;
};
export async function buildApp(config: Config, deps: Deps = {}) {
  const app = Fastify({
    bodyLimit: 8192,
    requestTimeout: 300000,
    connectionTimeout: 30000,
    logController: new LogController({ disableRequestLogging: true }),
    logger: deps.logger ?? false,
    trustProxy: false,
  });
  const owner = authenticator(config.clients);
  const storage = deps.storage ?? new FileStorage(config.dir);
  await storage.init();
  const sessions = new Sessions(config, storage, deps.now);
  await app.register(rateLimit, {
    max: config.rate,
    timeWindow: 60000,
    cache: 4096,
  });
  const timer = setInterval(
    () => sessions.sweep().catch(() => app.log.error("session cleanup failed")),
    config.sweep,
  ).unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
  });
  app.addHook("onRequest", async (_req, res) => {
    res
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer");
  });
  app.setErrorHandler((error: Error & { statusCode?: number }, req, res) => {
    const status =
      error instanceof ApiError
        ? error.status
        : error instanceof z.ZodError
          ? 400
          : (error.statusCode ?? 500);
    const code =
      error instanceof ApiError
        ? error.code
        : status === 400
          ? "invalid_request"
          : status === 429
            ? "rate_limited"
            : status === 413
              ? "payload_too_large"
              : status === 415
                ? "unsupported_media_type"
                : "request_failed";
    req.log[status >= 500 ? "error" : "warn"](
      { status, code, route: req.routeOptions.url, requestId: req.id },
      "request failed",
    );
    res.code(status).send({ error: code, requestId: req.id });
  });
  app.setNotFoundHandler((_req, res) =>
    res.code(404).send({ error: "not_found" }),
  );
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) =>
    done(null, payload),
  );
  const enabled = () => {
    if (!config.enabled) throw new ApiError(503, "service_disabled");
  };
  const base = "/api/v1/install/sessions";
  app.get("/health", async () => ({
    status: "ok",
    enabled: config.enabled,
    apiVersion: 1,
  }));
  app.get("/api/v1/config", async () => ({
    apiVersion: 1,
    enabled: config.enabled,
    uploadOptional: true,
    maxIpaBytes: config.maxBytes,
    sessionTTLSeconds: config.ttl / 1000,
    fileTTLSeconds: config.fileTTL / 1000,
  }));
  app.post("/api/v1/install/resolve", async (req) => {
    owner(req);
    enabled();
    const { url } = z
      .strictObject({ url: z.string().min(1).max(4096) })
      .parse(req.body);
    return (deps.resolve ?? resolveSource)(url, config.hosts, config.maxBytes);
  });
  app.post(base, async (req, res) => {
    const who = owner(req);
    enabled();
    const s = sessions.create(who, metadataSchema.parse(req.body));
    return res
      .code(201)
      .header("Location", base + "/" + s.id + "/status")
      .send(s);
  });
  app.get(base + "/:id/status", async (req) =>
    sessions.status(sessions.owned(idParams.parse(req.params).id, owner(req))),
  );
  app.delete(base + "/:id", async (req, res) => {
    const s = sessions.owned(idParams.parse(req.params).id, owner(req));
    await sessions.retire(s);
    return res.code(204).send();
  });
  app.post(base + "/:id/upload", async (req) => {
    const who = owner(req);
    enabled();
    const s = sessions.owned(idParams.parse(req.params).id, who);
    if (req.headers["content-type"] !== "application/octet-stream")
      throw new ApiError(415, "binary_body_required");
    if (req.headers["x-amaryt-upload-consent"] !== "1")
      throw new ApiError(400, "consent_required");
    if (!req.headers["content-length"])
      throw new ApiError(411, "length_required");
    const n = Number(req.headers["content-length"]);
    if (!Number.isSafeInteger(n) || n < 1 || n > config.maxBytes)
      throw new ApiError(413, "upload_too_large");
    return sessions.upload(s, req.body as Readable, n);
  });
  for (const file of ["manifest.plist", "app.ipa"] as const) {
    app.get(base + "/:id/" + file, async (req, res) => {
      enabled();
      const parsed = keyQuery.safeParse(req.query);
      if (!parsed.success) throw new ApiError(404, "file_unavailable");
      const s = sessions.readable(
        idParams.parse(req.params).id,
        parsed.data.key,
      );
      if (file === "manifest.plist") {
        if (req.method === "GET") s.manifestRequested = true;
        return res
          .type("application/xml")
          .send(manifest(s.metadata, sessions.fileURL(s, "app.ipa")));
      }
      const fd = await storage.open(s.id).catch(() => {
        throw new ApiError(503, "storage_unavailable");
      });
      res.type("application/octet-stream").header("Content-Length", s.bytes);
      if (req.method === "HEAD") {
        await fd.close();
        return res.send();
      }
      s.packageRequested = true;
      return res.send(fd.createReadStream());
    });
  }
  return { app, sessions };
}
