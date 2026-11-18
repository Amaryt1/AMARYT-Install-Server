import { bundleInfo } from "./bundle-info.js";
import type { Metadata } from "./manifest.js";
import yauzl from "yauzl";
import { ApiError } from "../security/auth.js";

// Read the central directory and a bounded Info.plist in memory.
export function inspectArchive(
  path: string,
  metadata: Metadata,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const invalid = () => new ApiError(422, "signed_ipa_structure_required");
    yauzl.open(
      path,
      { lazyEntries: true, strictFileNames: true },
      (err, zip) => {
        if (err || !zip) return reject(invalid());
        let count = 0;
        const apps = new Map<string, Set<string>>();
        const fail = () => {
          zip.close();
          reject(invalid());
        };
        zip.on("error", fail);
        zip.on("entry", (entry: yauzl.Entry) => {
          if (++count > 60000 || entry.isEncrypted()) return fail();
          const m =
            /^Payload\/([^/]+\.app)\/(Info\.plist|_CodeSignature\/CodeResources|embedded\.mobileprovision)$/.exec(
              entry.fileName,
            );
          if (m && entry.uncompressedSize > 0) {
            const files = apps.get(m[1]) ?? new Set<string>();
            if (files.has(m[2])) return fail();
            files.add(m[2]);
            apps.set(m[1], files);
            if (m[2] === "Info.plist") {
              if (entry.uncompressedSize > 512 * 1024) return fail();
              zip.openReadStream(entry, (error, stream) => {
                if (error || !stream) return fail();
                let size = 0;
                const chunks: Buffer[] = [];
                stream.on("error", fail);
                stream.on("data", (chunk: Buffer) => {
                  size += chunk.length;
                  if (size > 512 * 1024) {
                    stream.destroy();
                    fail();
                    return;
                  }
                  chunks.push(chunk);
                });
                stream.on("end", () => {
                  bundleInfo(Buffer.concat(chunks))
                    .then((info) => {
                      if (
                        info.id !== metadata.bundleIdentifier ||
                        info.build !== metadata.bundleVersion
                      )
                        return fail();
                      zip.readEntry();
                    })
                    .catch(fail);
                });
              });
              return;
            }
          }
          zip.readEntry();
        });
        zip.on("end", () => {
          if (apps.size === 1 && [...apps.values()][0].size === 3) resolve();
          else reject(invalid());
        });
        zip.readEntry();
      },
    );
  });
}
