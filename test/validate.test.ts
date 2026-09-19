import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { validateSource, sniffFormat } from "@/lib/sources/validate";

const parquet = new Uint8Array(readFileSync("public/data/commerce/sellers.parquet"));
const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

/** A server that ignores Range and streams the whole body, counting what was read. */
function wholeFileServer(body: Uint8Array) {
  const state = { bytesRead: 0, cancelled: false };
  globalThis.fetch = (async () => {
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= body.byteLength) { controller.close(); return; }
        const chunk = body.subarray(offset, offset + 256);
        offset += chunk.byteLength;
        state.bytesRead += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() { state.cancelled = true; },
    });
    // 200, not 206: Range was ignored.
    return new Response(stream, { status: 200, headers: { "content-length": String(body.byteLength) } });
  }) as typeof fetch;
  return state;
}

describe("validateSource", () => {
  it("reads only a prefix when the server ignores Range", async () => {
    // Regression: arrayBuffer() pulled the entire body just to sniff the first
    // kilobyte, and fetchWithProgress then downloaded it all again.
    const state = wholeFileServer(parquet);
    const report = await validateSource("https://example.com/sellers.parquet");

    expect(report.ok).toBe(true);
    expect(report.format).toBe("parquet");
    expect(state.bytesRead, "read the whole file to sniff 1 KB").toBeLessThan(4096);
    expect(state.bytesRead).toBeLessThan(parquet.byteLength);
    expect(state.cancelled, "left the rest of the transfer streaming").toBe(true);
  });

  it("still identifies the format from the prefix it kept", async () => {
    wholeFileServer(parquet);
    const report = await validateSource("https://example.com/x.parquet");
    expect(report.checks.find((c) => c.id === "format")?.status).toBe("pass");
  });

  it("reports a range-supporting server as such", async () => {
    globalThis.fetch = (async () =>
      new Response(parquet.subarray(0, 1024), {
        status: 206,
        headers: { "content-range": `bytes 0-1023/${parquet.byteLength}` },
      })) as typeof fetch;
    const report = await validateSource("https://example.com/x.parquet");
    expect(report.supportsRanges).toBe(true);
    expect(report.sizeBytes).toBe(parquet.byteLength);
  });

  it("distinguishes a CORS refusal from an unreachable host", async () => {
    let call = 0;
    globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      call++;
      // First (cors) throws; second (no-cors) succeeds => the host is up.
      // A real opaque response has status 0, but the Response constructor
      // rejects that; what matters here is that it resolves rather than throws.
      if (init?.mode === "no-cors") return new Response(null, { status: 200 });
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    const report = await validateSource("https://example.com/x.parquet");
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === "cors")?.detail).toMatch(/cross-origin/i);
    expect(call).toBe(2);
  });

  it("rejects a non-https scheme and a non-URL outright", async () => {
    expect((await validateSource("ftp://example.com/x.csv")).ok).toBe(false);
    expect((await validateSource("not a url")).ok).toBe(false);
  });
});

describe("sniffFormat", () => {
  it("identifies parquet by magic bytes, not extension", () => {
    expect(sniffFormat(parquet.subarray(0, 1024))).toBe("parquet");
    expect(sniffFormat(new TextEncoder().encode('[{"a":1}]'))).toBe("json");
    expect(sniffFormat(new TextEncoder().encode("a,b\n1,2\n"))).toBe("csv");
  });
});
