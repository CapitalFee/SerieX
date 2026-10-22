// Top icon bar (View > Top Icon Bar): a row of icon buttons with labels under the menu bar.
import { useShallow } from 'zustand/react/shallow';
import { useSession } from '@/state/session';
import { useWindowStore } from '@/windows/windowStore';
import { SHORTCUTS, shortcutSelected } from './shortcutItems';

export function TopIconBar() {
  const hasCompany = useSession((s) => !!s.companyId);
  // Kind and props only, so moving or resizing the active window does not re-render the bar.
  const active = useWindowStore(
    useShallow((s) => {
      const w = s.windows.find((v) => v.id === s.activeId);
      return { kind: w?.kind ?? null, props: w?.props ?? null };
    }),
  );
  return (
    <div className="sx-topbar sx-dimmable" role="toolbar" aria-label="Icon bar">
      <div className="sx-topbar-items">
        {SHORTCUTS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`sx-topbar-btn${shortcutSelected(s, active.kind, active.props) ? ' sx-selected' : ''}`}
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
