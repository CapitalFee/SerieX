#!/usr/bin/env python3
"""Talk to a running SerieX Books or SerieX Payroll on this computer.

Uses only the Python standard library (Python 3.8 or later), on macOS, Windows and Linux.
Run `python3 seriex.py -h` for the commands. Paths that do not start with /api/ are
relative to the chosen company: `get /accounts` calls /api/c/<company>/accounts.

Settings (environment variables, all optional):
  SERIEX_BOOKS_URL    address of SerieX Books   (default: find the running app)
  SERIEX_PAYROLL_URL  address of SerieX Payroll (default: find the running app)
  SERIEX_COMPANY      company file id or exact name (default: the only company file)
  SERIEX_USER, SERIEX_PASSWORD   login, when the company file has passwords
  SERIEX_DATA_DIR     SerieX data folder, when the desktop app uses a custom one
  SERIEX_ALLOW_REMOTE=1          allow an address that is not this computer
"""

import argparse
import getpass
import json
import mimetypes
import os
import re
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid

TIMEOUT = 120
WARNING_KINDS = {
    "dupnum": "the number is already used by another transaction",
    "creditlimit": "the customer goes over its credit limit",
    "inventory": "selling more than the quantity on hand",
    "inactive": "using an inactive account, name or item",
    "reconciled": "changing or removing reconciled entries",
    "deposited": "changing or removing a payment that was deposited",
    "applied": "removing a transaction that has payments or credits applied",
    "closing": "the date is on or before the closing date",
    "account": "the bank file belongs to another account number",
}


class Fail(Exception):
    """A problem to show to the reader as plain text (exit code 1 or 2)."""

    def __init__(self, msg, code=2):
        super().__init__(msg)
        self.code = code


# ---------------------------------------------------------------------------
# Finding the servers


def data_dir():
    v = os.environ.get("SERIEX_DATA_DIR", "").strip()
    if v:
        return v
    if sys.platform == "win32":
        base = os.environ.get("APPDATA")
        return os.path.join(base, "SerieX") if base else ""
    if sys.platform == "darwin":
        return os.path.expanduser("~/Library/Application Support/SerieX")
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return os.path.join(base, "SerieX")


def desktop_ports():
    """Ports the desktop app uses: servers.json (running now), then settings.json (remembered)."""
    out = {}
    d = data_dir()
    if not d:
        return out
    for name, pick in (("servers.json", lambda v: v.get("port")), ("settings.json", None)):
        try:
            with open(os.path.join(d, name), encoding="utf-8") as f:
                doc = json.load(f)
        except (OSError, ValueError):
            continue
        if pick is None:
            doc = doc.get("ports") or {}
            pick = lambda v: v  # noqa: E731
        for key in ("books", "payroll"):
            if key in out or key not in doc:
                continue
            try:
                p = int(pick(doc[key]))
            except (TypeError, ValueError, AttributeError):
                continue
            if 0 < p < 65536:
                out[key] = p
    return out


def check_url(setting, raw):
    u = urllib.parse.urlparse(raw.strip())
    if u.scheme not in ("http", "https") or not u.hostname:
        raise Fail(f"{setting} must be an address such as http://127.0.0.1:47180 (got {raw!r}).")
    host = u.hostname.lower().rstrip(".")
    local = host in ("localhost", "::1") or host.endswith(".localhost") or re.match(r"^127\.\d+\.\d+\.\d+$", host)
    if not local and os.environ.get("SERIEX_ALLOW_REMOTE", "").lower() not in ("1", "true", "yes", "on"):
        raise Fail(f"{setting} must point to this computer (127.0.0.1 or localhost). "
                   "To use SerieX on another computer on purpose, also set SERIEX_ALLOW_REMOTE=1.")
    return f"{u.scheme}://{u.netloc}{u.path}".rstrip("/")


def raw_request(method, url, body=None, headers=None, timeout=TIMEOUT):
    """Returns (status, content type, bytes). Raises URLError when nothing answers."""
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.headers.get("Content-Type", ""), r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type", ""), e.read()


def probe(base):
    try:
        st, _, body = raw_request("GET", base + "/api/info", timeout=3)
        if st == 200:
            return json.loads(body.decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError):
        pass
    return None


def find_server(app):
    """Returns (base address, /api/info answer) of SerieX Books ("books") or Payroll ("payroll")."""
    env = "SERIEX_BOOKS_URL" if app == "books" else "SERIEX_PAYROLL_URL"
    label = "SerieX Books" if app == "books" else "SerieX Payroll"
    if os.environ.get(env, "").strip():
        base = check_url(env, os.environ[env])
        info = probe(base)
        if not info:
            raise Fail(f"{label} does not answer at {base} ({env}). Is SerieX running?")
        return base, info
    candidates = []
    p = desktop_ports().get(app)
    if p:
        candidates.append(f"http://127.0.0.1:{p}")
    if app == "payroll":
        try:
            _, binfo = find_server("books")
            if binfo.get("payrollUrl"):
                candidates.append(check_url("payrollUrl", binfo["payrollUrl"]))
        except Fail:
            pass
        candidates += ["http://127.0.0.1:47190", "http://127.0.0.1:8090"]
    else:
        candidates += ["http://127.0.0.1:47180", "http://127.0.0.1:8080"]
    seen = set()
    for base in candidates:
        if base in seen:
            continue
        seen.add(base)
        info = probe(base)
        if info and label.lower() in str(info.get("app", "")).lower():
            return base, info
    raise Fail(f"{label} is not running on this computer (tried {', '.join(seen)}). "
               f"Ask the user to open SerieX, or set {env} to its address.")


# ---------------------------------------------------------------------------
# Login tokens (kept in a private temporary file so the user can log in once)


def token_file(base, cid):
    user = re.sub(r"[^A-Za-z0-9_.-]", "_", getpass.getuser() or "user")
    d = os.path.join(tempfile.gettempdir(), f"seriex-skill-{user}")
    os.makedirs(d, mode=0o700, exist_ok=True)
    key = re.sub(r"[^A-Za-z0-9_.-]", "_", f"{urllib.parse.urlparse(base).netloc}-{cid}")
    return os.path.join(d, f"session-{key}.json")


def load_token(base, cid):
    try:
        with open(token_file(base, cid), encoding="utf-8") as f:
            return json.load(f).get("token", "")
    except (OSError, ValueError):
        return ""


def save_token(base, cid, token, user):
    path = token_file(base, cid)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"token": token, "user": user}, f)


def drop_token(base, cid):
    try:
        os.remove(token_file(base, cid))
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Client


class Client:
    def __init__(self, app, company_arg):
        self.app = app
        self.base, self.info = find_server(app)
        self.company_arg = company_arg
        self._cid = None
        self._cname = None
        self.token = ""

    def companies(self):
        data = self.call_json("GET", "/api/companies", company=False)
        return data if isinstance(data, list) else []

    def company(self):
        if self._cid:
            return self._cid
        want = (self.company_arg or os.environ.get("SERIEX_COMPANY", "")).strip()
        lst = self.companies()
        names = ", ".join(f'"{c.get("name")}" (id {c.get("id")})' for c in lst)
        if want:
            for test in (lambda c: str(c.get("id", "")).lower() == want.lower(),
                         lambda c: str(c.get("name", "")).strip().lower() == want.lower()):
                hit = [c for c in lst if test(c)]
                if hit:
                    self._cid, self._cname = hit[0]["id"], hit[0].get("name", "")
                    return self._cid
            raise Fail(f'Company "{want}" was not found. Company files: {names or "none"}.')
        if len(lst) == 1:
            self._cid, self._cname = lst[0]["id"], lst[0].get("name", "")
            return self._cid
        if not lst:
            raise Fail("There are no company files yet. Create or open a company in SerieX first.")
        raise Fail(f"There are {len(lst)} company files: {names}. Ask the user which one to use, "
                   "then pass --company <id> (or set SERIEX_COMPANY).")

    def login(self, user, password):
        cid = self.company()
        body = json.dumps({"user": user, "password": password}).encode("utf-8")
        st, ctype, raw = raw_request("POST", f"{self.base}/api/companies/{urllib.parse.quote(cid)}/login",
                                     body, {"Content-Type": "application/json", "Accept": "application/json"})
        data = parse(raw, ctype)
        if st != 200 or not isinstance(data, dict):
            raise Fail(explain(st, data), 1)
        self.token = data.get("token", "")
        save_token(self.base, cid, self.token, data.get("user", user))
        return data.get("user", user)

    def path(self, p, company=True):
        if p.startswith("http://") or p.startswith("https://"):
            raise Fail("Give a path such as /accounts or /api/info, not a full address.")
        if not p.startswith("/"):
            p = "/" + p
        if p.startswith("/api/") or not company:
            return p
        return f"/api/c/{urllib.parse.quote(self.company())}{p}"

    def call(self, method, p, query=None, body=None, ctype=None, company=True, retry=True):
        full = self.path(p, company)
        url = self.base + full
        if query:
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode(query)
        headers = {"Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = ctype or "application/json"
        cid = None
        m = re.match(r"^/api/c/([^/]+)/", full)
        if m:
            cid = urllib.parse.unquote(m.group(1))
            if not self.token:
                self.token = load_token(self.base, cid)
            if self.token:
                headers["X-Session"] = self.token
        try:
            st, rtype, raw = raw_request(method, url, body, headers)
        except (urllib.error.URLError, OSError) as e:
            raise Fail(f"Could not reach {self.base}: {e}. Is SerieX still running?")
        if st == 401 and cid and retry:
            user = os.environ.get("SERIEX_USER", "").strip()
            pw = os.environ.get("SERIEX_PASSWORD", "")
            drop_token(self.base, cid)
            self.token = ""
            if user and pw:
                self._cid = cid
                self.login(user, pw)
                return self.call(method, p, query, body, ctype, company, retry=False)
        return st, (raw if rtype and "json" not in rtype else parse(raw, rtype)), rtype

    def call_json(self, method, p, query=None, body=None, ctype=None, company=True):
        st, data, _ = self.call(method, p, query, body, ctype, company)
        if st >= 400:
            raise Fail(explain(st, data), 1)
        return data


def parse(raw, ctype):
    if not raw:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return raw.decode("utf-8", "replace")


def explain(status, data):
    """Turns a SerieX error answer into instructions the assistant can follow."""
    if not isinstance(data, dict):
        return f"HTTP {status}: {str(data)[:500]}"
    code, msg = data.get("code", ""), data.get("error", "")
    out = [f"SerieX refused ({code or status}): {msg}"]
    if data.get("field"):
        out.append(f"Field: {data['field']}")
    if code == "confirm":
        kind = data.get("warning", "")
        out.append("NOTHING WAS SAVED. SerieX asks the user a Yes/No question.")
        if kind:
            out.append(f"Warning kind: {kind} ({WARNING_KINDS.get(kind, 'see the message')}).")
            out.append(f"Ask the user. Only if they clearly say yes, run the same command again with "
                       f"--accept {kind} (add it to any kinds already accepted).")
        else:
            out.append("This question has no warning kind. Ask the user. Only if they clearly say yes to this "
                       "exact question, run the same command again with --force (it answers Yes to the "
                       "questions of this one request).")
    elif code == "closing_date":
        out.append("NOTHING WAS SAVED. The date is on or before the closing date. Changes there need the "
                   "closing date password, which the user types in the SerieX app themselves. "
                   "Do not ask for it. Offer to use a later date if that is what the user meant.")
    elif code == "auth":
        out.append("A login is needed. Ask the user to run `python3 scripts/seriex.py login` (in this skill's folder) in their own terminal "
                   "(it asks for the password privately), or to set SERIEX_USER and SERIEX_PASSWORD. "
                   "Never ask for the password in the chat.")
    elif code == "books_unavailable":
        out.append("SerieX Payroll could not reach SerieX Books. Ask the user to check that SerieX is "
                   "open with the company, then try again.")
    elif code == "books_auth":
        out.append("SerieX Payroll's login to SerieX Books expired. The user logs in again "
                   "(`python3 scripts/seriex.py --payroll login` in their own terminal, or in the app).")
    elif code == "forbidden":
        out.append("The logged-in SerieX user is not allowed to do this (often: administrator only).")
    elif code == "not_found":
        out.append("Check the id or path (list the records first).")
    elif code == "conflict":
        if data.get("data"):
            out.append("Details: " + json.dumps(data["data"], ensure_ascii=False)[:800])
    elif code == "internal":
        out.append("An unexpected server problem. Do not retry in a loop; tell the user, and suggest "
                   "File > Utilities > Check Company File in SerieX if it keeps happening.")
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Output


def trim(data, fields, limit):
    note = ""
    if isinstance(data, dict) and isinstance(data.get("rows"), list) and set(data) <= {"rows", "total"}:
        rows, note = trim(data["rows"], fields, limit)
        out = {"rows": rows}
        if "total" in data:
            out["total"] = data["total"]
        return out, note
    if isinstance(data, list):
        if limit and len(data) > limit:
            note = f"... {len(data) - limit} more of {len(data)} (use filters, --limit or --out)"
            data = data[:limit]
        if fields:
            data = [{k: d.get(k) for k in fields} if isinstance(d, dict) else d for d in data]
    elif isinstance(data, dict) and fields:
        data = {k: data.get(k) for k in fields}
    return data, note


def emit(data, args, note=""):
    if getattr(args, "out", None):
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f"Saved to {args.out}")
        return
    if data is None:
        print("OK (no content)")
        return
    if isinstance(data, (str, bytes)):
        print(data.decode("utf-8", "replace") if isinstance(data, bytes) else data)
        return
    fields = [f.strip() for f in (args.fields or "").split(",") if f.strip()]
    data, n = trim(data, fields, args.limit)
    if args.compact:
        print(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    else:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    for x in (n, note):
        if x:
            print(x)


def money(v):
    if isinstance(v, bool) or v is None:
        return "" if v is None else str(v)
    if isinstance(v, (int, float)):
        return f"{v:,.2f}"
    return str(v)


def render_report(rep, drill=False):
    """A report answer as an indented text table."""
    cols = rep.get("columns") or []
    lines = []
    head = [rep.get("title", ""), rep.get("companyName", ""), rep.get("dateRangeLabel", ""), rep.get("basis", "")]
    lines.append(" | ".join(h for h in head if h))
    if not cols:
        return "\n".join(lines + [json.dumps(rep.get("rows", []), ensure_ascii=False)[:4000]])
    first, rest = cols[0], cols[1:]
    def cell(c, row):
        v = (row.get("cells") or {}).get(c.get("key"))
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            t = c.get("type")
            if t == "percent":
                return f"{v:.1f}%"
            if t == "money":
                return money(v)
            return f"{v:,.0f}" if float(v).is_integer() else f"{v:,.4f}".rstrip("0")
        return "" if v is None else str(v)
    widths = []
    for c in rest:
        w = len(str(c.get("label", "")))
        for r in rep.get("rows", []):
            w = max(w, len(cell(c, r)))
        widths.append(min(max(w, 6), 40))
    lw = 8
    for r in rep.get("rows", []):
        lw = max(lw, min(70, 2 * int(r.get("level", 0)) + len(cell(first, r))))
    def fit(c, text, w):
        return text[:w].ljust(w) if c.get("type") in ("text", "date", None, "") else text[:w].rjust(w)
    lines.append((" " * lw + "  " + "  ".join(fit(c, str(c.get("label", "")), w) for c, w in zip(rest, widths))).rstrip())
    for r in rep.get("rows", []):
        label = "  " * int(r.get("level", 0)) + cell(first, r)
        vals = "  ".join(fit(c, cell(c, r), w) for c, w in zip(rest, widths))
        line = f"{label[:lw].ljust(lw)}  {vals}".rstrip()
        if drill and r.get("txnId"):
            line += f"   [txn {r['txnId']}]"
        if drill and r.get("drill"):
            line += f"   [drill: {r['drill'].get('report')} {urllib.parse.urlencode(r['drill'].get('params') or {})}]"
        lines.append(line)
    if rep.get("params"):
        lines.append("params: " + urllib.parse.urlencode(rep["params"]))
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Commands


def kv(pairs):
    out = []
    for p in pairs or []:
        if "=" not in p:
            raise Fail(f"Expected key=value, got {p!r}.")
        k, v = p.split("=", 1)
        out.append((k, v))
    return out


def read_body(arg):
    if arg is None:
        return None
    if arg == "-":
        text = sys.stdin.read()
    elif arg.startswith("@"):
        with open(arg[1:], encoding="utf-8") as f:
            text = f.read()
    else:
        text = arg
    try:
        json.loads(text)
    except ValueError as e:
        raise Fail(f"The request body is not valid JSON: {e}")
    return text.encode("utf-8")


def with_accept(query, args):
    kinds = sorted({k.strip().lower() for k in (args.accept or "").split(",") if k.strip()})
    bad = [k for k in kinds if k not in WARNING_KINDS]
    if bad:
        raise Fail(f"Unknown warning kind(s): {', '.join(bad)}. Known: {', '.join(WARNING_KINDS)}.")
    if kinds:
        query.append(("accept", ",".join(kinds)))
    if getattr(args, "force", False):
        query.append(("force", "1"))
    return query


def cmd_status(c, args):
    print(f"{c.info.get('app')} {c.info.get('version', '')} at {c.base}")
    if c.app == "books" and "payrollUrl" in c.info:
        print(f"SerieX Payroll: {c.info.get('payrollUrl') or 'not set'}"
              f" ({'reachable' if c.info.get('payrollReachable') else 'not reachable'})")
    lst = c.companies()
    print(f"Company files ({len(lst)}):")
    for co in lst:
        line = f"  - {co.get('name')}  (id: {co.get('id')})"
        st, auth, _ = c.call("GET", f"/api/companies/{urllib.parse.quote(str(co.get('id')))}/auth")
        if st == 200 and isinstance(auth, dict):
            line += "  login: " + ("password needed, users " + ", ".join(auth.get("users", [])) if auth.get("required") else "none needed")
        print(line)


def cmd_companies(c, args):
    emit(c.companies(), args)


def cmd_get(c, args):
    emit(c.call_json("GET", args.path, kv(args.params)), args)


def cmd_write(c, args):
    method = args.cmd.upper()
    body = read_body(args.data) if method != "DELETE" else None
    if method in ("POST", "PUT") and body is None:
        body = b"{}"
    query = with_accept(kv(args.params), args)
    if args.dry_run:
        print(f"{method} {c.base}{c.path(args.path)}" + (("?" + urllib.parse.urlencode(query)) if query else ""))
        if body:
            print(body.decode("utf-8"))
        print("(dry run: nothing was sent)")
        return
    emit(c.call_json(method, args.path, query, body), args)


def cmd_upload(c, args):
    boundary = "----seriex" + uuid.uuid4().hex
    name = os.path.basename(args.file)
    with open(args.file, "rb") as f:
        content = f.read()
    ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
    parts = []
    for k, v in kv(args.form):
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode("utf-8"))
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{args.field}"; filename="{name}"\r\n'
                 f"Content-Type: {ctype}\r\n\r\n".encode("utf-8") + content + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode("utf-8"))
    query = with_accept(kv(args.params), args)
    emit(c.call_json("POST", args.path, query, b"".join(parts), f"multipart/form-data; boundary={boundary}"), args)


def cmd_download(c, args):
    st, data, rtype = c.call("GET", args.path, kv(args.params))
    if st >= 400:
        raise Fail(explain(st, data if isinstance(data, dict) else parse(data, "json")), 1)
    raw = data if isinstance(data, bytes) else (json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
                                                 if not isinstance(data, str) else data.encode("utf-8"))
    with open(args.outfile, "wb") as f:
        f.write(raw)
    print(f"Saved {len(raw):,} bytes to {args.outfile}")


def cmd_report(c, args):
    if not args.key:
        rows = c.call_json("GET", "/reports")
        for r in rows:
            print(f"{r.get('key'):38} {r.get('category', '')[:26]:26} {r.get('title', '')}")
        return
    rep = c.call_json("GET", f"/reports/{urllib.parse.quote(args.key)}", kv(args.params))
    if args.json or args.out:
        emit(rep, args)
    else:
        print(render_report(rep, args.drill))


def cmd_backup(c, args):
    emit(c.call_json("POST", "/backups", None, b"{}"), args)


def cmd_login(c, args):
    user = args.user or os.environ.get("SERIEX_USER", "").strip()
    if not user:
        cid = c.company()
        st, auth, _ = c.call("GET", f"/api/companies/{urllib.parse.quote(cid)}/auth")
        users = auth.get("users", []) if isinstance(auth, dict) else []
        if isinstance(auth, dict) and not auth.get("required"):
            print("This company file has no passwords: no login is needed.")
            return
        if not sys.stdin.isatty():
            raise Fail("Pass --user NAME. Users: " + ", ".join(users))
        user = input(f"SerieX user ({', '.join(users)}): ").strip()
    pw = os.environ.get("SERIEX_PASSWORD", "")
    if not pw:
        if not sys.stdin.isatty():
            raise Fail("The password must be typed by the user: run this command in your own terminal, "
                       "or set SERIEX_PASSWORD.")
        pw = getpass.getpass(f"Password for {user}: ")
    name = c.login(user, pw)
    print(f"Logged in to {c._cname or c.company()} as {name}. Other commands now use this login "
          "until SerieX restarts or you run logout.")


def cmd_logout(c, args):
    cid = c.company()
    c.call("POST", f"/api/c/{urllib.parse.quote(cid)}/logout", body=b"{}")
    drop_token(c.base, cid)
    print("Logged out.")


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        try:
            getattr(stream, "reconfigure")(encoding="utf-8")
        except (AttributeError, OSError, ValueError):
            pass
    p = argparse.ArgumentParser(prog="seriex.py", description="Talk to SerieX Books or SerieX Payroll on this computer.")
    p.add_argument("--payroll", action="store_true", help="talk to SerieX Payroll instead of SerieX Books")
    p.add_argument("--company", "-c", help="company file id or exact name (see `companies`)")
    out = argparse.ArgumentParser(add_help=False)
    out.add_argument("--fields", help="keep only these keys (comma separated) of each record")
    out.add_argument("--limit", type=int, default=0, help="show at most N records of a list")
    out.add_argument("--compact", action="store_true", help="one-line JSON")
    out.add_argument("--out", help="save the full JSON answer to this file instead of printing it")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status", help="find SerieX, show the version, company files and whether a login is needed")
    sub.add_parser("companies", parents=[out], help="list company files (id, name, file)")
    g = sub.add_parser("get", parents=[out], help="GET a path, e.g. get /accounts  or  get /txns type=invoice")
    g.add_argument("path")
    g.add_argument("params", nargs="*", help="query parameters as key=value")
    for name in ("post", "put", "delete"):
        w = sub.add_parser(name, parents=[out], help=f"{name.upper()} a path with a JSON body")
        w.add_argument("path")
        if name != "delete":
            w.add_argument("--data", "-d", help="JSON body, @file.json, or - for standard input")
        w.add_argument("params", nargs="*", help="query parameters as key=value")
        w.add_argument("--accept", help="warning kinds the USER said yes to, e.g. dupnum,inventory")
        w.add_argument("--force", action="store_true",
                       help="answer Yes to a question WITHOUT a warning kind, after the user said yes to it")
        w.add_argument("--dry-run", action="store_true", help="print the request without sending it")
    u = sub.add_parser("upload", parents=[out], help="send a file (bank file import, CSV list import)")
    u.add_argument("path")
    u.add_argument("file")
    u.add_argument("--field", default="file", help="form field name of the file (default: file)")
    u.add_argument("--form", nargs="*", help="other form fields as key=value")
    u.add_argument("params", nargs="*", help="query parameters as key=value")
    u.add_argument("--accept", help="warning kinds the USER said yes to")
    u.add_argument("--force", action="store_true",
                   help="answer Yes to a question WITHOUT a warning kind, after the user said yes to it")
    d = sub.add_parser("download", help="save an answer (CSV export, backup file) to a file")
    d.add_argument("path")
    d.add_argument("outfile")
    d.add_argument("params", nargs="*", help="query parameters as key=value")
    r = sub.add_parser("report", parents=[out], help="run a report as a text table; no key lists the reports")
    r.add_argument("key", nargs="?")
    r.add_argument("params", nargs="*", help="report parameters as key=value, e.g. from=2026-01-01 to=2026-03-31")
    r.add_argument("--json", action="store_true", help="print the raw JSON answer")
    r.add_argument("--drill", action="store_true", help="show how to open the transactions behind each row")
    sub.add_parser("backup", parents=[out], help="back up the company file now (File > Back Up Company > Back Up Now)")
    li = sub.add_parser("login", help="log in (the user types the password; it is never shown)")
    li.add_argument("--user")
    sub.add_parser("logout", help="log out and forget the saved login")

    args = p.parse_args(argv)
    for name in ("fields", "limit", "compact", "out"):
        if not hasattr(args, name):
            setattr(args, name, None if name != "limit" else 0)
    try:
        c = Client("payroll" if args.payroll else "books", args.company)
        handler = {"status": cmd_status, "companies": cmd_companies, "get": cmd_get, "post": cmd_write,
                   "put": cmd_write, "delete": cmd_write, "upload": cmd_upload, "download": cmd_download,
                   "report": cmd_report, "backup": cmd_backup, "login": cmd_login, "logout": cmd_logout}[args.cmd]
        handler(c, args)
    except Fail as e:
        print(str(e), file=sys.stderr)
        return e.code
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
