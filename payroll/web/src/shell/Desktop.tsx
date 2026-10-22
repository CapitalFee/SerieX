// Work area: hosts the windows (full-size tab pages in the Tabs workspace, floating
// windows otherwise), the minimized title tabs (floating only) and the modal overlay.
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  useWindowStore,
  setDesktopSize,
  getTopModal,
  flashWindow,
  restoreWindow,
  maximizeWindow,
  closeWindow,
} from '@/windows/windowStore';
import { useView } from '@/state/view';
import { MdiWindow, MODAL_LAYER } from './MdiWindow';
import { GlyphClose, GlyphMax, GlyphRestore } from './glyphs';

export function Desktop({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // Stable DOM order (by creation) so reordering tabs never moves window elements.
  const ids = useWindowStore(useShallow((s) => s.windows.map((w) => w.id).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))));
  const tabs = useView((s) => s.windowMode === 'one');
  const minimized = useWindowStore(
    useShallow((s) =>
      s.windows
        .filter((w) => w.minimized)
        .sort((a, b) => a.minOrder - b.minOrder)
        .map((w) => w.id),
    ),
  );
  const topModal = useWindowStore((s) => {
    let t: { id: string; z: number } | null = null;
    for (const w of s.windows) if (w.modal && (!t || w.z > t.z)) t = w;
    return t ? `${t.id}:${t.z}` : '';
  });

  // Keep the store informed of the desktop size (window placement, tiling).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setDesktopSize(Math.round(el.clientWidth), Math.round(el.clientHeight));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // While a modal dialog is open, keyboard focus may not leave it.
  useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      const top = getTopModal();
      if (!top) return;
      const t = e.target;
      if (!(t instanceof Element) || !t.closest('.sx-frame')) return;
      const box = document.querySelector<HTMLElement>(`[data-window-id="${top.id}"]`);
      if (!box || box.contains(t)) return;
      box.focus({ preventScroll: true });
    };
    document.addEventListener('focusin', onFocus);
    return () => document.removeEventListener('focusin', onFocus);
  }, []);

  const [modalId, modalZ] = topModal ? topModal.split(':') : ['', '0'];

  return (
    <div className={`sx-desktop${tabs ? ' sx-desktop-tabs' : ''}`} ref={ref} data-workspace={tabs ? 'tabs' : 'floating'}>
      <div className="sx-desktop-bg">{children}</div>
      {ids.map((id) => (
        <MdiWindow key={id} id={id} />
      ))}
      {!tabs &&
        minimized.map((id, i) => (
          <MinimizedTab key={id} id={id} index={i} />
        ))}
      {modalId && (
        <div
          className="sx-modal-overlay"
          style={{ zIndex: MODAL_LAYER + Number(modalZ) * 2 - 1 }}
          onPointerDown={(e) => {
            e.preventDefault();
            flashWindow(modalId);
          }}
        />
      )}
    </div>
  );
}

const TAB_W = 180;
const TAB_H = 30;

/** Title tab of a minimized window at the bottom of the desktop. */
function MinimizedTab({ id, index }: { id: string; index: number }) {
  const w = useWindowStore((s) => s.windows.find((v) => v.id === id));
  const deskW = useWindowStore((s) => s.desktop.w);
  if (!w) return null;
  const perRow = Math.max(1, Math.floor((deskW - 4) / (TAB_W + 2)));
  const left = 2 + (index % perRow) * (TAB_W + 2);
  const bottom = 2 + Math.floor(index / perRow) * (TAB_H + 2);
  return (
    <div
      className="sx-mintab"
      style={{ left, bottom, width: TAB_W, height: TAB_H }}
      title={w.title}
      data-min-window-id={id}
      onDoubleClick={() => restoreWindow(id)}
      onClick={(e) => {
        if ((e.target as Element).closest('.sx-wbtn')) return;
        restoreWindow(id);
      }}
    >
      <span className="sx-mintab-title">{w.title}</span>
      <button type="button" className="sx-wbtn" title="Restore Up" tabIndex={-1} onClick={() => restoreWindow(id)}>
        <GlyphRestore />
      </button>
      <button
        type="button"
        className="sx-wbtn"
        title="Maximize"
        tabIndex={-1}
        onClick={() => {
          restoreWindow(id);
          maximizeWindow(id);
        }}
      >
        <GlyphMax />
      </button>
      <button
        type="button"
        className="sx-wbtn sx-wbtn-close"
        title="Close"
        tabIndex={-1}
        onClick={() => void closeWindow(id)}
      >
        <GlyphClose />
      </button>
    </div>
  );
}
