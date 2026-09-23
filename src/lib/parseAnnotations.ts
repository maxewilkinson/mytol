import * as d3 from "d3";
import type { AnnotationRow } from "./types";

/**
 * Parse a CSV or TSV annotation file.
 *
 * The original behavior is preserved: prefer an explicit 'id' or 'name' column,
 * and otherwise rely on the existing file parsing rules. An explicit UI/query
 * override can select a specific metadata key when needed.
 */
export async function parseAnnotations(
  file: File,
  idField?: string
): Promise<{ rows: AnnotationRow[]; columns: string[] }> {
  const text = await file.text();

  const isTsv = file.name.toLowerCase().endsWith(".tsv") || text.includes("\t");
  const parsed = isTsv ? d3.tsvParse(text) : d3.csvParse(text);

  const columns = parsed.columns.map((c) => c.trim());
  const resolvedIdField =
    idField && columns.some((c) => c.toLowerCase() === idField.toLowerCase())
      ? columns.find((c) => c.toLowerCase() === idField.toLowerCase())!
      : columns.find((c) => c.toLowerCase() === "id" || c.toLowerCase() === "name") ??
        columns[0];

  if (!resolvedIdField) {
    throw new Error(
      `Annotation file must include at least one column (found: ${columns.join(", ")})`
    );
  }

  const dataRows = parsed
    .map((r) => {
      const row: AnnotationRow = {
        id: String(r[resolvedIdField] ?? "").trim(),
      };
      for (const col of columns) {
        if (col !== resolvedIdField) row[col] = r[col] != null ? String(r[col]).trim() : r[col];
      }
      return row;
    })
    .filter((r) => r.id !== "");

  const dataCols = columns.filter((c) => c !== resolvedIdField);
  return { rows: dataRows, columns: dataCols };
}
