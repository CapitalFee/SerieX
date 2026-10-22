// Windows-style access key labels: "&Save && Close" → "Save & Close" with S underlined.
import type { ReactNode } from 'react';

/**
 * Parses a label with `&` access key markers. `&x` underlines x (and makes it the access key),
 * `&&` is a literal ampersand. With `accessKey` given, the first occurrence of that letter is
 * underlined instead. Returns the rendered node, the plain text and the access key (lowercase).
 */
export function parseAccessLabel(label: string, accessKey?: string): { node: ReactNode; text: string; key: string | null } {
  let text = '';
  let keyIndex = -1;
  for (let i = 0; i < label.length; i++) {
    const c = label[i];
    if (c === '&') {
      if (label[i + 1] === '&') {
        text += '&';
        i++;
        continue;
      }
      if (i + 1 < label.length && keyIndex < 0 && !accessKey) {
        keyIndex = text.length;
      }
      continue;
    }
    text += c;
  }
  if (accessKey) keyIndex = text.toLowerCase().indexOf(accessKey.toLowerCase());
  if (keyIndex < 0) return { node: text, text, key: accessKey ? accessKey.toLowerCase() : null };
  const node = (
    <>
      {text.slice(0, keyIndex)}
      <u className="sx-ak">{text[keyIndex]}</u>
      {text.slice(keyIndex + 1)}
    </>
  );
  return { node, text, key: (accessKey ?? text[keyIndex]).toLowerCase() };
}
