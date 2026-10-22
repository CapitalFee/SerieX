// Focus helpers (tab order, committing the field being edited).

const TABBABLE =
  'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href], [tabindex]';

function visible(el: HTMLElement): boolean {
  if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
  const st = getComputedStyle(el);
  return st.visibility !== 'hidden' && st.display !== 'none';
}

/** Tabbable elements inside `root` in DOM order (tabindex ≥ 0, visible, enabled). */
export function tabbables(root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter((el) => el.tabIndex >= 0 && visible(el));
}

/** The scope used for Tab order: the nearest dialog / MDI window content, else the document. */
export function focusScope(el: HTMLElement): ParentNode {
  return (el.closest('.sx-dlg-box, [data-window-id], [data-sx-window], .sx-txnform') as HTMLElement | null) ?? document;
}

/**
 * Moves focus to the next (or previous) tabbable element outside `container`,
 * as if Tab/Shift+Tab was pressed on its last/first element. Returns false when none.
 */
export function focusOutside(container: HTMLElement, backward = false): boolean {
  const list = tabbables(focusScope(container));
  if (backward) {
    for (let i = list.length - 1; i >= 0; i--) {
      const el = list[i];
      if (!container.contains(el) && el.compareDocumentPosition(container) & Node.DOCUMENT_POSITION_FOLLOWING) {
        el.focus();
        return true;
      }
    }
  } else {
    for (const el of list) {
      if (!container.contains(el) && el.compareDocumentPosition(container) & Node.DOCUMENT_POSITION_PRECEDING) {
        el.focus();
        return true;
      }
    }
  }
  return false;
}

/**
 * Commits the field being edited (combo text, money arithmetic, grid cell) by blurring it,
 * then waits a tick so React state settles. Call before saving from a shortcut like Alt+S.
 * Only blurs when the focused element is inside `root` (when given).
 */
export async function commitActiveEditor(root?: HTMLElement | null): Promise<void> {
  const ae = document.activeElement as HTMLElement | null;
  if (ae && ae !== document.body && (!root || root.contains(ae))) {
    ae.blur();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Focuses the first field whose name / data-field equals `field` inside root. Returns true when found. */
export function focusField(root: HTMLElement | null | undefined, field: string | undefined | null): boolean {
  if (!root || !field) return false;
  const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(field) : field.replace(/"/g, '\\"');
  const el = root.querySelector<HTMLElement>(`[name="${esc}"], [data-field="${esc}"]`);
  if (!el) return false;
  const target = el.matches('input, select, textarea, button, [tabindex]') ? el : el.querySelector<HTMLElement>('input, select, textarea, button, [tabindex]');
  if (!target) return false;
  target.focus();
  if (target instanceof HTMLInputElement) target.select();
  return true;
}
