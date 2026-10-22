// Check amounts in words ("One thousand two hundred thirty-four and 56/100"), like printed checks.

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = ['', 'thousand', 'million', 'billion', 'trillion'];

function under1000(n: number): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h) parts.push(`${ONES[h]} hundred`);
  if (r) {
    if (r < 20) parts.push(ONES[r]);
    else parts.push(TENS[Math.floor(r / 10)] + (r % 10 ? '-' + ONES[r % 10] : ''));
  }
  return parts.join(' ');
}

/** Whole number in English words ("one thousand two hundred thirty-four"); "zero" for 0. */
export function numberInWords(n: number): string {
  let v = Math.floor(Math.abs(n));
  if (v === 0) return 'zero';
  const groups: string[] = [];
  let i = 0;
  while (v > 0 && i < SCALES.length) {
    const g = v % 1000;
    if (g) groups.unshift(under1000(g) + (SCALES[i] ? ' ' + SCALES[i] : ''));
    v = Math.floor(v / 1000);
    i++;
  }
  return groups.join(' ');
}

/** Check amount in words: 1234.56 → "One thousand two hundred thirty-four and 56/100". */
export function amountInWords(amount: number | null | undefined): string {
  const cents = Math.round(Math.abs(Number(amount ?? 0)) * 100);
  const dollars = Math.floor(cents / 100);
  const c = cents % 100;
  const w = numberInWords(dollars);
  return `${w.charAt(0).toUpperCase()}${w.slice(1)} and ${String(c).padStart(2, '0')}/100`;
}
