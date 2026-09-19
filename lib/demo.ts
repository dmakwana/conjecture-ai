/**
 * Curated datasets that ship with the app, served from public/data.
 *
 * These are same-origin and known-good, so they skip the URL validation that
 * user-supplied sources go through. There is no CORS question to answer and no
 * format to sniff.
 */

import type { SourceFormat } from "@/lib/sources/validate";

export type DemoId = "commerce" | "flights" | "cars";

export interface DemoFile {
  /** SQL identifier. Fixed here rather than derived, so hypotheses about the
   *  demo data are reproducible and the prompt sees stable names. */
  table: string;
  path: string;
  /** Declared rather than sniffed, since we control these files. A test checks
   *  the declaration against the bytes, because reading a file as the wrong
   *  format fails deep inside DuckDB with a message about neither. */
  format: SourceFormat;
}

export interface Attribution {
  /** Credit line, phrased as the source asks for it where one does. */
  text: string;
  /** Where the original lives. */
  href: string;
}

export interface DemoDataset {
  id: DemoId;
  name: string;
  /** What the data is. */
  blurb: string;
  attribution: Attribution;
  files: DemoFile[];
  approxRows: number;
  approxBytes: number;
}

export const DEMO_DATASETS: DemoDataset[] = [
  {
    id: "commerce",
    name: "Commerce",
    blurb:
      "An online marketplace in seven normalised tables: customers, sellers, products, orders, line items, payments and refunds.",
    attribution: {
      text: "Synthetic. Generated for this demo; no real records. Schema inspired by the Olist Brazilian e-commerce dataset.",
      href: "https://www.kaggle.com/datasets/olistbr/brazilian-ecommerce",
    },
    files: [
      { table: "customers", path: "/data/commerce/customers.parquet", format: "parquet" },
      { table: "sellers", path: "/data/commerce/sellers.parquet", format: "parquet" },
      { table: "products", path: "/data/commerce/products.parquet", format: "parquet" },
      { table: "orders", path: "/data/commerce/orders.parquet", format: "parquet" },
      { table: "order_items", path: "/data/commerce/order_items.parquet", format: "parquet" },
      { table: "payments", path: "/data/commerce/payments.parquet", format: "parquet" },
      { table: "refunds", path: "/data/commerce/refunds.parquet", format: "parquet" },
    ],
    approxRows: 185_000,
    approxBytes: 4_600_000,
  },
  {
    id: "flights",
    name: "Flights",
    blurb:
      "Ninety thousand domestic flights with schedules, delays and a breakdown of what caused them.",
    attribution: {
      text: "U.S. Department of Transportation, Bureau of Transportation Statistics, Reporting Carrier On-Time Performance, June 2024. A US federal work, not subject to copyright.",
      href: "https://www.transtats.bts.gov/Fields.asp?gnoyr_VQ=FGJ",
    },
    files: [{ table: "flights", path: "/data/flights/flights.parquet", format: "parquet" }],
    approxRows: 91_000,
    approxBytes: 2_100_000,
  },
  {
    id: "cars",
    name: "Cars",
    blurb:
      "Four hundred cars from the 1970s and 80s, with engine size, power, weight, fuel economy and origin. Small enough to read end to end.",
    attribution: {
      text: "vega-datasets (BSD-3-Clause), which carries the 1983 ASA Data Exposition cars dataset.",
      href: "https://github.com/vega/vega-datasets",
    },
    files: [{ table: "cars", path: "/data/cars/cars.json", format: "json" }],
    approxRows: 406,
    approxBytes: 100_492,
  },
];

export const DEFAULT_DEMO: DemoId = "commerce";

export function demoById(id: DemoId): DemoDataset {
  const found = DEMO_DATASETS.find((d) => d.id === id);
  if (!found) throw new Error(`Unknown demo dataset: ${id}`);
  return found;
}
