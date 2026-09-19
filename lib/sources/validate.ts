export type SourceFormat = "parquet" | "csv" | "json";

export type CheckStatus = "pass" | "warn" | "fail";

export interface SourceCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface ValidationReport {
  ok: boolean;
  url: string;
  format: SourceFormat | null;
  sizeBytes: number | null;
  supportsRanges: boolean;
  checks: SourceCheck[];
}

/** Warn above this, since the file is materialised into browser memory. */
const LARGE_FILE_BYTES = 500 * 1024 * 1024;

const EXTENSION_FORMATS: Record<string, SourceFormat> = {
  parquet: "parquet",
  pq: "parquet",
  csv: "csv",
  tsv: "csv",
  txt: "csv",
  json: "json",
  ndjson: "json",
  jsonl: "json",
};

export function formatFromExtension(pathname: string): SourceFormat | null {
  const ext = pathname.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_FORMATS[ext] ?? null;
}

/**
 * Identify the format from the first bytes of the file rather than trusting the
 * extension. Parquet has a real magic number; JSON and CSV are inferred from
 * the first non-whitespace character and general text-ness.
 */
export function sniffFormat(head: Uint8Array): SourceFormat | null {
  if (head.length >= 4) {
    // Every Parquet file begins (and ends) with the ASCII bytes "PAR1".
    if (head[0] === 0x50 && head[1] === 0x41 && head[2] === 0x52 && head[3] === 0x31) {
      return "parquet";
    }
  }

  // Anything with NUL bytes in the first KB is binary, and not a format we read.
  if (head.subarray(0, 512).includes(0x00)) return null;

  const text = new TextDecoder("utf-8", { fatal: false }).decode(head).trimStart();
  if (text === "") return null;
  if (text[0] === "{" || text[0] === "[") return "json";

  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  if (/[,;\t|]/.test(firstLine)) return "csv";
  return null;
}

export function formatBytes(n: number | null): string {
  if (n === null) return "unknown size";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/**
 * Preflight a data URL before we try to load it.
 *
 * Uses a ranged GET rather than HEAD: many object stores reject HEAD under CORS,
 * and one ranged request simultaneously tests reachability, CORS, range support,
 * size and file contents.
 */
export async function validateSource(rawUrl: string): Promise<ValidationReport> {
  const checks: SourceCheck[] = [];
  const fail = (report: Partial<ValidationReport> = {}): ValidationReport => ({
    ok: false,
    url: rawUrl,
    format: null,
    sizeBytes: null,
    supportsRanges: false,
    checks,
    ...report,
  });

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    checks.push({
      id: "url",
      label: "Valid URL",
      status: "fail",
      detail: "That is not a URL. It should start with https://",
    });
    return fail();
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    checks.push({
      id: "url",
      label: "Valid URL",
      status: "fail",
      detail: `Unsupported scheme "${url.protocol}". Use http or https.`,
    });
    return fail();
  }
  checks.push({ id: "url", label: "Valid URL", status: "pass", detail: url.host });

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Range: "bytes=0-1023" },
      mode: "cors",
      // Do NOT let this land in the HTTP cache. It is a 206 Partial Content of
      // the first kilobyte, and a cached partial can be served to the full GET
      // that follows, handing back a truncated file. That produced
      // "No magic bytes found at end of file" on every URL source while the
      // demo, which fetches once and never probes, worked fine.
      cache: "no-store",
    });
  } catch {
    // The browser refuses to tell us whether this was a CORS rejection or a dead
    // host, so probe again without CORS to work out which and say so honestly.
    let hostReachable = false;
    try {
      await fetch(url, { mode: "no-cors" });
      hostReachable = true;
    } catch {
      /* still unreachable */
    }
    checks.push(
      hostReachable
        ? {
            id: "cors",
            label: "CORS accessible",
            status: "fail",
            detail:
              "The server is reachable but refuses cross-origin reads. It needs to send an Access-Control-Allow-Origin header.",
          }
        : {
            id: "cors",
            label: "Reachable",
            status: "fail",
            detail: "Could not reach the URL. Check the address and your connection.",
          },
    );
    return fail();
  }

  if (!res.ok && res.status !== 206) {
    checks.push({
      id: "cors",
      label: "Reachable",
      status: "fail",
      detail: `Server responded ${res.status} ${res.statusText}.`,
    });
    return fail();
  }
  checks.push({
    id: "cors",
    label: "CORS accessible",
    status: "pass",
    detail: "Cross-origin read allowed.",
  });

  const supportsRanges = res.status === 206;
  checks.push(
    supportsRanges
      ? {
          id: "ranges",
          label: "Range requests",
          status: "pass",
          detail: "Server supports partial reads.",
        }
      : {
          id: "ranges",
          label: "Range requests",
          status: "warn",
          detail: "Not supported, so the whole file will be downloaded.",
        },
  );

  // Content-Range and Accept-Ranges are not CORS-safelisted, so they are often
  // invisible to us even when the server sent them. Report unknown, never guess.
  let sizeBytes: number | null = null;
  const contentRange = res.headers.get("content-range");
  const contentLength = res.headers.get("content-length");
  if (contentRange) {
    const total = Number(contentRange.split("/")[1]);
    if (Number.isFinite(total)) sizeBytes = total;
  } else if (!supportsRanges && contentLength) {
    const total = Number(contentLength);
    if (Number.isFinite(total)) sizeBytes = total;
  }

  if (sizeBytes !== null && sizeBytes > LARGE_FILE_BYTES) {
    checks.push({
      id: "size",
      label: "Size",
      status: "warn",
      detail: `${formatBytes(sizeBytes)}. Large files are held in browser memory and may be slow.`,
    });
  } else {
    checks.push({
      id: "size",
      label: "Size",
      status: "pass",
      detail:
        sizeBytes === null
          ? "Not reported by the server (headers not exposed to the browser)."
          : formatBytes(sizeBytes),
    });
  }

  const head = new Uint8Array(await res.arrayBuffer());
  const sniffed = sniffFormat(head);
  const declared = formatFromExtension(url.pathname);
  const format = sniffed ?? declared;

  if (format === null) {
    checks.push({
      id: "format",
      label: "Recognised format",
      status: "fail",
      detail: "Not Parquet, CSV or JSON as far as we can tell.",
    });
    return fail({ supportsRanges, sizeBytes });
  }

  if (sniffed && declared && sniffed !== declared) {
    checks.push({
      id: "format",
      label: "Recognised format",
      status: "warn",
      detail: `Named .${url.pathname.split(".").pop()} but the contents look like ${sniffed}. Reading it as ${sniffed}.`,
    });
  } else {
    checks.push({
      id: "format",
      label: "Recognised format",
      status: "pass",
      detail: sniffed
        ? `${sniffed} (confirmed from file contents)`
        : `${format} (from the file extension)`,
    });
  }

  return { ok: true, url: rawUrl, format, sizeBytes, supportsRanges, checks };
}

/**
 * Check downloaded bytes really are the format we are about to read them as.
 *
 * DuckDB's complaint about a truncated file names an internal buffer and a
 * missing footer, which tells a user nothing. Catching it here means a short or
 * corrupt download is reported as a short download.
 */
export function verifyDownload(
  bytes: Uint8Array,
  format: SourceFormat,
  expectedBytes?: number | null,
): string | null {
  if (bytes.byteLength === 0) return "The download was empty.";

  if (expectedBytes != null && bytes.byteLength < expectedBytes) {
    return `The download stopped early: got ${formatBytes(bytes.byteLength)} of ${formatBytes(expectedBytes)}.`;
  }

  if (format === "parquet") {
    const magic = [0x50, 0x41, 0x52, 0x31]; // "PAR1"
    const startsRight = magic.every((b, i) => bytes[i] === b);
    const tail = bytes.byteLength - 4;
    const endsRight = tail >= 4 && magic.every((b, i) => bytes[tail + i] === b);

    if (!startsRight) return "That is not a Parquet file: it has no PAR1 header.";
    if (!endsRight) {
      return `The Parquet file is incomplete: it has a PAR1 header but no footer, so the download was cut short at ${formatBytes(bytes.byteLength)}.`;
    }
  }

  return null;
}
