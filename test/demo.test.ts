import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DEMO_DATASETS, DEFAULT_DEMO, demoById } from "@/lib/demo";
import { isSafeTableName } from "@/lib/duckdb/tables";
import { sniffFormat, verifyDownload } from "@/lib/sources/validate";

/** public/ is served at the root, so /data/x maps to public/data/x. */
const onDisk = (p: string) => path.join("public", p.replace(/^\//, ""));

describe("demo manifest", () => {
  it("points at files that actually exist", () => {
    // A typo here would 404 at runtime with no other warning.
    for (const dataset of DEMO_DATASETS) {
      for (const file of dataset.files) {
        expect(existsSync(onDisk(file.path)), `${dataset.id}: ${file.path}`).toBe(true);
      }
    }
  });

  it("stays within the Cloudflare static-asset size limit", () => {
    const LIMIT = 25 * 1024 * 1024;
    for (const dataset of DEMO_DATASETS) {
      for (const file of dataset.files) {
        expect(statSync(onDisk(file.path)).size, file.path).toBeLessThan(LIMIT);
      }
    }
  });

  it("uses table names that are safe and unique within a dataset", () => {
    for (const dataset of DEMO_DATASETS) {
      const names = dataset.files.map((f) => f.table);
      for (const name of names) {
        expect(isSafeTableName(name), `${dataset.id}: ${name}`).toBe(true);
      }
      expect(new Set(names).size, `${dataset.id} has duplicate table names`).toBe(names.length);
    }
  });

  it("defaults to commerce, which is the multi-table one", () => {
    expect(DEFAULT_DEMO).toBe("commerce");
    const commerce = demoById("commerce");
    // The default should be the one that shows off cross-table checks.
    expect(commerce.files.length).toBeGreaterThan(1);
    expect(DEMO_DATASETS[0].id).toBe("commerce");
  });

  it("advertises a size that matches the files on disk", () => {
    // The picker shows these numbers, so a dataset swap must not leave a stale
    // claim behind.
    for (const dataset of DEMO_DATASETS) {
      const actual = dataset.files.reduce((n, f) => n + statSync(onDisk(f.path)).size, 0);
      const drift = Math.abs(actual - dataset.approxBytes) / actual;
      expect(drift, `${dataset.id}: claims ${dataset.approxBytes}, actual ${actual}`)
        .toBeLessThan(0.1);
    }
  });

  it("declares the format each file actually is", () => {
    // loadDemo trusts this. It used to hardcode "parquet", which would have read
    // cars.json with read_parquet and failed deep inside DuckDB with a message
    // about neither format.
    for (const dataset of DEMO_DATASETS) {
      for (const file of dataset.files) {
        const bytes = new Uint8Array(readFileSync(onDisk(file.path)));
        expect(sniffFormat(bytes.subarray(0, 1024)), `${file.path}`).toBe(file.format);
        expect(verifyDownload(bytes, file.format), `${file.path}`).toBeNull();
      }
    }
  });

  it("credits every dataset", () => {
    for (const d of DEMO_DATASETS) {
      expect(d.attribution.text.length, d.id).toBeGreaterThan(10);
      expect(d.attribution.href, d.id).toMatch(/^https:\/\//);
    }
  });

  it("says plainly which data is real and which is generated", () => {
    // Being vague about this is the one thing attribution must not do.
    expect(demoById("commerce").attribution.text).toMatch(/synthetic/i);
    expect(demoById("flights").attribution.text).toMatch(/Bureau of Transportation Statistics/);
    expect(demoById("cars").attribution.text).toMatch(/vega-datasets/);
  });

  it("describes every dataset", () => {
    for (const d of DEMO_DATASETS) {
      expect(d.name.length).toBeGreaterThan(0);
      expect(d.blurb.length).toBeGreaterThan(20);
      expect(d.approxRows).toBeGreaterThan(0);
      expect(d.approxBytes).toBeGreaterThan(0);
    }
  });

  it("has an entry for every directory under public/data", () => {
    // Catches a dataset being added to disk but never wired into the picker.
    const dirs = new Set(
      DEMO_DATASETS.flatMap((d) => d.files.map((f) => f.path.split("/")[2])),
    );
    expect(dirs).toEqual(new Set(["commerce", "flights", "cars"]));
  });
});
