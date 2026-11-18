import { mkdir, readdir, unlink, open, rename, chmod } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import type { Metadata } from "../services/manifest.js";
import { inspectArchive } from "../services/archive.js";
import { ApiError } from "../security/auth.js";

export class FileStorage {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = resolve(dir);
  }
  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    for (const name of await readdir(this.dir)) {
      if (/^amaryt-[a-f0-9]{48}\.(part|ipa)$/.test(name))
        await unlink(join(this.dir, name));
    }
  }
  private path(id: string, ext: string) {
    if (!/^[a-f0-9]{48}$/.test(id)) throw Error("Invalid storage key");
    return join(this.dir, "amaryt-" + id + "." + ext);
  }
  async write(
    id: string,
    body: Readable,
    length: number,
    max: number,
    signal: AbortSignal,
    metadata: Metadata,
  ) {
    const part = this.path(id, "part");
    let bytes = 0;
    await pipeline(
      body,
      new Transform({
        transform(chunk, _, done) {
          bytes += chunk.length;
          done(
            bytes > max || bytes > length
              ? new ApiError(413, "upload_too_large")
              : null,
            chunk,
          );
        },
      }),
      createWriteStream(part, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    if (bytes !== length) throw new ApiError(400, "incomplete_upload");
    await inspectArchive(part, metadata);
    signal.throwIfAborted();
    await rename(part, this.path(id, "ipa"));
    return bytes;
  }
  async open(id: string) {
    return open(this.path(id, "ipa"), "r");
  }
  async remove(id: string) {
    for (const ext of ["part", "ipa"]) {
      await unlink(this.path(id, ext)).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
    }
  }
}
