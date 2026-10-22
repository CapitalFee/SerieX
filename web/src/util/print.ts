// Printing through a hidden iframe (the browser print dialog prints only the given HTML).

/** Basic print stylesheet used for every printed page (forms, reports, checks). */
export const BASE_PRINT_CSS = `
  @page { margin: 0.5in; }
  * { box-sizing: border-box; }
  body { font: 11px 'Segoe UI', Tahoma, Arial, sans-serif; color: #000; margin: 0; }
  h1 { font-size: 18px; margin: 0 0 6px; }
  h2 { font-size: 14px; margin: 0 0 4px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 2px 6px; vertical-align: top; }
  th { text-align: left; font-weight: bold; border-bottom: 1px solid #000; }
  .num, .right { text-align: right; white-space: nowrap; }
  .center { text-align: center; }
  .bold { font-weight: bold; }
  .muted { color: #555; }
  .page-break { page-break-after: always; }
  tr { page-break-inside: avoid; }
`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Escapes text for inclusion in printHtml bodies. */
export const escHtml = escapeHtml;

/**
 * Prints an HTML fragment with the browser print dialog, using a hidden iframe so the
 * application itself is not printed. `css` is added after {@link BASE_PRINT_CSS}.
 * Resolves when the print dialog has closed (or after a timeout on browsers without afterprint).
 */
export function printHtml(title: string, bodyHtml: string, css = ''): Promise<void> {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
    document.body.appendChild(frame);
    const doc = frame.contentDocument!;
    doc.open();
    doc.write(
      `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
        `<style>${BASE_PRINT_CSS}${css}</style></head><body>${bodyHtml}</body></html>`,
    );
    doc.close();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      setTimeout(() => frame.remove(), 100);
      resolve();
    };
    const win = frame.contentWindow!;
    win.addEventListener('afterprint', finish);
    // give images/fonts a moment to load
    setTimeout(() => {
      try {
        win.focus();
        win.print();
      } finally {
        // print() blocks in most browsers; the timeout is a fallback for those that do not
        setTimeout(finish, 1000);
      }
    }, 150);
  });
}
