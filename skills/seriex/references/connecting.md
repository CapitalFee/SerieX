# Connecting to SerieX Books (and finding SerieX Payroll)

How an assistant with a shell on the user's computer finds the running servers, picks a
company file, logs in, and reads the answers and errors. Everything here was checked
against a live SerieX Books 2026.10.2 server.

The helper `scripts/seriex.py` does all of this for you (finding the servers, choosing the
company, the session header, readable errors). Read on when it cannot find SerieX, when you
work without it (for example with `curl`), or when you need the exact rules.

## Contents

1. [Find the servers](#1-find-the-servers)
2. [Health and app info](#2-health-and-app-info)
3. [Company files and the company id](#3-company-files-and-the-company-id)
4. [Login, sessions and "Admin"](#4-login-sessions-and-admin)
5. [The request guard](#5-the-request-guard)
6. [Errors](#6-errors)
7. [Yes/No questions (code `confirm`)](#7-yesno-questions-code-confirm)
8. [The closing date password (code `closing_date`)](#8-the-closing-date-password-code-closing_date)
9. [What needs an administrator](#9-what-needs-an-administrator)

---

## 1. Find the servers

Both servers listen on `127.0.0.1` only (this computer). Nothing is on the internet.

| How SerieX runs | SerieX Books | SerieX Payroll |
|---|---|---|
| Desktop app (default) | `http://127.0.0.1:47180` | `http://127.0.0.1:47190` |
| Desktop app, port taken | next free of 47181-47189, else any free port | next free of 47191-47199, else any free port |
| Built from source (`start-books.sh`, `go run`) | `http://127.0.0.1:8080` | `http://127.0.0.1:8090` |

The desktop app remembers the ports it picked, so they stay the same between runs.

**Data folder** (the desktop app's folder for company files, logs and settings):

| System | Folder |
|---|---|
| macOS | `~/Library/Application Support/SerieX` |
| Windows | `%APPDATA%\SerieX` (for example `C:\Users\<you>\AppData\Roaming\SerieX`) |
| Linux | `$XDG_CONFIG_HOME/SerieX`, else `~/.config/SerieX` |
| Any | the environment variable `SERIEX_DATA_DIR`, when set, replaces the folder above |

What is inside:

```
<data>/books/            SerieX Books company files: <id>.sxb (+ <id>.sxb-wal, <id>.sxb-shm)
<data>/books/backups/    automatic backups, one folder per company id
<data>/payroll/          SerieX Payroll files (same ids as the Books company files)
<data>/logs/             books.log, payroll.log, main.log (the desktop app)
<data>/settings.json     remembered ports and window settings
<data>/servers.json      ONLY while the desktop app runs: the two servers' process ids and ports
```

`servers.json`, written by the desktop app when it starts the servers and removed when it quits
normally (exact format):

```json
{
  "books": { "pid": 51234, "port": 47180 },
  "payroll": { "pid": 51235, "port": 47190 }
}
```

`settings.json` keeps `"ports": {"books": 47180, "payroll": 47190}` (the ports to use next time)
plus window settings. After a crash `servers.json` can be left behind with dead process ids, so
always confirm with `GET /api/health`.

Discovery order:

1. Read `<data>/servers.json`; try `http://127.0.0.1:<books.port>/api/health`.
2. Else try the port in `settings.json` `ports.books`, then `47180`, then `8080`.
3. Still nothing: SerieX is not running. Ask the user to open the SerieX app. Do not start a
   second server on the same data folder yourself: two servers writing the same company files
   at once is not supported.

```sh
D="${SERIEX_DATA_DIR:-$HOME/Library/Application Support/SerieX}"   # macOS; see table for others
P=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['books']['port'])" "$D/servers.json" 2>/dev/null || echo 47180)
curl -s "http://127.0.0.1:$P/api/health"
```

Never copy or open a `.sxb` file directly while SerieX runs: the files use a write-ahead log
(`-wal` file), so a plain copy can miss recent changes. Use the backup endpoint
(`GET /api/companies/{id}/backup`, see company-admin.md).

## 2. Health and app info

`GET /api/health` -> `{"ok": true, "time": "2026-10-20T22:36:26-04:00"}`

`GET /api/info` on SerieX Books:

```json
{"app": "SerieX Books", "version": "2026.10.2", "payrollUrl": "http://127.0.0.1:47190", "payrollReachable": true}
```

`GET /api/info` on SerieX Payroll answers `{"app": "SerieX Payroll", "version", "booksUrl",
"booksReachable", "taxYears": [...]}`. Use the `app` field to tell the two apart. Books'
`payrollUrl` is the quickest way to find Payroll (`""` when Books was started without it).

## 3. Company files and the company id

`GET /api/companies` -> every company file of the data folder, most recently changed first:

```json
[{"id": "blue-fern-consulting-llc", "name": "Blue Fern Consulting LLC",
  "fileName": "blue-fern-consulting-llc.sxb",
  "path": "/Users/me/Library/Application Support/SerieX/books/blue-fern-consulting-llc.sxb",
  "modified": "2026-10-21T02:36:42Z", "size": 315392}]
```

- `id` is made from the company name when the file is created (lowercase letters, digits and
  dashes, at most 64 characters). A second file with the same name gets `-2`, `-3`... So two
  files can show the same `name`: tell the user both and ask which one (`modified` helps).
- Company routes are `/api/c/{id}/...`. The same id is used by SerieX Payroll.
- There is no "open company" step on the server: any file can be used at any time. The app
  (not the server) enters due automatic memorized transactions when a user opens a file.
- `sample-harborview` is the sample company (fake data). Never treat it as the user's books.

## 4. Login, sessions and "Admin"

`GET /api/companies/{id}/auth` -> `{"required": false, "users": ["Admin"]}`

- `users`: the active users, administrators first.
- `required: false`: **no active user has a password.** Every request works without login and
  runs as user `Admin`, an administrator. Send no session header.
- `required: true`: at least one active user has a password. **Every** company request then needs
  a session, or it fails with `401 {"code":"auth","error":"Please log in."}`.

Log in:

```
POST /api/companies/{id}/login
Content-Type: application/json

{"user": "maria", "password": "..."}
```

-> `{"token": "49171d66eb6554f8eed6f08bd6a1956f", "user": "maria"}`. Send the token on every
request to that company: header `X-Session: <token>`.

- User names are not case sensitive (`Maria` = `maria`); spaces around them are ignored.
- Wrong name or password: `400 {"code":"validation","field":"password","error":"The user name or
  password you entered is not correct. Please try again."}`. After 5 wrong passwords in a row for
  one user (20 for the file) logins are refused for 30 seconds, doubling up to 15 minutes:
  `429 {"code":"validation","error":"Too many incorrect passwords. Wait 30 seconds and try again."}`.
  Stop and tell the user; do not retry in a loop.
- **Once logins are required, a user without a password cannot log in** ("<name> has no
  password yet and cannot log in. Ask an administrator to give <name> a password."). SerieX
  also refuses to give any other user a password before an administrator has one ("Give the
  administrator Admin a password first..."), so the order is: Admin's password first, then the
  other users (Company > Set Up Users and Passwords > Set Up Users...; passwords need at least
  8 characters).
- The password is the user's, and it should not pass through the chat. With the helper, the
  user logs in once in their own terminal: `python3 scripts/seriex.py login` asks for the user
  name and password privately and keeps only the session token (in a private temporary file),
  which later commands reuse until SerieX restarts. Alternatively the user sets
  `SERIEX_USER` and `SERIEX_PASSWORD` in the environment the assistant runs in. Never ask for
  the password in the conversation, never put it on a command line, and never write it to a
  file. If the user does not want to log in this way, guide them through the screens instead.

Log out: `POST /api/c/{id}/logout` with the `X-Session` header -> `{"ok": true}` (works even when
the token is already invalid).

Session lifetime: tokens live in the server's memory only and have no time limit. A token ends
when: you log out; the server restarts (the desktop app quits, crashes or is restarted); the
user's password changes (other sessions of that user end; the session that changed it stays);
the user is made inactive or deleted; the company file is restored over, replaced or deleted. A
token is valid only for the company file it was made for. On `401 auth` in the middle of work,
log in again and resend the same request.

SerieX Payroll uses the SerieX Books users: its own `POST /api/companies/{id}/login` (on the Payroll
server) checks the name and password with Books and returns its own token (`{token, user,
isAdmin}`), sent to Payroll as `X-Session` too. A Books token does not work on Payroll and the
other way round. Details are in the payroll reference.

## 5. The request guard

SerieX Books refuses requests that look like they come from another web page. Programs such as
curl pass if they follow these rules:

- **Host**: call `127.0.0.1` or `localhost` (any IP address works; other names need the server
  flag `-allow-host`). Otherwise: `403 forbidden` "This address is not allowed. Open SerieX Books at
  http://127.0.0.1 or http://localhost."
- **Origin** (POST, PUT, PATCH, DELETE only): do not send an `Origin` header, or send exactly the
  server's own address (`http://127.0.0.1:47180`). A header `Sec-Fetch-Site` other than
  `same-origin`/`none` is refused too. Refused: `403 forbidden` "Requests from other web pages are
  not allowed."
- **Content-Type** of a request with a body: `application/json`, or `multipart/form-data` for
  file uploads (restore, imports). Anything else: `415 validation` "Send the request as JSON
  (Content-Type: application/json) or as a file upload." Note: `curl -d` alone sends
  `application/x-www-form-urlencoded` and is refused; always add `-H 'Content-Type: application/json'`.
- JSON bodies larger than 8 MB: `413 validation`.

GET requests never need a body or a content type.

## 6. Errors

Every error is JSON (all the optional fields are shown here; a real error has only some):

```json
{"error": "plain message for people", "code": "validation", "field": "closingDate",
 "warning": "dupnum", "data": {"existingId": 12}}
```

`field` (the JSON field at fault), `warning` (only with `confirm`) and `data` (extra details, for
example the record that already uses a name) appear only when they apply. The `error` text is
written for the user: you can show it as is.

| HTTP | `code` | Meaning | What to do |
|---|---|---|---|
| 400 | `validation` | Bad or missing input. `field` names the field. | Fix the request (or ask the user for the missing value) and resend. |
| 413 / 415 | `validation` | Body too large / wrong content type. | See section 5. |
| 429 | `validation` | Too many wrong passwords. | Wait the seconds given; tell the user. |
| 401 | `auth` | Login needed, or the token ended. | Log in (section 4) and resend. |
| 403 | `forbidden` | Logged in, but not allowed (needs an administrator), or refused by the guard. | Tell the user who can do it (section 9). Do not look for another way around. |
| 403 | `closing_date` | The transaction is dated on or before the closing date and a closing date password is set. | Section 8. |
| 404 | `not_found` | Record, company file or route does not exist (a wrong HTTP method also gives 404). | Check the id or path. |
| 409 | `conflict` | Cannot be done as asked (name in use, record used elsewhere, someone else changed it, only administrator...). | Explain to the user; change the request. Retrying the same request will not help. |
| 409 | `confirm` | A Yes/No question for the user. | Section 7. |
| 499 | `canceled` | The caller stopped waiting before the answer (mostly browsers). | Check whether the change was saved before sending it again. |
| 500 | `internal` | Unexpected failure, with a `(ref XXXXXX)` to find it in `logs/books.log`. | Tell the user; suggest File > Utilities > Check Company File. Messages say when the file is busy (wait and retry) or damaged (restore a backup). |

## 7. Yes/No questions (code `confirm`)

Some saves need the user's Yes first, like the message boxes of the app. The server answers
`409`:

```json
{"code": "confirm", "warning": "dupnum",
 "error": "Check number 102 has already been used in Checking. Do you want to keep this number anyway?"}
```

Nothing was saved. To answer Yes, resend **the same request** with `?accept=<warning>` (or header
`X-Accept: <warning>`). One request can raise several questions one after the other; add each
kind as the user accepts it: `?accept=closing,dupnum`. Accepting a kind that was not asked has no
effect on other questions.

| `warning` | Question |
|---|---|
| `dupnum` | The invoice, PO, bill (same vendor) or check (same bank account) number is already used. |
| `creditlimit` | The customer goes over their credit limit. |
| `inventory` | Selling more than the quantity on hand. |
| `inactive` | Using an inactive account, name or item. |
| `reconciled` | Changing or removing entries that were reconciled. |
| `deposited` | Changing or removing a payment that was deposited. |
| `applied` | Removing a transaction that has payments or credits applied. |
| `closing` | Dated on or before the closing date, and no closing date password is set. |
| `account` | A bank file for another account number. |
| `restore` | Replacing a company file's data with an automatic backup. |
| (none) | Bank feed match with a different amount: only `?force=1` answers it. |

`?force=1` answers Yes to every question, including ones you have not seen yet.

**Rule for assistants:** a `confirm` error is a question for the user, not an obstacle. Show the
user the exact `error` text and add the kind to `accept` only after the user said Yes to that
question in this conversation. Never add `accept` kinds or `force=1` in advance "to avoid
errors": these questions protect against duplicate numbers, changing reconciled or closed
periods, overselling stock and overwriting data. Use `force=1` only when the user said Yes to a
question that has no `warning` kind.

## 8. The closing date password (code `closing_date`)

An administrator can set a closing date (Company > Set Closing Date). Adding, changing,
deleting or voiding a transaction dated on or before it:

- with **no** closing date password: Yes/No question `confirm` with `warning: "closing"` (section 7);
- **with** a closing date password: `403`:

```json
{"code": "closing_date", "error": "This transaction is dated on or before the closing date of 01/31/2026. Enter the closing date password to continue."}
```

`?force=1` and `?accept=closing` do not pass it; only the header `X-Closing-Password: <password>`
does (it applies to the old and the new date of an edited transaction). A wrong one answers
`"The closing date password is incorrect."`; 5 wrong ones lock it out for a while (`429`).
Administrators need the password too.

**Rule for assistants:** never ask for the closing date password, never guess it, and never
send `X-Closing-Password` (the helper script has no way to send it, on purpose). The closing
date protects periods whose numbers were already reported or filed; a change there is a
decision the person who holds the password makes in SerieX themself. The usual right answer is
to tell the user that nothing was saved and why, and to suggest dating the correction after the
closing date (for example a journal entry in the current period), or asking their accountant.

## 9. What needs an administrator

When no active user has a password, everyone works as `Admin` and can do everything. Otherwise
these need a session of an administrator (`isAdmin: true`); others get `403 forbidden` with a
plain message:

| Action | Route |
|---|---|
| Add, delete users; change another user (name, administrator, active, password) | `POST /users`, `DELETE /users/{id}`, `PUT /users/{id}` |
| Change company information | `PUT /company` |
| Change company preferences (a regular user may change only: `windowMode`, `iconBar`, `showHomePageOnOpen`, `showRemindersOnOpen`, `autoRecall`, `autoFillPayee`, `defaultCheckAccountId`, `defaultBillPayAccountId`, `defaultDepositAccountId`) | `PUT /prefs` |
| Set or clear the closing date and its password | `PUT /closing-date` |
| View the audit trail (route and the Audit Trail report) | `GET /audit`, report `audit_trail` |
| Repair the company file (File > Utilities > Repair Company File) | `POST /rebuild` |
| Download a backup file; copy the company file | `GET /api/companies/{id}/backup`, `POST /api/companies/{id}/copy` |
| Change automatic backup settings | `PUT /backups/settings` |
| Replace the file with an automatic backup | `POST /backups/{bid}/restore` with `mode: "replace"` |
| Import QuickBooks Desktop files; import lists from Excel/CSV | `POST /qbimport/preview`, `POST /qbimport/run`, `POST /import/{entity}` |
| Delete a company file; replace a sample that has passwords | `DELETE /api/companies/{id}`, `POST /api/companies/sample` |

Any logged-in user may: enter and change transactions, change their own password, run Check
Company File, back up now, and everything else not listed.
Restoring an uploaded backup file as a new company file (`POST /api/companies/restore`) needs no
login at all (the new file keeps its own users and passwords).
