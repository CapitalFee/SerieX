// CSV export of reports and lists.

/** One CSV cell value. Numbers are written without thousands separators. */
export type CsvCell = string | number | boolean | null | undefined;

/** A plain number written as text ("-1,234.56", "+5", "12%"): safe, Excel reads it as a number. */
const NUMERIC_TEXT = /^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?%?$/;

/**
 * Text that Excel / Sheets would run as a formula (starts with = + - @, a tab or a carriage
 * return) gets a leading apostrophe so it is shown as text (CSV formula injection). Real numbers
 * (number values, or plain numeric text like "-12.50") are left alone.
 */
function neutralize(s: string): string {
  if (!/^[=+\-@\t\r]/.test(s)) return s;
  if (/\d/.test(s) && NUMERIC_TEXT.test(s)) return s;
  return "'" + s;
}

function cell(v: CsvCell): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : neutralize(String(v));
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Converts rows to CSV text (CRLF line endings, RFC 4180 quoting). */
export function toCsv(rows: CsvCell[][]): string {
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/**
 * Downloads rows as a CSV file. A UTF-8 byte order mark is added so Excel opens accents correctly.
 * `.csv` is appended to the file name when missing.
 */
export function downloadCsv(filename: string, rows: CsvCell[][]): void {
  const name = /\.csv$/i.test(filename) ? filename : filename + '.csv';
  const blob = new Blob(['﻿' + toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name.replace(/[\\/:*?"<>|]+/g, '_');
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
