// Tax form values on the client: the user's changes (overrides of computed amounts, texts,
// check boxes) and the lines that depend on them, recomputed exactly like the server
// (server/internal/forms: f941.go, f940.go, stateui.go) so totals follow the user's edits before
// the form is saved. The saved form returned by the server is always the reference: while the
// user has no unsaved change the server's values are shown as they are.
import type { FormLine, TaxForm } from '@/api/types';
import { fmtMoney } from '@/util/format';

/** The user's values of the editable lines, keyed "line" or "line:col". */
export interface FormValues {
  overrides: Record<string, number>;
  texts: Record<string, string>;
  checks: Record<string, boolean>;
}

export const lineKey = (l: { key: string; col: string }) => (l.col ? `${l.key}:${l.col}` : l.key);

/** The saved user values of a form (lines marked overridden). */
export function savedValues(form: TaxForm): FormValues {
  const v: FormValues = { overrides: {}, texts: {}, checks: {} };
  for (const l of form.lines) {
    if (!l.editable || !l.overridden) continue;
    const k = lineKey(l);
    if (l.kind === 'text') v.texts[k] = l.text;
    else if (l.kind === 'check') v.checks[k] = l.checked;
    else v.overrides[k] = l.value;
  }
  return v;
}

export function sameValues(a: FormValues, b: FormValues): boolean {
  const eq = (x: Record<string, unknown>, y: Record<string, unknown>) => {
    const kx = Object.keys(x);
    if (kx.length !== Object.keys(y).length) return false;
    return kx.every((k) => k in y && x[k] === y[k]);
  };
  return eq(a.overrides, b.overrides) && eq(a.texts, b.texts) && eq(a.checks, b.checks);
}

// ---------------------------------------------------------------------------
// cents arithmetic (same rounding as the server)

/** Dollars → cents, half away from zero (store.Cents). */
export function cents(d: number): number {
  if (!Number.isFinite(d)) return 0;
  const v = d * 100;
  return v >= 0 ? Math.floor(v + 0.5 + 1e-7) : -Math.floor(-v + 0.5 + 1e-7);
}
export const dollars = (c: number) => c / 100;

/** cents × rate% rounded half away from zero (forms.pctOf). */
export function pctOf(c: number, rate: number): number {
  // integer arithmetic like the server (BigInt: cents × rate·1e6 can exceed 2^53)
  const r = BigInt(Math.round(rate * 1e6));
  const num = BigInt(Math.round(c)) * r;
  const den = 100_000_000n;
  return Number(num >= 0n ? (num + den / 2n) / den : -((-num + den / 2n) / den));
}

/** Adds a difference to a list of amounts like forms.spread (positive: last non-zero; negative: from the first positive ones). */
export function spread(vals: number[], diff: number): number[] {
  const out = vals.slice();
  if (!out.length || diff === 0) return out;
  if (diff > 0) {
    let idx = out.length - 1;
    for (let i = out.length - 1; i >= 0; i--)
      if (out[i] !== 0) {
        idx = i;
        break;
      }
    out[idx] += diff;
    return out;
  }
  let left = -diff;
  for (let i = 0; i < out.length && left > 0; i++) {
    if (out[i] <= 0) continue;
    const take = Math.min(out[i], left);
    out[i] -= take;
    left -= take;
  }
  if (left > 0) out[out.length - 1] -= left;
  return out;
}

/** The rate printed in a label ("Column 1 × 0.124" → 12.4 percent). */
export function rateInLabel(label: string): number | null {
  const m = /×\s*([0-9]*\.?[0-9]+)/.exec(label);
  return m ? parseFloat(m[1]) * 100 : null;
}

// ---------------------------------------------------------------------------
// effective values

/** Effective value of every line (money/count/number in dollars, checks as booleans, texts). */
export interface Effective {
  num: Map<string, number>;
  chk: Map<string, boolean>;
  txt: Map<string, string>;
}

interface Ctx {
  form: TaxForm;
  byKey: Map<string, FormLine>;
  v: FormValues;
  /** effective cents of a money line (override, else the value the recompute set, else the server computed value) */
  c(key: string): number;
  /** effective number of a number/count line */
  n(key: string): number;
  has(key: string): boolean;
  set(key: string, centsValue: number): void;
  setNum(key: string, value: number): void;
  setChk(key: string, computed: boolean): boolean;
  serverC(key: string): number;
}

function makeCtx(form: TaxForm, v: FormValues): { ctx: Ctx; eff: Effective } {
  const byKey = new Map(form.lines.map((l) => [lineKey(l), l]));
  const eff: Effective = { num: new Map(), chk: new Map(), txt: new Map() };
  const computedC = new Map<string, number>();
  const ctx: Ctx = {
    form,
    byKey,
    v,
    has: (k) => byKey.has(k),
    c: (k) => {
      const l = byKey.get(k);
      if (!l) return 0;
      if (l.editable && k in v.overrides) return cents(v.overrides[k]);
      if (computedC.has(k)) return computedC.get(k)!;
      return cents(l.computed);
    },
    n: (k) => {
      const l = byKey.get(k);
      if (!l) return 0;
      if (l.editable && k in v.overrides) return v.overrides[k];
      return eff.num.get(k) ?? l.computed;
    },
    set: (k, cv) => computedC.set(k, cv),
    setNum: (k, val) => eff.num.set(k, val),
    setChk: (k, computed) => {
      const l = byKey.get(k);
      const val = l && l.editable && k in v.checks ? v.checks[k] : computed;
      eff.chk.set(k, val);
      return val;
    },
    serverC: (k) => cents(byKey.get(k)?.value ?? 0),
  };
  return { ctx, eff };
}

function finish(form: TaxForm, ctx: Ctx, eff: Effective): Effective {
  for (const l of form.lines) {
    const k = lineKey(l);
    if (l.kind === 'text') eff.txt.set(k, l.editable && k in ctx.v.texts ? ctx.v.texts[k] : l.editable && l.overridden ? '' : l.text);
    else if (l.kind === 'check') {
      if (!eff.chk.has(k)) eff.chk.set(k, l.editable && k in ctx.v.checks ? ctx.v.checks[k] : l.editable && l.overridden ? l.computed === 1 : l.computed === 1);
    } else if (l.kind === 'money') eff.num.set(k, dollars(ctx.c(k)));
    else if (!eff.num.has(k) || (l.editable && k in ctx.v.overrides)) eff.num.set(k, ctx.n(k));
  }
  return eff;
}

/** Form 941 (f941.go). */
function recompute941(form: TaxForm, v: FormValues): Effective {
  const { ctx, eff } = makeCtx(form, v);
  const lbl = (k: string) => ctx.byKey.get(k)?.label ?? '';
  const ssRate = rateInLabel(lbl('5a:2')) ?? 12.4;
  const medRate = rateInLabel(lbl('5c:2')) ?? 2.9;
  const addlRate = rateInLabel(lbl('5d:2')) ?? 0.9;
  const a1 = ctx.c('5a:1');
  const t1 = ctx.c('5b:1');
  const c1 = ctx.c('5c:1');
  const d1 = ctx.c('5d:1');
  ctx.setChk('4', a1 === 0 && t1 === 0 && c1 === 0 && d1 === 0);
  const a2 = pctOf(a1, ssRate);
  const t2 = pctOf(t1, ssRate);
  const c2 = pctOf(c1, medRate);
  const d2 = pctOf(d1, addlRate);
  ctx.set('5a:2', a2);
  ctx.set('5b:2', t2);
  ctx.set('5c:2', c2);
  ctx.set('5d:2', d2);
  const l5e = a2 + t2 + c2 + d2;
  ctx.set('5e', l5e);
  const l6 = ctx.c('3') + l5e + ctx.c('5f');
  ctx.set('6', l6);
  const at = (form.extra?.actualTaxes ?? {}) as Record<string, number>;
  const fica = cents((at.socialSecurityEmployee ?? 0) + (at.socialSecurityCompany ?? 0) + (at.medicareEmployee ?? 0) + (at.medicareCompany ?? 0) + (at.additionalMedicare ?? 0));
  const peek = (k: string) => (k in v.overrides ? cents(v.overrides[k]) : 0);
  ctx.set('7', fica - l5e - peek('8') - peek('9'));
  const l10 = l6 + ctx.c('7') + ctx.c('8') + ctx.c('9');
  ctx.set('10', l10);
  const l12 = Math.max(0, l10 - ctx.c('11'));
  ctx.set('12', l12);
  const l13 = ctx.c('13');
  ctx.set('14', l12 > l13 ? l12 - l13 : 0);
  ctx.set('15a', l13 > l12 ? l13 - l12 : 0);
  const schedule = String(form.extra?.depositSchedule ?? 'monthly');
  const small = l12 < 250000;
  ctx.setChk('16:1', small);
  const box2 = ctx.setChk('16:2', !small && schedule === 'monthly');
  ctx.setChk('16:3', !small && schedule === 'semiweekly');
  const base = ((form.extra?.monthlyLiability as number[] | undefined) ?? [0, 0, 0]).map(cents);
  const liab = spread(base, l12 - ctx.serverC('12'));
  const cm = box2 ? liab : [0, 0, 0];
  ['m1', 'm2', 'm3'].forEach((m, i) => ctx.set(`16:${m}`, box2 && `16:${m}` in v.overrides ? cents(v.overrides[`16:${m}`]) : cm[i]));
  ctx.set('16:total', ctx.c('16:m1') + ctx.c('16:m2') + ctx.c('16:m3'));
  return finish(form, ctx, eff);
}

/** Form 940 (f940.go). */
function recompute940(form: TaxForm, v: FormValues): Effective {
  const { ctx, eff } = makeCtx(form, v);
  const futaRate = rateInLabel(ctx.byKey.get('8')?.label ?? '') ?? 0.6;
  const e6 = ctx.c('4') + ctx.c('5');
  ctx.set('6', e6);
  const e7 = ctx.c('3') - e6;
  ctx.set('7', e7);
  const e8 = pctOf(e7, futaRate);
  ctx.set('8', e8);
  const e11 = ctx.c('11');
  const e12 = e8 + ctx.c('9') + ctx.c('10') + e11;
  ctx.set('12', e12);
  const e13 = ctx.c('13');
  ctx.set('14', e12 > e13 ? e12 - e13 : 0);
  ctx.set('15a', e13 > e12 ? e13 - e12 : 0);
  const keys = ['16a', '16b', '16c', '16d'];
  const base = keys.map((k) => cents(ctx.byKey.get(k)?.computed ?? 0));
  const serverE11 = ctx.serverC('11');
  base[3] -= serverE11;
  const serverX = ctx.serverC('12') - serverE11;
  const liab = spread(base, e12 - e11 - serverX);
  liab[3] += e11;
  keys.forEach((k, i) => ctx.set(k, liab[i]));
  ctx.set('17', keys.reduce((s, k) => s + ctx.c(k), 0));
  return finish(form, ctx, eff);
}

/** State quarterly wage report (stateui.go). */
function recomputeStateUI(form: TaxForm, v: FormValues): Effective {
  const { ctx, eff } = makeCtx(form, v);
  const uiTax = pctOf(ctx.c('D'), ctx.n('D:rate'));
  ctx.set('D:tax', uiTax);
  let subtotal = uiTax;
  if (ctx.has('D:employee')) subtotal += ctx.c('D:employee');
  const progs = new Set<string>();
  for (const l of form.lines) if (l.section === 'Other State Taxes') progs.add(l.key);
  for (const k of progs) {
    if (ctx.has(`${k}:tax`)) {
      const t = pctOf(ctx.c(`${k}:wages`), ctx.n(`${k}:rate`));
      ctx.set(`${k}:tax`, t);
      subtotal += t;
    }
    if (ctx.has(`${k}:employee`)) subtotal += ctx.c(`${k}:employee`);
  }
  if (ctx.has('G')) subtotal += ctx.c('G');
  ctx.set('H', subtotal);
  ctx.set('J', subtotal - ctx.c('I'));
  return finish(form, ctx, eff);
}

/** Server values as they are (no unsaved change). */
function serverEffective(form: TaxForm): Effective {
  const eff: Effective = { num: new Map(), chk: new Map(), txt: new Map() };
  for (const l of form.lines) {
    const k = lineKey(l);
    if (l.kind === 'text') eff.txt.set(k, l.text);
    else if (l.kind === 'check') eff.chk.set(k, l.checked);
    else eff.num.set(k, l.value);
  }
  return eff;
}

/** Effective values of a form with the user's values (the server's own values while nothing changed). */
export function effectiveValues(form: TaxForm, v: FormValues, changed: boolean): Effective {
  if (!changed) return serverEffective(form);
  if (form.form === '941') return recompute941(form, v);
  if (form.form === '940') return recompute940(form, v);
  return recomputeStateUI(form, v);
}

/** Recomputes the saved values and lists the lines whose result differs from the server (self-check). */
export function selfCheck(form: TaxForm): string[] {
  const v = savedValues(form);
  const e = form.form === '941' ? recompute941(form, v) : form.form === '940' ? recompute940(form, v) : recomputeStateUI(form, v);
  const out: string[] = [];
  for (const l of form.lines) {
    const k = lineKey(l);
    if (l.kind === 'money' || l.kind === 'count' || l.kind === 'number') {
      if (Math.abs((e.num.get(k) ?? 0) - l.value) > 0.004) out.push(`${k}: ${e.num.get(k)} != ${l.value}`);
    } else if (l.kind === 'check' && (e.chk.get(k) ?? false) !== l.checked) out.push(`${k}: ${e.chk.get(k)} != ${l.checked}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Check for Errors

export interface FormProblem {
  /** Line key ("16" or "16:m1") to jump to; empty for the whole form. */
  line: string;
  message: string;
  severity: 'error' | 'warning';
}

const digits = (s: string) => (s ?? '').replace(/\D/g, '');

/** Problems of a form that must be fixed (errors) or looked at (warnings) before filing. */
export function checkForm(form: TaxForm, e: Effective): FormProblem[] {
  const out: FormProblem[] = [];
  const err = (line: string, message: string) => out.push({ line, message, severity: 'error' });
  const warn = (line: string, message: string) => out.push({ line, message, severity: 'warning' });
  const num = (k: string) => e.num.get(k) ?? 0;
  const chk = (k: string) => e.chk.get(k) ?? false;
  const txt = (k: string) => (e.txt.get(k) ?? '').trim();
  const co = form.company;
  if (form.form !== 'STATE-UI' && digits(co.ein).length !== 9) err('', 'The employer identification number (EIN) is missing or not 9 digits. Enter it in Company Payroll Information.');
  if (!co.address.line1.trim() || !co.address.city.trim() || digits(co.address.zip).length < 5) err('', 'The company address is incomplete (street, city and ZIP code). Enter it in Company Payroll Information.');
  if (e.txt.has('sign:name') && !txt('sign:name')) err('sign:name', 'Enter the name of the person who signs the form.');
  if (e.txt.has('sign:title') && !txt('sign:title')) err('sign:title', 'Enter the title of the person who signs the form.');
  if (chk('designee')) {
    if (!txt('designee:name')) err('designee:name', "Enter the third-party designee's name.");
    if (!/^\d{5}$/.test(txt('designee:pin'))) err('designee:pin', 'The designee PIN must be 5 digits.');
  }
  if (chk('15b:1') && chk('15b:2')) err('15b:1', 'Line 15: check only one box (apply to the next return or send a refund).');
  if (num('15a') > 0 && !chk('15b:1') && !chk('15b:2')) warn('15b:1', 'Line 15: you have an overpayment; check whether to apply it to the next return or send a refund.');
  if (form.form === '941') {
    const boxes = ['16:1', '16:2', '16:3'].filter(chk);
    if (boxes.length !== 1) err('16:1', 'Line 16: check exactly one box.');
    if (chk('16:2') && Math.abs(num('16:total') - num('12')) > 0.004)
      err('16:m1', `Line 16: the total liability for the quarter (${fmtMoney(num('16:total'))}) must equal line 12 (${fmtMoney(num('12'))}).`);
    if (chk('16:1') && num('12') >= 2500) warn('16:1', 'Line 16, box 1 is for line 12 under $2,500 (or under $2,500 on the prior quarter return). Check that this applies.');
    if (chk('16:3') && !Array.isArray(form.extra?.scheduleB)) warn('16:3', 'Box 3 needs Schedule B (Form 941).');
    if (chk('17') && !txt('17:date')) err('17:date', 'Line 17: enter the final date you paid wages.');
    if (Math.abs(num('7')) >= 1) warn('7', `Line 7 (fractions of cents) is ${fmtMoney(num('7'))}; it is normally a few cents.`);
    if (num('14') > 0) warn('14', `Line 14 shows a balance due of ${fmtMoney(num('14'))}. Deposit it (or pay it with the return when line 12 is under $2,500).`);
  }
  if (form.form === '940') {
    if (!txt('1a') && !chk('1b')) err('1a', 'Line 1a: enter the state abbreviation (or check line 1b when you paid state unemployment tax in more than one state).');
    if (txt('1a') && chk('1b')) err('1a', 'Line 1: fill in line 1a or line 1b, not both.');
    if (num('12') > 500 && Math.abs(num('17') - num('12')) > 0.004) err('16a', `Line 17 (${fmtMoney(num('17'))}) must equal line 12 (${fmtMoney(num('12'))}) when line 12 is more than $500.`);
    if (num('14') > 500) warn('14', 'Line 14 is more than $500: the balance must be deposited (it cannot be paid with the return).');
  }
  if (form.form === 'STATE-UI') {
    if (!co.stateId) err('', `Enter the ${form.state} unemployment insurance account number in Company Payroll Information (state settings).`);
    if (num('J') < 0) warn('J', 'Line J is negative: you paid more than the taxes due for the quarter.');
  }
  for (const w of form.warnings ?? []) if (!out.some((p) => p.message === w)) out.push({ line: '', message: w, severity: 'warning' });
  return out;
}
