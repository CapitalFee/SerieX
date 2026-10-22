// "Paycheck Details": the details of a saved paycheck in its own window. OK saves the
// paycheck (PUT /paychecks/{id} with the previewed lines; the SerieX Books check is replaced),
// Cancel closes without saving.
import { useEffect, useRef } from 'react';
import { api } from '@/api/client';
import { usePaycheck } from '@/api/hooks';
import type { Paycheck } from '@/api/types';
import { EmptyState, Spinner, confirmBox, toast } from '@/components';
import { useWindow } from '@/windows/WindowContext';
import { PaycheckDetail } from './PaycheckDetail';
import { afterPaycheckSaved, sendableLines, showError, showPostingProblems, toInput } from './shared';
import './payroll.css';

export interface PaycheckDetailWindowProps {
  /** Saved paycheck. */
  id: number;
}

export default function PaycheckDetailWindow(props: PaycheckDetailWindowProps) {
  const win = useWindow();
  const { data: pc, isLoading, error } = usePaycheck(props.id);
  const dirtyRef = useRef(false);

  useEffect(() => {
    win.setTitle(pc ? `Paycheck Details - ${pc.employeeName}` : 'Paycheck Details');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pc?.employeeName]);
  useEffect(() => {
    win.setBeforeClose(async () => !dirtyRef.current || (await confirmBox('Close without saving your changes to this paycheck?', 'Paycheck Details')));
    return () => win.setBeforeClose(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (isLoading) return <Spinner center label="Loading paycheck…" />;
  if (error || !pc) return <EmptyState title="Paycheck not found" message={error instanceof Error ? error.message : 'This paycheck no longer exists.'} />;
  if (pc.voided || pc.kind === 'ytd') {
    return (
      <EmptyState
        title={pc.voided ? 'This paycheck is void' : 'Year-to-date amounts'}
        message={pc.voided ? 'A void paycheck has no amounts and cannot be changed.' : 'Year-to-date amounts are changed with Enter Year-to-Date Amounts.'}
      />
    );
  }

  const save = async (edited: Paycheck): Promise<boolean> => {
    try {
      // Recalculate when an earnings line or another payroll item changed; otherwise every amount
      // stays as saved (a typed tax only changes that tax and the net pay)
      const saved = await api.put<Paycheck>(`/paychecks/${pc.id}`, { ...toInput(edited), id: pc.id, lines: sendableLines(edited.lines), recalculate: edited.recalculate });
      afterPaycheckSaved(saved);
      toast(`Paycheck to ${saved.employeeName} saved`, { kind: 'success' });
      if (saved.syncStatus === 'error')
        await showPostingProblems([{ entity: 'paycheck', id: saved.id, label: `Paycheck - ${saved.employeeName}`, code: 'error', message: saved.syncError }], 'The paycheck is saved, but SerieX Books reported a problem:');
      return true;
    } catch (e) {
      await showError(e, 'Paycheck Details');
      return false;
    }
  };

  return (
    <div className="py-detail-win">
      <PaycheckDetail
        key={pc.updatedAt}
        mode="saved"
        paycheck={pc}
        onDirtyChange={(d) => {
          dirtyRef.current = d;
          win.setDirty(d);
        }}
        onDone={async (action, edited, changed) => {
          if (action === 'cancel' || !edited) {
            dirtyRef.current = false;
            await win.close(true);
            return;
          }
          if (changed && !(await save(edited))) return false;
          dirtyRef.current = false;
          win.setDirty(false);
          await win.close(true);
        }}
      />
    </div>
  );
}
