// New / Edit Payroll Item wizard (one question per page):
//   kind → wages (hourly / salary / commission / bonus / tips; regular, overtime, sick, vacation),
//          addition, deduction, company-paid benefit, federal tax, state tax, local or other tax
//   pages per kind: name, payee + liability account (new vendor / account in SerieX Books),
//   expense account, tax treatment (W-2 box 12 / 14), taxes that apply (taxability check boxes
//   starting from the tax treatment), how it is calculated (quantity / hours / fixed or percent,
//   or match), default amount and limit; tax items: tax, state and program, company rate.
// Left: the step list (every page can be opened directly when editing); bottom: Back / Next /
// Finish / Cancel.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, Info } from 'lucide-react';
import { api } from '@/api/client';
import { invalidateAll, useBooksAccounts, useItems, useMeta } from '@/api/hooks';
import {
  ITEM_TYPE_LABELS,
  TAX_CODE_LABELS,
  WAGE_BASES,
  WAGE_BASE_LABELS,
  isWageType,
  type BooksAccount,
  type ItemType,
  type Meta,
  type PayrollItem,
  type TaxCode,
  type TaxTracking,
} from '@/api/types';
import {
  AccountPicker,
  Button,
  Checkbox,
  ErrorBanner,
  Field,
  FieldRow,
  FormErrorsProvider,
  MoneyField,
  NumberField,
  PayrollItemPicker,
  SegmentedControl,
  Select,
  Spinner,
  StatePicker,
  TextField,
  VendorPicker,
  confirmBox,
  notifyCreated,
  toast,
  useFormErrors,
} from '@/components';
import { fmtPercent } from '@/util/format';
import { useWindow } from '@/windows/WindowContext';
import { errMessage, itemTypeText, taxCodeLabel, useLatest } from './shared';

export interface PayrollItemWizardProps {
  /** Item to edit (new item when missing). */
  id?: number;
  /** Item type of a new item. */
  type?: ItemType;
}

type Group = 'wage' | 'addition' | 'deduction' | 'contribution' | 'federal_tax' | 'state_tax' | 'other_tax';
type Step = 'type' | 'wage' | 'wageUse' | 'wageCalc' | 'tax' | 'name' | 'agency' | 'expense' | 'tracking' | 'taxes' | 'calc' | 'rate' | 'taxRate';

const STEP_LABELS: Record<Step, string> = {
  type: 'Kind of item',
  wage: 'Kind of pay',
  wageUse: 'Regular pay or time off',
  wageCalc: 'Amount and calculation',
  tax: 'Tax',
  name: 'Name',
  agency: 'Payee and accounts',
  expense: 'Expense account',
  tracking: 'Tax treatment',
  taxes: 'Taxes that apply',
  calc: 'How it is calculated',
  rate: 'Default amount and limit',
  taxRate: 'Tax rate',
};

const GROUPS: { key: Group; label: string; desc: string }[] = [
  { key: 'wage', label: 'Wages and other pay for work', desc: 'Pay for work: hourly and salary pay (regular, overtime, sick and vacation), commissions, bonuses and tips.' },
  { key: 'addition', label: 'Addition to the paycheck', desc: 'Amounts added to the paycheck that are not wages, such as reimbursements, allowances or advances.' },
  { key: 'deduction', label: 'Deduction from pay', desc: 'Amounts withheld from the employee’s pay and paid to someone else: retirement plans, insurance premiums, garnishments, union dues.' },
  { key: 'contribution', label: 'Company-paid benefit', desc: 'Benefits the company pays on top of the paycheck: retirement matches, health insurance, HSA contributions.' },
  { key: 'federal_tax', label: 'Federal tax', desc: 'Federal payroll taxes. Payroll setup creates them; add one only when it is missing.' },
  { key: 'state_tax', label: 'State tax', desc: 'State income tax withholding, unemployment insurance and state programs such as disability or paid family leave.' },
  { key: 'other_tax', label: 'Local or other tax', desc: 'City, county or school district taxes and other taxes calculated as a percent of wages.' },
];

const FEDERAL_CODES: TaxCode[] = ['FIT', 'SS_EE', 'SS_ER', 'MED_EE', 'MED_ER', 'ADDL_MED', 'FUTA'];
const EMPLOYER_CODES = ['SS_ER', 'MED_ER', 'FUTA', 'SUI_ER', 'ST_ER', 'LOCAL_ER'];
const LIABILITY_TYPES = ['Other Current Liability', 'Long Term Liability'];
const EXPENSE_TYPES = ['Expense', 'Other Expense', 'Cost of Goods Sold'];

function groupOf(type: ItemType | ''): Group | null {
  if (!type) return null;
  if (isWageType(type)) return 'wage';
  return type as Group;
}

function defaultTracking(type: ItemType): TaxTracking {
  switch (type) {
    case 'overtime':
      return 'qualified_overtime';
    case 'tips':
      return 'paid_tips';
    case 'reported_tips':
      return 'reported_tips';
    case 'deduction':
      return 'other';
    case 'contribution':
      return 'none';
    default:
      return 'compensation';
  }
}

/** Tracking choices for an item type (contributions also get "None"). */
function trackingOptions(meta: Meta | undefined, type: ItemType): { key: TaxTracking; label: string; w2Box12: string; taxability: Partial<Record<string, boolean>> }[] {
  const list = (meta?.taxTracking ?? []).filter((t) => t.itemTypes.includes(type)).map((t) => ({ key: t.key, label: t.label, w2Box12: t.w2Box12, taxability: t.taxability }));
  if (type === 'contribution' && !list.some((t) => t.key === 'none')) list.unshift({ key: 'none', label: 'Not wages (not on the W-2)', w2Box12: '', taxability: {} });
  if (type === 'deduction' && !list.some((t) => t.key === 'other')) list.push({ key: 'other', label: 'Other (after tax)', w2Box12: '', taxability: {} });
  return list;
}

/** Default taxability and box 12 code of a tracking type for an item type (meta.taxTracking). */
function trackingDefaults(meta: Meta | undefined, type: ItemType, key: TaxTracking): { taxability: Partial<Record<string, boolean>>; w2Box12: string } {
  const t = trackingOptions(meta, type).find((x) => x.key === key);
  const tax: Partial<Record<string, boolean>> = {};
  for (const b of WAGE_BASES) tax[b] = !!t?.taxability?.[b];
  if (!t && isWageType(type) && key !== 'none') for (const b of WAGE_BASES) tax[b] = true;
  return { taxability: tax, w2Box12: t?.w2Box12 ?? '' };
}

function blankItem(type: ItemType, meta: Meta | undefined): PayrollItem {
  const tracking = defaultTracking(type);
  const d = trackingDefaults(meta, type, tracking);
  const isTax = type === 'federal_tax' || type === 'state_tax' || type === 'other_tax';
  return {
    id: 0,
    name: '',
    type,
    taxCode: type === 'other_tax' ? 'LOCAL_EE' : '',
    state: '',
    taxKey: '',
    pto: '',
    calc: isTax ? 'tax' : type === 'commission' ? 'quantity' : 'fixed',
    rate: type === 'overtime' ? 1.5 : 0,
    annualLimit: null,
    limitKind: 'annual',
    matchItemId: null,
    matchCapPct: 0,
    taxTracking: isTax ? 'compensation' : tracking,
    w2Box12: isTax ? '' : d.w2Box12,
    w2Box14: '',
    taxability: isTax ? {} : d.taxability,
    supplemental: type === 'bonus',
    notPaid: type === 'reported_tips',
    expenseAccountId: null,
    liabilityAccountId: null,
    agencyVendorId: null,
    paymentGroup: '',
    active: true,
    category: 'earning',
    effectiveGroup: '',
    expenseAccountName: '',
    liabilityAccountName: '',
    agencyName: '',
    hasPaychecks: false,
  };
}

const isEmployerCode = (code: string) => EMPLOYER_CODES.includes(code);

/** Which tax an item tracks: federal code, state code + state, or state program code + state + program. */
function taxIdentity(code: string, state: string, key: string): string {
  if ((FEDERAL_CODES as string[]).includes(code)) return code;
  if (code === 'ST_EE' || code === 'ST_ER') return `${code}|${state.toUpperCase()}|${key.toUpperCase()}`;
  return `${code}|${state.toUpperCase()}`;
}
/** The item needs an expense account. */
function needsExpense(it: PayrollItem): boolean {
  if (isWageType(it.type) || it.type === 'addition' || it.type === 'contribution') return true;
  return (it.type === 'federal_tax' || it.type === 'state_tax' || it.type === 'other_tax') && isEmployerCode(it.taxCode);
}
/** The item needs a liability account (and an agency). */
function needsLiability(it: PayrollItem): boolean {
  return !isWageType(it.type) && it.type !== 'addition';
}

function stepsFor(it: PayrollItem | null, group: Group | null, isNew: boolean): Step[] {
  const s: Step[] = isNew ? ['type'] : [];
  if (!group || !it) return s;
  switch (group) {
    case 'wage':
      s.push('wage');
      if (it.type === 'hourly' || it.type === 'salary' || it.type === 'overtime') s.push('wageUse');
      if (it.type === 'bonus' || it.type === 'commission') s.push('wageCalc');
      s.push('name', 'expense');
      break;
    case 'addition':
      s.push('name', 'expense', 'tracking', 'taxes', 'calc', 'rate');
      break;
    case 'deduction':
    case 'contribution':
      s.push('name', 'agency', 'tracking', 'taxes', 'calc', 'rate');
      break;
    case 'federal_tax':
      s.push('tax', 'name', 'agency');
      break;
    case 'state_tax':
      s.push('tax', 'name', 'agency');
      if (it.taxCode === 'SUI_ER' || it.taxCode === 'ST_EE' || it.taxCode === 'ST_ER') s.push('taxRate');
      break;
    case 'other_tax':
      s.push('tax', 'name', 'agency', 'rate');
      break;
  }
  return s;
}

/** Suggested accounts for a new item (copied from existing items of the same kind). */
function suggestAccounts(it: PayrollItem, items: PayrollItem[], accounts: BooksAccount[]): Partial<PayrollItem> {
  const byName = (re: RegExp, types: string[]) => accounts.find((a) => a.active && types.includes(a.type) && re.test(a.fullName))?.id ?? null;
  const first = (f: (i: PayrollItem) => boolean, k: 'expenseAccountId' | 'liabilityAccountId') => items.find((i) => i.active && f(i) && i[k])?.[k] ?? null;
  const out: Partial<PayrollItem> = {};
  if (needsExpense(it) && !it.expenseAccountId) {
    if (isWageType(it.type)) out.expenseAccountId = first((i) => i.type === 'salary' || i.type === 'hourly', 'expenseAccountId') ?? byName(/wage|salar/i, EXPENSE_TYPES);
    else if (it.type === 'addition') out.expenseAccountId = first((i) => i.type === 'addition', 'expenseAccountId') ?? byName(/reimburs/i, EXPENSE_TYPES);
    else if (it.type === 'contribution') out.expenseAccountId = first((i) => i.type === 'contribution', 'expenseAccountId') ?? byName(/benefit/i, EXPENSE_TYPES);
    else out.expenseAccountId = first((i) => EMPLOYER_CODES.includes(i.taxCode), 'expenseAccountId') ?? byName(/payroll tax/i, EXPENSE_TYPES);
  }
  if (needsLiability(it) && !it.liabilityAccountId) {
    if (it.type === 'deduction' || it.type === 'contribution') {
      const retire = ['401k', '403b', '457b', 'roth_401k', 'roth_403b', 'simple_ira'].includes(it.taxTracking);
      const health = ['section_125', 'hsa', 'health_coverage', 'dependent_care'].includes(it.taxTracking);
      out.liabilityAccountId = retire ? byName(/retire/i, LIABILITY_TYPES) : health ? byName(/health|benefit/i, LIABILITY_TYPES) : byName(/other deduction/i, LIABILITY_TYPES);
      out.liabilityAccountId = out.liabilityAccountId ?? first((i) => i.type === it.type, 'liabilityAccountId');
    } else if (it.type === 'federal_tax') {
      out.liabilityAccountId = it.taxCode === 'FUTA' ? first((i) => i.taxCode === 'FUTA', 'liabilityAccountId') ?? byName(/940|unemploy/i, LIABILITY_TYPES) : first((i) => i.taxCode === 'FIT', 'liabilityAccountId') ?? byName(/941|federal/i, LIABILITY_TYPES);
    } else if (it.type === 'state_tax') {
      out.liabilityAccountId =
        it.taxCode === 'SIT' ? first((i) => i.taxCode === 'SIT', 'liabilityAccountId') ?? byName(/state withh/i, LIABILITY_TYPES) : first((i) => i.type === 'state_tax' && i.taxCode !== 'SIT', 'liabilityAccountId') ?? byName(/unemploy|disab/i, LIABILITY_TYPES);
    } else if (it.type === 'other_tax') {
      out.liabilityAccountId = first((i) => i.type === 'other_tax', 'liabilityAccountId') ?? byName(/local/i, LIABILITY_TYPES);
    }
  }
  if (!it.agencyVendorId && (it.type === 'federal_tax' || it.type === 'state_tax')) {
    const same = items.find((i) => i.active && i.agencyVendorId && (it.type === 'federal_tax' ? i.type === 'federal_tax' : i.type === 'state_tax' && i.state === it.state && (it.taxCode === 'SIT') === (i.taxCode === 'SIT')));
    if (same) out.agencyVendorId = same.agencyVendorId;
  }
  return out;
}

/** Suggested name of a tax item ("CA - Withholding"). */
function taxName(it: PayrollItem, meta: Meta | undefined): string {
  if (it.type === 'federal_tax') return it.taxCode ? taxCodeLabel(it.taxCode) : '';
  if (it.type === 'state_tax' && it.state && it.taxCode) {
    const st = meta?.states.find((s) => s.code === it.state);
    const prog = st?.programs.find((p) => p.value === it.taxKey)?.label;
    const lbl: Record<string, string> = {
      SIT: 'Withholding',
      SUI_ER: 'Unemployment (company)',
      SUI_EE: 'Unemployment (employee)',
      ST_EE: `${prog ?? 'State Program'} (employee)`,
      ST_ER: `${prog ?? 'State Program'} (company)`,
    };
    return `${it.state} - ${lbl[it.taxCode] ?? it.taxCode}`;
  }
  return '';
}

export default function PayrollItemWizard(props: PayrollItemWizardProps) {
  const win = useWindow();
  const fe = useFormErrors();
  const meta = useMeta().data;
  const allItems = useItems({ active: 'all' }).data;
  const accounts = useBooksAccounts().data;
  const isNew = !props.id;
  const [it, setIt] = useState<PayrollItem | null>(null);
  const [group, setGroup] = useState<Group | null>(null);
  const [step, setStep] = useState<Step>('type');
  const [visited, setVisited] = useState<Set<Step>>(new Set());
  const [busy, setBusy] = useState(false);
  const [orig, setOrig] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nameTouched, setNameTouched] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** Liability account suggested for a new item (re-suggested while unchanged). */
  const autoLiab = useRef<number | null>(null);

  // load the item / start a new one
  useEffect(() => {
    if (props.id) {
      let off = false;
      api
        .get<PayrollItem>(`/items/${props.id}`)
        .then((x) => {
          if (off) return;
          setIt(x);
          setGroup(groupOf(x.type));
          setOrig(JSON.stringify(x));
          setStep(stepsFor(x, groupOf(x.type), false)[0] ?? 'name');
          setNameTouched(true);
        })
        .catch((e) => !off && setLoadError(errMessage(e)));
      return () => {
        off = true;
      };
    }
    if (props.type && meta) {
      const x = blankItem(props.type, meta);
      setIt(x);
      setGroup(groupOf(props.type));
      setOrig(JSON.stringify(x));
      setVisited(new Set(['type']));
      setStep(stepsFor(x, groupOf(props.type), true)[1] ?? 'type');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.id, props.type, !!meta]);

  // a new item started from a type (picker "+ Add new") gets suggested accounts once the lists are loaded
  const suggestedOnce = useRef(false);
  useEffect(() => {
    if (!isNew || !it || suggestedOnce.current || !allItems || !accounts) return;
    suggestedOnce.current = true;
    if (it.expenseAccountId || it.liabilityAccountId) return;
    const s = suggestAccounts(it, allItems, accounts);
    autoLiab.current = s.liabilityAccountId ?? null;
    const next = { ...it, ...s };
    setIt(next);
    setOrig(JSON.stringify(next)); // suggestions do not count as changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [it?.type, !!allItems, !!accounts]);

  const steps = useMemo(() => stepsFor(it, group, isNew), [it, group, isNew]);
  const idx = Math.max(0, steps.indexOf(step));
  const last = idx === steps.length - 1 && steps.length > 1;

  const dirty = !!it && JSON.stringify(it) !== orig;
  const dirtyRef = useLatest(dirty);
  useEffect(() => {
    win.setDirty(dirty);
  }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    win.setBeforeClose(async () => (dirtyRef.current ? confirmBox('Close the payroll item without saving your changes?', 'Unsaved Changes') : true));
    return () => win.setBeforeClose(null);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // window title: New Payroll Item (Deduction:Union Dues)
  useEffect(() => {
    if (!it) return;
    const tag = it.name ? ` (${itemTypeText(it)}:${it.name})` : '';
    win.setTitle((isNew ? 'New Payroll Item' : 'Edit Payroll Item') + tag);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [it?.name, it?.type, it?.taxCode]);

  // focus the first field of a page
  useEffect(() => {
    const t = setTimeout(() => {
      const root = bodyRef.current;
      if (!root || root.contains(document.activeElement)) return;
      const el = root.querySelector<HTMLElement>('input:not([disabled]):not([type=hidden]), select:not([disabled])');
      el?.focus();
    }, 30);
    return () => clearTimeout(t);
  }, [step]);

  if (loadError) return <div className="sxp-emp-pad sxp-emp-dlg-error">{loadError}</div>;
  if ((!isNew || props.type) && !it)
    return (
      <div className="sxp-emp-page" style={{ alignItems: 'center', justifyContent: 'center', background: '#fff' }}>
        <Spinner label="Loading…" />
      </div>
    );

  const set = (p: Partial<PayrollItem>) => setIt((x) => (x ? { ...x, ...p } : x));
  const suggest = (x: PayrollItem) => {
    if (!allItems || !accounts) return x;
    const r = { ...x, ...suggestAccounts(x, allItems, accounts) };
    autoLiab.current = r.liabilityAccountId;
    return r;
  };

  /** Changes the item type (keeping the name and accounts that still apply). */
  const changeType = (type: ItemType, extra: Partial<PayrollItem> = {}) => {
    const base = blankItem(type, meta);
    setIt((x) => {
      const keep = x && groupOf(x.type) === groupOf(type) ? { name: x.name, expenseAccountId: x.expenseAccountId, liabilityAccountId: x.liabilityAccountId, agencyVendorId: x.agencyVendorId, active: x.active } : {};
      return suggest({ ...base, ...(x && !isNew ? { id: x.id } : {}), ...keep, ...extra });
    });
  };

  const chooseGroup = (g: Group) => {
    setGroup(g);
    if (groupOf(it?.type ?? '') === g) return;
    const type: ItemType = g === 'wage' ? 'hourly' : (g as ItemType);
    const next = suggest(blankItem(type, meta));
    setIt(next);
    setOrig(JSON.stringify(next));
    setNameTouched(false);
  };

  const setTracking = (key: TaxTracking) => {
    if (!it) return;
    const d = trackingDefaults(meta, it.type, key);
    let next: PayrollItem = { ...it, taxTracking: key, taxability: d.taxability, w2Box12: d.w2Box12 };
    // a new item follows the suggested liability account (retirement, health...) until the user picks one
    if (isNew && allItems && accounts && it.liabilityAccountId === autoLiab.current) {
      const s = suggestAccounts({ ...next, liabilityAccountId: null }, allItems, accounts);
      if (s.liabilityAccountId) {
        next = { ...next, liabilityAccountId: s.liabilityAccountId };
        autoLiab.current = s.liabilityAccountId;
      }
    }
    setIt(next);
  };

  const setTax = (p: Partial<PayrollItem>) => {
    if (!it) return;
    let next = { ...it, ...p };
    if (isNew && !nameTouched) next.name = taxName(next, meta) || next.name;
    if (isNew && accounts && allItems) {
      // employer / employee change: re-suggest accounts that no longer apply
      if (!needsExpense(next)) next.expenseAccountId = null;
      next = { ...next, ...suggestAccounts(next, allItems, accounts) };
    }
    setIt(next);
  };

  // ---- validation per page
  const check = (s: Step): Record<string, string> => {
    const e: Record<string, string> = {};
    if (!it) {
      if (s === 'type') e.type = 'Choose the type of payroll item.';
      return e;
    }
    switch (s) {
      case 'type':
        if (!group) e.type = 'Choose the type of payroll item.';
        break;
      case 'wageUse':
        if (it.type === 'overtime' && !(it.rate > 0)) e.rate = 'Enter the overtime multiplier (for example 1.5).';
        break;
      case 'name':
        if (!it.name.trim()) e.name = 'Enter a name for the payroll item.';
        else if (/[:\n\r\t]/.test(it.name)) e.name = 'The name cannot contain a colon.';
        else if (allItems?.some((x) => x.id !== it.id && x.name.trim().toLowerCase() === it.name.trim().toLowerCase())) e.name = `There is already a payroll item named "${it.name.trim()}".`;
        break;
      case 'expense':
        if (!it.expenseAccountId) e.expenseAccountId = 'Choose the expense account for this item.';
        break;
      case 'agency':
        if (needsLiability(it) && !it.liabilityAccountId) e.liabilityAccountId = 'Choose the liability account for this item.';
        if (needsExpense(it) && !it.expenseAccountId) e.expenseAccountId = 'Choose the expense account for this item.';
        break;
      case 'tax':
        if (it.type === 'federal_tax' && !it.taxCode) e.taxCode = 'Choose the federal tax this item tracks.';
        if (it.type === 'state_tax') {
          if (!it.state) e.state = 'Choose the state of this tax.';
          if (!it.taxCode) e.taxCode = 'Choose the state tax this item tracks.';
          if ((it.taxCode === 'ST_EE' || it.taxCode === 'ST_ER') && !it.taxKey) e.taxKey = 'Choose the state program.';
        }
        // one active item per federal / state tax (same rule as the server)
        if (!e.taxCode && !e.state && !e.taxKey && it.active && (it.type === 'federal_tax' || it.type === 'state_tax') && it.taxCode) {
          const me = taxIdentity(it.taxCode, it.state, it.taxKey);
          const dup = allItems?.find((x) => x.id !== it.id && x.active && (x.type === 'federal_tax' || x.type === 'state_tax') && x.taxCode && taxIdentity(x.taxCode, x.state, x.taxKey) === me);
          if (dup) e.taxCode = `The active payroll item "${dup.name}" already tracks this tax. Make it inactive first or edit it instead.`;
        }
        break;
      case 'rate':
        if (it.calc === 'match') {
          if (!it.matchItemId) e.matchItemId = 'Choose the employee deduction this contribution matches.';
          if (!(it.rate > 0)) e.rate = 'Enter the percent the company matches.';
        }
        if (it.calc === 'percent' && it.rate > 100) e.rate = 'The percent cannot be more than 100.';
        break;
    }
    return e;
  };

  const goto = (target: Step) => {
    // moving forward checks the pages in between
    const ti = steps.indexOf(target);
    if (ti > idx) {
      for (let i = idx; i < ti; i++) {
        const errs = check(steps[i]);
        if (Object.keys(errs).length) {
          fe.setErrors(errs);
          setStep(steps[i]);
          return;
        }
      }
    }
    fe.clearAll();
    setVisited((v) => new Set([...v, step]));
    setStep(target);
  };

  const fieldStep = (field: string): Step | null => {
    const map: Record<string, Step> = {
      name: 'name',
      type: 'type',
      taxCode: 'tax',
      state: 'tax',
      taxKey: 'tax',
      liabilityAccountId: 'agency',
      agencyVendorId: 'agency',
      expenseAccountId: steps.includes('expense') ? 'expense' : 'agency',
      taxTracking: 'tracking',
      w2Box12: 'tracking',
      w2Box14: 'tracking',
      calc: 'calc',
      matchItemId: 'rate',
      matchCapPct: 'rate',
      annualLimit: 'rate',
      limitKind: 'rate',
      rate: steps.includes('rate') ? 'rate' : steps.includes('taxRate') ? 'taxRate' : steps.includes('wageCalc') ? 'wageCalc' : 'wageUse',
      pto: 'wageUse',
    };
    const s = map[field];
    return s && steps.includes(s) ? s : null;
  };

  const finish = async () => {
    if (!it) return;
    for (const s of steps) {
      const errs = check(s);
      if (Object.keys(errs).length) {
        fe.setErrors(errs);
        setStep(s);
        return;
      }
    }
    setBusy(true);
    try {
      const body: PayrollItem = { ...it, name: it.name.trim() };
      const saved = isNew ? await api.post<PayrollItem>('/items', body) : await api.put<PayrollItem>(`/items/${it.id}`, body);
      setOrig(JSON.stringify(saved));
      setIt(saved);
      win.setDirty(false);
      if (isNew) notifyCreated({ kind: 'item', id: saved.id });
      await invalidateAll();
      toast(`Payroll item "${saved.name}" ${isNew ? 'created' : 'saved'}`, { kind: 'success' });
      await win.close(true);
    } catch (e) {
      const f = (e as { field?: string }).field;
      const s = f ? fieldStep(f) : null;
      if (s) setStep(s);
      fe.fromError(e);
    } finally {
      setBusy(false);
    }
  };

  // ---- pages
  const head = (title: string, sub?: ReactNode) => (
    <div className="sxp-wiz-head">
      <h2>{title}</h2>
      {sub && <div className="sxp-emp-note">{sub}</div>}
    </div>
  );
  const option = (on: boolean, label: ReactNode, desc: ReactNode, onPick: () => void, disabled?: boolean) => (
    <label key={typeof label === 'string' ? label : undefined} className={'sxp-wiz-opt' + (on ? ' sxp-on' : '')} style={disabled ? { opacity: 0.55, cursor: 'default' } : undefined}>
      <input type="radio" checked={on} disabled={disabled} onChange={() => !disabled && onPick()} />
      <span>
        <b>{label}</b>
        {desc && <span className="sxp-emp-note">{desc}</span>}
      </span>
    </label>
  );

  const used = !!it?.hasPaychecks;
  /** An other active item already tracks this tax (federal code, or state code + state + program). */
  const setUp = (code: string, state: string, key: string) =>
    !!allItems?.some((x) => x.id !== it?.id && x.active && (x.type === 'federal_tax' || x.type === 'state_tax') && taxIdentity(x.taxCode, x.state, x.taxKey) === taxIdentity(code, state, key));
  const typeName = it ? (ITEM_TYPE_LABELS[it.type] ?? it.type).toLowerCase() : '';
  const st = it?.state ? meta?.states.find((s) => s.code === it.state) : undefined;

  let page: ReactNode = null;
  switch (step) {
    case 'type':
      page = (
        <>
          {head('What kind of payroll item is it?', 'Pick the group that fits best.')}
          <div className="sxp-wiz-options" data-field="type">
            {GROUPS.map((g) => option(group === g.key, g.label, g.desc, () => chooseGroup(g.key)))}
          </div>
        </>
      );
      break;
    case 'wage':
      if (it)
        page = (
          <>
            {head('Kind of pay', 'How is the employee paid with this item?')}
            {used && (
              <div className="sxp-wiz-info">
                <Info size={15} />
                <span>This item is on paychecks, so its kind of pay cannot change.</span>
              </div>
            )}
            <div className="sxp-wiz-options">
              {option(it.type === 'hourly' || it.type === 'overtime', 'By the hour', 'Paid for each hour worked (regular, overtime, sick and vacation hours).', () => changeType('hourly'), used)}
              {option(it.type === 'salary', 'Yearly salary', 'A yearly amount divided among the paychecks of the year.', () => changeType('salary'), used)}
              {option(it.type === 'commission', 'Commission', 'A percent of the sales amount you enter on the paycheck, or a fixed amount.', () => changeType('commission'), used)}
              {option(it.type === 'bonus', 'Bonus', 'One-time or occasional pay; withheld at the supplemental rate.', () => changeType('bonus'), used)}
              {option(it.type === 'tips', 'Tips paid on the paycheck', 'Tips the company pays out on the paycheck.', () => changeType('tips'), used)}
              {option(it.type === 'reported_tips', 'Cash tips the employee reported', 'Tips the employee kept: taxed but not paid on the paycheck.', () => changeType('reported_tips'), used)}
            </div>
          </>
        );
      break;
    case 'wageUse':
      if (it) {
        const hourly = it.type === 'hourly' || it.type === 'overtime';
        page = (
          <>
            {head('Regular pay or time off', 'Is this item for normal hours, overtime, sick time or vacation?')}
            <div className="sxp-wiz-options" data-field="pto">
              {option(it.type !== 'overtime' && !it.pto, 'Normal hours', '', () => (it.type === 'overtime' ? changeType('hourly') : set({ pto: '' })), used && it.type === 'overtime')}
              {hourly && option(it.type === 'overtime', 'Overtime', 'A multiple of the regular hourly rate (salaried employees: annual salary / 2,080).', () => changeType('overtime'), used && it.type !== 'overtime')}
              {option(it.type !== 'overtime' && it.pto === 'sick', 'Sick time', 'Uses the sick hours of the Sick and Vacation settings.', () => (it.type === 'overtime' ? changeType('hourly', { pto: 'sick' }) : set({ pto: 'sick' })), used && it.type === 'overtime')}
              {option(
                it.type !== 'overtime' && it.pto === 'vacation',
                'Vacation time',
                'Uses the vacation hours of the Sick and Vacation settings.',
                () => (it.type === 'overtime' ? changeType('hourly', { pto: 'vacation' }) : set({ pto: 'vacation' })),
                used && it.type === 'overtime',
              )}
            </div>
            {it.type === 'overtime' && (
              <FieldRow>
                <Field label="Overtime rate (multiple of the regular rate)" width={280} hint="1.5 for time and a half, 2 for double time.">
                  <NumberField name="rate" value={it.rate} nullable={false} onChange={(v) => set({ rate: v ?? 0 })} />
                </Field>
                <div style={{ paddingTop: 22 }}>
                  <Checkbox
                    checked={it.taxTracking === 'qualified_overtime'}
                    onChange={(v) => set({ taxTracking: v ? 'qualified_overtime' : 'compensation', w2Box12: v ? 'TT' : '' })}
                    label="Qualified overtime (W-2 box 12 code TT)"
                  />
                </div>
              </FieldRow>
            )}
          </>
        );
      }
      break;
    case 'wageCalc':
      if (it)
        page =
          it.type === 'bonus' ? (
            <>
              {head('Bonus', 'Enter the usual bonus amount (you can change it on each paycheck).')}
              <FieldRow>
                <Field label="Default amount" width={200}>
                  <MoneyField name="rate" value={it.rate} onChange={(v) => set({ rate: v ?? 0 })} />
                </Field>
              </FieldRow>
              <Checkbox
                checked={it.supplemental}
                onChange={(v) => set({ supplemental: v })}
                label="Supplemental wages: withhold federal income tax at the flat supplemental rate (22%)"
              />
            </>
          ) : (
            <>
              {head('Commission', 'How is the commission calculated?')}
              <div className="sxp-wiz-options" data-field="calc">
                {option(it.calc === 'quantity', 'Percent of a sales amount', 'Enter the sales amount on each paycheck; the commission is that amount times the percent.', () => set({ calc: 'quantity' }))}
                {option(it.calc === 'fixed', 'Fixed amount', 'Enter the commission amount on each paycheck.', () => set({ calc: 'fixed' }))}
              </div>
              <FieldRow>
                <Field label={it.calc === 'quantity' ? 'Default commission percent' : 'Default amount'} width={220} hint="The employee record can override it.">
                  {it.calc === 'quantity' ? (
                    <NumberField name="rate" value={it.rate} nullable={false} suffix="%" onChange={(v) => set({ rate: v ?? 0 })} />
                  ) : (
                    <MoneyField name="rate" value={it.rate} onChange={(v) => set({ rate: v ?? 0 })} />
                  )}
                </Field>
              </FieldRow>
            </>
          );
      break;
    case 'tax':
      if (it) {
        if (it.type === 'federal_tax')
          page = (
            <>
              {head('Federal tax', 'Which federal tax does this item track? Payroll setup creates these items; add one only when it is missing.')}
              <FieldRow>
                <Field label="Tax" width={320}>
                  <Select
                    name="taxCode"
                    value={it.taxCode}
                    options={[{ value: '', label: '' }, ...FEDERAL_CODES.map((c) => ({ value: c, label: TAX_CODE_LABELS[c] + (setUp(c, '', '') ? ' (already set up)' : '') }))]}
                    onChange={(v) => setTax({ taxCode: v as TaxCode })}
                    disabled={used}
                  />
                </Field>
              </FieldRow>
            </>
          );
        else if (it.type === 'state_tax') {
          const codes: { value: string; label: string }[] = [{ value: '', label: '' }];
          const mark = (code: string) => (it.state && setUp(code, it.state, '') ? ' (already set up)' : '');
          if (!st || st.hasIncomeTax) codes.push({ value: 'SIT', label: 'State Withholding (employee)' + mark('SIT') });
          codes.push({ value: 'SUI_ER', label: 'State Unemployment (company)' + mark('SUI_ER') });
          if (!st || st.hasEmployeeSui) codes.push({ value: 'SUI_EE', label: 'State Unemployment (employee)' + mark('SUI_EE') });
          if (!st || st.programs.length) {
            codes.push({ value: 'ST_EE', label: 'State program - employee (SDI, family leave...)' });
            codes.push({ value: 'ST_ER', label: 'State program - company (training tax, ...)' });
          }
          page = (
            <>
              {head('State tax', 'Choose the state and the tax this item tracks. SerieX Payroll calculates it from the state tax tables.')}
              <div className="sxp-emp-grid sxp-emp-g2">
                <Field label="State">
                  <StatePicker name="state" value={it.state} onChange={(c) => setTax({ state: c ?? '', taxKey: '' })} disabled={used} aria-label="State" />
                </Field>
                <Field label="Tax">
                  <Select name="taxCode" value={it.taxCode} options={codes} onChange={(v) => setTax({ taxCode: v as TaxCode, taxKey: '' })} disabled={used} />
                </Field>
                {(it.taxCode === 'ST_EE' || it.taxCode === 'ST_ER') && (
                  <Field label="State program" className="sxp-emp-span2">
                    <Select
                      name="taxKey"
                      value={it.taxKey}
                      options={[
                        { value: '', label: '' },
                        ...(st?.programs ?? []).map((p) => ({ value: p.value, label: `${p.label} (${p.value})` + (setUp(it.taxCode, it.state, p.value) ? ' (already set up)' : '') })),
                      ]}
                      onChange={(v) => setTax({ taxKey: v })}
                      disabled={used}
                    />
                  </Field>
                )}
              </div>
              {st && !st.hasIncomeTax && <div className="sxp-emp-hint">{st.name} has no state income tax withholding.</div>}
            </>
          );
        } else
          page = (
            <>
              {head('Other tax', 'Who pays this tax? Local taxes are a percent of the local wages of the employee.')}
              <div className="sxp-wiz-options" data-field="taxCode">
                {option(it.taxCode !== 'LOCAL_ER', 'Tax is paid by the employee', 'Withheld from the paycheck (for example a city income tax).', () => setTax({ taxCode: 'LOCAL_EE' }))}
                {option(it.taxCode === 'LOCAL_ER', 'Tax is paid by the company', 'A company expense (for example a local payroll or head tax).', () => setTax({ taxCode: 'LOCAL_ER' }))}
              </div>
              <FieldRow>
                <Field label="State (optional)" width={220} hint="For reports and the W-2 locality.">
                  <StatePicker name="state" value={it.state} onChange={(c) => set({ state: c ?? '' })} aria-label="State" />
                </Field>
              </FieldRow>
            </>
          );
      }
      break;
    case 'name':
      if (it)
        page = (
          <>
            {head('Item name', 'This name is shown on paychecks, pay stubs and payroll reports.')}
            <FieldRow>
              <Field label="Name" width={360} required>
                <TextField
                  name="name"
                  value={it.name}
                  onChange={(v) => {
                    setNameTouched(true);
                    set({ name: v });
                  }}
                  maxLength={100}
                />
              </Field>
            </FieldRow>
            <div className="sxp-emp-hint">
              {it.type === 'hourly'
                ? 'For example "Regular Hours" or "Weekend Hours".'
                : it.type === 'deduction'
                  ? 'For example "Union Dues", "Garnishment" or "Dental Insurance".'
                  : it.type === 'addition'
                    ? 'For example "Mileage Reimbursement" or "Employee Advance".'
                    : it.type === 'contribution'
                      ? 'For example "401(k) Company Match" or "Health Insurance Company".'
                      : `Use a short name your employees will recognize (this is a ${typeName} item).`}
            </div>
            {!isNew && (
              <Checkbox checked={!it.active} onChange={(v) => set({ active: !v })} label="Inactive (hidden in Payroll Items and in the drop-down lists)" />
            )}
          </>
        );
      break;
    case 'expense':
      if (it)
        page = (
          <>
            {head('Expense account', 'Where SerieX Books records the cost of this item.')}
            <FieldRow>
              <Field label="Expense account" width={380} required>
                <AccountPicker name="expenseAccountId" types={EXPENSE_TYPES} value={it.expenseAccountId} onChange={(aid) => set({ expenseAccountId: aid })} />
              </Field>
            </FieldRow>
            <div className="sxp-emp-hint">
              {isWageType(it.type) ? 'Wages are a cost to your company.' : 'Additions are a cost to your company.'} Paychecks post this item to the account in SerieX Books; you can pick
              another account later.
            </div>
          </>
        );
      break;
    case 'agency':
      if (it) {
        const companyPaid = it.type === 'contribution' || isEmployerCode(it.taxCode);
        page = (
          <>
            {head(companyPaid ? 'Who the company pays' : 'Who gets the withheld amounts', 'The payee and the account that holds the money until you pay it.')}
            <FieldRow>
              <Field label="Payee (agency or vendor)" width={380} help="The vendor (tax agency, benefit provider, plan administrator) you pay. Pay Payroll Taxes writes the check to it.">
                <VendorPicker name="agencyVendorId" value={it.agencyVendorId} onChange={(vid) => set({ agencyVendorId: vid })} />
              </Field>
            </FieldRow>
            <FieldRow>
              <Field label={companyPaid ? 'Liability account (company-paid)' : 'Liability account (employee-paid)'} width={380} required>
                <AccountPicker name="liabilityAccountId" types={LIABILITY_TYPES} value={it.liabilityAccountId} onChange={(aid) => set({ liabilityAccountId: aid })} />
              </Field>
            </FieldRow>
            <div className="sxp-emp-hint">This liability account holds the {companyPaid ? 'company contributions and taxes' : 'deductions and withholding'} until you pay them. You can pick another account later.</div>
            {needsExpense(it) && (
              <>
                <FieldRow>
                  <Field label="Expense account" width={380} required>
                    <AccountPicker name="expenseAccountId" types={EXPENSE_TYPES} value={it.expenseAccountId} onChange={(aid) => set({ expenseAccountId: aid })} />
                  </Field>
                </FieldRow>
                <div className="sxp-emp-hint">Company-paid {it.type === 'contribution' ? 'contributions' : 'taxes'} are a cost to your company.</div>
              </>
            )}
          </>
        );
      }
      break;
    case 'tracking':
      if (it) {
        const opts = trackingOptions(meta, it.type);
        page = (
          <>
            {head('Tax treatment', 'Tells payroll how this item is taxed and where it goes on the W-2. Pick the one that matches the plan or benefit, so your tax forms come out right.')}
            <FieldRow>
              <Field label="Tax treatment" width={360}>
                <Select name="taxTracking" value={it.taxTracking} options={opts.map((o) => ({ value: o.key, label: o.label }))} onChange={(v) => setTracking(v as TaxTracking)} />
              </Field>
            </FieldRow>
            {it.taxTracking === 'none' && (
              <div className="sxp-wiz-info sxp-warn">
                <AlertTriangle size={15} />
                <span>
                  With this choice the item is not wages: it is not taxed and is not on the W-2. Use it only for amounts such as accountable-plan reimbursements.
                </span>
              </div>
            )}
            <div className="sxp-emp-grid sxp-emp-g2">
              <Field label="W-2 box 12 code" help="Code printed in box 12 of the W-2 (for example D for 401(k) deferrals, W for HSA, DD for employer health coverage).">
                <Select name="w2Box12" value={it.w2Box12} options={[{ value: '', label: '(none)' }, ...(meta?.box12Codes ?? []).map((c) => ({ value: c.value, label: c.label }))]} onChange={(v) => set({ w2Box12: v })} />
              </Field>
              <Field label="W-2 box 14 label" help="Optional: show the yearly amount in box 14 with this label (for example union dues).">
                <TextField name="w2Box14" value={it.w2Box14} onChange={(v) => set({ w2Box14: v })} maxLength={40} />
              </Field>
            </div>
          </>
        );
      }
      break;
    case 'taxes':
      if (it) {
        const reduces = it.type === 'deduction';
        page = (
          <>
            {head(
              'Taxes that apply',
              'These boxes start from the tax treatment you picked and fit most items. Change them only when you know this item is taxed differently.',
            )}
            <div className="sxp-emp-note">{reduces ? 'A check means the deduction is pre-tax: it reduces the wages subject to that tax.' : 'A check means the item counts as wages subject to that tax.'}</div>
            <div className="sxp-wiz-taxes" data-field="taxability">
              {WAGE_BASES.map((b) => (
                <Checkbox key={b} checked={!!it.taxability[b]} onChange={(v) => set({ taxability: { ...it.taxability, [b]: v } })} label={WAGE_BASE_LABELS[b]} />
              ))}
            </div>
            <div>
              <Button small label="Default" title="Go back to the settings of the tax treatment" onClick={() => set({ taxability: trackingDefaults(meta, it.type, it.taxTracking).taxability })} />
            </div>
          </>
        );
      }
      break;
    case 'calc':
      if (it) {
        const neither = it.calc === 'fixed' || it.calc === 'percent';
        page = (
          <>
            {head('How it is calculated')}
            <div className="sxp-wiz-options" data-field="calc">
              {option(it.calc === 'quantity', 'From a quantity', 'Figured from a number you type on each paycheck (for example miles).', () =>
                set({ calc: 'quantity', matchItemId: null }),
              )}
              {option(it.calc === 'per_hour', 'From the hours worked', 'Figured from the hours on the paycheck.', () => set({ calc: 'per_hour', matchItemId: null }))}
              {option(neither, 'Fixed amount or percent', 'A flat amount per paycheck or a percent of gross pay.', () => set({ calc: 'fixed', matchItemId: null }))}
              {it.type === 'contribution' &&
                option(it.calc === 'match', 'Match an employee deduction', 'The company matches a percent of an employee deduction (for example a 401(k) match), up to a percent of gross pay.', () =>
                  set({ calc: 'match', rate: it.rate || 100, matchCapPct: it.matchCapPct || 4 }),
                )}
            </div>
          </>
        );
      }
      break;
    case 'rate':
      if (it) {
        const isTaxItem = it.type === 'other_tax';
        page = (
          <>
            {head(
              'Default amount and limit',
              'Employees who get this item start with this amount. You can give any employee a different amount on their record.',
            )}
            {isTaxItem ? (
              <FieldRow>
                <Field label="Tax rate (% of local wages)" width={220}>
                  <NumberField name="rate" value={it.rate} nullable={false} suffix="%" onChange={(v) => set({ rate: v ?? 0 })} />
                </Field>
              </FieldRow>
            ) : it.calc === 'match' ? (
              <>
                <div className="sxp-emp-grid sxp-emp-g2">
                  <Field label="Employee deduction matched">
                    <PayrollItemPicker name="matchItemId" types={['deduction']} value={it.matchItemId} onChange={(mid) => set({ matchItemId: mid })} />
                  </Field>
                  <Field label="Company matches (% of the deduction)">
                    <NumberField name="rate" value={it.rate} nullable={false} suffix="%" onChange={(v) => set({ rate: v ?? 0 })} />
                  </Field>
                  <Field label="Up to (% of gross pay)" hint="0 for no cap.">
                    <NumberField name="matchCapPct" value={it.matchCapPct} nullable={false} suffix="%" onChange={(v) => set({ matchCapPct: v ?? 0 })} />
                  </Field>
                </div>
                <div className="sxp-emp-hint">
                  Example: {fmtPercent(it.rate || 0)} of the employee's deduction, up to {fmtPercent(it.matchCapPct || 0)} of gross pay.
                </div>
              </>
            ) : it.calc === 'quantity' || it.calc === 'per_hour' ? (
              <FieldRow>
                <Field label={it.calc === 'quantity' ? 'Rate per unit (amount × quantity on the paycheck)' : 'Amount per hour worked'} width={320}>
                  <MoneyField name="rate" value={it.rate} onChange={(v) => set({ rate: v ?? 0 })} />
                </Field>
              </FieldRow>
            ) : (
              <div className="sxp-emp-inline" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <Field label="Calculate as">
                  <SegmentedControl
                    value={it.calc === 'percent' ? 'percent' : 'fixed'}
                    onChange={(v) => set({ calc: v })}
                    options={[
                      { value: 'fixed', label: 'Amount per paycheck' },
                      { value: 'percent', label: 'Percent of gross pay' },
                    ]}
                    aria-label="Calculate as"
                  />
                </Field>
                <Field label={it.calc === 'percent' ? 'Default percent' : 'Default amount'} width={180}>
                  {it.calc === 'percent' ? (
                    <NumberField name="rate" value={it.rate} nullable={false} suffix="%" onChange={(v) => set({ rate: v ?? 0 })} />
                  ) : (
                    <MoneyField name="rate" value={it.rate} onChange={(v) => set({ rate: v ?? 0 })} />
                  )}
                </Field>
              </div>
            )}
            <div className="sxp-emp-hint">
              Optional cap on the total. An employee without a limit of their own uses this one; when both have a limit, the lower one applies.
            </div>
            <div className="sxp-emp-grid sxp-emp-g2">
              <Field label="Limit">
                <MoneyField name="annualLimit" nullable value={it.annualLimit} onChange={(v) => set({ annualLimit: v === null ? null : Math.abs(v) })} />
              </Field>
              <Field label="Limit type">
                <Select
                  name="limitKind"
                  value={it.limitKind}
                  onChange={(v) => set({ limitKind: v as PayrollItem['limitKind'] })}
                  options={[
                    { value: 'annual', label: 'Yearly (starts over each year)' },
                    { value: 'one_time', label: 'One time (never starts over)' },
                  ]}
                />
              </Field>
            </div>
          </>
        );
      }
      break;
    case 'taxRate':
      if (it)
        page = (
          <>
            {head(
              it.taxCode === 'ST_EE' ? 'Employee rate' : 'Company rate',
              it.taxCode === 'SUI_ER' ? 'The unemployment rate your state gave the company.' : 'The rate of this state program.',
            )}
            <FieldRow>
              <Field label="Rate (%)" width={200} hint="Leave 0 to use the rate of Company Payroll Information (state settings) or of the state tax tables.">
                <NumberField name="rate" value={it.rate} nullable={false} suffix="%" onChange={(v) => set({ rate: v ?? 0 })} />
              </Field>
            </FieldRow>
            {it.taxCode === 'SUI_ER' && st && <div className="sxp-emp-hint">The yearly unemployment rate of each state is kept in Company Payroll Information; an item rate here applies to every year.</div>}
          </>
        );
      break;
  }

  const close = () => void win.close();

  return (
    <FormErrorsProvider value={fe}>
      <div
        className="sxp-wiz"
        onKeyDown={(e) => {
          if (e.defaultPrevented) return;
          const t = e.target as HTMLElement;
          if (e.key === 'Escape' && t.getAttribute('aria-expanded') !== 'true') {
            e.preventDefault();
            close();
          } else if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.shiftKey && t.tagName !== 'BUTTON' && t.tagName !== 'TEXTAREA' && t.getAttribute('aria-expanded') !== 'true') {
            if (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'radio' && (t as HTMLInputElement).type !== 'checkbox') return; // fields commit on Enter
            e.preventDefault();
            if (last) void finish();
            else if (steps[idx + 1]) goto(steps[idx + 1]);
          }
        }}
      >
        <nav className="sxp-wiz-rail" aria-label="Steps">
          <div className="sxp-wiz-railtitle">{isNew ? 'New Payroll Item' : 'Edit Payroll Item'}</div>
          {steps.map((s, i) => (
            <button
              key={s}
              type="button"
              className={'sxp-wiz-step' + (s === step ? ' sxp-on' : '') + (i < idx || visited.has(s) ? ' sxp-done' : '')}
              onClick={() => goto(s)}
              disabled={busy || (isNew && i > idx && !visited.has(s) && i !== idx + 1)}
              aria-current={s === step ? 'step' : undefined}
            >
              <span className="sxp-wiz-num">{i < idx ? <Check size={13} /> : i + 1}</span>
              {STEP_LABELS[s]}
            </button>
          ))}
          {it && (
            <div className="sxp-wiz-railfoot">
              {itemTypeText(it)}
              {it.name ? `: ${it.name}` : ''}
            </div>
          )}
        </nav>
        <div className="sxp-wiz-main">
          <div className="sxp-wiz-body" ref={bodyRef}>
            {(fe.message || Object.keys(fe.errors).length > 0) && <ErrorBanner errors={fe.errors} message={fe.message} root={bodyRef.current} onDismiss={() => fe.clearAll()} />}
            {page}
          </div>
          <div className="sxp-wiz-foot">
            <div className="sxp-grow">{steps.length > 1 ? `Step ${idx + 1} of ${steps.length}` : 'Step 1'}</div>
            <Button label="Cancel" onClick={close} disabled={busy} />
            <Button label="&Back" onClick={() => idx > 0 && goto(steps[idx - 1])} disabled={busy || idx === 0} />
            <Button label="&Next" variant={last ? 'secondary' : 'primary'} onClick={() => steps[idx + 1] && goto(steps[idx + 1])} disabled={busy || last || !steps[idx + 1] || (step === 'type' && !group)} />
            <Button label="&Finish" variant={last ? 'primary' : 'secondary'} busy={busy} onClick={() => void finish()} disabled={busy || !it || (isNew && !last)} />
          </div>
        </div>
      </div>
    </FormErrorsProvider>
  );
}
