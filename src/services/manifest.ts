import { z } from "zod";
const text = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((v) => !/[\u0000-\u001f\ufffe\uffff]/u.test(v) && v.isWellFormed());
export const metadataSchema = z.strictObject({
  title: text,
  bundleIdentifier: z
    .string()
    .max(255)
    .regex(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/),
  bundleVersion: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[0-9A-Za-z.-]+$/),
});
export type Metadata = z.infer<typeof metadataSchema>;
const escape = (v: string) =>
  v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
export function manifest(meta: Metadata, fileURL: string) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>items</key><array><dict>' +
    "<key>assets</key><array><dict><key>kind</key><string>software-package</string><key>url</key><string>" +
    escape(fileURL) +
    "</string></dict></array>" +
    "<key>metadata</key><dict>" +
    Object.entries({
      "bundle-identifier": meta.bundleIdentifier,
      "bundle-version": meta.bundleVersion,
      kind: "software",
      title: meta.title,
    })
      .map(([k, v]) => "<key>" + k + "</key><string>" + escape(v) + "</string>")
      .join("") +
    "</dict></dict></array></dict></plist>"
  );
}
