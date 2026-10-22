// Company > To Do List: notes with a due date, optionally about a customer, vendor or other name.
// Add / edit in a small dialog, tick them off as done, filter Open / Done / All.
import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckSquare, Pencil, Plus, Square, Trash2 } from 'lucide-react';
import { api } from '@/api/client';
import { invalidateAll, queryClient, useNames } from '@/api/hooks';
import type { ID, Name, Todo } from '@/api/types';
import {
  Checkbox,
  DateField,
  EmptyState,
  ErrorBanner,
  Field,
  FilterChips,
  FormErrorsProvider,
  ListView,
  NamePicker,
  SearchBox,
  TextArea,
  TextField,
  Toolbar,
  ToolbarButton,
  ToolbarSpacer,
  confirmBox,
  showDialog,
  toast,
  useFormErrors,
  type ListColumn,
} from '@/components';
import { fmtDate } from '@/util/format';
import { todayIso } from '@/util/dates';
import { useTodos } from './shared';
import './company.css';

export interface TodoListProps {
  /** Start a new to do about this name. */
  nameId?: number;
}

type Filter = 'open' | 'done' | 'all';

export default function TodoList({ nameId }: TodoListProps) {
  const q = useTodos();
  const names = useNames(undefined, { active: 'all' });
  const byId = useMemo(() => new Map<ID, Name>((names.data ?? []).map((n) => [n.id, n])), [names.data]);
  const [filter, setFilter] = useState<Filter>('open');
  const [text, setText] = useState('');
  const [sel, setSel] = useState<number | null>(null);
  const today = todayIso();

  const all = q.data ?? [];
  const rows = useMemo(() => {
    const t = text.trim().toLowerCase();
    return all
      .filter((x) => (filter === 'all' ? true : filter === 'done' ? x.done : !x.done))
      .filter((x) => !t || `${x.title} ${x.notes} ${x.nameId ? (byId.get(x.nameId)?.fullName ?? '') : ''}`.toLowerCase().includes(t))
      .sort((a, b) => Number(a.done) - Number(b.done) || (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || a.id - b.id);
  }, [all, filter, text, byId]);
  const selected = rows.find((r) => r.id === sel) ?? null;
  useEffect(() => {
    if (rows.length && (sel === null || !rows.some((r) => r.id === sel))) setSel(rows[0].id);
  }, [rows, sel]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['todos'] });
    void invalidateAll();
  };

  const edit = async (t: Todo | null) => {
    const saved = await showDialog<Todo | null>({
      title: t ? 'Edit To Do' : 'New To Do',
      cancelValue: null,
      render: (close) => <TodoForm todo={t} defaultNameId={nameId ?? null} onDone={close} />,
    });
    if (saved) {
      await refresh();
      setSel(saved.id);
      if (!t && filter === 'done') setFilter('open');
      toast(t ? 'To do saved' : 'To do added');
    }
  };

  const toggle = async (t: Todo) => {
    try {
      await api.put<Todo>(`/todos/${t.id}`, { ...t, done: !t.done });
      await refresh();
      if (!t.done) toast(`Done: ${t.title}`, { action: { label: 'Undo', onClick: () => void api.put(`/todos/${t.id}`, { ...t, done: false }).then(refresh) } });
    } catch (e) {
      toast((e as Error).message, { kind: 'error' });
    }
  };

  const remove = async (t: Todo) => {
    if (!(await confirmBox(`Delete the to do "${t.title}"?`, 'Delete To Do'))) return;
    try {
      await api.del(`/todos/${t.id}`);
      await refresh();
      toast('To do deleted', { kind: 'info' });
    } catch (e) {
      toast((e as Error).message, { kind: 'error' });
    }
  };

  // The default widths add up to 618px, so all columns fit the list of the floating window at its
  // default size (660px wide); To do, Name and Notes share any extra width.
  const columns: ListColumn<Todo>[] = [
    {
      key: 'done',
      label: 'Done',
      width: 56,
      align: 'center',
      sortValue: (r) => (r.done ? 1 : 0),
      render: (r) => (
        <button
          type="button"
          className="cx-todocheck"
          aria-label={r.done ? 'Mark as not done' : 'Mark as done'}
          title={r.done ? 'Mark as not done' : 'Mark as done'}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            void toggle(r);
          }}
        >
          {r.done ? <CheckSquare size={16} color="var(--sx-success)" /> : <Square size={16} />}
        </button>
      ),
    },
    { key: 'title', label: 'To do', width: 176, grow: true, render: (r) => <span className={r.done ? 'cx-strike' : undefined}>{r.title}</span> },
    {
      key: 'dueDate',
      label: 'Due date',
      width: 96,
      render: (r) => <span className={!r.done && r.dueDate && r.dueDate < today ? 'cx-tone-danger' : undefined}>{fmtDate(r.dueDate)}</span>,
    },
    {
      key: 'nameId',
      label: 'Name',
      width: 150,
      grow: true,
      sortValue: (r) => (r.nameId ? (byId.get(r.nameId)?.fullName ?? '') : ''),
      render: (r) => (r.nameId ? (byId.get(r.nameId)?.fullName ?? '') : ''),
    },
    { key: 'notes', label: 'Notes', width: 140, grow: true, render: (r) => <span className="cx-muted">{r.notes.replace(/\s+/g, ' ')}</span> },
  ];

  const counts = { open: all.filter((x) => !x.done).length, done: all.filter((x) => x.done).length, all: all.length };

  return (
    <div className="cx-todos">
      <Toolbar>
        <ToolbarButton label="New To Do" icon={Plus} variant="primary" onClick={() => void edit(null)} />
        <ToolbarButton label="Edit" icon={Pencil} disabled={!selected} onClick={() => selected && void edit(selected)} shortcut="Ctrl+E" />
        <ToolbarButton
          label={selected?.done ? 'Mark as not done' : 'Mark as done'}
          icon={CheckSquare}
          disabled={!selected}
          onClick={() => selected && void toggle(selected)}
        />
        <ToolbarButton label="Delete" icon={Trash2} disabled={!selected} onClick={() => selected && void remove(selected)} />
        <ToolbarSpacer />
        <SearchBox value={text} onChange={setText} placeholder="Find a to do" width={180} />
      </Toolbar>
      <div className="cx-todo-filter">
        <FilterChips
          value={filter}
          onChange={(v) => setFilter((v as Filter) ?? 'all')}
          options={[
            { key: 'open', label: 'Open', count: counts.open },
            { key: 'done', label: 'Done', count: counts.done },
            { key: 'all', label: 'All', count: counts.all },
          ]}
          aria-label="Show"
        />
      </div>
      <div className="cx-todo-list">
        {!q.isLoading && rows.length === 0 ? (
          <EmptyState
            icon={CheckSquare}
            title={filter === 'done' ? 'Nothing done yet' : all.length ? 'Nothing to do' : 'No to dos yet'}
            message="To dos remind you to call a customer, follow up on an estimate or renew a license. They also appear on the Home page and in Reminders."
            action={{ label: 'New To Do', onClick: () => void edit(null) }}
          />
        ) : (
          <ListView<Todo>
            columns={columns}
            rows={rows}
            loading={q.isLoading}
            selectedKey={sel}
            onSelect={(k) => setSel(Number(k))}
            onActivate={(r) => void edit(r)}
            isInactive={(r) => r.done}
            contextMenu={(r) =>
              r
                ? [
                    { label: '&Edit To Do...', onClick: () => void edit(r) },
                    { label: r.done ? 'Mark as &not done' : 'Mark as &done', onClick: () => void toggle(r) },
                    { separator: true },
                    { label: '&Delete', onClick: () => void remove(r) },
                  ]
                : [{ label: '&New To Do...', onClick: () => void edit(null) }]
            }
            onKeyDown={(e) => {
              if (!selected) return;
              if (e.key === ' ') {
                e.preventDefault();
                void toggle(selected);
              } else if (e.key === 'Delete') {
                e.preventDefault();
                void remove(selected);
              } else if (e.key.toLowerCase() === 'e' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void edit(selected);
              }
            }}
            persistKey="todos"
            aria-label="To dos"
          />
        )}
      </div>
    </div>
  );
}

function TodoForm({ todo, defaultNameId, onDone }: { todo: Todo | null; defaultNameId: ID | null; onDone: (t: Todo | null) => void }) {
  const fe = useFormErrors();
  const [rec, setRec] = useState<Todo>(todo ?? { id: 0, title: '', notes: '', dueDate: todayIso(), nameId: defaultNameId, done: false });
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLFormElement>(null);
  const set = (p: Partial<Todo>) => setRec((r) => ({ ...r, ...p }));
  const submit = async () => {
    fe.clearAll();
    if (!rec.title.trim()) {
      fe.setErrors({ title: 'Enter what needs to be done.' });
      return;
    }
    setBusy(true);
    try {
      const saved = rec.id ? await api.put<Todo>(`/todos/${rec.id}`, rec) : await api.post<Todo>('/todos', rec);
      onDone(saved);
    } catch (e) {
      fe.fromError(e, { nameField: 'title' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormErrorsProvider value={fe}>
      <form
        ref={root}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <div className="cx-userform" style={{ width: 440 }}>
          {fe.message && <ErrorBanner message={fe.message} root={root.current} onDismiss={() => fe.setMessage(null)} />}
          <Field label="To do" required>
            <TextField name="title" value={rec.title} onChange={(v) => set({ title: v })} autoFocus placeholder="e.g. Call about the estimate" />
          </Field>
          <div className="cx-row" style={{ alignItems: 'flex-start', gap: 12 }}>
            <Field label="Due date" width={150}>
              <DateField name="dueDate" value={rec.dueDate} onChange={(v) => set({ dueDate: v })} />
            </Field>
            <Field label="About (customer, vendor or other name)" width={260}>
              <NamePicker name="nameId" value={rec.nameId} onChange={(id) => set({ nameId: id })} placeholder="Nobody in particular" />
            </Field>
          </div>
          <Field label="Notes">
            <TextArea name="notes" value={rec.notes} onChange={(v) => set({ notes: v })} height={80} />
          </Field>
          {rec.id > 0 && <Checkbox checked={rec.done} onChange={(v) => set({ done: v })} label="Done" />}
        </div>
        <div className="sx-dlg-buttons">
          <button type="submit" className="sx-btn sx-btn-primary" disabled={busy}>
            OK
          </button>
          <button type="button" className="sx-btn sx-btn-secondary" onClick={() => onDone(null)}>
            Cancel
          </button>
        </div>
      </form>
    </FormErrorsProvider>
  );
}
