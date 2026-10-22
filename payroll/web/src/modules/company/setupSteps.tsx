// Steps of the Payroll Setup interview and the left step rail shared by its first page (a
// dialog shown before the payroll file exists) and the Payroll Setup window (the other steps).
import { Building2, CalendarClock, Check, FileCheck2, FolderPlus, History, Landmark, ListChecks, Users, type LucideIcon } from 'lucide-react';

/** One step of the Payroll Setup interview. */
export interface SetupStep {
  key: SetupStepKey;
  label: string;
  icon: LucideIcon;
}

export type SetupStepKey = 'file' | 'company' | 'state' | 'schedules' | 'items' | 'employees' | 'ytd' | 'review';

export const SETUP_STEPS: SetupStep[] = [
  { key: 'file', label: 'Payroll file', icon: FolderPlus },
  { key: 'company', label: 'Company info', icon: Building2 },
  { key: 'state', label: 'State taxes', icon: Landmark },
  { key: 'schedules', label: 'Pay schedules', icon: CalendarClock },
  { key: 'items', label: 'Payroll items', icon: ListChecks },
  { key: 'employees', label: 'Employees', icon: Users },
  { key: 'ytd', label: 'Year-to-date pay', icon: History },
  { key: 'review', label: 'Review and finish', icon: FileCheck2 },
];

/** Props of {@link SetupRail}. */
export interface SetupRailProps {
  /** Index of the current step. */
  current: number;
  /** Steps already done (checked). */
  done: (key: SetupStepKey, index: number) => boolean;
  /** Called when a step is clicked (omit to make the rail read-only). */
  onGo?: (index: number) => void;
  /** Steps that cannot be clicked. */
  disabled?: (key: SetupStepKey, index: number) => boolean;
  footer?: React.ReactNode;
}

/** The left step list of the Payroll Setup interview (same look as the SerieX Books setup wizards). */
export function SetupRail({ current, done, onGo, disabled, footer }: SetupRailProps) {
  return (
    <nav className="cx-wiz-rail" aria-label="Payroll Setup steps">
      <div className="cx-wiz-railtitle">Payroll Setup</div>
      {SETUP_STEPS.map((s, i) => {
        const Icon = s.icon;
        const isDone = done(s.key, i);
        return (
          <button
            key={s.key}
            type="button"
            data-step={s.key}
            className={'cx-wiz-step' + (i === current ? ' cx-on' : '') + (isDone ? ' cx-done' : '')}
            onClick={() => onGo?.(i)}
            disabled={!onGo || !!disabled?.(s.key, i)}
            aria-current={i === current ? 'step' : undefined}
          >
            <span className="cx-wiz-num">{isDone && i !== current ? <Check size={13} /> : <Icon size={13} />}</span>
            {s.label}
          </button>
        );
      })}
      {footer && <div className="cx-wiz-railfoot cx-muted cx-small">{footer}</div>}
    </nav>
  );
}

/** Heading of a wizard page. */
export function WizHead({ title, sub }: { title: string; sub?: React.ReactNode }) {
  return (
    <div className="cx-wiz-head">
      <h2>{title}</h2>
      {sub && <div className="cx-muted">{sub}</div>}
    </div>
  );
}
