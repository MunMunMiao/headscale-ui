type CsvCell = string | number | boolean | null | undefined;

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function csvCell(value: CsvCell) {
  const text = String(value ?? "");
  // OWASP CSV-injection mitigation; the visible apostrophe is an accepted trade-off.
  const safe =
    typeof value === "string" && FORMULA_PREFIX.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function downloadCsv<K extends string>(
  fileName: string,
  columns: readonly K[],
  rows: Array<Record<K, CsvCell>>,
) {
  const csv = [
    columns.map(csvCell).join(","),
    ...rows.map((row) =>
      columns.map((column) => csvCell(row[column])).join(","),
    ),
  ].join("\n");
  // The byte order mark makes Excel decode UTF-8 instead of the system code page.
  const url = URL.createObjectURL(
    new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  // Some browsers read the blob after click() returns; FileSaver.js waits 40 s for the same reason.
  setTimeout(() => URL.revokeObjectURL(url), 40_000);
}
