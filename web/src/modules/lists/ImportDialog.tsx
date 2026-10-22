// Import of lists from CSV files (File > Utilities > Import): choose what to import, pick or drop a CSV
// or tab-delimited text file (the columns it recognizes are shown with a short preview), import,
// then see how many records were added / updated and the rows that had problems.
// The preview reads the file like the server does: UTF-8, UTF-16 (Excel "Unicode Text", with or
// without a byte-order mark) or Windows-1252, separated by commas, tabs or semicolons. The
// original file is uploaded unchanged.
import { useMemo, useRef, useState } from 'react';
import { FileUp, Info } from 'lucide-react';
import { api } from '@/api/client';
import { invalidateAll, useAccounts, useItems, useNames } from '@/api/hooks';
import { Button, EditDialog, Field, SegmentedControl, toast, useFormErrors } from '@/components';
import type { WindowKind } from '@/windows/kinds';
import { openWindow } from '@/windows/windowStore';
import { downloadExport, errMessage, plural } from './common';
import './lists.css';

export interface ImportDialogProps {
  entity?: string;
}

type Entity = 'customers' | 'vendors' | 'items' | 'accounts' | 'other';

const ENTITIES: { value: Entity; label: string; word: string; window: WindowKind }[] = [
  { value: 'customers', label: 'Customers', word: 'customer', window: 'customerCenter' },
  { value: 'vendors', label: 'Vendors', word: 'vendor', window: 'vendorCenter' },
  { value: 'items', label: 'Items', word: 'item', window: 'itemList' },
  { value: 'accounts', label: 'Accounts', word: 'account', window: 'chartOfAccounts' },
  { value: 'other', label: 'Other names', word: 'name', window: 'otherNames' },
];

// the column names the server reads (same as its CSV export)
const NAME_COLS = ['Name', 'Company', 'Salutation', 'First', 'Last', 'Phone', 'Mobile', 'Fax', 'Email', 'Bill Line1', 'Bill Line2', 'Bill City', 'Bill State', 'Bill Zip', 'Ship Line1', 'Ship City', 'Ship State', 'Ship Zip', 'Terms', 'Account No', 'Notes', 'Active'];
const COLUMNS: Record<Entity, string[]> = {
  accounts: ['Name', 'Type', 'Number', 'Description', 'Bank Acct No', 'Note', 'Active'],
  customers: NAME_COLS,
  vendors: NAME_COLS,
  other: NAME_COLS,
  items: ['Name', 'Type', 'Description', 'Purchase Description', 'Price', 'Cost', 'Income Account', 'Expense/COGS Account', 'Asset Account', 'Taxable', 'Preferred Vendor', 'Reorder Point', 'Active'],
};

const HINT: Record<Entity, string> = {
  accounts: 'Name and Type are needed for new accounts. Use "Parent:Child" names for subaccounts.',
  customers: 'Only Name is required. For a job, write the customer and the job separated by a colon, for example "Smith:Kitchen".',
  vendors: 'Only Name is required.',
  other: 'Only Name is required.',
  items: 'Name and Type are needed for new items, with an Income Account for most types. Use "Parent:Child" names for subitems.',
};

interface ImportResult {
  imported: number;
  updated: number;
  errors: string[];
}

type Encoding = 'UTF-8' | 'UTF-16' | 'Windows-1252';

/**
 * Text of an uploaded file, decoded like the server (store.DecodeText): a byte-order mark tells
 * UTF-8 or UTF-16; without one, a zero in every other byte means UTF-16 (Excel "Unicode Text");
 * else valid UTF-8 is kept and anything else is read as Windows-1252 (Excel "CSV" on Windows).
 */
function decodeText(bytes: Uint8Array): { text: string; encoding: Encoding } {
  const dec = (enc: string, b: Uint8Array = bytes) => new TextDecoder(enc, { ignoreBOM: true }).decode(b);
  const [b0, b1, b2, b3] = bytes;
  if (b0 === 0xef && b1 === 0xbb && b2 === 0xbf) return { text: dec('utf-8', bytes.subarray(3)), encoding: 'UTF-8' };
  if (b0 === 0xff && b1 === 0xfe) return { text: dec('utf-16le', bytes.subarray(2)), encoding: 'UTF-16' };
  if (b0 === 0xfe && b1 === 0xff) return { text: dec('utf-16be', bytes.subarray(2)), encoding: 'UTF-16' };
  if (bytes.length >= 4 && b0 === 0 && b1 !== 0 && b2 === 0) return { text: dec('utf-16be'), encoding: 'UTF-16' };
  if (bytes.length >= 4 && b0 !== 0 && b1 === 0 && b3 === 0) return { text: dec('utf-16le'), encoding: 'UTF-16' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), encoding: 'UTF-8' };
  } catch {
    return { text: dec('windows-1252'), encoding: 'Windows-1252' };
  }
}

const DELIMITER_NAME: Record<string, string> = { ',': 'comma-separated', '\t': 'tab-separated', ';': 'semicolon-separated' };

/**
 * Field separator of a file, chosen like the server (store.CSVDelimiter) from the first non-blank
 * line: a semicolon when it has more of them than commas, then a tab when it has more tabs than
 * that; else a comma.
 */
function csvDelimiter(text: string): string {
  const first = text.split('\n').find((l) => l.trim() !== '') ?? '';
  const count = (ch: string) => first.split(ch).length - 1;
  let d = ',';
  if (count(';') > count(',')) d = ';';
  if (count('\t') > count(d)) d = '\t';
  return d;
}

/**
 * CSV reader for the preview that splits rows and fields exactly like the server (Go
 * encoding/csv with LazyQuotes, then blank rows skipped), so the preview shows what will be
 * imported:
 * - a field is quoted only when its very first character is a double quote; a quote anywhere
 *   else (9" Pot) is plain text;
 * - in a quoted field a doubled quote is one quote, a quote followed by the separator or the
 *   line end closes the field, any other quote is kept as text, and line breaks are part of it;
 * - lines end at LF or CRLF (a lone CR is text); empty lines and rows of blank cells are skipped.
 */
function parseCsv(text: string, maxRows: number, delimiter = ','): string[][] {
  const s = text.replace(/^\uFEFF/, '');
  let at = 0;
  /** Next line with its line feed (CRLF read as LF; a CR at the very end dropped), or null at the end. */
  const readLine = (): string | null => {
    if (at >= s.length) return null;
    const nl = s.indexOf('\n', at);
    let line = nl < 0 ? s.slice(at) : s.slice(at, nl + 1);
    at = nl < 0 ? s.length : nl + 1;
    if (nl < 0 && line.endsWith('\r')) line = line.slice(0, -1);
    else if (line.endsWith('\r\n')) line = line.slice(0, -2) + '\n';
    return line;
  };
  /** Whether what is left of a line is nothing but its line feed. */
  const atLineEnd = (l: string) => l === '' || l === '\n';
  const rows: string[][] = [];
  while (rows.length < maxRows) {
    let line = readLine();
    while (line === '\n') line = readLine(); // empty lines are skipped
    if (line === null) break;
    const row: string[] = [];
    for (;;) {
      if (line[0] !== '"') {
        // plain field: everything up to the separator, quotes included
        const i = line.indexOf(delimiter);
        if (i >= 0) {
          row.push(line.slice(0, i));
          line = line.slice(i + delimiter.length);
          continue;
        }
        row.push(line.endsWith('\n') ? line.slice(0, -1) : line);
        break;
      }
      // quoted field
      let field = '';
      let endOfRow = false;
      line = line.slice(1);
      for (;;) {
        const i = line.indexOf('"');
        if (i >= 0) {
          field += line.slice(0, i);
          line = line.slice(i + 1);
          if (line[0] === '"') {
            field += '"'; // "" is one quote
            line = line.slice(1);
          } else if (line.startsWith(delimiter)) {
            line = line.slice(delimiter.length);
            break;
          } else if (atLineEnd(line)) {
            endOfRow = true;
            break;
          } else field += '"'; // a stray quote is kept
        } else if (line.length > 0) {
          // the field goes on to the next line
          field += line;
          line = readLine() ?? '';
        } else {
          endOfRow = true; // the file ends inside the quotes
          break;
        }
      }
      row.push(field);
      if (endOfRow) break;
    }
    if (row.some((x) => x.trim() !== '')) rows.push(row);
  }
  return rows;
}

export default function ImportDialog(props: ImportDialogProps) {
  const fe = useFormErrors();
  const initial = ENTITIES.find((e) => e.value === props.entity)?.value ?? 'customers';
  const [entity, setEntity] = useState<Entity>(initial);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string[][]>([]);
  /** How the chosen file was read ("tab-separated · UTF-16"), shown next to its name. */
  const [format, setFormat] = useState('');
  const [over, setOver] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // counts shown next to the choices (refreshed after the import)
  const { data: accounts } = useAccounts({ active: 'all' });
  const { data: items } = useItems({ active: 'all' });
  const { data: names } = useNames(undefined, { active: 'all' });
  const info = ENTITIES.find((e) => e.value === entity)!;

  const count = (e: Entity) =>
    e === 'accounts' ? accounts?.length : e === 'items' ? items?.length : names?.filter((n) => n.kind === (e === 'customers' ? 'customer' : e === 'vendors' ? 'vendor' : 'other')).length;

  const header = preview[0] ?? [];
  const known = useMemo(() => new Set(COLUMNS[entity].map((c) => c.toLowerCase())), [entity]);
  const recognized = header.filter((h) => known.has(h.trim().toLowerCase()));
  const ignored = header.filter((h) => h.trim() && !known.has(h.trim().toLowerCase()));
  const hasName = header.some((h) => h.trim().toLowerCase() === 'name');

  const pick = async (f: File | null | undefined) => {
    fe.clearAll();
    setResult(null);
    if (!f) return;
    if (!/\.(csv|txt|tsv)$/i.test(f.name) && f.type && !/csv|text|excel|tab-separated/i.test(f.type)) {
      fe.setMessage('Choose a CSV or text file. In Excel, use File > Save As > "CSV (Comma delimited)" or "Unicode Text".');
      return;
    }
    setFile(f);
    try {
      // read like the server: any encoding Excel saves, commas, tabs or semicolons
      const { text, encoding } = decodeText(new Uint8Array(await f.arrayBuffer()));
      const delimiter = csvDelimiter(text);
      setPreview(parseCsv(text, 4, delimiter));
      setFormat(`${DELIMITER_NAME[delimiter]}${encoding === 'UTF-8' ? '' : ` · ${encoding}`}`);
    } catch {
      setPreview([]);
      setFormat('');
    }
  };

  const doImport = async () => {
    fe.clearAll();
    if (!file) {
      fe.setMessage('Choose the file to import first.');
      return;
    }
    if (preview.length && !hasName) {
      fe.setMessage('The first row of the file must hold the column names, including a "Name" column.');
      return;
    }
    setBusy(true);
    try {
      const r = await api.upload<ImportResult>(`/import/${entity}`, file);
      setResult({ imported: r.imported ?? 0, updated: r.updated ?? 0, errors: r.errors ?? [] });
      await invalidateAll();
      if (r.imported || r.updated) toast(`${plural(r.imported + r.updated, info.word)} imported from ${file.name}`);
    } catch (e) {
      const m = errMessage(e);
      if (m) fe.setMessage(m);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setFile(null);
    setPreview([]);
    setFormat('');
    setResult(null);
    fe.clearAll();
    if (inputRef.current) inputRef.current.value = '';
  };

  if (result) {
    return (
      <EditDialog
        title="Import"
        okLabel="Import another file"
        onOk={reset}
        cancelLabel="Close"
        extraButtons={<Button label={`Open ${info.label}`} onClick={() => openWindow(info.window)} />}
      >
        <div className="fl-form">
          <div className="fl-note">
            Imported <b>{file?.name}</b> into {info.label.toLowerCase()}.
          </div>
          <div className="fl-result">
            <div className="fl-result-box">
              <div className="fl-result-num" style={{ color: 'var(--sx-success)' }}>
                {result.imported}
              </div>
              <div className="fl-result-label">added</div>
            </div>
            <div className="fl-result-box">
              <div className="fl-result-num" style={{ color: 'var(--sx-accent)' }}>
                {result.updated}
              </div>
              <div className="fl-result-label">updated</div>
            </div>
            <div className="fl-result-box">
              <div className="fl-result-num" style={{ color: result.errors.length ? 'var(--sx-danger)' : 'var(--sx-text-muted)' }}>
                {result.errors.length}
              </div>
              <div className="fl-result-label">{result.errors.length === 1 ? 'row skipped' : 'rows skipped'}</div>
            </div>
          </div>
          {result.errors.length > 0 ? (
            <>
              <div className="fl-note">These rows were skipped. Fix them in the file and import it again; rows already imported are updated, not duplicated.</div>
              <ul className="fl-errlist">
                {result.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </>
          ) : (
            <div className="fl-note">Every row was imported.</div>
          )}
        </div>
      </EditDialog>
    );
  }

  return (
    <EditDialog title="Import" errors={fe} okLabel="Import" busy={busy} okDisabled={!file} onOk={doImport} cancelLabel="Close">
      <div className="fl-form">
        <Field label="What do you want to import?">
          <SegmentedControl<Entity>
            block
            value={entity}
            onChange={(v) => {
              setEntity(v);
              fe.clearAll();
            }}
            options={ENTITIES.map((e) => ({ value: e.value, label: e.label, title: count(e.value) !== undefined ? `${count(e.value)} now in the file` : undefined }))}
            aria-label="What to import"
          />
        </Field>
        <div
          className={'fl-drop' + (over ? ' fl-over' : '')}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            void pick(e.dataTransfer.files?.[0]);
          }}
        >
          <span className="fl-drop-icon">
            <FileUp size={18} />
          </span>
          <div className="fl-drop-text">
            {file ? (
              <>
                <div className="fl-drop-file">{file.name}</div>
                <div className="fl-note">
                  {(file.size / 1024).toFixed(1)} KB{format ? ` · ${format}` : ''} · {preview.length > 1 ? 'ready to import' : 'the file looks empty'}
                </div>
              </>
            ) : (
              <>
                <div>
                  <b>Drop a CSV or text file here</b> or choose one.
                </div>
                <div className="fl-note">From Excel: File &gt; Save As &gt; "CSV (Comma delimited)" or "Unicode Text".</div>
              </>
            )}
          </div>
          <Button label={file ? 'Choose another…' : 'Choose file…'} onClick={() => inputRef.current?.click()} />
          <input ref={inputRef} type="file" accept=".csv,text/csv,.txt,text/plain,.tsv,text/tab-separated-values" hidden onChange={(e) => void pick(e.target.files?.[0])} aria-label="CSV or text file" />
        </div>
        {file && header.length > 0 ? (
          <>
            <div className="fl-colchips" aria-label="Columns in the file">
              {recognized.map((h) => (
                <span key={'ok' + h} className="fl-colchip fl-ok" title="This column will be imported">
                  ✓ {h}
                </span>
              ))}
              {ignored.map((h) => (
                <span key={'bad' + h} className="fl-colchip fl-bad" title="SerieX Books does not know this column; it will be ignored">
                  {h} (ignored)
                </span>
              ))}
            </div>
            {!hasName && <div className="sx-field-msg">The file needs a "Name" column in its first row.</div>}
            {preview.length > 1 && (
              <div className="fl-preview">
                <table>
                  <thead>
                    <tr>
                      {header.map((h, i) => (
                        <th key={i} className={known.has(h.trim().toLowerCase()) ? '' : 'fl-bad'}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.slice(1).map((r, i) => (
                      <tr key={i}>
                        {header.map((_, j) => (
                          <td key={j}>{r[j] ?? ''}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <div className="fl-info">
            <Info size={16} />
            <span>
              The first row must hold the column names. {HINT[entity]} Records whose name already exists are updated; blank cells keep the current value.{' '}
              <button type="button" className="fl-linkbtn" onClick={() => void downloadExport(entity)}>
                Download your current {info.label.toLowerCase()} as a sample file
              </button>
            </span>
          </div>
        )}
      </div>
    </EditDialog>
  );
}
