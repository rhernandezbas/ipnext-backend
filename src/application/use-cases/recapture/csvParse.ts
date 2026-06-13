/**
 * Pure, dependency-free CSV parser.
 *
 * Handles:
 * - Quoted fields (double-quotes per RFC 4180)
 * - Commas inside quoted fields
 * - Newlines inside quoted fields
 * - Windows CRLF (\r\n) and Unix LF (\n) line endings
 * - Trailing newline (no spurious empty row)
 * - Whitespace trimming for unquoted fields only
 *
 * Returns an array of objects keyed by the header row.
 * Empty rows (after trimming) are silently skipped.
 */
export function parseCsv(input: string): Record<string, string>[] {
  if (!input.trim()) return [];

  const cells = tokenize(input);
  if (cells.length === 0) return [];

  // First row is the header — always trim header names
  const headers = cells[0]!.map((h) => h.value.trim());

  const rows: Record<string, string>[] = [];
  for (let i = 1; i < cells.length; i++) {
    const row = cells[i]!;
    // Skip completely empty rows (trailing newline etc.)
    if (row.every((c) => c.value.trim() === '')) continue;

    const obj: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      const cell = row[j];
      // Unquoted cells get trimmed; quoted cells preserve their content exactly
      obj[headers[j]!] = cell ? (cell.wasQuoted ? cell.value : cell.value.trim()) : '';
    }
    rows.push(obj);
  }

  return rows;
}

interface Cell {
  value: string;
  wasQuoted: boolean;
}

/**
 * RFC 4180-compliant tokenizer.
 * Returns a 2D array of Cell objects.
 * Quoted regions are unescaped (double-quote escaping handled).
 */
function tokenize(input: string): Cell[][] {
  const rows: Cell[][] = [];
  let currentRow: Cell[] = [];
  let cell = '';
  let wasQuoted = false;
  let i = 0;
  let inQuotes = false;

  const pushCell = () => {
    currentRow.push({ value: cell, wasQuoted });
    cell = '';
    wasQuoted = false;
  };

  const pushRow = () => {
    rows.push(currentRow);
    currentRow = [];
  };

  while (i < input.length) {
    const ch = input[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < input.length && input[i + 1] === '"') {
          // Escaped double-quote
          cell += '"';
          i += 2;
        } else {
          // Closing quote
          inQuotes = false;
          i++;
        }
      } else {
        cell += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        wasQuoted = true;
        i++;
      } else if (ch === ',') {
        pushCell();
        i++;
      } else if (ch === '\r' && i + 1 < input.length && input[i + 1] === '\n') {
        pushCell();
        pushRow();
        i += 2;
      } else if (ch === '\n') {
        pushCell();
        pushRow();
        i++;
      } else {
        cell += ch;
        i++;
      }
    }
  }

  // Flush remaining content
  if (cell !== '' || currentRow.length > 0 || wasQuoted) {
    pushCell();
    pushRow();
  }

  return rows;
}
