import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/config/index.js";
import { FileStorage } from "../src/storage/files.js";

const alice = "a".repeat(40),
  bob = "b".repeat(40);
const auth = (key = alice) => ({ authorization: "Bearer " + key });
const base = "/api/v1/install/sessions";
const meta = {
  bundleIdentifier: "org.example.app",
  bundleVersion: "7",
  title: "A&B",
};
const files = Object.fromEntries(
  [
    "Info.plist",
    "embedded.mobileprovision",
    "_CodeSignature/CodeResources",
  ].map((f) => ["Payload/Test.app/" + f, strToU8("fixture")]),
);
files["Payload/Test.app/Info.plist"] = strToU8(
  '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.example.app</string><key>CFBundleVersion</key><string>7</string></dict></plist>',
);
const ipa = Buffer.from(zipSync(files));
let dir: string,
  service: Awaited<ReturnType<typeof buildApp>>,
  storage: FileStorage,
  now: number,
  config: ReturnType<typeof readConfig>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "amaryt-test-"));
  config = readConfig({
    API_CLIENTS: JSON.stringify({ alice, bob }),
    DATA_DIR: dir,
    PUBLIC_ORIGIN: "https://install.example",
    MAX_IPA_BYTES: "4096",
  });
  storage = new FileStorage(dir);
  now = Date.now();
  service = await buildApp(config, {
    storage,
    now: () => now,
    resolve: async (url) => ({ url, sizeBytes: 120 }),
  });
});
afterEach(async () => {
  await service.app.close();
  await rm(dir, { recursive: true, force: true });
});
async function create() {
  const r = await service.app.inject({
    method: "POST",
    url: base,
    headers: auth(),
    payload: meta,
  });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}
function upload(id: string, bytes = ipa, who = alice, consent = "1") {
  return service.app.inject({
    method: "POST",
    url: base + "/" + id + "/upload",
    headers: {
      ...auth(who),
      "content-type": "application/octet-stream",
      "x-amaryt-upload-consent": consent,
    },
    payload: bytes,
  });
}
it("exposes only public config and protects session creation", async () => {
  expect((await service.app.inject("/health")).json().status).toBe("ok");
  const cfg = (await service.app.inject("/api/v1/config")).json();
  expect(cfg.uploadOptional).toBe(true);
  expect(cfg.clients).toBeUndefined();
  expect(
    (await service.app.inject({ method: "POST", url: base, payload: meta }))
      .statusCode,
  ).toBe(401);
  expect(
    (
      await service.app.inject({
        method: "POST",
        url: base,
        headers: auth(),
        payload: { ...meta, p12: "unexpected" },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await service.app.inject({
        method: "PATCH",
        url: "/api/v1/config",
        headers: auth(),
        payload: { enabled: false },
      })
    ).statusCode,
  ).toBe(404);
});
it("resolves authenticated source requests and rejects unexpected fields", async () => {
  const url = "/api/v1/install/resolve",
    payload = { url: "https://cdn.example.org/a" };
  expect(
    (
      await service.app.inject({
        method: "POST",
        url,
        headers: auth(),
        payload,
      })
    ).json().sizeBytes,
  ).toBe(120);
  expect(
    (
      await service.app.inject({
        method: "POST",
        url,
        headers: auth(),
        payload: { ...payload, host: "override" },
      })
    ).statusCode,
  ).toBe(400);
});
it("enforces ownership, consent and bounded binary uploads", async () => {
  const id = await create();
  expect((await upload(id, ipa, bob)).statusCode).toBe(404);
  expect((await upload(id, ipa, alice, "0")).statusCode).toBe(400);
  expect((await upload(id, Buffer.alloc(5000))).statusCode).toBe(413);
  for (const method of ["GET", "DELETE"] as const)
    expect(
      (
        await service.app.inject({
          method,
          url: base + "/" + id + (method === "GET" ? "/status" : ""),
          headers: auth(bob),
        })
      ).statusCode,
    ).toBe(404);
});
it("serves a capability-gated XML manifest and exact package, tracks retrieval only", async () => {
  const id = await create();
  const result = await upload(id);
  expect(result.statusCode).toBe(200);
  const url = new URL(result.json().manifestURL);
  expect(url.origin).toBe(config.origin);
  expect((await service.app.inject(url.pathname)).statusCode).toBe(404);
  expect(
    (await service.app.inject(url.pathname + "?key=" + "x".repeat(43)))
      .statusCode,
  ).toBe(404);
  expect((await service.app.inject(url.pathname + url.search)).body).toContain(
    "A&amp;B",
  );
  const file = url.pathname.replace("manifest.plist", "app.ipa") + url.search;
  expect((await service.app.inject({ method: "HEAD", url: file })).body).toBe(
    "",
  );
  expect((await service.app.inject(file)).rawPayload.equals(ipa)).toBe(true);
  expect(
    (
      await service.app.inject({
        url: base + "/" + id + "/status",
        headers: auth(),
      })
    ).json(),
  ).toMatchObject({
    state: "ready",
    packageRequested: true,
    manifestRequested: true,
  });
  expect((await upload(id)).statusCode).toBe(409);
  expect(
    (
      await service.app.inject({
        method: "DELETE",
        url: base + "/" + id,
        headers: auth(),
      })
    ).statusCode,
  ).toBe(204);
  expect(await readdir(dir)).toEqual([]);
  expect((await service.app.inject(file)).statusCode).toBe(404);
});
it("rejects incomplete/unsigned archives, cleans staging and permits retry", async () => {
  const id = await create();
  for (const bad of [
    Buffer.from(
      zipSync({ ...files, "Payload/Test.app/Info.plist": strToU8("invalid") }),
    ),
    Buffer.from("not a zip"),
    Buffer.from(zipSync({ "Payload/A.app/Info.plist": strToU8("test") })),
  ]) {
    expect((await upload(id, bad)).statusCode).toBe(422);
    expect(await readdir(dir)).toEqual([]);
  }
  expect((await upload(id)).statusCode).toBe(200);
});
it("expires capabilities immediately and sweeps files", async () => {
  const id = await create(),
    u = new URL((await upload(id)).json().manifestURL);
  now += config.fileTTL;
  expect((await service.app.inject(u.pathname + u.search)).statusCode).toBe(
    404,
  );
  await service.sessions.sweep();
  expect(await readdir(dir)).toEqual([]);
});
it("exposes service disablement and retains owner deletion", async () => {
  const id = await create();
  config.enabled = false;
  expect((await service.app.inject("/api/v1/config")).json().enabled).toBe(
    false,
  );
  expect((await upload(id)).statusCode).toBe(503);
  expect(
    (
      await service.app.inject({
        method: "DELETE",
        url: base + "/" + id,
        headers: auth(),
      })
    ).statusCode,
  ).toBe(204);
});
it("fails closed on storage failures and retries cleanup", async () => {
  const id = await create();
  vi.spyOn(storage, "write").mockRejectedValueOnce(Error("private details"));
  const r = await upload(id);
  expect(r.statusCode).toBe(503);
  expect(r.body).not.toContain("private details");
  expect((await upload(id)).statusCode).toBe(200);
  vi.spyOn(storage, "remove").mockRejectedValueOnce(Error("disk busy"));
  await service.app.inject({
    method: "DELETE",
    url: base + "/" + id,
    headers: auth(),
  });
  await service.sessions.sweep();
  expect(await readdir(dir)).toEqual([]);
});
it("cleans only service-owned orphans on restart", async () => {
  await writeFile(join(dir, "amaryt-" + "1".repeat(48) + ".part"), "test");
  await writeFile(join(dir, "unrelated"), "keep");
  await storage.init();
  expect(await readdir(dir)).toEqual(["unrelated"]);
});
it("limits sessions and per-minute requests", async () => {
  config.capacity = 1;
  await create();
  expect(
    (
      await service.app.inject({
        method: "POST",
        url: base,
        headers: auth(),
        payload: meta,
      })
    ).statusCode,
  ).toBe(429);
  const statuses = [];
  for (let i = 0; i <= config.rate; i++)
    statuses.push((await service.app.inject("/health")).statusCode);
  expect(statuses).toContain(429);
});
