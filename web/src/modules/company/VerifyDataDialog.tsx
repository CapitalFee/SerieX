// Check Company File / Repair Company File (File > Utilities).
// Check looks at the company file (unbalanced transactions, open balances that do not match their
// payments, inventory values, orphan rows); Repair recomputes every posting from the transactions.
import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ShieldCheck, Wrench } from 'lucide-react';
import { api } from '@/api/client';
import { invalidateAll } from '@/api/hooks';
import { Button, Spinner, toast } from '@/components';
import { useOptionalWindow } from '@/windows/WindowContext';
import { openWindow } from '@/windows/windowStore';
import './company.css';

export interface VerifyDataDialogProps {
  /** Repair the company file instead of only checking it. */
  rebuild?: boolean;
}

type State =
  { step: 'ready' } | { step: 'running'; what: string } | { step: 'done'; problems: string[]; rebuilt: boolean } | { step: 'error'; message: string };

export default function VerifyDataDialog({ rebuild }: VerifyDataDialogProps) {
  const win = useOptionalWindow();
  const [state, setState] = useState<State>({ step: 'ready' });

  useEffect(() => {
    win?.setTitle(rebuild ? 'Repair Company File' : 'Check Company File');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rebuild]);

  const verify = async (rebuilt: boolean) => {
    setState({ step: 'running', what: 'Checking your data...' });
    const r = await api.post<{ ok: boolean; problems: string[] }>('/verify');
    setState({ step: 'done', problems: r.problems ?? [], rebuilt });
  };

  const run = async () => {
    try {
      if (rebuild) {
        setState({ step: 'running', what: 'Repairing your company file. This can take a moment...' });
        await api.post('/rebuild');
        void invalidateAll();
        toast('Data rebuilt');
        await verify(true);
      } else await verify(false);
    } catch (e) {
      setState({ step: 'error', message: (e as Error).message || 'The check could not be completed.' });
    }
  };

  const running = state.step === 'running';
  return (
    <div className="cx-dlg">
      <div className="cx-dlg-body">
        {state.step === 'ready' && (
          <div className="cx-stack">
            <div className="cx-bigstatus">
              {rebuild ? <Wrench size={22} color="#d97706" /> : <ShieldCheck size={22} color="#2563eb" />}
              {rebuild ? 'Repair your company file' : 'Check your company file for problems'}
            </div>
            {rebuild ? (
              <p className="cx-intro" style={{ margin: 0 }}>
                Repair recalculates every posting, open balance and inventory value from your transactions. Your transactions are not changed. It is a good
                idea to{' '}
                <button type="button" className="sx-linkbtn" onClick={() => openWindow('backupCompany')}>
                  back up the company
                </button>{' '}
                first.
              </p>
            ) : (
              <p className="cx-intro" style={{ margin: 0 }}>
                The check looks for transactions that do not balance, open balances that do not match their payments, inventory values that do not match the
                inventory account, and damaged records. Nothing is changed.
              </p>
            )}
          </div>
        )}
        {running && (
          <div style={{ paddingTop: 30, display: 'grid', placeItems: 'center' }}>
            <Spinner label={state.what} />
          </div>
        )}
        {state.step === 'done' &&
          (state.problems.length === 0 ? (
            <div className="cx-note cx-ok">
              <CheckCircle2 size={18} />
              <div>
                <b>{state.rebuilt ? 'The repair has finished.' : 'No problems found.'}</b>
                <div>{state.rebuilt ? 'Your data was rebuilt and checked: there are no problems.' : 'Your company data has no problems.'}</div>
              </div>
            </div>
          ) : (
            <>
              <div className="cx-note cx-warn">
                <AlertTriangle size={18} />
                <div>
                  <b>
                    {state.problems.length} problem{state.problems.length === 1 ? '' : 's'} found.
                  </b>
                  <div>
                    {rebuild
                      ? 'Some problems remain after the repair. Review the transactions listed below.'
                      : 'Run Repair Company File to fix them; problems that remain after a repair need a closer look.'}
                  </div>
                </div>
              </div>
              <ul className="cx-problems">
                {state.problems.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </>
          ))}
        {state.step === 'error' && (
          <div className="cx-note cx-bad">
            <AlertTriangle size={18} />
            <div>{state.message}</div>
          </div>
        )}
      </div>
      <div className="cx-dlg-foot">
        <span className="cx-grow" />
        {state.step === 'done' && !rebuild && state.problems.length > 0 && (
          <Button
            label="Repair Company File..."
            onClick={() => {
              void win?.close(true).then(() => openWindow('verifyData', { rebuild: true }));
            }}
          />
        )}
        {state.step === 'done' || state.step === 'error' ? (
          <Button variant="primary" label="Close" autoFocus onClick={() => void win?.close()} />
        ) : (
          <>
            <Button label="Cancel" disabled={running} onClick={() => void win?.close()} />
            <Button variant="primary" autoFocus label={rebuild ? 'Repair' : 'Check'} busy={running} onClick={() => void run()} />
          </>
        )}
      </div>
    </div>
  );
}
