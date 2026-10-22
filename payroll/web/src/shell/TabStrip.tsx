// Tab strip of the Tabs workspace: one tab per document window
// (title, unsaved-changes dot, close x), middle-click closes, drag to reorder,
// right-click menu (Close / Close others / Close tabs to the right / Close all),
// overflow scroll and an "all open windows" drop-down. The active tab is the
// window shown in the work area (top document window).
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ChevronDown, X } from 'lucide-react';
import {
  useWindowStore,
  focusWindow,
  closeWindow,
  closeOtherWindows,
  closeWindowsAfter,
  closeAllWindows,
  moveTab,
  getCurrentTabId,
} from '@/windows/windowStore';
import type { WindowKind } from '@/windows/kinds';
import { Popover } from './Popover';
import { kindIcon } from './kindIcons';

interface TabInfo {
  id: string;
  title: string;
  dirty: boolean;
  kind: WindowKind;
}

function useTabs(): TabInfo[] {
  const rows = useWindowStore(
    useShallow((s) => s.windows.filter((w) => !w.modal).map((w) => `${w.id}\u0001${w.title}\u0001${w.dirty ? 1 : 0}\u0001${w.kind}`)),
  );
  return rows.map((r) => {
    const [id, title, dirty, kind] = r.split('\u0001');
    return { id, title, dirty: dirty === '1', kind: kind as WindowKind };
  });
}

export function TabStrip() {
  const tabs = useTabs();
  const current = useWindowStore((s) => getCurrentTabId(s));
  const scrollRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const listBtn = useRef<HTMLButtonElement>(null);

  // Keep the active tab visible.
  useLayoutEffect(() => {
    if (!current) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-tab-id="${current}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [current, tabs.length]);

  // Mouse wheel scrolls the strip sideways.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (id: string) => (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest('.sx-wtab-close')) return;
    if (e.button === 1) {
      // Middle button: no autoscroll; the tab closes on auxclick.
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    focusWindow(id);
    const tabEl = e.currentTarget;
    const startX = e.clientX;
    let dragging = false;
    tabEl.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) < 6) return;
        dragging = true;
        setDrag(id);
        document.body.classList.add('sx-dragging');
      }
      // Drop position: before the first tab whose middle is right of the pointer.
      const strip = scrollRef.current;
      if (!strip) return;
      const els = Array.from(strip.querySelectorAll<HTMLElement>('[data-tab-id]'));
      let to = els.length - 1;
      for (let i = 0; i < els.length; i++) {
        const r = els[i].getBoundingClientRect();
        if (ev.clientX < r.left + r.width / 2) {
          to = i;
          break;
        }
      }
      const from = els.findIndex((x) => x.dataset.tabId === id);
      if (from >= 0 && to !== from) moveTab(id, to);
      // Scroll when dragging near the strip edges.
      const sr = strip.getBoundingClientRect();
      if (ev.clientX < sr.left + 24) strip.scrollLeft -= 12;
      else if (ev.clientX > sr.right - 24) strip.scrollLeft += 12;
    };
    const up = () => {
      tabEl.removeEventListener('pointermove', move);
      tabEl.removeEventListener('pointerup', up);
      tabEl.removeEventListener('pointercancel', up);
      document.body.classList.remove('sx-dragging');
      setDrag(null);
    };
    tabEl.addEventListener('pointermove', move);
    tabEl.addEventListener('pointerup', up);
    tabEl.addEventListener('pointercancel', up);
  };

  return (
    <div className="sx-wtabs sx-dimmable" role="tablist" aria-label="Open windows">
      <div className="sx-wtabs-scroll" ref={scrollRef}>
        {tabs.map((t) => {
          const Icon = kindIcon(t.kind);
          const active = t.id === current;
          return (
            <div
              key={t.id}
              className={`sx-wtab${active ? ' sx-wtab-active' : ''}${t.dirty ? ' sx-wtab-isdirty' : ''}${drag === t.id ? ' sx-wtab-dragging' : ''}`}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              title={t.dirty ? `${t.title} (unsaved changes)` : t.title}
              data-tab-id={t.id}
              data-tab-kind={t.kind}
              onPointerDown={onPointerDown(t.id)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  void closeWindow(t.id);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ id: t.id, x: e.clientX, y: e.clientY });
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  e.preventDefault();
                  const i = tabs.findIndex((x) => x.id === t.id);
                  const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
                  focusWindow(next.id);
                  window.setTimeout(() => scrollRef.current?.querySelector<HTMLElement>(`[data-tab-id="${next.id}"]`)?.focus(), 0);
                } else if (e.key === 'Delete') {
                  e.preventDefault();
                  void closeWindow(t.id);
                }
              }}
            >
              <Icon size={14} strokeWidth={2} className="sx-wtab-icon" />
              <span className="sx-wtab-title">{t.title}</span>
              <span className="sx-wtab-end">
                {t.dirty && <span className="sx-wtab-dirty" />}
                <button
                  type="button"
                  className="sx-wtab-close"
                  title="Close (Ctrl+F4)"
                  tabIndex={-1}
                  aria-label={`Close ${t.title}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    void closeWindow(t.id);
                  }}
                >
                  <X size={13} strokeWidth={2.2} />
                </button>
              </span>
            </div>
          );
        })}
      </div>
      <div className="sx-wtabs-tools">
        <button
          ref={listBtn}
          type="button"
          className={`sx-wtabs-btn${listOpen ? ' sx-on' : ''}`}
          title="All open windows"
          aria-haspopup="true"
          aria-expanded={listOpen}
          disabled={!tabs.length}
          data-tabs-list=""
          onClick={() => setListOpen((o) => !o)}
        >
          <ChevronDown size={16} />
        </button>
      </div>
      {listOpen && (
        <Popover anchor={() => listBtn.current} placement="below-end" onClose={() => setListOpen(false)} role="menu" ariaLabel="All open windows">
          <div className="sx-pop-list" style={{ minWidth: 280, maxWidth: 420 }}>
            <div className="sx-pop-title">Open windows ({tabs.length})</div>
            {tabs.map((t) => {
              const Icon = kindIcon(t.kind);
              return (
                <div
                  key={t.id}
                  className={`sx-pop-item${t.id === current ? ' sx-checked' : ''}`}
                  role="menuitem"
                  tabIndex={0}
                  data-tab-list-item={t.id}
                  onClick={() => {
                    setListOpen(false);
                    focusWindow(t.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      setListOpen(false);
                      focusWindow(t.id);
                    }
                  }}
                >
                  <Icon size={15} />
                  <span className="sx-pop-item-text">{t.title}</span>
                  {t.dirty && <span className="sx-nav-row-dot" title="Unsaved changes" />}
                  <button
                    type="button"
                    className="sx-pop-close"
                    title="Close"
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation();
                      void closeWindow(t.id);
                    }}
                  >
                    <X size={13} />
                  </button>
                </div>
              );
            })}
            <div className="sx-pop-sep" />
            <button
              type="button"
              className="sx-pop-item"
              onClick={() => {
                setListOpen(false);
                void closeAllWindows();
              }}
            >
              <X size={15} />
              <span className="sx-pop-item-text">Close all</span>
            </button>
          </div>
        </Popover>
      )}
      {menu && (
        <Popover anchor={() => null} placement="at-point" point={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} role="menu" ariaLabel="Tab">
          <div className="sx-pop-list" style={{ minWidth: 200 }}>
            {(
              [
                ['Close', () => closeWindow(menu.id)],
                ['Close other tabs', () => closeOtherWindows(menu.id)],
                ['Close tabs to the right', () => closeWindowsAfter(menu.id)],
                ['Close all', () => closeAllWindows()],
              ] as [string, () => Promise<boolean>][]
            ).map(([label, fn]) => (
              <button
                key={label}
                type="button"
                className="sx-pop-item"
                onClick={() => {
                  setMenu(null);
                  void fn();
                }}
              >
                <span className="sx-pop-item-text">{label}</span>
              </button>
            ))}
          </div>
        </Popover>
      )}
    </div>
  );
}
