import { lookup } from "node:dns/promises";
import https from "node:https";
import ipaddr from "ipaddr.js";
import { ApiError } from "./auth.js";

export const publicAddress = (value: string) => {
  if (!ipaddr.isValid(value)) return false;
  const ip = ipaddr.process(value);
  // Permit ordinary global unicast only. Reject transition prefixes, metadata,
  // documentation/reserved space and mapped IPv4 private addresses.
  if (ip.range() !== "unicast") return false;
  const denied =
    ip.kind() === "ipv4"
      ? ["168.63.129.16/32", "192.0.0.0/24"]
      : ["2001::/23", "3fff::/20"];
  if (denied.some((cidr) => ip.match(ipaddr.parseCIDR(cidr)))) return false;
  return ip.kind() === "ipv4" || ip.match(ipaddr.parseCIDR("2000::/3"));
};
type Address = { address: string; family: number };
type Reply = { status: number; location?: string; size?: string };
type Resolver = (host: string) => Promise<Address[]>;
type Probe = (url: URL, target: Address) => Promise<Reply>;
const dns: Resolver = (host) => lookup(host, { all: true, verbatim: true });
const head: Probe = (url, target) =>
  new Promise((resolve, reject) => {
    // Connect to the vetted IP. Host and SNI keep TLS verification bound to the original name.
    const req = https.request(
      {
        hostname: target.address,
        family: target.family,
        port: 443,
        path: url.pathname + url.search,
        method: "HEAD",
        headers: { host: url.hostname },
        servername: url.hostname,
        agent: false,
        signal: AbortSignal.timeout(4000),
      },
      (res) => {
        const result = {
          status: res.statusCode ?? 0,
          location: res.headers.location,
          size: res.headers["content-length"],
        };
        res.destroy();
        resolve(result);
      },
    );
    req.on("error", reject);
    req.end();
  });
async function boundedLookup(resolver: Resolver, host: string) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      resolver(host),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("DNS timeout")), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function resolveSource(
  raw: string,
  hosts: string[],
  maxBytes: number,
  resolver: Resolver = dns,
  probe: Probe = head,
) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(400, "invalid_source");
  }
  for (let hops = 0; hops <= 3; hops++) {
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      ipaddr.isValid(host.replace(/^\[|\]$/g, "")) ||
      !hosts.includes(host)
    )
      throw new ApiError(400, "source_not_allowed");
    let addresses: Address[];
    try {
      addresses = await boundedLookup(resolver, host);
    } catch {
      throw new ApiError(502, "source_dns_failed");
    }
    if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
      throw new ApiError(400, "unsafe_source_address");
    let response: Reply;
    try {
      response = await probe(url, addresses[0]);
    } catch {
      throw new ApiError(502, "source_unreachable");
    }
    if (
      [301, 302, 303, 307, 308].includes(response.status) &&
      response.location
    ) {
      try {
        url = new URL(response.location, url);
      } catch {
        throw new ApiError(400, "invalid_redirect");
      }
      continue;
    }
    if (response.status < 200 || response.status >= 300)
      throw new ApiError(422, "source_head_rejected");
    const size = response.size === undefined ? null : Number(response.size);
    if (
      size !== null &&
      (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes)
    )
      throw new ApiError(413, "invalid_source_size");
    return { url: url.href, sizeBytes: size };
  }
  throw new ApiError(400, "too_many_redirects");
}
