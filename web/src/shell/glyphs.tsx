// Small window-button glyphs and the SerieX Books application mark.

export function GlyphMin() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="0" y="4.5" width="10" height="1.1" fill="currentColor" />
    </svg>
  );
}

export function GlyphMax() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="0.6" y="0.6" width="8.8" height="8.8" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

export function GlyphRestore() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="0.6" y="2.6" width="6.8" height="6.8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <path d="M2.6 2.4V1.6a1 1 0 0 1 1-1h4.8a1 1 0 0 1 1 1v4.8a1 1 0 0 1-1 1h-.8" fill="none" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

export function GlyphClose() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

/** SVG source of the application mark (also used for the browser tab icon). */
export const APP_MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
  '<rect width="32" height="32" rx="8" fill="#2563eb"/>' +
  '<path d="M9 11.5h14M9 16h14M9 20.5h8.5" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>' +
  '<path d="M20.2 20.6l1.9 1.9 3.4-3.9" stroke="#93c5fd" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';

/** SerieX Books application mark: a ledger badge in the accent color. */
export function AppIcon({ size = 16 }: { size?: number }) {
  return (
    <svg className="sx-brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#2563eb" />
      <path d="M9 11.5h14M9 16h14M9 20.5h8.5" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M20.2 20.6l1.9 1.9 3.4-3.9" stroke="#93c5fd" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
