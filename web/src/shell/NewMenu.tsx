// "+ New" button and its grouped panel: Customers / Vendors / Other /
// Lists columns plus "Recent transactions". Keyboard: arrows move between items
// (up/down in a column, left/right between columns), Enter opens, Escape closes.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Clock } from 'lucide-react';
import { TXN_TYPE_LABELS } from '@/api/types';
import { useSession } from '@/state/session';
import { openTxn } from '@/windows/windowStore';
import { getRecentTxns, onRecentTxnsChange, type RecentTxn } from '@/util/recent';
import { buildNewGroups } from './navItems';
import { Popover } from './Popover';
import { shellDate, shellMoney } from './format';

export type NewButtonVariant = 'nav' | 'nav-collapsed' | 'appbar';

export function NewButton({ variant }: { variant: NewButtonVariant }) {
  const hasCompany = useSession((s) => !!s.companyId);
  const [open, setOpen] = useState(false);
  const [focusFirst, setFocusFirst] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!hasCompany) setOpen(false);
  }, [hasCompany]);

  const cls = variant === 'appbar' ? `sx-appbar-btn sx-appbar-new${open ? ' sx-on' : ''}` : `sx-newbtn${open ? ' sx-on' : ''}`;
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={cls}
        disabled={!hasCompany}
        aria-haspopup="true"
        aria-expanded={open}
        title="Create a transaction or list entry"
        data-new-button={variant}
        onClick={(e) => {
          // Keyboard activation (Enter/Space) puts focus on the first entry.
          setFocusFirst(e.detail === 0);
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || (e.key === 'ArrowRight' && variant !== 'appbar')) {
            e.preventDefault();
            setFocusFirst(true);
            setOpen(true);
          }
        }}
      >
        <Plus size={variant === 'nav-collapsed' ? 20 : 17} strokeWidth={2.5} />
        {variant !== 'nav-collapsed' && <span>New</span>}
      </button>
      {open && (
        <Popover
          anchor={() => btn.current}
          placement={variant === 'appbar' ? 'below-start' : 'right-start'}
          gap={variant === 'appbar' ? 6 : 20}
          onClose={() => setOpen(false)}
          role="dialog"
          ariaLabel="Create new"
        >
          <NewPanel focusFirst={focusFirst} onDone={() => setOpen(false)} />
        </Popover>
      )}
    </>
  );
}

function useRecentTxns(): RecentTxn[] {
  const [list, setList] = useState(() => getRecentTxns());
  useEffect(() => onRecentTxnsChange(() => setList(getRecentTxns())), []);
  return list;
}

/** Label of a recent transaction: "Invoice #1042". */
export function recentLabel(r: RecentTxn): string {
  const t = TXN_TYPE_LABELS[r.type] ?? r.type;
  return r.refNumber ? `${t} #${r.refNumber}` : t;
}

function NewPanel({ focusFirst, onDone }: { focusFirst: boolean; onDone(): void }) {
  const prefs = useSession((s) => s.prefs);
  const groups = useMemo(() => buildNewGroups(prefs), [prefs]);
  const recent = useRecentTxns().slice(0, 10);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusFirst) return;
    // After the popover got its position (it is invisible until then and cannot take the focus).
    const t = window.setTimeout(() => root.current?.querySelector<HTMLElement>('[data-col="0"][data-row="0"]')?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [focusFirst]);

  const run = (fn: () => void) => {
    onDone();
    // Let the popover unmount before the window takes the focus.
    window.setTimeout(fn, 0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = document.activeElement as HTMLElement | null;
    const col = Number(el?.dataset.col ?? -1);
    const row = Number(el?.dataset.row ?? -1);
    const at = (c: number, r: number) => root.current?.querySelector<HTMLElement>(`[data-col="${c}"][data-row="${r}"]`) ?? null;
    const colLen = (c: number) => root.current?.querySelectorAll(`[data-col="${c}"]`).length ?? 0;
    const cols = groups.length + (recent.length ? 1 : 0);
    if (col < 0) {
      if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        at(0, 0)?.focus();
      }
      return;
    }
    let target: HTMLElement | null = null;
    switch (e.key) {
      case 'ArrowDown':
        target = at(col, (row + 1) % colLen(col));
        break;
      case 'ArrowUp':
        target = at(col, (row - 1 + colLen(col)) % colLen(col));
        break;
      case 'ArrowRight':
      case 'ArrowLeft': {
        const c = (col + (e.key === 'ArrowRight' ? 1 : -1) + cols) % cols;
        target = at(c, Math.min(row, colLen(c) - 1));
        break;
      }
      case 'Home':
        target = at(col, 0);
        break;
      case 'End':
        target = at(col, colLen(col) - 1);
        break;
      default:
        return;
    }
    e.preventDefault();
    target?.focus();
  };

  return (
    <div className="sx-newpanel" ref={root} onKeyDown={onKeyDown}>
      <div className="sx-newpanel-cols">
        {groups.map((g, c) => (
          <div key={g.id} className="sx-newpanel-col" role="group" aria-label={g.label}>
            <div className="sx-newpanel-head">{g.label}</div>
            {g.items.map((it, r) => (
              <button
                key={it.id}
                type="button"
                className="sx-newpanel-item"
                data-col={c}
                data-row={r}
                data-new-item={it.id}
                onClick={() => run(it.open)}
              >
                <it.icon size={16} strokeWidth={1.9} />
                <span>{it.label}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="sx-newpanel-recent" role="group" aria-label="Recent transactions">
        <div className="sx-newpanel-head">Recent transactions</div>
        {!recent.length && <div className="sx-newpanel-empty">Transactions you open or save show up here so you can get back to them quickly.</div>}
        {recent.map((r, i) => (
          <button
            key={r.id}
            type="button"
            className="sx-newpanel-item"
            data-col={groups.length}
            data-row={i}
            title={`Open ${recentLabel(r)}`}
            onClick={() => run(() => openTxn(r.type, r.id))}
          >
            <Clock size={15} strokeWidth={1.9} />
            <span className="sx-recent-main">
              <b>{recentLabel(r)}</b>
              <span>{[r.nameFull, shellDate(r.date)].filter(Boolean).join(' · ')}</span>
            </span>
            <span className="sx-recent-amt">{shellMoney(r.amount)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
