import { describe, it, expect, vi } from "vitest";
import { publicAddress, resolveSource } from "../src/security/source.js";
const hosts = ["cdn.example.org", "other.example.org"];
const dns = async () => [{ address: "93.184.216.34", family: 4 }];
const ok = async () => ({ status: 200, size: "15" });
describe("source validation", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "100.64.0.1",
    "169.254.169.254",
    "192.168.0.2",
    "168.63.129.16",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
    "ff00::1",
  ])("denies %s", (ip) => expect(publicAddress(ip)).toBe(false));
  it.each([
    "http://cdn.example.org/a",
    "https://root@cdn.example.org/a",
    "https://localhost/a",
    "https://[::1]/a",
    "https://2130706433/a",
    "https://metadata.google.internal/a",
    "https://cdn.example.org:8080/a",
  ])("rejects %s without a probe", async (url) => {
    const head = vi.fn(ok);
    await expect(
      resolveSource(url, hosts, 100, dns, head),
    ).rejects.toMatchObject({ status: 400 });
    expect(head).not.toHaveBeenCalled();
  });
  it("revalidates redirect DNS, rejects mixed answers and never connects to them", async () => {
    const lookup = vi
      .fn(dns)
      .mockImplementationOnce(dns)
      .mockImplementationOnce(async () => [
        ...(await dns()),
        { address: "10.0.0.9", family: 4 },
      ]);
    const probe = vi.fn(async () => ({
      status: 302,
      location: "https://other.example.org/app.ipa",
    }));
    await expect(
      resolveSource("https://cdn.example.org/a", hosts, 100, lookup, probe),
    ).rejects.toMatchObject({ code: "unsafe_source_address" });
    expect(probe.mock.calls.length).toBe(1);
  });
  it("rechecks allowlist on redirects and pins the selected public address", async () => {
    const probe = vi.fn(ok);
    const result = await resolveSource(
      "https://cdn.example.org/app.ipa",
      hosts,
      100,
      dns,
      probe,
    );
    expect(result.sizeBytes).toBe(15);
    expect(probe).toHaveBeenCalledWith(new URL(result.url), {
      address: "93.184.216.34",
      family: 4,
    });
    await expect(
      resolveSource(result.url, hosts, 100, dns, async () => ({
        status: 302,
        location: "https://unlisted.example/a",
      })),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("bounds redirects, sizes and network errors", async () => {
    const url = "https://cdn.example.org/a";
    await expect(
      resolveSource(url, hosts, 100, dns, async () => ({
        status: 302,
        location: "/a",
      })),
    ).rejects.toMatchObject({ code: "too_many_redirects" });
    await expect(resolveSource(url, hosts, 10, dns, ok)).rejects.toMatchObject({
      status: 413,
    });
    await expect(
      resolveSource(url, hosts, 100, dns, async () => {
        throw Error();
      }),
    ).rejects.toMatchObject({ status: 502 });
    await expect(
      resolveSource(
        url,
        hosts,
        100,
        async () => {
          throw Error();
        },
        ok,
      ),
    ).rejects.toMatchObject({ code: "source_dns_failed" });
  });
});
