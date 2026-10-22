// AI Assistants (left sidebar and menu bar): share this company file with AI assistant apps on this computer
// (Claude, ChatGPT, Grok Build and others) and show how to connect them.
//
// The settings are per company file and only an administrator changes them (PUT
// /ai-assistants); everyone else sees them read-only. Apps are connected through the helper
// program the SerieX desktop app carries (status.helper): "Set up ... for me" adds it to the
// app's settings file on this computer (POST /ai-assistants/setup), or the user copies the
// lines shown here. Without the helper (SerieX Books run on its own) the apps connect to the
// web address with the access key instead.
//
// The access key is read only when an administrator asks for it (Show, Copy) and is kept in
// this window's memory only: never in localStorage, the query cache or a log.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Ban,
  Bot,
  Check,
  CircleCheck,
  Copy,
  Eye,
  EyeOff,
  Globe,
  Info,
  KeyRound,
  ShieldCheck,
  Smartphone,
  TriangleAlert,
  WandSparkles,
} from 'lucide-react';
import { api, getCompanyId } from '@/api/client';
import { makeAiAccessKey, readAiAccessKey, saveAiAssistants, setUpAiApp, useAiAssistants } from '@/api/hooks';
import type { AiAccessKey, AiAssistantsSettings, AiAssistantsStatus, AiSetupFile, AiSetupResult, AiSetupTarget, User } from '@/api/types';
import { Button, Checkbox, Field, SegmentedControl, Select, Spinner, msgBox, toast } from '@/components';
import { useSession } from '@/state/session';
import { useOptionalWindow } from '@/windows/WindowContext';
import './company.css';
import './aiassistants.css';

export interface AiAssistantsDialogProps {}

type Tab = 'claude' | 'chatgpt' | 'grok' | 'other';
type Platform = AiAssistantsStatus['platform'];

/** Shown instead of the access key until an administrator asks to see it. */
const KEY_PLACEHOLDER = '<access key>';

// ---------------------------------------------------------------------------
// Text of the commands and settings files

/**
 * A path or argument for a terminal command. Mac and Linux: in single quotes, which the shell
 * takes exactly as written (no $, `, \ or ! is acted on); each ' inside becomes '\'' (end the
 * quotes, a quoted ', start them again). Windows (PowerShell): in single quotes, which PowerShell
 * takes exactly as written ($ and ` included); an apostrophe inside is doubled (PowerShell also
 * ends single-quoted text at the typographic quotes ‘ ’ ‚ ‛, so those are doubled too).
 */
function shellQuote(s: string, platform: Platform): string {
  if (platform === 'windows') return `'${s.replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')}'`;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** An argument for a terminal command: as it is when it is plain (--data), else quoted. */
function shellArg(s: string, platform: Platform): string {
  const plain = platform === 'windows' ? /^[A-Za-z0-9_\-.:\\/]+$/ : /^[A-Za-z0-9_\-.,/:@+][A-Za-z0-9_\-.,/:=@+]*$/;
  return plain.test(s) ? s : shellQuote(s, platform);
}

/**
 * The apps start the helper program: SerieX gives its location (administrators on the computer
 * where SerieX runs). Else, when there is a helper, only an administrator there can set the apps
 * up; without a helper, the apps connect to the web address with the key.
 */
function viaHelper(st: AiAssistantsStatus): boolean {
  return st.helper.available && st.helper.path !== '';
}

/**
 * The name of SerieX in an app's list of servers when the app connects to the web address. Each
 * company file has its own key there, so each gets its own entry: seriex-<company id>. (The
 * helper serves every shared company file under the one name "seriex".)
 */
function webEntryName(companyId: string | null): string {
  const id = (companyId ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return id ? `seriex-${id}` : 'seriex';
}

/** "<helper>" <args...> for a terminal command. */
function helperCommand(st: AiAssistantsStatus): string {
  return [shellQuote(st.helper.path, st.platform), ...st.helper.args.map((a) => shellArg(a, st.platform))].join(' ');
}

/**
 * Text as a string of the ChatGPT / Codex settings file (config.toml), written the way SerieX
 * Books writes it: '...' when the text has no ' and no line breaks, else "..." with \ and " escaped.
 */
function tomlString(s: string): string {
  let literal = !s.includes("'");
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c < 0x20 && c !== 9) || c === 0x7f) literal = false;
  }
  if (literal) return `'${s}'`;
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 0x20 || c === 0x7f) out += '\\u' + c.toString(16).toUpperCase().padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

/** "..." string of the settings file (config.toml) for the web address and the key. */
function tomlBasic(s: string): string {
  return '"' + s.replace(/["\\]/g, '\\$&') + '"';
}

const json = (v: unknown) => JSON.stringify(v, null, 2);

/** {"mcpServers": {"seriex": {"command": H, "args": A}}}: Claude, Cursor, LM Studio and similar apps. */
function mcpServersJson(st: AiAssistantsStatus): string {
  return json({ mcpServers: { seriex: { command: st.helper.path, args: st.helper.args } } });
}

/** Only the "seriex": {...} part, for a Claude settings file that already holds other settings. */
function seriexEntryJson(st: AiAssistantsStatus): string {
  const inner = json({ seriex: { command: st.helper.path, args: st.helper.args } });
  // drop the outer braces and one level of indentation
  return inner
    .split('\n')
    .slice(1, -1)
    .map((l) => l.replace(/^ {2}/, ''))
    .join('\n');
}

function codexToml(st: AiAssistantsStatus): string {
  return [
    '[mcp_servers.seriex]',
    `command = ${tomlString(st.helper.path)}`,
    `args = [${st.helper.args.map(tomlString).join(', ')}]`,
    'startup_timeout_sec = 20',
  ].join('\n');
}

// Where the apps keep their settings files on each kind of computer.
const CLAUDE_FILE: Record<Platform, string> = {
  darwin: '~/Library/Application Support/Claude/claude_desktop_config.json',
  windows: '%APPDATA%\\Claude\\claude_desktop_config.json',
  linux: '~/.config/Claude/claude_desktop_config.json',
};
/**
 * Claude for Windows installed as an app package (for example from the Microsoft Store) gets its
 * own copy of %APPDATA% and reads its settings file there, not in %APPDATA%\Claude.
 */
const CLAUDE_PACKAGES = '%LOCALAPPDATA%\\Packages';
const CLAUDE_FILE_PACKAGED = '%LOCALAPPDATA%\\Packages\\Claude_*\\LocalCache\\Roaming\\Claude\\claude_desktop_config.json';
const CODEX_FILE: Record<Platform, string> = {
  darwin: '~/.codex/config.toml',
  windows: '%USERPROFILE%\\.codex\\config.toml',
  linux: '~/.codex/config.toml',
};
const CURSOR_FILE: Record<Platform, string> = {
  darwin: '~/.cursor/mcp.json',
  windows: '%USERPROFILE%\\.cursor\\mcp.json',
  linux: '~/.cursor/mcp.json',
};

/** The app that runs commands on this kind of computer. */
function terminalName(platform: Platform): string {
  return platform === 'windows' ? 'PowerShell' : platform === 'darwin' ? 'Terminal' : 'a terminal';
}

/** The app that shows files, and a plain text editor, on this kind of computer. */
function fileApps(platform: Platform): { files: string; editor: string } {
  if (platform === 'darwin') return { files: 'Finder', editor: 'TextEdit' };
  if (platform === 'windows') return { files: 'File Explorer', editor: 'Notepad' };
  return { files: 'your file manager', editor: 'a text editor' };
}

// ---------------------------------------------------------------------------
// Copying

/** Puts text on the clipboard (with a fallback for pages the clipboard API refuses). */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* try the fallback below */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.opacity = '0';
  const prev = document.activeElement as HTMLElement | null;
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  prev?.focus?.({ preventScroll: true });
  return ok;
}

/** Copy button: copies `text` (or what `get` returns, e.g. a command with the access key filled in). */
function CopyButton({ text, get, label = 'Copy', what }: { text?: string; get?: () => Promise<string | null>; label?: string; what?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);
  const run = async () => {
    const value = get ? await get() : text;
    if (value == null) return;
    if (await copyText(value)) setCopied(true);
    else await msgBox({ title: 'Copy', icon: 'warning', message: 'SerieX could not copy the text. Select it and copy it yourself.' });
  };
  return (
    <Button
      size="sm"
      icon={copied ? Check : Copy}
      label={copied ? 'Copied' : label}
      title={what ? `Copy ${what}` : undefined}
      aria-label={what ? `Copy ${what}` : undefined}
      onClick={() => void run()}
      className="ai-copy"
    />
  );
}

/**
 * A command or the lines of a settings file, with a Copy button. The block itself has no label
 * of its own, so screen readers read its text; `what` names it on the Copy button.
 */
function CodeBlock({ text, copy, what }: { text: string; copy?: () => Promise<string | null>; what?: string }) {
  return (
    <div className="ai-code">
      <pre tabIndex={0}>{text}</pre>
      <CopyButton text={text} get={copy} what={what} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The access key (administrators on this computer only)

interface KeyAccess {
  /** This user may read the key here (administrator, on this computer, connection on). */
  allowed: boolean;
  /** The key, once read. */
  key: string | null;
  /** The key is shown in the commands (else KEY_PLACEHOLDER). */
  shown: boolean;
  setShown(v: boolean): void;
  /** Reads the key when it is not read yet; null when it could not be read (the user was told). */
  ensure(): Promise<string | null>;
  /** The key was replaced (Make a new key). */
  replaced(key: AiAccessKey): void;
  /** Forgets the key read earlier, because the server replaced it: hidden, and read again when asked for. */
  drop(): void;
}

/** statusFailedAt: when reading the status last failed (0: never; the query's errorUpdatedAt). */
function useKeyAccess(st: AiAssistantsStatus | undefined, statusFailedAt: number): KeyAccess {
  const [key, setKey] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  // Goes up each time the key held here changes outside ensure (dropped or replaced), so a key
  // that was still being read then is not kept.
  const generation = useRef(0);
  // The keyVersion the server gave with the key held here (null: no key held, or a server that
  // does not give it).
  const heldVersion = useRef<string | null>(null);
  const allowed = !!st && st.available && st.isAdmin && st.fromThisComputer;

  const drop = useCallback(() => {
    generation.current += 1;
    heldVersion.current = null;
    setKey(null);
    setShown(false);
  }, []);
  const hold = useCallback((k: AiAccessKey) => {
    heldVersion.current = k.keyVersion || null;
    setKey(k.key);
  }, []);
  const replaced = useCallback(
    (k: AiAccessKey) => {
      generation.current += 1;
      hold(k);
    },
    [hold],
  );

  // Drop the key held here when the key changed on the server (keyVersion: made, replaced or
  // dropped, in this window or another one) unless it changed to the very key held here (made
  // with "Make a new key", or by Show when the file had no key yet). Drop it too when sharing is
  // turned on (the server makes a new key), when the company file gets its first password (the
  // key stops working) or loses its passwords, and when this user may no longer read the key.
  const seen = useRef<{ enabled: boolean; passwordsRequired: boolean; keyVersion: string; allowed: boolean } | null>(null);
  useEffect(() => {
    if (!st) return;
    const prev = seen.current;
    seen.current = { enabled: st.enabled, passwordsRequired: st.passwordsRequired, keyVersion: st.keyVersion, allowed };
    if (!prev) return;
    const keyChanged = prev.keyVersion !== st.keyVersion && st.keyVersion !== heldVersion.current;
    const sharingTurnedOn = !prev.enabled && st.enabled;
    if (keyChanged || sharingTurnedOn || prev.passwordsRequired !== st.passwordsRequired || (prev.allowed && !allowed)) drop();
  }, [st, allowed, drop]);

  // The status could not be read again (for example the file now asks for a login, after a
  // password was set in another tab): the key held here may not work any more either.
  const failedAt = useRef(statusFailedAt);
  useEffect(() => {
    if (statusFailedAt === failedAt.current) return;
    failedAt.current = statusFailedAt;
    if (statusFailedAt) drop();
  }, [statusFailedAt, drop]);

  const ensure = useCallback(async () => {
    if (!allowed) return null;
    if (key) return key;
    try {
      const gen = generation.current;
      let k = await readAiAccessKey();
      // dropped while it was read: read the key the server uses now
      if (gen !== generation.current) k = await readAiAccessKey();
      hold(k);
      return k.key;
    } catch (e) {
      await msgBox({ title: 'Access Key', icon: 'error', message: (e as Error).message });
      return null;
    }
  }, [allowed, key, hold]);
  return { allowed, key, shown, setShown, ensure, replaced, drop };
}

// ---------------------------------------------------------------------------

export default function AiAssistantsDialog(_props: AiAssistantsDialogProps) {
  const win = useOptionalWindow();
  const q = useAiAssistants();
  const st = q.data;
  const companyName = useSession((s) => s.company?.name || s.companyId || 'this company file');
  const entry = webEntryName(useSession((s) => s.companyId) ?? getCompanyId());
  const keys = useKeyAccess(st, q.errorUpdatedAt);
  const [tab, setTab] = useState<Tab>('claude');

  useEffect(() => {
    win?.setTitle('AI Assistants');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!st) {
    return (
      <div className="cx-dlg" style={{ display: 'grid', placeItems: 'center' }}>
        {q.error ? <span className="cx-muted">{(q.error as Error).message}</span> : <Spinner label="Loading..." />}
      </div>
    );
  }

  return (
    <div className="cx-dlg ai-dlg">
      <div className="cx-dlg-body ai-body">
        <div className="ai-head">
          <div className="ai-head-icon" aria-hidden="true">
            <Bot size={22} />
          </div>
          <div>
            <h2 className="ai-title">AI Assistants</h2>
            <p className="ai-lead">Let an AI assistant on this computer, such as Claude or ChatGPT, answer questions about your books.</p>
          </div>
        </div>
        <ul className="ai-points">
          <li>SerieX must be open while you use the assistant.</li>
          <li>The assistant can only look, unless you allow changes below.</li>
          <li>
            What the assistant reads is sent to the company that runs the AI (for example Anthropic, OpenAI or xAI), the same as anything you type into
            it.
          </li>
        </ul>

        <ShareSection st={st} companyName={companyName} onSharingOn={keys.drop} />

        {st.available && (
          <>
            <ConnectSection st={st} tab={tab} setTab={setTab} keys={keys} companyName={companyName} entry={entry} />
            <CannotConnect />
            {st.isAdmin && <Advanced st={st} keys={keys} companyName={companyName} />}
          </>
        )}
      </div>
      <div className="cx-dlg-foot">
        <span className="cx-grow" />
        <Button variant="primary" label="Close" onClick={() => void win?.close()} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// This company file

/**
 * On/off switch. It stays usable while a change is being saved (busy): clicks are ignored then,
 * so the keyboard focus stays on it instead of falling back to the page.
 */
function Switch({ checked, onChange, disabled, busy, label, id }: { checked: boolean; onChange(v: boolean): void; disabled?: boolean; busy?: boolean; label: ReactNode; id: string }) {
  return (
    <div className={'ai-switch-row' + (disabled ? ' ai-disabled' : '')}>
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={checked}
        aria-busy={busy || undefined}
        disabled={disabled}
        className={'ai-switch' + (checked ? ' ai-on' : '') + (busy ? ' ai-busy' : '')}
        onClick={() => {
          if (!busy) onChange(!checked);
        }}
      >
        <span className="ai-switch-thumb" />
      </button>
      <label htmlFor={id} className="ai-switch-label">
        {label}
      </label>
      {busy && <span className="sx-spinner ai-inline-spinner" aria-hidden="true" />}
    </div>
  );
}

/** Users of the company file with their roles (GET /users, administrators): marks the administrators in "Work as user". */
function useUserRoles(enabled: boolean) {
  return useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/users', { noPrompt: true }), enabled: enabled && !!getCompanyId(), retry: false });
}

/** onSharingOn: sharing was just turned on, so the server made a new access key. */
function ShareSection({ st, companyName, onSharingOn }: { st: AiAssistantsStatus; companyName: string; onSharingOn(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The switch was turned on in a file with passwords before a user was chosen. */
  const [needUser, setNeedUser] = useState(false);
  const userSelect = useRef<HTMLSelectElement>(null);
  // The user chosen while access is off (sent when it is turned on). In files with passwords the
  // administrator chooses it: nothing is chosen for them, so nobody shares the file as an
  // administrator by accident.
  const [chosen, setChosen] = useState(() => (st.enabled && st.users.includes(st.user) ? st.user : ''));
  const ro = !st.isAdmin;
  const user = st.enabled ? st.user || chosen : chosen;
  /** The saved user no longer exists or is inactive (administrators see the active users). */
  const userGone = !ro && st.enabled && !!st.user && !st.users.includes(st.user);
  /** The user sent with a change: in files without passwords the server's default unless the saved one is still active. */
  const sendUser = st.passwordsRequired ? user : st.users.includes(st.user) ? st.user : '';
  const roles = useUserRoles(!ro && st.passwordsRequired);
  const admins = new Set((roles.data ?? []).filter((u) => u.isAdmin).map((u) => u.name));

  const save = async (next: AiAssistantsSettings, done: string) => {
    setBusy(true);
    setError(null);
    const wasOn = st.enabled;
    try {
      const r = await saveAiAssistants(next);
      if (r.enabled && !wasOn) onSharingOn();
      if (r.enabled && r.users.includes(r.user)) setChosen(r.user);
      toast(done, { kind: 'success' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const setEnabled = (on: boolean) => {
    if (busy) return;
    if (on && st.passwordsRequired && !user) {
      setNeedUser(true);
      userSelect.current?.focus();
      return;
    }
    setNeedUser(false);
    void save(
      { enabled: on, allowChanges: on ? st.allowChanges : false, user: sendUser },
      on ? `AI assistants can now use ${companyName}` : `AI assistants can no longer use ${companyName}`,
    );
  };

  const setAllowChanges = async (on: boolean) => {
    if (busy) return;
    if (on) {
      const who = st.passwordsRequired && user ? `, working as ${user}` : '';
      const r = await msgBox({
        title: 'Allow Changes',
        icon: 'question',
        message: `Let AI assistants make changes in ${companyName}${who}?\n\nThey can then create invoices, record payments, enter bills and similar when you ask them to. Every transaction they save shows in the audit trail.`,
        buttons: ['Allow Changes', 'Cancel'],
      });
      if (r !== 'Allow Changes') return;
    }
    await save({ enabled: true, allowChanges: on, user: sendUser }, on ? 'AI assistants may now make changes' : 'AI assistants may now only look');
  };

  const setUser = (u: string) => {
    if (busy || !u) return;
    setNeedUser(false);
    if (!st.enabled) {
      setChosen(u);
      return;
    }
    void save({ enabled: true, allowChanges: st.allowChanges, user: u }, `AI assistants now work as ${u}`);
  };

  const userOptions = [
    ...(user ? [] : [{ value: '', label: 'Choose a user', disabled: true }]),
    ...(user && !st.users.includes(user) ? [{ value: user, label: `${user} (no longer active)` }] : []),
    ...st.users.map((u) => ({ value: u, label: admins.has(u) ? `${u} (administrator)` : u })),
  ];

  const pill = !st.enabled
    ? { text: 'Not shared', cls: '' }
    : userGone
      ? { text: 'Shared, but the chosen user is gone', cls: ' ai-pill-warn' }
      : { text: st.allowChanges ? 'Shared, may make changes' : 'Shared, look only', cls: ' ai-pill-on' };

  return (
    <section className="ai-section" aria-labelledby="ai-share-title">
      <div className="ai-section-head">
        <h3 id="ai-share-title">This company file</h3>
        {st.available && <span className={'ai-pill' + pill.cls}>{pill.text}</span>}
      </div>
      {!st.available ? (
        <div className="cx-note cx-warn" role="note">
          <TriangleAlert size={15} />
          <div>{st.unavailableReason || 'AI assistants cannot connect to this SerieX.'}</div>
        </div>
      ) : (
        <div className="cx-stack" style={{ gap: 10 }}>
          <Switch id="ai-share" checked={st.enabled} onChange={setEnabled} disabled={ro} busy={busy} label={`Let AI assistants use ${companyName}`} />
          {st.passwordsRequired && (
            <div className="ai-indent">
              <div className="cx-note cx-warn cx-small" role="note">
                <KeyRound size={15} />
                <div>
                  While this is on, anyone who uses this computer account can use {companyName} through an AI assistant without its password, with the
                  rights of the user {ro ? 'shown' : 'chosen'} below.
                </div>
              </div>
            </div>
          )}
          <div className="ai-indent">
            <Checkbox
              checked={st.allowChanges}
              onChange={(v) => void setAllowChanges(v)}
              disabled={ro || !st.enabled}
              aria-busy={busy || undefined}
              label="Also allow changes"
            />
            <div className="cx-hint ai-hint-indent">
              The assistant can then create invoices, record payments, enter bills and similar. Before saving something unusual, SerieX asks a question
              that the assistant must pass on to you. Changes to reconciled, deposited or paid entries, or on or before the closing date, are made in
              SerieX itself.
            </div>
          </div>
          {st.passwordsRequired && (
            <div className="ai-indent">
              {ro ? (
                <div>
                  Works as user: <b>{st.user || 'not chosen yet'}</b>
                  <div className="cx-hint">The assistant sees and does only what this user may.</div>
                </div>
              ) : (
                <Field
                  label="Work as user"
                  htmlFor="ai-user"
                  hint="The assistant sees and does only what this user may. Safest is a user who is not an administrator, for example one you add just for the assistant (Company > Set Up Users and Passwords)."
                  width={420}
                >
                  <Select
                    ref={userSelect}
                    id="ai-user"
                    name="aiUser"
                    value={user}
                    aria-busy={busy || undefined}
                    invalid={needUser}
                    onChange={setUser}
                    options={userOptions}
                    width={300}
                  />
                </Field>
              )}
            </div>
          )}
          {needUser && (
            <div className="cx-note cx-warn cx-small" role="alert">
              <TriangleAlert size={15} />
              <div>Choose the user the assistant works as, then turn this on.</div>
            </div>
          )}
          {userGone && (
            <div className="cx-note cx-warn cx-small" role="alert">
              <TriangleAlert size={15} />
              <div>
                The user chosen for AI assistants ({st.user}) no longer exists or is inactive, so assistants cannot use this company file.{' '}
                {st.passwordsRequired ? 'Choose another user.' : 'Turn access off and on again to use the administrator.'}
              </div>
            </div>
          )}
          {ro && (
            <div className="cx-note cx-small" role="note">
              <Info size={15} />
              <div>Only an administrator can change this.</div>
            </div>
          )}
          {error && (
            <div className="cx-note cx-bad cx-small" role="alert">
              <TriangleAlert size={15} />
              <div>{error}</div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Connect your assistant

interface ConnectProps {
  st: AiAssistantsStatus;
  tab: Tab;
  setTab(t: Tab): void;
  keys: KeyAccess;
  companyName: string;
  /** The name of SerieX in the apps' lists of servers when they connect to the web address. */
  entry: string;
}

/** What each tab gets. */
interface TabProps {
  st: AiAssistantsStatus;
  keys: KeyAccess;
  entry: string;
}

function ConnectSection({ st, tab, setTab, keys, companyName, entry }: ConnectProps) {
  // There is a helper program, but SerieX gives its location only to administrators on the
  // computer where SerieX runs: everyone else asks them to set the apps up.
  const askAdmin = st.helper.available && !viaHelper(st);
  return (
    <section className="ai-section" aria-labelledby="ai-connect-title">
      <div className="ai-section-head">
        <h3 id="ai-connect-title">Connect your assistant</h3>
      </div>
      {!st.enabled && (
        <div className="cx-note cx-small ai-gap" role="note">
          <Info size={15} />
          <div>
            The assistant will not see {companyName} until {st.isAdmin ? 'you share' : 'an administrator shares'} it above.
          </div>
        </div>
      )}
      {!st.fromThisComputer && (
        <div className="cx-note cx-warn cx-small ai-gap" role="note">
          <TriangleAlert size={15} />
          <div>AI assistants can only connect on the computer where SerieX runs.{askAdmin ? '' : ' Follow these steps on that computer.'}</div>
        </div>
      )}
      {askAdmin ? <AskAdmin st={st} /> : <ConnectTabs st={st} tab={tab} setTab={setTab} keys={keys} entry={entry} />}
    </section>
  );
}

/** Instead of the steps, for everyone but an administrator on the computer where SerieX runs. */
function AskAdmin({ st }: { st: AiAssistantsStatus }) {
  return (
    <>
      <div className="cx-note cx-info cx-small ai-gap" role="note">
        <Info size={15} />
        <div>
          {st.isAdmin
            ? 'Set this up on the computer where SerieX runs (AI Assistants).'
            : 'Ask an administrator to set this up on the computer where SerieX runs (AI Assistants).'}
        </div>
      </div>
      <p className="cx-muted cx-small ai-p">
        It works with the Claude and ChatGPT desktop apps, Claude Code, Grok Build, and apps such as Cursor, LM Studio and Visual Studio Code.
      </p>
    </>
  );
}

function ConnectTabs({ st, tab, setTab, keys, entry }: { st: AiAssistantsStatus; tab: Tab; setTab(t: Tab): void; keys: KeyAccess; entry: string }) {
  return (
    <>
      <SegmentedControl<Tab>
        size="sm"
        value={tab}
        onChange={setTab}
        aria-label="AI assistant app"
        options={[
          { value: 'claude', label: 'Claude' },
          { value: 'chatgpt', label: 'ChatGPT' },
          { value: 'grok', label: 'Grok' },
          { value: 'other', label: 'Other apps' },
        ]}
      />
      <div className="ai-tab" role="region" aria-label={{ claude: 'Claude', chatgpt: 'ChatGPT', grok: 'Grok', other: 'Other apps' }[tab]}>
        {!st.helper.available && (
          <div className="cx-note cx-info cx-small ai-gap" role="note">
            <Info size={15} />
            <div>
              The easiest setup needs the SerieX desktop app. Without it, assistants connect to SerieX at its web address with the access key, as shown
              below. Each company file is added separately, with its own key.
            </div>
          </div>
        )}
        {tab === 'claude' && <ClaudeTab st={st} keys={keys} entry={entry} />}
        {tab === 'chatgpt' && <ChatGptTab st={st} keys={keys} entry={entry} />}
        {tab === 'grok' && <GrokTab st={st} keys={keys} entry={entry} />}
        {tab === 'other' && <OtherTab st={st} keys={keys} entry={entry} />}
      </div>
    </>
  );
}

interface SetupButtonProps {
  target: AiSetupTarget;
  file: AiSetupFile;
  app: string;
  /** What to do next, after the server's own message (shown when done, and under "Already set up"). */
  after: string;
  /** The result of the setup made in this window, if any. */
  done: AiSetupResult | null;
  onDone(r: AiSetupResult): void;
}

/**
 * What SerieX did to the settings file. Older servers do not send "result": it is then worked
 * out from the backup (made only when an existing file changed) and whether the file was there.
 */
function setupFileNote(done: AiSetupResult, app: string, existed: boolean): string {
  const result = done.result ?? (done.backup ? 'changed' : existed ? 'unchanged' : 'created');
  if (result === 'unchanged') return `${app} was already set up; nothing changed.`;
  if (result === 'changed' && done.backup) return `SerieX updated ${done.file} and kept a copy of the old one at ${done.backup}.`;
  if (result === 'changed') return `SerieX updated ${done.file}.`;
  return `SerieX created ${done.file}.`;
}

/** "Set up ... for me", or "Already set up". Asks first which file is changed. */
function SetupButton({ target, file, app, after, done, onDone }: SetupButtonProps) {
  const [busy, setBusy] = useState(false);
  // Whether the file was there when the setup ran (the status read again afterwards says it is).
  const existed = useRef(file.exists);
  const baseName = file.file.split(/[\\/]/).pop() || file.file;

  const run = async () => {
    existed.current = file.exists;
    const message = file.exists
      ? `SerieX will add itself to this ${app} settings file:\n\n${file.file}\n\nYour other settings in that file stay as they are, and a backup of the file is kept next to it (${baseName}.seriex-backup).`
      : `SerieX will create this ${app} settings file:\n\n${file.file}`;
    const r = await msgBox({ title: `Set Up ${app}`, icon: 'question', message, buttons: ['Set Up', 'Cancel'], width: 520 });
    if (r !== 'Set Up') return;
    setBusy(true);
    try {
      const res = await setUpAiApp(target);
      onDone(res);
      toast(`${app} is set up to use SerieX`, { kind: 'success' });
    } catch (e) {
      await msgBox({ title: `Set Up ${app}`, icon: 'error', message: (e as Error).message, width: 520 });
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="cx-note cx-ok ai-gap" role="status">
        <CircleCheck size={15} />
        <div>
          <div>
            <b>{done.message}</b> {after}
          </div>
          <div className="cx-small ai-filenote">{setupFileNote(done, app, existed.current)}</div>
        </div>
      </div>
    );
  }
  if (file.configured) {
    return (
      <>
        <div className="ai-setup-row">
          <span className="ai-pill ai-pill-on">
            <Check size={13} /> Already set up
          </span>
          <span className="cx-small cx-muted ai-filenote">{file.file}</span>
        </div>
        <p className="cx-muted cx-small ai-p">{after}</p>
      </>
    );
  }
  return (
    <div className="ai-setup-row">
      <Button variant="primary" icon={WandSparkles} label={`Set up ${app} for me`} busy={busy} onClick={() => void run()} />
    </div>
  );
}

/**
 * The steps to do by hand. Once the app is set up (with the button above, or already), they are
 * folded away so nobody adds SerieX a second time: a second entry can break the app's settings
 * file. `fold` also folds them while the button is the main way (Claude on Windows).
 */
function ManualSteps({ setUp, fold, app, children }: { setUp: boolean; fold?: boolean; app: string; children: ReactNode }) {
  if (!setUp && !fold) return <>{children}</>;
  return (
    <details className="ai-fold">
      <summary>{setUp ? `Set it up by hand instead (skip this: ${app} is already set up)` : 'Set it up by hand instead'}</summary>
      <div className="ai-fold-body">{children}</div>
    </details>
  );
}

/** Builds a text that holds the access key: shown with the key or the placeholder, copied with the key when allowed. */
function keyedText(keys: KeyAccess, build: (key: string) => string) {
  const text = build(keys.shown && keys.key ? keys.key : KEY_PLACEHOLDER);
  const copy = async () => {
    if (!keys.allowed) return build(KEY_PLACEHOLDER);
    const k = await keys.ensure();
    return k ? build(k) : null;
  };
  return { text, copy };
}

/** Where the access key comes from, under the commands that need it. */
function KeyNote({ st, keys }: { st: AiAssistantsStatus; keys: KeyAccess }) {
  if (!st.isAdmin) return <p className="cx-muted cx-small ai-p">Ask an administrator for the access key and put it in place of {KEY_PLACEHOLDER}.</p>;
  if (!keys.allowed) return <p className="cx-muted cx-small ai-p">The access key can only be shown on the computer where SerieX runs.</p>;
  return (
    <div className="ai-keynote cx-small">
      <span className="cx-muted">{keys.shown ? 'The commands show the access key. Keep it private.' : 'Copy fills in the access key.'}</span>
      {!st.enabled && <span className="cx-muted">Turn sharing on above before you copy this, because turning it on makes a new key.</span>}
      <button
        type="button"
        className="sx-linkbtn"
        onClick={() =>
          void (async () => {
            if (keys.shown) keys.setShown(false);
            else if (await keys.ensure()) keys.setShown(true);
          })()
        }
      >
        {keys.shown ? 'Hide the key' : 'Show the key'}
      </button>
    </div>
  );
}

const authHeader = (key: string) => `Authorization: Bearer ${key}`;

function ClaudeTab({ st, keys, entry }: TabProps) {
  const [done, setDone] = useState<AiSetupResult | null>(null);
  const helper = viaHelper(st);
  const name = helper ? 'seriex' : entry;
  const http = keyedText(keys, (k) => `claude mcp add --transport http --scope user ${entry} ${shellArg(st.address, st.platform)} --header "${authHeader(k)}"`);
  const windows = st.platform === 'windows';
  const apps = fileApps(st.platform);
  const setUp = !!done || !!st.setup?.claudeDesktop.configured;
  const offerButton = !!st.setup && !setUp;
  return (
    <>
      <h4 className="ai-h4">Claude desktop app</h4>
      {helper ? (
        <>
          {st.setup && (
            <SetupButton
              target="claudeDesktop"
              file={st.setup.claudeDesktop}
              app="Claude"
              after="In a new chat, open the tools menu in the message box (the + button) and check that seriex is listed and turned on."
              done={done}
              onDone={setDone}
            />
          )}
          {/* On Windows the button is the main way: it finds the file Claude reads by itself. */}
          <ManualSteps setUp={setUp} fold={windows && offerButton} app="Claude">
            {windows ? (
              <>
                <p className="ai-p">
                  Claude keeps its settings in a file named claude_desktop_config.json. Which one it reads depends on how Claude was installed:
                </p>
                <ul className="ai-files">
                  <li>
                    If {CLAUDE_PACKAGES} has a folder whose name starts with Claude_ (for example Claude from the Microsoft Store), it is{' '}
                    <code className="ai-inline">{CLAUDE_FILE_PACKAGED}</code>, where Claude_* is that folder.
                  </li>
                  <li>
                    Otherwise it is <code className="ai-inline">{CLAUDE_FILE.windows}</code>.
                  </li>
                </ul>
                <p className="ai-p">
                  To look, paste {CLAUDE_PACKAGES} into the address bar of {apps.files} and press Enter. Open the file with {apps.editor}, or create it
                  if it is not there.
                </p>
              </>
            ) : (
              <p className="ai-p">
                {offerButton ? 'Or do it by hand: in' : 'In'} Claude, open Settings, then Developer, then Edit Config. Claude shows its settings file,
                claude_desktop_config.json, in {apps.files}. Open that file with {apps.editor}.
              </p>
            )}
            <p className="ai-p">If the file is empty or holds only {'{}'}, replace everything in it with this:</p>
            <CodeBlock text={mcpServersJson(st)} what="the Claude settings" />
            <p className="ai-p">
              If the file already has other text, keep it. Put only this part inside the braces after "mcpServers", with a comma between it and the
              entry before it:
            </p>
            <CodeBlock text={seriexEntryJson(st)} what="the seriex part of the Claude settings" />
            <p className="cx-muted cx-small ai-p">
              {offerButton
                ? 'If the file has text but no "mcpServers" yet, the Set up Claude for me button above is the easy way.'
                : 'If the file has text but no "mcpServers" yet, add "mcpServers": { } with the part above inside the braces, followed by a comma, right after the first { of the file.'}
            </p>
            <p className="ai-p">Save the file, then quit Claude completely and open it again.</p>
            {(st.setup || !windows) && (
              <p className="cx-muted cx-small ai-p ai-filenote">
                {windows ? 'On this computer the file is' : 'The file is'} {st.setup?.claudeDesktop.file || CLAUDE_FILE[st.platform]}.
              </p>
            )}
          </ManualSteps>
        </>
      ) : (
        <p className="ai-p">The Claude desktop app can connect only through the SerieX desktop app.</p>
      )}

      <h4 className="ai-h4">Claude Code (for technical users)</h4>
      <p className="ai-p">In {terminalName(st.platform)}, run:</p>
      {helper ? (
        <CodeBlock text={`claude mcp add --scope user seriex -- ${helperCommand(st)}`} what="the Claude Code command" />
      ) : (
        <>
          <CodeBlock text={http.text} copy={http.copy} what="the Claude Code command" />
          <KeyNote st={st} keys={keys} />
        </>
      )}
      <p className="ai-p">Then check that {name} is listed:</p>
      <CodeBlock text="claude mcp list" what="the check command" />
      <p className="cx-muted cx-small ai-p">
        {helper
          ? 'This works in the Claude desktop app and Claude Code, not on claude.ai or the phone app.'
          : 'This works in Claude Code, not on claude.ai or the phone app.'}
      </p>
    </>
  );
}

function ChatGptTab({ st, keys, entry }: TabProps) {
  const [done, setDone] = useState<AiSetupResult | null>(null);
  const file = st.setup?.codex.file || CODEX_FILE[st.platform];
  const http = keyedText(keys, (k) => [`[mcp_servers.${entry}]`, `url = ${tomlBasic(st.address)}`, `http_headers = { "Authorization" = ${tomlBasic('Bearer ' + k)} }`].join('\n'));
  const setUp = !!done || !!st.setup?.codex.configured;
  const offerButton = !!st.setup && !setUp;
  const restart = 'Then in ChatGPT open Settings, then MCP servers, and click Restart (or quit and reopen ChatGPT).';
  return (
    <>
      <p className="ai-p">Use the new ChatGPT desktop app (not ChatGPT Classic).</p>
      {viaHelper(st) ? (
        <>
          {st.setup && (
            <SetupButton
              target="codex"
              file={st.setup.codex}
              app="ChatGPT"
              after="Start a Work or Codex conversation; regular Chat conversations cannot use SerieX yet. Type /mcp to check that seriex is listed."
              done={done}
              onDone={setDone}
            />
          )}
          <p className="cx-muted cx-small ai-p">
            {offerButton
              ? "This also sets up OpenAI's Codex, which uses the same settings."
              : setUp
                ? "OpenAI's Codex uses the same settings as ChatGPT, so it is set up too."
                : "OpenAI's Codex uses the same settings as ChatGPT."}
          </p>

          <ManualSteps setUp={setUp} app="ChatGPT">
            <h4 className="ai-h4">{offerButton ? 'Or do it yourself' : 'Set it up yourself'}</h4>
            <p className="ai-p">
              <b>Option A.</b> In ChatGPT open Settings, then MCP servers, then Add server. Choose STDIO, type the name <b>seriex</b> and this command:
            </p>
            <CodeBlock text={st.helper.path} what="the command" />
            {st.helper.args.length > 0 && (
              <>
                <p className="ai-p">Add these arguments, one per line:</p>
                <CodeBlock text={st.helper.args.join('\n')} what="the arguments" />
              </>
            )}
            <p className="ai-p">
              <b>Option B.</b> Add this to the end of the file {file}. Use only one of the two options:
            </p>
            <CodeBlock text={codexToml(st)} what="the ChatGPT settings" />
            <p className="cx-muted cx-small ai-p">{restart}</p>
          </ManualSteps>
        </>
      ) : (
        <>
          <p className="ai-p">Add this to the file {file}, which ChatGPT and OpenAI's Codex share:</p>
          <CodeBlock text={http.text} copy={http.copy} what="the ChatGPT settings" />
          <KeyNote st={st} keys={keys} />
          <p className="cx-muted cx-small ai-p">{restart}</p>
        </>
      )}
    </>
  );
}

function GrokTab({ st, keys, entry }: TabProps) {
  const helper = viaHelper(st);
  const http = keyedText(keys, (k) => `grok mcp add --transport http ${entry} ${shellArg(st.address, st.platform)} --header "${authHeader(k)}"`);
  const windows = st.platform === 'windows';
  return (
    <>
      <p className="ai-p">
        Grok's website and phone apps cannot connect. Grok Build, xAI's terminal app, can. It needs a SuperGrok or X Premium+ subscription, or an xAI API
        key (it is in early beta).
      </p>
      <ol className="ai-steps">
        <li>
          Install Grok Build: in {terminalName(st.platform)}, run
          <CodeBlock text={windows ? 'irm https://x.ai/cli/install.ps1 | iex' : 'curl -fsSL https://x.ai/cli/install.sh | bash'} what="the install command" />
        </li>
        <li>
          Run <code className="ai-inline">grok</code> once and sign in.
        </li>
        <li>
          Add SerieX:
          {helper ? (
            <CodeBlock text={`grok mcp add seriex -- ${helperCommand(st)}`} what="the Grok command" />
          ) : (
            <>
              <CodeBlock text={http.text} copy={http.copy} what="the Grok command" />
              <KeyNote st={st} keys={keys} />
            </>
          )}
        </li>
        <li>
          Check that it works:
          <CodeBlock text={`grok mcp doctor ${helper ? 'seriex' : entry}`} what="the check command" />
        </li>
      </ol>
    </>
  );
}

function OtherTab({ st, keys, entry }: TabProps) {
  const helper = viaHelper(st);
  const cursorHttp = keyedText(keys, (k) => json({ mcpServers: { [entry]: { url: st.address, headers: { Authorization: `Bearer ${k}` } } } }));
  const vscodeHttp = keyedText(keys, (k) => json({ servers: { [entry]: { type: 'http', url: st.address, headers: { Authorization: `Bearer ${k}` } } } }));
  return (
    <>
      <h4 className="ai-h4">Cursor, LM Studio and similar apps</h4>
      <p className="ai-p">
        Add this to the app's settings file. For Cursor it is {CURSOR_FILE[st.platform]}. For LM Studio, open the Program tab on the right, then Install,
        then Edit mcp.json. If other servers are listed, add {helper ? 'seriex' : entry} next to them.
      </p>
      {helper ? (
        <CodeBlock text={mcpServersJson(st)} what="the settings" />
      ) : (
        <>
          <CodeBlock text={cursorHttp.text} copy={cursorHttp.copy} what="the settings" />
          <KeyNote st={st} keys={keys} />
        </>
      )}

      <h4 className="ai-h4">Visual Studio Code</h4>
      <p className="ai-p">
        Add this to .vscode/mcp.json in your folder, or open the Command Palette, run MCP: Open User Configuration and add it there:
      </p>
      {helper ? (
        <CodeBlock text={json({ servers: { seriex: { type: 'stdio', command: st.helper.path, args: st.helper.args } } })} what="the Visual Studio Code settings" />
      ) : (
        <>
          <CodeBlock text={vscodeHttp.text} copy={vscodeHttp.copy} what="the Visual Studio Code settings" />
          <KeyNote st={st} keys={keys} />
        </>
      )}

      {helper && (
        <>
          <h4 className="ai-h4">Apps that ask for a program</h4>
          <p className="ai-p">Name: seriex. Program:</p>
          <CodeBlock text={st.helper.path} what="the program" />
          {st.helper.args.length > 0 && (
            <>
              <p className="ai-p">Arguments, one per line:</p>
              <CodeBlock text={st.helper.args.join('\n')} what="the arguments" />
            </>
          )}
        </>
      )}
      <div className="cx-note cx-ok cx-small ai-gap" role="note">
        <ShieldCheck size={15} />
        <div>LM Studio and Jan can run the AI model on this computer, so your books never leave it.</div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Cannot connect

function CannotConnect() {
  return (
    <section className="ai-section" aria-labelledby="ai-cannot-title">
      <div className="ai-section-head">
        <h3 id="ai-cannot-title">Cannot connect</h3>
      </div>
      <ul className="ai-cannot">
        <li>
          <Globe size={15} aria-hidden="true" /> claude.ai, chatgpt.com and grok.com in a web browser
        </li>
        <li>
          <Smartphone size={15} aria-hidden="true" /> The Claude, ChatGPT and Grok phone apps
        </li>
        <li>
          <Ban size={15} aria-hidden="true" /> "Add custom connector" in Claude
        </li>
        <li>
          <Ban size={15} aria-hidden="true" /> Grok Bot on X
        </li>
      </ul>
      <p className="cx-muted cx-small ai-p">They connect from the AI company's servers on the internet, so they cannot reach SerieX on your computer.</p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Advanced (administrators)

function Advanced({ st, keys, companyName }: { st: AiAssistantsStatus; keys: KeyAccess; companyName: string }) {
  const [busy, setBusy] = useState(false);

  const showHide = async () => {
    if (keys.shown) keys.setShown(false);
    else if (await keys.ensure()) keys.setShown(true);
  };

  const makeNew = async () => {
    const r = await msgBox({
      title: 'Make a New Key',
      icon: 'warning',
      message:
        'Make a new access key? The old key stops working at once.\n\nAssistants set up with the web address and key must be updated. Assistants set up with the buttons above reconnect by themselves.',
      buttons: ['Make New Key', 'Cancel'],
      defaultButton: 'Cancel',
      width: 500,
    });
    if (r !== 'Make New Key') return;
    setBusy(true);
    try {
      keys.replaced(await makeAiAccessKey());
      toast('A new access key was made', { kind: 'success' });
    } catch (e) {
      await msgBox({ title: 'Make a New Key', icon: 'error', message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="ai-advanced">
      <summary>Advanced: connection details</summary>
      <div className="ai-advanced-body">
        <p className="cx-muted cx-small ai-p">For apps that connect to a web address instead of starting the SerieX program.</p>
        <dl className="cx-kv ai-kv">
          <dt>Web address</dt>
          <dd>
            <div className="ai-valrow">
              <code className="ai-inline ai-val">{st.address}</code>
              <CopyButton text={st.address} what="the web address" />
            </div>
          </dd>
          <dt>Access key</dt>
          <dd>
            {keys.allowed ? (
              <>
                <div className="ai-valrow">
                  <code className="ai-inline ai-val" aria-label={keys.shown && keys.key ? 'Access key' : 'Access key (hidden)'}>
                    {keys.shown && keys.key ? keys.key : '••••••••••••••••••••••••••••••'}
                  </code>
                  <Button size="sm" icon={keys.shown ? EyeOff : Eye} label={keys.shown ? 'Hide' : 'Show'} onClick={() => void showHide()} />
                  <CopyButton get={keys.ensure} what="the access key" />
                </div>
                <div className="cx-hint">
                  Send it as "{authHeader(KEY_PLACEHOLDER)}". Anyone with this key can use {companyName} through an AI assistant while it is shared, so
                  keep it private.
                </div>
                <div className="cx-hint">Turning sharing on makes a new key, so assistants set up with the web address need the new one.</div>
                <div style={{ marginTop: 8 }}>
                  <Button size="sm" icon={KeyRound} label="Make a new key" busy={busy} onClick={() => void makeNew()} />
                </div>
              </>
            ) : (
              <span className="cx-muted">The access key can only be shown on the computer where SerieX runs.</span>
            )}
          </dd>
          {viaHelper(st) && (
            <>
              <dt>SerieX program</dt>
              <dd>
                <CodeBlock text={st.helper.path} what="the SerieX program location" />
                {st.helper.args.length > 0 && (
                  <>
                    <div className="cx-hint">Arguments, one per line:</div>
                    <CodeBlock text={st.helper.args.join('\n')} what="the arguments" />
                  </>
                )}
                <div className="cx-hint">Assistant apps start this program. It finds SerieX and the key by itself.</div>
              </dd>
            </>
          )}
        </dl>
      </div>
    </details>
  );
}
