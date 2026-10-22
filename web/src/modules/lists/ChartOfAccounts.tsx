// Chart of Accounts (Lists > Chart of Accounts, Ctrl+A).
// Classic list (NAME tree, TYPE, BALANCE TOTAL) with the bottom menu buttons Account ▾,
// Activities ▾ and Reports ▾, plus friendlier parts: search, type filter chips, bulk select
// (make inactive / export), hover actions (Register or Activity Report, Edit).
// Double-click / Enter: balance sheet account → register; income or expense account → Account Activity.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ListTree, Plus } from 'lucide-react';
import { api } from '@/api/client';
import { useAccounts, usePrefValues } from '@/api/hooks';
import { downloadCsv } from '@/util/csv';
import { fmtMoney } from '@/util/format';
import type { Account, AccountType, ID } from '@/api/types';
import { Button, Checkbox, DropdownButton, EmptyState, FilterChips, ListView, useHotkeys, type ListColumn, type MenuItem } from '@/components';
import { openWindow } from '@/windows/windowStore';
import {
  accountLabel,
  actionsColumn,
  deleteBlocker,
  deleteRecord,
  isBalanceSheet,
  descendantIds,
  downloadExport,
  ListPage,
  ListSearchBox,
  matchesSearch,
  openAccountActivity,
  openRegister,
  openReport,
  plural,
  printList,
  runBulk,
  setRecordActive,
  useBulkSelect,
  useCreatedListener,
  useElementWidth,
  useRevealRow,
  useAutoSelect,
  useLocalState,
} from './common';

export interface ChartOfAccountsProps {
  /** Account to select when the window opens. */
  selectId?: number;
}

const GROUPS: { key: string; label: string; types: AccountType[] }[] = [
  { key: 'bank', label: 'Bank', types: ['Bank'] },
  { key: 'assets', label: 'Assets', types: ['Accounts Receivable', 'Other Current Asset', 'Fixed Asset', 'Other Asset'] },
  { key: 'liab', label: 'Liabilities', types: ['Accounts Payable', 'Credit Card', 'Other Current Liability', 'Long Term Liability'] },
  { key: 'equity', label: 'Equity', types: ['Equity'] },
  { key: 'income', label: 'Income', types: ['Income', 'Other Income'] },
  { key: 'expenses', label: 'Expenses', types: ['Cost of Goods Sold', 'Expense', 'Other Expense'] },
];

const SPECIAL_LABEL: Record<string, string> = {
  AccountsReceivable: 'System',
  AccountsPayable: 'System',
  UndepositedFunds: 'System',
  OpeningBalanceEquity: 'System',
  RetainedEarnings: 'System',
  SalesTaxPayable: 'System',
  InventoryAsset: 'System',
  CostOfGoodsSold: 'System',
  UncategorizedIncome: 'System',
  UncategorizedExpenses: 'System',
  AskMyAccountant: 'System',
};

const isBS = (a: Account) => isBalanceSheet(a);

export default function ChartOfAccounts(props: ChartOfAccountsProps) {
  const prefs = usePrefValues();
  const { data, isLoading, error, refetch } = useAccounts({ active: 'all' });
  const [q, setQ] = useState('');
  const [group, setGroup] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useLocalState('sx.fl.coa.inactive', false);
  const [flat, setFlat] = useLocalState('sx.fl.coa.flat', false);
  const [selId, setSelId] = useState<ID | null>(props.selectId ?? null);
  const rootRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(rootRef);

  useEffect(() => {
    if (props.selectId) {
      setSelId(props.selectId);
      reveal(props.selectId);
    }
  }, [props.selectId]); // eslint-disable-line react-hooks/exhaustive-deps
  useCreatedListener('account', (d) => {
    setSelId(d.id);
    setQ('');
    setGroup(null);
    reveal(d.id);
  });

  const all = data ?? [];
  const base = useMemo(() => (showInactive ? all : all.filter((a) => a.active)), [all, showInactive]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const g of GROUPS) c[g.key] = base.filter((a) => g.types.includes(a.type)).length;
    return c;
  }, [base]);
  const searching = q.trim() !== '';
  const rows = useMemo(() => {
    const g = GROUPS.find((x) => x.key === group);
    return base.filter((a) => (!g || g.types.includes(a.type)) && (!searching || matchesSearch(q, a.fullName, a.number, a.description, a.type)));
  }, [base, group, q, searching]);
  const treeMode = !flat && !searching;

  const reveal = useRevealRow(rootRef, rows, (r) => r.id);
  const sel = rows.find((a) => a.id === selId) ?? null;
  useAutoSelect(rows, sel, (r) => setSelId(r.id), reveal.pending);

  const bulk = useBulkSelect<Account>(rows, (a) => a.id, (a) => a.fullName);
  const childrenOf = (a: Account) => descendantIds(all, a.id).size - 1;

  // ---- actions
  const newAccount = (extra: Record<string, unknown> = {}) => openWindow('accountEdit', extra);
  const edit = (a: Account | null = sel) => a && openWindow('accountEdit', { id: a.id });
  const del = (a: Account | null = sel) =>
    a &&
    deleteRecord({
      what: 'account',
      name: a.fullName,
      blocked: deleteBlocker('account', a.fullName, { special: a.special !== '', children: childrenOf(a), hasTxns: a.hasTxns, childWord: 'subaccounts' }),
      request: () => api.del(`/accounts/${a.id}`),
      makeInactive: () => api.put(`/accounts/${a.id}/active`, { active: false }),
    });
  const toggleActive = (a: Account | null = sel) =>
    a &&
    setRecordActive({
      what: 'account',
      name: a.fullName,
      active: !a.active,
      childCount: a.active ? childrenOf(a) : 0,
      childWord: 'subaccounts',
      request: () => api.put(`/accounts/${a.id}/active`, { active: !a.active }),
    });
  const activate = (a: Account) => (isBS(a) ? openRegister(a) : openAccountActivity(a));
  const activityReport = (a: Account | null = sel) => a && openAccountActivity(a);
  const register = (a: Account | null = sel) => {
    if (!a) return false;
    if (isBS(a)) openRegister(a);
    else openAccountActivity(a);
  };

  const print = () =>
    printList(
      'Chart of Accounts',
      [{ label: 'Name' }, { label: 'Type' }, { label: 'Balance Total', align: 'right' }, { label: 'Description' }],
      rows.map((a) => ({
        cells: [accountLabel(a, prefs, !treeMode), a.type, isBS(a) ? fmtMoney(a.balance) : '', a.description],
        level: treeMode ? a.level : 0,
        inactive: !a.active,
      })),
    );

  const exportSelected = () => {
    const list = rows.filter((a) => bulk.selected.has(a.id));
    downloadCsv('accounts-selected', [['Name', 'Number', 'Type', 'Balance Total', 'Description', 'Active'], ...list.map((a) => [a.fullName, a.number, a.type, isBS(a) ? a.balance : '', a.description, a.active ? 'Yes' : 'No'])]);
  };

  useHotkeys({
    'ctrl+e': () => (sel ? void edit() : false),
    'ctrl+d': () => (sel ? void del() : false),
    'ctrl+q': () => (sel ? void activityReport() : false),
    'ctrl+r': () => (sel ? void register() : false),
  });

  // ---- menus
  const bankLike = sel && (sel.type === 'Bank' || sel.type === 'Credit Card');
  const accountMenu: MenuItem[] = [
    { label: '&New', onClick: () => newAccount() },
    { label: '&Edit Account', shortcut: 'Ctrl+E', disabled: !sel, onClick: () => edit() },
    { label: '&Delete Account', shortcut: 'Ctrl+D', disabled: !sel, onClick: () => void del() },
    { label: sel && !sel.active ? 'Make Account &Active' : 'Make Account &Inactive', disabled: !sel, onClick: () => void toggleActive() },
    { label: 'New &Subaccount', disabled: !sel || sel.type === 'Non-Posting', onClick: () => sel && newAccount({ parentId: sel.id, type: sel.type }) },
    { separator: true },
    { label: 'Show Inacti&ve Accounts', checked: showInactive, onClick: () => setShowInactive(!showInactive) },
    { label: '&Hierarchical View', checked: !flat, onClick: () => setFlat(false) },
    { label: '&Flat View', checked: flat, onClick: () => setFlat(true) },
    { separator: true },
    { label: '&Open Register', shortcut: 'Ctrl+R', disabled: !sel || !isBS(sel), onClick: () => sel && openRegister(sel) },
    { label: 'Find &Transactions in Account...', disabled: !sel, onClick: () => sel && openWindow('find', { advanced: true, accountId: sel.id }) },
    { separator: true },
    { label: '&Print List...', onClick: () => void print() },
    { label: 'I&mport from CSV...', onClick: () => openWindow('importData', { entity: 'accounts' }) },
    { label: 'E&xport to CSV', onClick: () => void downloadExport('accounts') },
  ];
  const activitiesMenu: MenuItem[] = [
    { label: '&Write Checks', onClick: () => openWindow('writeCheck', sel?.type === 'Bank' ? { accountId: sel.id } : {}) },
    { label: 'Make &Deposits', onClick: () => openWindow('makeDeposit', sel?.type === 'Bank' ? { accountId: sel.id } : {}) },
    { label: '&Transfer Funds', onClick: () => openWindow('transferFunds') },
    { label: 'Make General &Journal Entries', onClick: () => openWindow('journalEntry') },
    { label: 'Enter &Credit Card Charges', onClick: () => openWindow('ccCharge', sel?.type === 'Credit Card' ? { accountId: sel.id } : {}) },
    { separator: true },
    { label: '&Reconcile', onClick: () => openWindow('reconcileBegin', bankLike && sel ? { accountId: sel.id } : {}) },
    { label: '&Open Register', disabled: !sel || !isBS(sel), onClick: () => sel && openRegister(sel) },
  ];
  const reportsMenu: MenuItem[] = [
    { label: sel ? `&Activity Report: ${sel.name}` : '&Activity Report', shortcut: 'Ctrl+Q', disabled: !sel, onClick: () => activityReport() },
    { separator: true },
    { label: '&Account Listing', onClick: () => openReport('account_listing') },
    { label: '&Profit && Loss Standard', onClick: () => openReport('profit_loss') },
    { label: '&Balance Sheet', onClick: () => openReport('balance_sheet') },
    { label: '&Trial Balance', onClick: () => openReport('trial_balance') },
    { label: '&General Ledger', onClick: () => openReport('general_ledger') },
  ];
  const rowMenu = (a: Account | null): MenuItem[] => {
    if (!a) return [{ label: '&New Account', onClick: () => newAccount() }];
    const bs = isBS(a);
    return [
      { label: bs ? '&Open Register' : '&Activity Report', onClick: () => activate(a) },
      ...(bs ? [{ label: '&Activity Report', shortcut: 'Ctrl+Q', onClick: () => openAccountActivity(a) }] : []),
      { separator: true },
      { label: '&New Account', onClick: () => newAccount() },
      { label: 'New &Subaccount', onClick: () => newAccount({ parentId: a.id, type: a.type }) },
      { label: '&Edit Account', shortcut: 'Ctrl+E', onClick: () => edit(a) },
      { label: '&Delete Account', shortcut: 'Ctrl+D', onClick: () => void del(a) },
      { label: a.active ? 'Make Account &Inactive' : 'Make Account &Active', onClick: () => void toggleActive(a) },
      ...(a.type === 'Bank' || a.type === 'Credit Card'
        ? [{ separator: true }, { label: '&Reconcile', onClick: () => openWindow('reconcileBegin', { accountId: a.id }) }]
        : []),
      ...(a.type === 'Bank' ? [{ label: '&Write Checks', onClick: () => openWindow('writeCheck', { accountId: a.id }) }] : []),
    ];
  };

  // ---- columns
  const wide = width >= 980;
  const roomy = width >= 740;
  const columns: ListColumn<Account>[] = [
    bulk.column,
    {
      key: 'name',
      label: 'Name',
      width: 260,
      grow: true,
      sortValue: (a) => accountLabel(a, prefs, true),
      render: (a) => (
        <span className="fl-name-cell">
          <span className="fl-name-text">
            {prefs.useAccountNumbers && a.number && <span className="fl-num">{a.number} · </span>}
            {treeMode ? a.name : a.fullName}
          </span>
          {a.special && SPECIAL_LABEL[a.special] && (
            <span className="fl-tag" title="SerieX Books uses this account for special purposes. It cannot be deleted.">
              {SPECIAL_LABEL[a.special]}
            </span>
          )}
        </span>
      ),
    },
    { key: 'type', label: 'Type', width: 170 },
    {
      key: 'balance',
      label: 'Balance Total',
      width: 130,
      align: 'right',
      sortValue: (a) => (isBS(a) ? a.balance : null),
      render: (a) => (isBS(a) ? <span className="fl-money">{fmtMoney(a.balance)}</span> : ''),
    },
    ...(wide ? [{ key: 'description', label: 'Description', width: 220, render: (a: Account) => <span title={a.description}>{a.description}</span> } as ListColumn<Account>] : []),
    ...(roomy
      ? [
          actionsColumn<Account>(
            (a) => [
              isBS(a) ? { label: 'Register', onClick: () => openRegister(a), title: 'Open the register (Ctrl+R)' } : { label: 'Activity Report', onClick: () => openAccountActivity(a), title: 'Account Activity (Ctrl+Q)' },
              { label: 'Edit', onClick: () => edit(a), title: 'Edit account (Ctrl+E)' },
            ],
            156,
          ),
        ]
      : []),
  ];

  const total = showInactive ? all.length : all.filter((a) => a.active).length;
  const status = rows.length === total ? plural(total, 'account') : `${rows.length.toLocaleString('en-US')} of ${plural(total, 'account')}`;
  const selRecords = rows.filter((a) => bulk.selected.has(a.id));

  return (
    <ListPage
      rootRef={rootRef}
      toolbar={<ListSearchBox value={q} onChange={setQ} placeholder="Search accounts" aria-label="Search accounts" />}
      filters={
        <FilterChips
            aria-label="Account type"
            allLabel="All"
            value={group}
            onChange={setGroup}
            options={GROUPS.map((g) => ({ key: g.key, label: g.label, count: counts[g.key] }))}
          />
      }
      actions={
        <Button variant="primary" icon={Plus} label="New account" onClick={() => newAccount()} />
      }
      bulk={
        bulk.count > 0 ? (
          <div className="fl-bulkbar" role="toolbar" aria-label="Selected accounts">
            <span className="fl-bulkbar-text">{plural(bulk.count, 'account')} selected</span>
            <Button
              small
              label="Make inactive"
              onClick={() =>
                void runBulk(selRecords.filter((a) => a.active), (a) => a.fullName, (a) => api.put(`/accounts/${a.id}/active`, { active: false }), (n) => `${plural(n, 'account')} made inactive`).then(bulk.clear)
              }
            />
            <Button
              small
              label="Make active"
              onClick={() =>
                void runBulk(selRecords.filter((a) => !a.active), (a) => a.fullName, (a) => api.put(`/accounts/${a.id}/active`, { active: true }), (n) => `${plural(n, 'account')} made active`).then(bulk.clear)
              }
            />
            <Button small label="Export to CSV" onClick={exportSelected} />
            <Button small variant="ghost" label="Clear selection" onClick={bulk.clear} />
          </div>
        ) : null
      }
      footer={
        <>
          <DropdownButton label="Acc&ount" items={accountMenu} up />
          <DropdownButton label="Ac&tivities" items={activitiesMenu} up />
          <DropdownButton label="Re&ports" items={reportsMenu} up />
          <Checkbox checked={showInactive} onChange={setShowInactive} label="Include inactive" style={{ marginLeft: 8 }} />
        </>
      }
      status={data ? status : undefined}
    >
      {error ? (
        <div className="fl-emptywrap">
          <EmptyState icon={ListTree} title="The chart of accounts could not be loaded" message={(error as Error).message} action={{ label: 'Try again', onClick: () => void refetch() }} />
        </div>
      ) : (
        <ListView<Account>
          className="fl-list"
          aria-label="Chart of accounts"
          columns={columns}
          rows={rows}
          loading={isLoading}
          selectedKey={sel?.id ?? null}
          onSelect={(k) => setSelId(k as ID)}
          onActivate={activate}
          contextMenu={rowMenu}
          getLevel={treeMode ? (a) => a.level : undefined}
          indentKey="name"
          isInactive={(a) => !a.active}
          showInactiveColumn={showInactive}
          persistKey="fl-coa"
          autoFocus
          emptyText={searching || group ? 'No accounts match your search. Clear the search or pick another type.' : 'No accounts yet.'}
          onKeyDown={(e) => bulk.onListKeyDown(e, sel)}
        />
      )}
    </ListPage>
  );
}
