// Check face of the Paycheck and Tax Payment windows (same layout as the SerieX Books
// Write Checks form):
//
//   FormFrame title="Paycheck"  titleRight={<CheckAccountBar bankAccount={…} endingBalance={…} />}
//            header={<CheckFace number={…} date={…} payee={…} amount={…} address={…} memo={…} />}
//
//   ┌────────────────────────────────────────────── NO. [1001]   DATE [10/23/2026] ┐
//   │ PAY TO THE ORDER OF [payee .......................]  $ [   1,905.59]           │
//   │ One thousand nine hundred five and 59/100 ·························· DOLLARS   │
//   │ ADDRESS                                                                        │
//   │ [box               ]          MEMO [..........................]               │
//   └────────────────────────────────────────────────────────────────────────────────┘
//
// Fields are slots: the module passes its own controls (pickers, date field...) or plain text
// when read-only. `address` may be text (shown in a read-only address box) or a control.
import type { CSSProperties, ReactNode } from 'react';
import { fmtMoney } from '@/util/format';
import { amountInWords } from '@/util/words';
import { AddressBlock } from '@/components/inputs';
import { Stamp, type StampKind } from './parts';

/** Props of {@link CheckAccountBar}. */
export interface CheckAccountBarProps {
  /** Bank account control (AccountPicker types={['Bank']} width={250}) or its name. */
  bankAccount: ReactNode;
  /** Ending balance of the bank account (red when negative; blank when null). */
  endingBalance?: number | null;
  /** Label of the account field (default "BANK ACCOUNT"). */
  label?: string;
  /** id of the account control (for the label). */
  htmlFor?: string;
}

/** BANK ACCOUNT + ENDING BALANCE at the right of the form title (FormFrame `titleRight`), like SerieX Books checks. */
export function CheckAccountBar({ bankAccount, endingBalance, label = 'BANK ACCOUNT', htmlFor }: CheckAccountBarProps) {
  return (
    <div className="sxp-acctbar">
      <div className="sxp-acctbar-field">
        <label className="sx-label" htmlFor={htmlFor}>
          {label}
        </label>
        {bankAccount}
      </div>
      {endingBalance !== undefined && (
        <div className="sxp-acctbar-bal">
          <span className="sx-label">ENDING BALANCE</span>
          <span className={'sxp-bal' + ((endingBalance ?? 0) < 0 ? ' sxp-neg' : '')}>{endingBalance === null ? '' : fmtMoney(endingBalance)}</span>
        </div>
      )}
    </div>
  );
}

/** Props of {@link CheckFace}. */
export interface CheckFaceProps {
  /**
   * Bank account control or name. Prefer {@link CheckAccountBar} in the FormFrame title row (the
   * SerieX Books layout); when given here the account bar is drawn above the check instead.
   */
  bankAccount?: ReactNode;
  /** Ending balance shown with `bankAccount`. */
  endingBalance?: number | null;
  /** Check number control or text ("To Print", "DD123"). */
  number?: ReactNode;
  /** Date control or text. */
  date?: ReactNode;
  /** Payee control or name ("PAY TO THE ORDER OF"). */
  payee?: ReactNode;
  /** Amount shown right of the "$" (a number, or a control). */
  amount?: number | ReactNode;
  /** Amount used for the words line (default: `amount` when it is a number). */
  wordsAmount?: number | null;
  /** Address: text with "\n" (read-only box) or a control (AddressBlock). */
  address?: string | ReactNode;
  /** Memo control or text. */
  memo?: ReactNode;
  /** Diagonal stamp over the check (e.g. VOID). */
  stamp?: StampKind | null;
  /** Content under the check (e.g. "Posted to SerieX Books" status). */
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/** Plain text slots are shown like a read-only field. */
function slot(v: ReactNode, cls: string) {
  return typeof v === 'string' || typeof v === 'number' ? <span className={'sxp-cf-text ' + cls}>{v}</span> : v;
}

/** The check of a paycheck or tax payment. */
export function CheckFace({ bankAccount, endingBalance, number, date, payee, amount, wordsAmount, address, memo, stamp, children, className, style }: CheckFaceProps) {
  const numeric = typeof amount === 'number' ? amount : null;
  const words = wordsAmount ?? numeric;
  return (
    <div className={'sxp-checkface-wrap' + (className ? ' ' + className : '')} style={style}>
      {bankAccount !== undefined && <CheckAccountBar bankAccount={bankAccount} endingBalance={endingBalance} />}
      <div className="sxp-checkface">
        {stamp && <Stamp kind={stamp} />}
        <div className="sxp-cf-top">
          <div className="sxp-cf-num">
            <span className="sxp-cf-label">NO.</span>
            <div>{slot(number, 'sxp-cf-numtext')}</div>
          </div>
          <div className="sxp-cf-date">
            <span className="sxp-cf-label">DATE</span>
            <div>{slot(date, 'sxp-cf-datetext')}</div>
          </div>
        </div>
        <div className="sxp-cf-pay">
          <span className="sxp-cf-label sxp-cf-label-2">
            PAY TO THE
            <br />
            ORDER OF
          </span>
          <div className="sxp-cf-payee">{slot(payee, 'sxp-cf-payeetext')}</div>
          <span className="sxp-cf-dollar">$</span>
          <div className="sxp-cf-amount">{numeric !== null ? <span className="sxp-cf-text sxp-cf-amounttext">{fmtMoney(numeric)}</span> : amount}</div>
        </div>
        <div className="sxp-cf-words">
          <span className="sxp-cf-words-text">{words !== null && words !== undefined ? amountInWords(words) : ''}</span>
          <span className="sxp-cf-stars" aria-hidden="true" />
          <span className="sxp-cf-label">DOLLARS</span>
        </div>
        <div className="sxp-cf-bottom">
          <div className="sxp-cf-addr">
            <span className="sxp-cf-label">ADDRESS</span>
            {typeof address === 'string' || address === undefined || address === null ? (
              <AddressBlock value={address ?? ''} rows={4} readOnly aria-label="Address" />
            ) : (
              address
            )}
          </div>
          <div className="sxp-cf-memo">
            <span className="sxp-cf-label">MEMO</span>
            <div>{slot(memo, 'sxp-cf-memotext')}</div>
          </div>
        </div>
      </div>
      {children}
    </div>
  );
}
