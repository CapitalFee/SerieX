// Quick create popovers used by the pickers ('+ Add "<text>"'), same look and
// keyboard as SerieX Books: a small panel next to the field that asks only the essentials,
// creates the record in SerieX Books through the payroll API, and hands it back so the picker
// selects it. "Add with details…" switches to the full New Account / New Vendor dialog.
//
//   accounts: name, type          (POST /books/accounts)
//   vendors:  name                (POST /books/vendors)
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { api } from '@/api/client';
import { queryClient } from '@/api/hooks';
import type { BooksAccount, BooksName, NewBooksAccount, NewBooksVendor } from '@/api/types';
import { Button } from './buttons';
import { tabbables } from './focus';
import { ErrorBanner, FormErrorsProvider, useFormErrors, type FormErrorsState } from './formErrors';
import { Field, Select, TextField } from './inputs';
import { Popup } from './Popup';

/** SerieX Books account types a payroll user may create (A/R, A/P and Non-Posting are left out). */
export const BOOKS_ACCOUNT_TYPES = [
  'Bank',
  'Other Current Asset',
  'Fixed Asset',
  'Other Asset',
  'Credit Card',
  'Other Current Liability',
  'Long Term Liability',
  'Equity',
  'Income',
  'Cost of Goods Sold',
  'Expense',
  'Other Income',
  'Other Expense',
];

/** A complete new SerieX Books vendor (POST /books/vendors). */
export function newVendorRecord(name: string, extra: Partial<NewBooksVendor> = {}): NewBooksVendor {
  return { name, companyName: '', address: { line1: '', line2: '', city: '', state: '', zip: '' }, phone: '', accountNumber: '', ...extra };
}

// ---------------------------------------------------------------------------
// Shared panel

interface PanelProps {
  anchor: HTMLElement | null;
  title: string;
  width?: number;
  busy: boolean;
  fe: FormErrorsState;
  onCancel(): void;
  onSubmit(): void;
  onDetails?: () => void;
  children: ReactNode;
}

function QuickPanel({ anchor, title, width, busy, fe, onCancel, onSubmit, onDetails, children }: PanelProps) {
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const t = window.setTimeout(() => {
      const first = formRef.current?.querySelector<HTMLInputElement>('input[name="name"]');
      first?.focus();
      first?.select();
    }, 0);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <Popup anchor={anchor} open onClose={onCancel} keepFocus={false} className="sx-popup-quick">
      <FormErrorsProvider value={fe}>
        <form
          ref={formRef}
          className="sx-quick"
          style={width ? { width } : undefined}
          aria-label={title}
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) onSubmit();
          }}
          onKeyDown={(e) => {
            // The popover is a portal: without this, keys would bubble (through the React tree)
            // to the grid / dialog that owns the picker.
            e.stopPropagation();
            if (e.key === 'Escape' && !e.defaultPrevented) {
              e.preventDefault();
              onCancel();
            } else if (e.key === 'Tab' && !e.defaultPrevented && formRef.current) {
              // keep Tab inside the popover
              const list = tabbables(formRef.current);
              const i = list.indexOf(document.activeElement as HTMLElement);
              if (list.length && (e.shiftKey ? i <= 0 : i === list.length - 1)) {
                e.preventDefault();
                list[e.shiftKey ? list.length - 1 : 0].focus();
              }
            }
          }}
        >
          <div className="sx-quick-head">
            <span className="sx-quick-title">{title}</span>
            <button type="button" className="sx-iconbtn" aria-label="Cancel" title="Cancel (Esc)" onClick={onCancel}>
              <X size={15} aria-hidden="true" />
            </button>
          </div>
          {fe.message && <ErrorBanner message={fe.message} />}
          <div className="sx-quick-body">{children}</div>
          <div className="sx-quick-foot">
            {onDetails && (
              <button type="button" className="sx-linkbtn" onClick={onDetails}>
                Add with details&hellip;
              </button>
            )}
            <span className="sx-flex1" />
            <Button variant="ghost" label="Cancel" onClick={onCancel} />
            <Button variant="primary" type="submit" label="Save" busy={busy} title="Save (Enter)" />
          </div>
        </form>
      </FormErrorsProvider>
    </Popup>
  );
}

/** Runs the submit after pending field commits. */
function useLatest<T>(v: T) {
  const r = useRef(v);
  r.current = v;
  return r;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// Accounts

/** Props of {@link QuickCreateAccount}. */
export interface QuickCreateAccountProps {
  anchor: HTMLElement | null;
  initialName: string;
  /** Account types the picker accepts. */
  types?: string[];
  onCreated(account: BooksAccount): void;
  onCancel(): void;
  onDetails?(name: string, type: string): void;
}

/** Quick create popover for SerieX Books accounts: name and type. */
export function QuickCreateAccount({ anchor, initialName, types, onCreated, onCancel, onDetails }: QuickCreateAccountProps) {
  const allowed = BOOKS_ACCOUNT_TYPES.filter((t) => !types || types.includes(t));
  const [name, setName] = useState(initialName);
  const [type, setType] = useState<string>(allowed.includes('Expense') ? 'Expense' : allowed[0] ?? 'Expense');
  const [busy, setBusy] = useState(false);
  const fe = useFormErrors();
  const st = useLatest({ name, type });
  const submit = async () => {
    await tick();
    const s = st.current;
    if (!s.name.trim()) {
      fe.setFieldError('name', 'Enter a name.');
      return;
    }
    setBusy(true);
    try {
      const body: NewBooksAccount = { name: s.name.trim(), type: s.type, parentId: null, number: '' };
      const created = await api.post<BooksAccount>('/books/accounts', body);
      await queryClient.invalidateQueries({ queryKey: ['books', 'accounts'] });
      onCreated(created);
    } catch (e) {
      fe.fromError(e);
      setBusy(false);
    }
  };
  return (
    <QuickPanel
      anchor={anchor}
      title="New account"
      busy={busy}
      fe={fe}
      onCancel={onCancel}
      onSubmit={() => void submit()}
      onDetails={onDetails ? () => onDetails(name.trim(), type) : undefined}
    >
      <Field label="Account name" required hint="Created in the SerieX Books chart of accounts.">
        <TextField name="name" value={name} onChange={setName} aria-label="Account name" />
      </Field>
      <Field label="Account type">
        <Select name="type" value={type} onChange={(v) => setType(v)} options={allowed.map((t) => ({ value: t, label: t }))} aria-label="Account type" />
      </Field>
    </QuickPanel>
  );
}

// ---------------------------------------------------------------------------
// Vendors

/** Props of {@link QuickCreateVendor}. */
export interface QuickCreateVendorProps {
  anchor: HTMLElement | null;
  initialName: string;
  onCreated(vendor: BooksName): void;
  onCancel(): void;
  onDetails?(name: string): void;
}

/** Quick create popover for SerieX Books vendors (tax agencies, benefit providers): name only. */
export function QuickCreateVendor({ anchor, initialName, onCreated, onCancel, onDetails }: QuickCreateVendorProps) {
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const fe = useFormErrors();
  const st = useLatest({ name });
  const submit = async () => {
    await tick();
    const s = st.current;
    if (!s.name.trim()) {
      fe.setFieldError('name', 'Enter a name.');
      return;
    }
    setBusy(true);
    try {
      const created = await api.post<BooksName>('/books/vendors', newVendorRecord(s.name.trim()));
      await queryClient.invalidateQueries({ queryKey: ['books', 'vendors'] });
      onCreated(created);
    } catch (e) {
      fe.fromError(e);
      setBusy(false);
    }
  };
  return (
    <QuickPanel
      anchor={anchor}
      title="New vendor"
      busy={busy}
      fe={fe}
      onCancel={onCancel}
      onSubmit={() => void submit()}
      onDetails={onDetails ? () => onDetails(name.trim()) : undefined}
    >
      <Field label="Vendor name" required hint="Created in the SerieX Books vendor list.">
        <TextField name="name" value={name} onChange={setName} aria-label="Vendor name" />
      </Field>
    </QuickPanel>
  );
}
