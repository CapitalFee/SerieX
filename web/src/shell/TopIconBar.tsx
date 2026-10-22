// Toolbar at the top (View menu): a row of icon buttons with labels under the menu bar.
import { useSession } from '@/state/session';
import { useWindowStore } from '@/windows/windowStore';
import { SHORTCUTS } from './shortcutItems';

export function TopIconBar() {
  const hasCompany = useSession((s) => !!s.companyId);
  const activeKind = useWindowStore((s) => s.windows.find((w) => w.id === s.activeId)?.kind ?? null);
  return (
    <div className="sx-topbar sx-dimmable" role="toolbar" aria-label="Icon bar">
      <div className="sx-topbar-items">
        {SHORTCUTS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`sx-topbar-btn${activeKind && s.kinds.includes(activeKind) ? ' sx-selected' : ''}`}
            disabled={!hasCompany}
            onClick={s.open}
            title={s.label}
            data-shortcut={s.id}
          >
            <s.icon size={20} color={s.colorLight} strokeWidth={1.9} />
            <span>{s.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
