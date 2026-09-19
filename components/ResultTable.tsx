export interface ResultRows {
  columns: string[];
  rows: unknown[][];
}

function render(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Rows from a local DuckDB query. Never transmitted anywhere. */
export function ResultTable({ preview }: { preview: ResultRows }) {
  return (
    <div className="overflow-x-auto rounded-md border hairline">
      <table className="text-xs font-mono border-collapse min-w-full">
        <thead>
          <tr className="border-b hairline">
            {preview.columns.map((c) => (
              <th key={c} className="px-2 py-1.5 text-left font-semibold whitespace-nowrap">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {preview.rows.map((row, i) => (
            <tr key={i} className="border-b hairline last:border-0">
              {row.map((cell, j) => (
                <td
                  key={j}
                  className={`px-2 py-1 whitespace-nowrap ${cell === null ? "muted italic" : ""}`}
                >
                  {render(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
