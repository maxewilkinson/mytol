import * as d3 from "d3";
import type { AnnotationRow } from "./types";

/**
 * Parse a CSV or TSV annotation file.
 *
 * Bug fix: the original code always used d3.csvParse, which silently failed
 * for TSV files (columns were not split). Now we detect the file extension
 * and use d3.tsvParse when appropriate.
 *
 * The file must contain an 'id' or 'name' column (case-insensitive) that
 * will be used to join rows against leaf names in the tree.
 */
export async function parseAnnotations(
  file: File
): Promise<{ rows: AnnotationRow[]; columns: string[] }> {
  const text = await file.text();

  const isTsv = file.name.toLowerCase().endsWith(".tsv");
  const parsed = isTsv ? d3.tsvParse(text) : d3.csvParse(text);

  const idCol = parsed.columns.find(
    (c) => c.toLowerCase() === "id" || c.toLowerCase() === "name"
  );
  if (!idCol) {
    throw new Error(
      `Annotation file must have an 'id' or 'name' column (found: ${parsed.columns.join(", ")})`
    );
  }

  const dataRows = parsed.map((r) => {
    const row: AnnotationRow = { id: (r[idCol] ?? "").toString() };
    for (const col of parsed.columns) {
      if (col !== idCol) row[col] = r[col];
    }
    return row;
  });

  const dataCols = parsed.columns.filter((c) => c !== idCol);
  return { rows: dataRows, columns: dataCols };
}
