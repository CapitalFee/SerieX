# SerieX user guide

How to install SerieX is in the [README](../README.md#install). This guide covers the rest.

- [What the install command does](#what-the-install-command-does)
- [Updating](#updating)
- [Your company files](#your-company-files)
- [Backups](#backups)
- [Import from QuickBooks® Desktop](#import-from-quickbooks-desktop)
- [AI assistants](#ai-assistants)
- [Remove SerieX](#remove-seriex)
- [If something goes wrong](#if-something-goes-wrong)

## What the install command does

**Mac:** the command downloads SerieX from the latest release, checks it against the `SHA256SUMS` file published with that release (this proves the download is complete and undamaged, not who made it), installs SerieX in **Applications** and opens it. It removes the mark macOS puts on files downloaded from the internet, so macOS does not show its usual warning. If your user account cannot write to **Applications**, SerieX goes into the **Applications** folder inside your home folder instead. You do not need an administrator password.

**Windows:** the command downloads SerieX from the latest release, checks it against the `SHA256SUMS` file, installs it for your user account only in `%LOCALAPPDATA%\Programs\SerieX`, adds it to the Start menu and opens it. It unblocks the downloaded files, so Windows does not show its usual warning for apps from the internet. You do not need administrator rights.

Only run the command if you trust this project.

## Updating

Run the same install command again. It closes SerieX, replaces it with the newest version and keeps your company files. Save your work first. On a Mac, the update stops if a window still has unsaved changes, so you can save them.

If you installed from a downloaded file, download the new file and install it the same way.

## Your company files

SerieX keeps your books in this folder:

- **Mac:** `~/Library/Application Support/SerieX` (in Finder, choose **Go > Go to Folder** and paste this path)
- **Windows:** `%APPDATA%\SerieX` (paste this into the address bar of File Explorer)

You can also right-click an empty spot of the SerieX window and choose **Open Data Folder**.

Updating or removing SerieX never deletes this folder.

## Backups

SerieX backs up each company by itself, whenever the company changed since its last backup:

- once a day,
- and when you close the company with **File > Close Company** or quit SerieX.

On Windows, quit SerieX before you sign out, restart or shut down the computer. Windows closes programs that are still open without giving SerieX time to make that backup.

It keeps the latest 14 backups of each company, in the `books/backups/<company>` folder inside the folder above.

- To back up right away, choose **File > Back Up Company > Back Up Now**.
- To change how many backups are kept, pick another folder, or turn automatic backups off, choose **File > Back Up Company > Automatic Backup Settings**.
- To bring a backup back, choose **File > Open or Restore Company**.

These backups stay on the same computer. Now and then, also save a backup to an external drive or to cloud storage with **File > Back Up Company > Create Local Backup**.

Automatic backups cover SerieX Books only. SerieX Payroll data (employees, paychecks and tax forms) is in the `payroll` folder inside the folder above and is not backed up automatically. Copy that folder to an external drive or cloud storage after each payroll. If you restore a SerieX Books backup, payroll records made after that backup stay in SerieX Payroll, so check that payroll and the books still agree.

## Import from QuickBooks® Desktop

SerieX can bring your books over from files exported by QuickBooks® Desktop, into a new company file or into an open company that has no transactions yet. Choose **File > Utilities > Import > QuickBooks® Desktop (IIF files)**, or click **Import your books** on the welcome screen.

There are two ways:

- **Every transaction:** your lists (accounts, customers and jobs, vendors, other names, employees (as other names), items, classes, terms, payment and shipping methods, customer, vendor and job types, customer messages and sales reps) and your transactions (invoices, payments, deposits, checks, bills, bill payments, vendor credits, credit card charges and credits, journal entries, transfers, credit memos, sales receipts, statement charges and item receipts) from `.iif` files. QuickBooks® Desktop exports the lists itself, with **File > Utilities > Export > Lists to IIF Files**. The transactions need an IIF file made with an export tool or by your accountant.
- **Opening balances on a conversion date:** the lists, plus the Trial Balance, Open Invoices and Unpaid Bills Detail reports saved as CSV files. Transactions dated after the conversion date can be imported too.

A step-by-step guide shows what the files contain and lets you review how each entry is matched. A test run lists any problem, with its line in the file, before anything is saved. Afterwards, a printable report compares your new trial balance with the files and checks aging and the company file.

Bank rules and memorized transactions are not imported, because these export files do not include them. Instead of bank rules, the import suggests rules from how your transactions were classified. Group items, including sales tax groups, are not imported either, because the files do not list the items inside them. Estimates, sales orders and purchase orders are skipped, because they do not change your balances. Paychecks, and any other kind of transaction that SerieX Books has no form for, come in as journal entries with the same accounts and amounts. Payroll settings are not imported.

## AI assistants

You can let an AI assistant on the same computer read your books and answer questions about them, for example "Which customers are overdue?" or "How did this month compare with last month?".

- Click **AI Assistants** in the left sidebar to turn it on. It is set per company file, is off until an administrator turns it on, and can only look unless an administrator also allows changes.
- It works with assistant apps that run on your computer: the Claude desktop app and Claude Code, the ChatGPT desktop app (Work and Codex modes) and Codex, Grok Build, and other desktop apps that support the Model Context Protocol, such as Cursor, VS Code and LM Studio. The **AI Assistants** window shows the steps for each one. For the Claude desktop app, the **Set up Claude for me** button does it for you. Each release also includes the SerieX extension for Claude (a `.mcpb` file you can double-click to install).
- The web and phone versions of these assistants cannot reach SerieX, because SerieX only runs on your own computer.
- What the assistant reads is sent to the company that runs it, unless the assistant app runs the AI model on your own computer, as LM Studio can. Transactions an assistant saves are recorded in the audit trail under the SerieX user it works as, marked "(AI assistant)".

### Use the SerieX skill

The SerieX skill is a set of instructions that teaches an AI assistant how SerieX works, how to keep your books correct and how to reach SerieX on your computer. It works with Claude and with Codex. Once it is installed, you can ask things like "Which customers owe us money?" or "Help me record this bill".

#### Claude app or claude.ai

1. Download [`seriex.skill`](https://github.com/CapitalFee/SerieX/releases/latest/download/seriex.skill) from the latest release.
2. In Claude, open **Customize > Skills**, click **+**, then **Create skill > Upload a skill**, and choose `seriex.skill`. Skills need **Code execution and file creation**, which you turn on in **Settings > Capabilities**.

Claude's chats run on Claude's computers, not on yours, so the skill alone cannot reach SerieX. In the Claude desktop app, also connect SerieX: click **AI Assistants** in SerieX's left sidebar, turn on sharing for the company file and click **Set up Claude for me**. In a chat in a web browser or on a phone, the assistant cannot reach SerieX at all. There it guides you click by click, reads reports you export from SerieX, and prepares files for SerieX to import.

#### Claude Code or Codex

These run on your computer, so the assistant can work in SerieX directly. Unzip `seriex.skill` into the assistant's skills folder, so that you get a folder named `seriex` there:

- Claude Code: `~/.claude/skills/seriex`
- Codex: `~/.agents/skills/seriex`

On a Mac, this Terminal command does it for Claude Code. For Codex, change `.claude` to `.agents`.

```bash
mkdir -p ~/.claude/skills && curl -fsSL -o /tmp/seriex.skill https://github.com/CapitalFee/SerieX/releases/latest/download/seriex.skill && unzip -oq /tmp/seriex.skill -d ~/.claude/skills
```

If you have the SerieX source code, you can copy its `skills/seriex` folder there instead. On Windows, the folders are in your user folder (`%USERPROFILE%\.claude\skills` and `%USERPROFILE%\.agents\skills`), and `seriex.skill` is a ZIP file, so rename it to `seriex.zip` to unzip it. Start a new session afterwards.

#### Good to know

- SerieX must be open while the assistant works with it.
- In Claude Code and Codex, the skill talks to SerieX through a small helper script that needs [Python 3](https://www.python.org/downloads/).
- If your company file has passwords, log in once in your own Terminal, so that your password never goes through the chat. Do it again after SerieX restarts. For Codex, the path starts with `~/.agents`, and on Windows use `py` instead of `python3`.

  ```bash
  python3 ~/.claude/skills/seriex/scripts/seriex.py login
  ```

- **What the assistant may see and change.** When the assistant is connected through **AI Assistants** in SerieX, the settings there decide which company files it may see and whether it may change anything, and the skill follows them. The helper script is different: it works like any other program on your computer and can do what the SerieX user it logs in as can do, which is the administrator in a company file without passwords. Either way, the skill tells the assistant to show you each change and wait for your yes before saving it.

## Remove SerieX

Your company files are kept in all cases.

- **Mac:** drag SerieX from **Applications** to the Trash, or run this in Terminal:

  ```bash
  curl -fsSL https://github.com/CapitalFee/SerieX/releases/latest/download/install.sh | bash -s -- --uninstall
  ```

- **Windows:** open **Settings > Apps > Installed apps** (on Windows 10: **Settings > Apps > Apps & features**), find **SerieX** and choose **Uninstall**.

If you no longer need your company files either, delete the folder listed in [Your company files](#your-company-files).

## If something goes wrong

- **The Mac says SerieX "cannot be opened".** This happens when SerieX was installed from a downloaded file. Follow the Mac steps in [Prefer a download?](../README.md#prefer-a-download), or install with the Terminal command, which avoids the warning.
- **The Mac command says it could not replace the SerieX in Applications.** Another user on this Mac probably installed that copy. Drag it to the Trash and run the command again, or install a copy just for you in the Applications folder inside your home folder:

  ```bash
  curl -fsSL https://github.com/CapitalFee/SerieX/releases/latest/download/install.sh | SERIEX_INSTALL_DIR="$HOME/Applications" bash
  ```

- **Do not run the Mac command with `sudo`.** It does not need administrator rights, and it stops if you run it with sudo.
- **The Mac command says SerieX is still open.** A window probably has unsaved changes. Save your work, quit SerieX, and run the command again.
- **SerieX starts but stays on a loading screen.** Quit SerieX completely and open it again. SerieX runs two small helper programs on your computer, one for SerieX Books and one for SerieX Payroll. They only accept connections from your own computer, and if their usual ports are busy, SerieX picks free ones by itself.
- **Still stuck?** [Open an issue](https://github.com/CapitalFee/SerieX/issues) and say what you did and what you saw. The log can help: right-click an empty spot of the SerieX window and choose **Show Logs**. Check that it holds nothing private before you share it.
