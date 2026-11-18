import { z } from "zod";

const int = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const envSchema = z.object({
  PUBLIC_ORIGIN: z
    .url()
    .refine(
      (s) => new URL(s).protocol === "https:" && new URL(s).origin === s,
      "Expected an HTTPS origin without trailing slash",
    ),
  API_CLIENTS: z.string(),
  SOURCE_HOSTS: z.string().default(""),
  SERVICE_ENABLED: z.enum(["true", "false"]).default("true"),
  DATA_DIR: z.string().min(1).default("./sessions"),
  HOST: z.enum(["127.0.0.1", "0.0.0.0"]).default("127.0.0.1"),
  PORT: int(1, 65535, 8080),
  SESSION_TTL_SECONDS: int(60, 3600, 900),
  FILE_TTL_SECONDS: int(30, 3600, 600),
  MAX_IPA_BYTES: int(1024, 2147483647, 536870912),
  MAX_SESSIONS: int(1, 1000, 8),
  RATE_PER_MINUTE: int(1, 10000, 120),
  CLEANUP_SECONDS: int(1, 60, 10),
});
const owners = z.record(
  z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  z.string().min(32).max(512),
);
export function readConfig(env: NodeJS.ProcessEnv) {
  const e = envSchema.parse(env);
  const clients = owners.parse(JSON.parse(e.API_CLIENTS));
  if (
    !Object.keys(clients).length ||
    new Set(Object.values(clients)).size !== Object.keys(clients).length
  )
    throw Error("API_CLIENTS must contain unique credentials");
  const hosts = e.SOURCE_HOSTS.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (hosts.some((s) => !/^([a-z0-9-]+\.)+[a-z0-9-]+$/.test(s)))
    throw Error("Invalid source host allowlist");
  return {
    origin: e.PUBLIC_ORIGIN,
    clients,
    hosts,
    enabled: e.SERVICE_ENABLED === "true",
    dir: e.DATA_DIR,
    host: e.HOST,
    port: e.PORT,
    ttl: e.SESSION_TTL_SECONDS * 1000,
    fileTTL: e.FILE_TTL_SECONDS * 1000,
    maxBytes: e.MAX_IPA_BYTES,
    capacity: e.MAX_SESSIONS,
    rate: e.RATE_PER_MINUTE,
    sweep: e.CLEANUP_SECONDS * 1000,
  };
}
export type Config = ReturnType<typeof readConfig>;
