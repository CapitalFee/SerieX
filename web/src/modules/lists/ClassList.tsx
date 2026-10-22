// Class List (Lists > Class List). Classes tag transactions so income and expenses can be reported
// by department, location or business line (Profit and Loss by Class).
import { usePrefValues } from '@/api/hooks';
import { openWindow } from '@/windows/windowStore';
import { openReport } from './common';
import { ListNotice, SimpleListWindow } from './SimpleList';

export interface ClassListProps {
  selectId?: number;
}

export default function ClassList(props: ClassListProps) {
  const prefs = usePrefValues();
  return (
    <SimpleListWindow
      list="class"
      selectId={props.selectId}
      notice={
        !prefs.useClassTracking ? (
          <ListNotice action={{ label: 'Open Preferences', onClick: () => openWindow('preferences', { section: 'accounting' }) }}>
            Class tracking is turned off, so transactions do not show a CLASS field. Turn it on in Preferences &gt; Accounting.
          </ListNotice>
        ) : undefined
      }
      reports={(sel) => [
        {
          label: sel ? `&Activity Report: ${sel.name}` : '&Activity Report',
          disabled: !sel,
          onClick: () => sel && openReport('profit_loss_detail', { classIds: String(sel.id), dates: 'thisFiscalYearToDate' }, `Class Activity: ${sel.fullName}`),
        },
        { separator: true },
        { label: 'Profit && Loss by &Class', onClick: () => openReport('profit_loss_by_class') },
        { label: 'Profit and Loss: &No Class', onClick: () => openReport('profit_loss_unclassified') },
      ]}
    />
  );
}
