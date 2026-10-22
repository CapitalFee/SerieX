// Open a Register: pick a balance sheet account and open its register.
import { useMemo, useState } from 'react';
import { useAccounts, usePrefValues } from '@/api/hooks';
import type { ID } from '@/api/types';
import { AccountPicker, EditDialog, Field, useFormErrors } from '@/components';
import { openWindow } from '@/windows/windowStore';
import { useWindow } from '@/windows/WindowContext';
import { REGISTER_TYPES } from './shared';
import './banking.css';

export interface UseRegisterDialogProps {}

const LAST_KEY = 'sx.bk.lastRegister';

function readLast(): ID | null {
  try {
    const v = Number(localStorage.getItem(LAST_KEY));
    return v > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Opens the register of an account (and remembers it for the Open a Register dialog). */
export function openRegister(accountId: ID, accountName?: string, selectTxnId?: ID) {
  try {
    localStorage.setItem(LAST_KEY, String(accountId));
  } catch {
    /* ignore */
  }
  openWindow('register', { accountId, accountName, selectTxnId }, accountName ? { title: accountName } : {});
}

export default function UseRegisterDialog(_props: UseRegisterDialogProps) {
  const win = useWindow();
  const prefs = usePrefValues();
  const { data: accounts } = useAccounts({ active: 'all' });
  const fe = useFormErrors();
  // the default is computed while rendering, so pressing Enter right away opens it
  const defaultId = useMemo<ID | null>(() => {
    if (!accounts) return null;
    const ok = (id: ID | null | undefined) => !!id && accounts.some((a) => a.id === id && REGISTER_TYPES.includes(a.type));
    const last = readLast();
    return ok(last) ? last : ok(prefs.defaultCheckAccountId) ? prefs.defaultCheckAccountId : accounts.find((a) => a.active && a.type === 'Bank')?.id ?? null;
  }, [accounts, prefs.defaultCheckAccountId]);
  const [picked, setPicked] = useState<ID | null | undefined>(undefined);
  const accountId = picked === undefined ? defaultId : picked;

  const ok = async () => {
    const a = accounts?.find((x) => x.id === accountId);
    if (!a) {
      fe.setFieldError('accountId', 'Choose the account whose register you want to open.');
      return;
    }
    await win.close(true);
    openRegister(a.id, a.fullName);
  };

  return (
    <EditDialog title="Open a Register" errors={fe} onOk={ok} okLabel="Open register">
      <Field label="Select account" htmlFor="bk-usereg-acct" help="Registers list every transaction of a bank, credit card, asset, liability or equity account with its running balance.">
        <AccountPicker id="bk-usereg-acct" name="accountId" types={REGISTER_TYPES} value={accountId} onChange={(id) => setPicked(id)} autoFocus addNew={false} />
      </Field>
    </EditDialog>
  );
}
