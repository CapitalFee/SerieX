// Payment method buttons of Receive Payments and Enter Sales Receipts:
// Cash, Check, Credit/Debit ▾, e-Check, More ▾, bound to the Payment Method list.
import { Banknote, CreditCard, FileCheck2, Landmark, Wallet } from 'lucide-react';
import { useList } from '@/api/hooks';
import type { ID, ListEntry } from '@/api/types';
import { showContextMenu, type MenuItem } from '@/components';
import { openWindow } from '@/windows/windowStore';

const METHOD_GROUPS: { key: string; label: string; icon: typeof Banknote; match: (e: ListEntry) => boolean }[] = [
  { key: 'cash', label: 'Cash', icon: Banknote, match: (e) => /cash/i.test(String(e.data?.type ?? e.name)) },
  { key: 'check', label: 'Check', icon: FileCheck2, match: (e) => /^check$|cheque/i.test(String(e.data?.type ?? e.name)) },
  { key: 'card', label: 'Credit/Debit', icon: CreditCard, match: (e) => /visa|master|amex|american|discover|debit|credit|card/i.test(String(e.data?.type ?? e.name)) },
  { key: 'echeck', label: 'e-Check', icon: Landmark, match: (e) => /e-?check|ach|transfer/i.test(String(e.data?.type ?? e.name)) },
];

/** Payment method buttons (Cash, Check, Credit/Debit ▾, e-Check, More ▾) bound to the payment method list. */
export function MethodButtons({ value, onChange, disabled }: { value: ID | null; onChange: (id: ID | null) => void; disabled?: boolean }) {
  const methods = useList('payment_method').data ?? [];
  const groupOf = (e: ListEntry) => METHOD_GROUPS.find((g) => g.match(e))?.key ?? 'more';
  const cur = methods.find((m) => m.id === value) ?? null;
  const curGroup = cur ? groupOf(cur) : null;
  const pick = (key: string, ev: React.MouseEvent<HTMLButtonElement>) => {
    const list = methods.filter((m) => groupOf(m) === key);
    if (list.length === 1 && key !== 'more') {
      onChange(list[0].id);
      return;
    }
    const r = ev.currentTarget.getBoundingClientRect();
    const items: MenuItem[] = list.length
      ? list.map((m) => ({ label: m.name, checked: m.id === value, onClick: () => onChange(m.id) }))
      : [{ label: 'No payment methods of this kind', disabled: true }];
    if (key === 'more') items.push({ separator: true }, { label: 'Add or edit payment methods…', onClick: () => openWindow('profileList', { list: 'payment_method' }) });
    showContextMenu({ x: r.left, y: r.bottom + 2 }, items);
  };
  return (
    <div className="sx-cust-methods" role="group" aria-label="Payment method" data-field="paymentMethodId">
      {[...METHOD_GROUPS, { key: 'more', label: 'More', icon: Wallet, match: () => false }].map((g) => {
        const on = curGroup === g.key;
        const Icon = g.icon;
        const multi = g.key === 'more' || methods.filter((m) => groupOf(m) === g.key).length > 1;
        return (
          <button
            key={g.key}
            type="button"
            disabled={disabled}
            className={'sx-cust-method' + (on ? ' sx-on' : '')}
            aria-pressed={on}
            onClick={(e) => pick(g.key, e)}
            title={on && cur ? cur.name : g.label}
          >
            <Icon size={16} aria-hidden="true" />
            <span>{on && cur && (g.key === 'card' || g.key === 'more') ? cur.name : g.label}</span>
            {multi && <span className="sx-cust-method-caret">▾</span>}
          </button>
        );
      })}
    </div>
  );
}

