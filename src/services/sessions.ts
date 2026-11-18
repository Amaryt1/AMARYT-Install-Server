import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Readable } from "node:stream";
import type { Config } from "../config/index.js";
import { ApiError, digest } from "../security/auth.js";
import { FileStorage } from "../storage/files.js";
import type { Metadata } from "./manifest.js";

type Phase = "awaiting_upload" | "uploading" | "ready" | "retired";
interface Session {
  id: string;
  owner: string;
  capability: string;
  metadata: Metadata;
  state: Phase;
  expires: number;
  bytes: number;
  manifestRequested: boolean;
  packageRequested: boolean;
  upload?: AbortController;
  removing?: Promise<void>;
}
export class Sessions {
  private records = new Map<string, Session>();
  constructor(
    private config: Config,
    readonly storage: FileStorage,
    private now = Date.now,
  ) {}
  create(owner: string, metadata: Metadata) {
    if (this.records.size >= this.config.capacity)
      throw new ApiError(429, "session_capacity");
    const s: Session = {
      id: randomBytes(24).toString("hex"),
      owner,
      capability: randomBytes(32).toString("base64url"),
      metadata,
      state: "awaiting_upload",
      expires: this.now() + this.config.ttl,
      bytes: 0,
      manifestRequested: false,
      packageRequested: false,
    };
    this.records.set(s.id, s);
    return this.status(s);
  }
  private active(id: string) {
    const s = this.records.get(id);
    if (!s || s.state === "retired" || s.expires <= this.now())
      throw new ApiError(404, "session_unavailable");
    return s;
  }
  owned(id: string, owner: string) {
    const s = this.active(id);
    if (s.owner !== owner) throw new ApiError(404, "session_unavailable");
    return s;
  }
  readable(id: string, key: string) {
    const s = this.active(id);
    if (
      s.state !== "ready" ||
      !timingSafeEqual(digest(key), digest(s.capability))
    )
      throw new ApiError(404, "file_unavailable");
    return s;
  }
  fileURL(s: Session, name: "manifest.plist" | "app.ipa") {
    return (
      this.config.origin +
      "/api/v1/install/sessions/" +
      s.id +
      "/" +
      name +
      "?key=" +
      s.capability
    );
  }
  status(s: Session) {
    return {
      id: s.id,
      state: s.state,
      expiresAt: new Date(s.expires).toISOString(),
      sizeBytes: s.bytes,
      manifestRequested: s.manifestRequested,
      packageRequested: s.packageRequested,
      manifestURL:
        s.state === "ready" ? this.fileURL(s, "manifest.plist") : null,
    };
  }
  async upload(s: Session, body: Readable, length: number) {
    if (s.state !== "awaiting_upload")
      throw new ApiError(409, "upload_conflict");
    const controller = new AbortController();
    s.state = "uploading";
    s.upload = controller;
    try {
      const bytes = await this.storage.write(
        s.id,
        body,
        length,
        this.config.maxBytes,
        controller.signal,
        s.metadata,
      );
      this.active(s.id);
      s.bytes = bytes;
      s.expires = Math.min(s.expires, this.now() + this.config.fileTTL);
      s.state = "ready";
      return this.status(s);
    } catch (e) {
      // Never expose a partial file or allow a retry to race cleanup.
      try {
        await this.storage.remove(s.id);
      } catch {
        s.state = "retired";
        throw new ApiError(503, "storage_unavailable");
      }
      if (!controller.signal.aborted && s.expires > this.now())
        s.state = "awaiting_upload";
      else {
        s.state = "retired";
        this.records.delete(s.id);
      }
      if (e instanceof ApiError) throw e;
      if (controller.signal.aborted) throw new ApiError(410, "session_closed");
      throw new ApiError(503, "upload_interrupted");
    } finally {
      delete s.upload;
    }
  }
  async retire(s: Session) {
    s.state = "retired";
    if (s.upload) {
      s.upload.abort();
      return;
    }
    if (!s.removing) {
      s.removing = this.storage
        .remove(s.id)
        .then(() => {
          this.records.delete(s.id);
        })
        .finally(() => {
          delete s.removing;
        });
    }
    await s.removing;
  }
  async sweep() {
    for (const s of this.records.values())
      if (s.expires <= this.now() || s.state === "retired")
        await this.retire(s);
  }
}
