// Other lists of the Lists menu: sales reps, customer
// types, vendor types, job types, terms, customer messages, payment methods, ship via.
import type { ListName } from '@/api/types';
import type { MenuItem } from '@/components';
import { openReport } from './common';
import { SimpleListWindow } from './SimpleList';

export interface ProfileListProps {
  list: ListName;
  selectId?: number;
}

const REPORTS: Partial<Record<ListName, MenuItem[]>> = {
  terms: [{ label: '&Terms Listing', onClick: () => openReport('terms_listing') }],
  sales_rep: [
    { label: 'Sales by Rep &Summary', onClick: () => openReport('sales_by_rep_summary') },
    { label: 'Sales by Rep &Detail', onClick: () => openReport('sales_by_rep_detail') },
  ],
  customer_type: [
    { label: 'Customer &Contact List', onClick: () => openReport('customer_contact_list') },
    { label: 'Sales by &Customer Summary', onClick: () => openReport('sales_by_customer_summary') },
  ],
  vendor_type: [{ label: 'Vendor &Contact List', onClick: () => openReport('vendor_contact_list') }],
  job_type: [{ label: '&Job Profitability Summary', onClick: () => openReport('job_profitability_summary') }],
};

export default function ProfileList(props: ProfileListProps) {
  const list: ListName = props.list ?? 'terms';
  return <SimpleListWindow key={list} list={list} selectId={props.selectId} reports={REPORTS[list] ? () => REPORTS[list]! : undefined} />;
}
