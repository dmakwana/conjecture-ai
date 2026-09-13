/**
 * Curated datasets that ship with the app, served from public/data.
 *
 * These are same-origin and known-good, so they skip the URL validation that
 * user-supplied sources go through — there is no CORS question to answer and no
 * format to sniff.
 */

export type DemoId = "commerce" | "flights" | "power";

export interface DemoFile {
  /** SQL identifier. Fixed here rather than derived, so hypotheses about the
   *  demo data are reproducible and the prompt sees stable names. */
  table: string;
  path: string;
}

export interface DemoDataset {
  id: DemoId;
  name: string;
  /** What the data is. */
  blurb: string;
  /** The kind of defect this dataset is good at showing off. */
  lookFor: string;
  files: DemoFile[];
  approxRows: number;
  approxBytes: number;
}

export const DEMO_DATASETS: DemoDataset[] = [
  {
    id: "commerce",
    name: "Commerce",
    blurb:
      "An online marketplace in seven normalised tables, plus a denormalised orders_flat built from them.",
    lookFor:
      "Referential integrity across orders, items, payments and refunds — and whether the flattened table still agrees with the tables it came from.",
    files: [
      { table: "customers", path: "/data/commerce/customers.parquet" },
      { table: "sellers", path: "/data/commerce/sellers.parquet" },
      { table: "products", path: "/data/commerce/products.parquet" },
      { table: "orders", path: "/data/commerce/orders.parquet" },
      { table: "order_items", path: "/data/commerce/order_items.parquet" },
      { table: "payments", path: "/data/commerce/payments.parquet" },
      { table: "refunds", path: "/data/commerce/refunds.parquet" },
      { table: "orders_flat", path: "/data/commerce/orders_flat.parquet" },
    ],
    approxRows: 258_000,
    approxBytes: 8_300_000,
  },
  {
    id: "flights",
    name: "Flights",
    blurb:
      "Ninety thousand domestic flights with schedules, delays and a breakdown of what caused them.",
    lookFor:
      "Arithmetic that should reconcile: delay causes summing to the total, elapsed time against air time plus taxiing, and what a cancelled flight is allowed to record.",
    files: [{ table: "flights", path: "/data/flights/flights.parquet" }],
    approxRows: 91_000,
    approxBytes: 2_100_000,
  },
  {
    id: "power",
    name: "Power",
    blurb:
      "Household electricity meter readings sampled over time, with firmware and ingest-batch metadata.",
    lookFor:
      "Sensor and pipeline problems: a cumulative register that should never go backwards, sub-meters that should not exceed the total, and gaps between batches.",
    files: [{ table: "meter_readings", path: "/data/power/meter_readings.parquet" }],
    approxRows: 89_000,
    approxBytes: 2_100_000,
  },
];

export const DEFAULT_DEMO: DemoId = "commerce";

export function demoById(id: DemoId): DemoDataset {
  const found = DEMO_DATASETS.find((d) => d.id === id);
  if (!found) throw new Error(`Unknown demo dataset: ${id}`);
  return found;
}
