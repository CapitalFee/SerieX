# SerieX screens guide (SerieX Books and SerieX Payroll)

Use this file to guide a user click by click through the screens, or to tell the user where to
look at something you created through the API. Every label below is copied from the app's code
(web/src and payroll/web/src). Labels change between versions; if the user sees something
slightly different, trust the screen.

## Contents

1. [Conventions](#1-conventions)
2. [Orientation](#2-orientation)
   - 2.1 Starting SerieX, the data folder, the desktop app menus
   - 2.2 Window layout
   - 2.3 Home page (Books)
   - 2.4 Apps button (switch Books / Payroll)
   - 2.5 + New button
   - 2.6 Search box
   - 2.7 Tabs, floating windows, closing windows
   - 2.8 How transaction forms work (toolbar, Save and close, Save and new)
   - 2.9 List and edit dialogs
   - 2.10 Pickers and quick create
   - 2.11 Line grids, date fields, amount fields
   - 2.12 Keyboard shortcuts (Windows and Mac)
   - 2.13 Features that hide menu items
3. [SerieX Books menu map](#3-seriex-books-menu-map)
4. [SerieX Payroll menu map](#4-seriex-payroll-menu-map)
5. [Books: task-by-task click paths](#5-books-task-by-task-click-paths)
6. [Payroll: task-by-task click paths](#6-payroll-task-by-task-click-paths)
7. [Center screens and lists: what each panel shows](#7-center-screens-and-lists-what-each-panel-shows)
8. [Where to see what the API did](#8-where-to-see-what-the-api-did)

---

## 1. Conventions

- "A > B > C" means: open menu A in the menu bar, choose B, then C in its submenu.
- "▾" after a button name means the button opens a small menu.
- Menu items ending with "..." open a dialog. The underlined letter of a menu item is its
  access key (Alt+letter, see 2.12). This guide drops the underline marks.
- Field names on transaction forms are shown in CAPITAL LETTERS on screen (the code writes some
  in mixed case, the style turns them to capitals). This guide writes them in capitals for
  transaction forms and as written for dialogs.
- A small "?" next to a field name explains the accounting term in plain words (hover or click).
- Some menu items exist only when a feature is on in Preferences (section 2.13).
- When a window is narrow, the toolbar of a form shows icons only; the name of each icon
  appears when the mouse rests on it. Tell the user to hover if they do not see a word.

---

## 2. Orientation

### 2.1 Starting SerieX, the data folder, the desktop app menus

- The desktop app is called **SerieX**. It holds both apps in one window. The first time it opens
  SerieX Books; later it opens the app used last.
- With no company open, Books shows the **Welcome to SerieX Books** screen with three big
  buttons: **Create a new company**, **Open or restore a company**, **Explore the sample company**
  (or **Open the sample company** once it exists), a link **Moving from QuickBooks® Desktop?
  Import your books**, and the list **Your companies** (search box "Find a company", **Open**,
  and an x to remove a file from the list without deleting it). When the sample exists there is
  also **Start the sample company over**.
- Payroll with no company open shows the SerieX Books companies with a payroll status
  (**No payroll yet**, **Setup not finished**, **Payroll set up**) and a button per row
  (**Set Up Payroll** or **Open**), plus cards **Set up payroll**, **Open SerieX Books**,
  **How payroll works**. If SerieX Payroll or Books cannot be reached, a banner with **Retry**.
- Company files and logs (desktop app):
  - Mac: `~/Library/Application Support/SerieX` (Finder: Go > Go to Folder).
  - Windows: `%APPDATA%\SerieX` (paste in File Explorer's address bar).
  - Ubuntu: `~/.config/SerieX` (Files: Ctrl+L, paste the path).
  - Books company files are in the `books` subfolder (`<id>.sxb`), automatic backups in
    `books/backups/<company>`, payroll files in `payroll`, logs in `logs`.
  - Fast way: right-click an empty spot of the SerieX window > **Open Data Folder** or
    **Show Logs**.
- Desktop app menus (outside the page):
  - **Mac** menu bar: **SerieX** (About SerieX, Services, Hide SerieX, Hide Others, Show All,
    Quit SerieX), **Edit** (Undo, Redo, Cut, Copy, Paste, Paste and Match Style, Delete, Select
    All), **View** (Reload Cmd+R, Actual Size Cmd+0, Zoom In Cmd+=, Zoom Out Cmd+-, Toggle Full
    Screen), **Go** (SerieX Books Cmd+1, SerieX Payroll Cmd+2), **Window** (Minimize, Zoom,
    Close Window, Bring All to Front), **Help** (**Open Data Folder**, **Show Logs**,
    **License**, **Third-Party Notices**).
  - **Windows and Linux**: no native menu bar (the page draws its own). Use the keys in 2.12 and
    the right-click menu.
  - **Right-click on an empty spot** (all systems): SerieX Books (Ctrl/Cmd+1), SerieX Payroll
    (Ctrl/Cmd+2), Reload (F5 on Windows and Linux, Cmd+R on Mac), Zoom ▸ (Actual Size, Zoom In,
    Zoom Out), Full Screen (F11) / Toggle Full Screen (Ctrl+Cmd+F), **Open Data Folder**,
    **Show Logs**, and on Windows and Linux **License**, **Third-Party Notices** and
    **About SerieX**. Right-click in a text field gives Undo, Redo, Cut, Copy, Paste, Select All.
  - Reload, switching app and closing the window ask first when a window has unsaved changes.

### 2.2 Window layout (Books; Payroll has the same frame)

From top to bottom, left to right:

1. **Top bar** (dark): a "collapse navigation" button (three lines), the app mark
   **SerieX Books**, the **apps button** (nine dots, 2.4), the **company name button** (menu:
   Recent companies, **Open or restore company...**, **New company...**, **Company
   information...**, **Close company**), the **search box** (2.6), a **?** help button (F1), and
   the **user button** with initials (menu: **Preferences...**, **Users and passwords...**,
   **Log out** (only when users have passwords), **Close company**).
   Payroll's company menu has **Open or set up company...**, **Open SerieX Books**, **Company
   payroll information...**, **Close company**; its user menu has **Preferences...**, **Payroll
   access...** (administrators), **Log out**, **Close company**.
2. **Left navigation** (dark, default): the blue **+ New** button (2.5), then groups:
   - Books: **Home**; **Customers & Sales** (Customers, Money In, Receive Payments);
     **Vendors & Expenses** (Vendors, Money Out, Pay Bills, Sales Tax); **Banking**
     (Bank Imports, Registers, Reconcile, Deposits); **Reports** (All Reports, Profit and Loss,
     Balance Sheet, starred reports, up to 8 memorized reports, Memorized Reports); **Lists**
     (Chart of Accounts, Products & Services, Other Names, Classes, Terms, Memorized
     Transactions); **Company** (Company Profile, Insights, Calendar, Company Info, Preferences,
     Users).
   - Payroll: **Home**; **Employees** (Employee Center, Payroll Center); **Payroll** (Pay
     Employees, Find and Edit Paychecks, Print Paychecks, Print Pay Stubs, Year-to-Date
     Amounts); **Taxes & Forms** (Pay Payroll Taxes, Adjust Tax Balances, Earlier Tax Payments,
     Tax Forms, W-2/W-3); **Reports** (Report Center and 5 favorite reports); **Lists** (Payroll
     Items, Pay Schedules); **Company** (Company Payroll Info, Preferences, Tax Tables,
     Payroll Setup, Audit Trail); **SerieX Books** (Books Sync, Open SerieX Books).
   - Bottom tabs: **Balances** (account balances; click one to open its register) and
     **Open Windows** (list of open windows, x closes one). Payroll has **Taxes Due** (payroll
     taxes due) instead of Balances.
   - View > Top Icon Bar puts a row of icons under the menu bar instead (Books icons: Home,
     Company Profile, Money In, Money Out, Calendar, Insights, Customers, Vendors, Bank Imports,
     Reports, Chart of Accounts, Item List, Reconcile; Payroll: Home, Employees, Payroll Center,
     Pay Employees, Pay Taxes, Tax Forms, Payroll Items, Reports, Books Sync, Open
     SerieX Books). View > Hide Navigation leaves only the menus.
3. **Menu bar** (right of the navigation): File, Edit, View, Lists, Favorites, Company,
   Customers, Vendors, Banking, Reports, Window, Help (Books); File, Edit, View, Lists,
   Employees, Reports, Window, Help (Payroll).
4. **Tab strip** (Tabs workspace, the default): one tab per open window, a dot on tabs with
   unsaved changes, x to close, a ▾ at the right listing all open windows. Right-click a tab:
   Close, Close others, Close tabs to the right, Close all. Middle-click closes. Drag to reorder.
5. **Work area**: the active window.

### 2.3 Home page (Books)

Opens when a company opens (Preferences > Workspace > "Show the Home page"). Also Company >
Home Page, or **Home** in the navigation. Top: **Home | Insights** switch, company name and date,
**Refresh**.

- Dashboard cards (click a title or a figure to drill in):
  - **Money in**: unpaid total, overdue (opens Overdue Invoices with Contacts), not due yet
    (Open Invoices), received last 30 days (Money In).
  - **Money out**: to pay, overdue bills (Unpaid Bills Detail), not due yet (Pay Bills), paid
    last 30 days (Money Out).
  - **Bank accounts**: each bank and card account with its balance, "N to review" (downloaded
    transactions waiting in Bank Imports) and the last reconciled date or "Not reconciled". Click
    a name to open its register.
  - **Profit and Loss**: net income this month compared with last month, small chart.
  - **Tasks**: things that need attention (overdue invoices, sales tax payments due, bills to
    pay, payments to deposit, memorized transactions due, to dos), link **See all reminders**.
- **Everyday tasks** card ("In the order they usually happen. Click a task to start."): four
  cards of numbered steps (steps for estimates, purchase orders, inventory and sales tax appear
  only when those features are on):
  - **Sell** ("Quote, invoice and get paid"): Estimate, Invoice, Receive a payment, Sales
    receipt, Credit or refund, Statement charge, Customer statements.
  - **Buy** ("Order, record bills and pay them"): Purchase order, Receive items, Bill for
    received items, Enter a bill, Pay bills, Pay sales tax.
  - **Bank** ("Deposit, spend and reconcile"): Deposit, Write a check, Print checks, Card
    charge, Import bank activity, Reconcile, Bank register.
  - **Books** ("Accounts, products and reports"): Chart of accounts, Products and services,
    Adjust inventory, Journal entry, Calendar, Reports.
- Right column: **Account balances** (click to open a register) and **Backup status** (last
  backup, **Back up now**, **Backup settings**).
- New company only: a **Get started** checklist: Add your bank accounts (**Add account**), Add
  your first customer (**Add customer**), Add a product or service (**Add item**), Set up sales
  tax (**Set up sales tax**, only when sales tax is on), Create your first invoice (**Create
  invoice**), Record an expense (**Enter bill**). An x hides it.

Payroll Home: cards **Pay employees** (next check date, **Pay Employees**), **Payroll
taxes** (Overdue, Due soon), **Last payroll**, **Tax forms** (next form due), right column
**Payroll summary** (this year) and **SerieX Books** (link status, **Open SerieX Books**, **Books
Sync**). A banner with **Continue Payroll Setup** shows while setup is not finished. Workflows
diagram: Employees (Employee Center > Pay Employees > Pay Payroll Taxes > Tax Forms,
plus Payroll Center, Find and Edit Paychecks, Adjust Tax Balances, Print Paychecks), Lists (Payroll
Items, Pay Schedules, Employee Defaults, Payroll Setup, Company Payroll Info, Tax Tables), Reports
(Report Center, Payroll Summary, Payroll Register, Liability Balances, Employee Earnings, Payroll
Item Detail, Paid Time Off, Audit Trail), SerieX Books (Open SerieX Books, Books Sync, Verify
Postings, Payroll Journal, Preferences).

### 2.4 Apps button (switch between Books and Payroll)

- The nine-dot button in the top bar, right of "SerieX Books". Its panel "Switch app" lists
  **SerieX Books** ("Invoices, bills, banking and reports", marked Current) and **SerieX
  Payroll** ("Paychecks, payroll taxes and employees"). Click the other one.
- The same company stays open. Open windows are asked to save first; Cancel stays.
- If Payroll is not running, the entry says "Not running at <address>" with **Retry**. The
  button is hidden when the server has no Payroll address (for example a source run started
  without `-payroll`).
- Other ways: File > Switch to SerieX Payroll... (Books) / File > Switch to SerieX Books...
  (Payroll); desktop app Ctrl+1 / Ctrl+2 (Windows and Linux) or Cmd+1 / Cmd+2 (Mac).

### 2.5 + New button

The blue **+ New** at the top of the left navigation (in the top bar when the navigation is on
top or hidden). The panel has columns (entries hidden when their feature is off):

- Books
  - **Customers**: Invoice, Receive payment, Estimate, Sales receipt, Credit memo, Refund,
    Statement charge
  - **Vendors**: Bill, Pay bills, Check / expense, Purchase order, Vendor credit, Credit card
    charge, Receive items
  - **Other**: Bank deposit, Transfer, Journal entry, Inventory adjustment, Pay sales tax
  - **Lists**: Customer, Vendor, Product / service, Account
  - **Recent transactions**: the last 10 transactions opened or saved in this browser (not ones
    created through the API).
- Payroll
  - **Payroll**: Run payroll, Extra paycheck, Final paycheck, Year-to-date amounts
  - **Payroll Taxes**: Tax payment, Tax balance adjustment, Earlier tax payments
  - **Lists**: Employee, Payroll item, Pay schedule, Account in Books, Vendor in Books

### 2.6 Search box

- In the top bar: "Search customers, vendors, transactions, reports..." (Payroll: "Search
  employees, paychecks, tax payments, reports..."). Ctrl+K (Cmd+K on Mac) or "/" puts the
  cursor there.
- Empty box: Recent transactions and Quick actions (Create invoice, Receive payment, Enter
  bill, Pay bills, Write check, Profit and Loss).
- Typing shows groups: Customers & vendors (opens the center on that name), Transactions (by
  number, name, memo, or an exact amount such as `1,250.00`), Products & services, Accounts
  (balance sheet accounts open the register; income/expense accounts open Account Activity),
  Actions (commands like "Pay bills", "Set closing date", "Check Company File", "Import lists
  from CSV", "Restore company file"), Reports.
- Arrow keys and Enter pick; Enter with nothing picked opens the first result; **See all results
  for "..."** opens the Search window (also Edit > Search...).

### 2.7 Tabs, floating windows, closing windows

- View > Tabs (default): each window is a full page with a tab. View > Floating Windows: classic
  movable windows; Window > Tile Vertically / Tile Horizontally / Cascade / Arrange Icons. Window
  > Close All / Close Others, and a numbered list of open windows.
- Opening a list or center that is already open brings that window forward (one window per
  kind). Each saved transaction opens in its own window.
- Esc closes the active window; Ctrl+F4 too. If it has unsaved changes the box "Unsaved
  Changes" asks "This transaction has changes that are not saved. Save them before you leave?"
  with Save / Don't Save / Cancel.
- Dialogs (Preferences, New Customer, User List...) are modal: finish or cancel them first.

### 2.8 How transaction forms work

Every Books transaction form (invoice, bill, check, deposit, journal entry...) has the same frame:

- **Toolbar** (top): ◄ ► (previous / next transaction of that type), **New**, **Save**
  (Ctrl+S), **Print** (Ctrl+P, on forms that print), **Delete ▾** (**Void**, **Delete**
  Ctrl+D), **Make a copy**, **Memorize** (Ctrl+M), **Mark as pending** (invoices and sales
  receipts: pending sales do not touch the books until made final), **More ▾** (Transaction
  history Ctrl+H, Transaction journal Ctrl+Y, form-specific reports, Find transactions… Ctrl+F),
  then form-specific buttons (for example **Receive payment** on an invoice).
- **Title** (Invoice, Bill, Check...) with a status pill (Paid, Open, Overdue, Pending, Void,
  Closed) and "Unsaved changes" while edited.
- A red banner "Please fix these N problems before saving" lists errors; click one to jump to
  the field. The field gets a red border and a short message.
- **Sticky bottom bar**: **Clear** (new form) or **Revert** (saved form), Alt+R; the totals;
  **Save and new** (Alt+N) and **Save and close** (Alt+S). Some forms have no Save and new
  (bill payments).
- A right-side **history panel** (customer or vendor summary, recent transactions, related
  transactions) on sales and purchase forms; the thin arrow on the right edge shows or hides it.
- Questions after Save: the app may ask Yes/No questions (duplicate number, over credit limit,
  not enough inventory, inactive name, changing a reconciled or deposited transaction, closing
  date). Answer them in the box. A transaction dated on or before the closing date asks for the
  **Closing Date Password**.
- Reading a saved transaction's postings: More ▾ > Transaction journal (Ctrl+Y). Seeing what
  is linked to it (payments, deposits): More ▾ > Transaction history (Ctrl+H).

Payroll windows (Pay Employees, Paycheck, Tax Payment) follow the same look with their own
buttons (section 6).

### 2.9 List and edit dialogs

- List windows (Chart of Accounts, Item List, Other Names, profile lists, Memorized Transaction
  List...) have a search box, type filter chips, an **Include inactive** check box and bottom
  menu buttons such as **Account ▾ / Activities ▾ / Reports ▾**. Double-click or Enter opens the
  entry. Rows have hover actions (Edit, Register, Activity Report). Check boxes on rows allow
  batch actions (Make inactive, Make active, Export to CSV).
- Edit dialogs (New Customer, New Vendor, New Item, New Account, New Employee...) have sections
  on the left and **Cancel**, **Save and new** (new records only, Alt+N), **Save and close**
  (Enter). Some dialogs use **OK** instead.
- If someone else changed the record meanwhile, the dialog offers to reload the latest version.

### 2.10 Pickers and quick create

- Name, item, account and list fields are drop-down pickers: type to filter; when empty they
  list recently picked entries first. Names show open balances, items price and quantity on
  hand, accounts type and balance.
- Typing a name that does not exist offers **Add "<text>"** (opens a small quick-create panel
  with only the essentials, then **Save**) and **Add with details…** (opens the full New dialog).
  **Add new** at the top of the list opens the full dialog.
  - Name quick create: name, type (Customer / Vendor / Other) when several are allowed, and for
    customers "Charge sales tax to this customer".
  - Item quick create ("New product or service"): Name, Type, Sales price (Cost on purchase
    forms), Income account (Expense account on purchase forms).
  - Account quick create ("New account"): Account name, Account type.
- The new record is selected in the field automatically.

### 2.11 Line grids, date fields, amount fields

- Line grids (invoice lines, Expenses / Items tabs, journal lines): Tab / Shift+Tab move between
  cells, Enter goes to the next cell, Up / Down change line, Ctrl+Insert inserts a line above,
  Ctrl+Delete deletes the line. Right-click a line: **Insert Line**, **Delete Line** (use this on
  a Mac keyboard without Insert). There is always one empty line at the end. Column edges can
  be dragged to resize.
- Date fields: type `1/5`, `1/5/26`, `01/05/2026` or `010526` (shown as MM/DD/YYYY after leaving
  the field). Click the field, the calendar button, Alt+Down or F4 for a calendar (arrows, Page
  Up / Page Down for months, **Today**). Keys while in a date field:

  | Key | Effect |
  |---|---|
  | `+` or `=` | next day |
  | `-` | previous day |
  | `t` | today |
  | `w` / `k` | first / last day of the week (press again: previous / next week) |
  | `m` / `h` | first / last day of the month (again: previous / next month) |
  | `y` / `r` | first / last day of the year (again: previous / next year) |
  | `[` / `]` | same day previous / next week |

  A text that is not a date stays with a message "Enter a date like 10/19/2026"; Esc puts the
  old date back. (Payroll's help page omits `[` `]` but the field supports them.)
- Amount and quantity fields accept arithmetic: `100*3+5` becomes 305.00. Commas and `$` are
  ignored.

### 2.12 Keyboard shortcuts (Windows and Mac)

On Linux, the keys are the same as in the Windows column.
On a Mac, the app's own shortcuts use the **Control** key (⌃), not Command, except the few rows
that say Cmd. Alt is the **Option** key (⌥). Shortcuts work only when a company is open and no
dialog is on top (except Esc, F1, Ctrl+Tab, Ctrl+F4).

**SerieX Books**

| Action | Windows | Mac |
|---|---|---|
| Search box | Ctrl+K or `/` | Cmd+K, Control+K or `/` |
| Create Invoices | Ctrl+I | Control+I |
| Customer Center | Ctrl+J | Control+J |
| Chart of Accounts (works in normal fields too, so it does not select text; not in the search box or multi-line notes) | Ctrl+A | Control+A |
| Use Register (pick an account) | Ctrl+R | Control+R |
| Write Checks | Alt+W (Ctrl+W also works in the desktop app; in a web browser Ctrl+W closes the browser tab) | Option+W or Control+W |
| Find transactions | Ctrl+F | Control+F |
| Memorized Transaction List | Ctrl+T | Control+T |
| Help (Getting started, Keyboard, About) | F1 | F1 |
| Close the active window | Esc or Ctrl+F4 | Esc or Control+F4 |
| Next / previous window | Ctrl+Tab / Ctrl+Shift+Tab (or Ctrl+F6) | Control+Tab / Control+Shift+Tab |
| Open a menu | Alt or F10, then the letter (Alt+F = File...) | Option+letter, or F10 |
| On a form: Save (stay) | Ctrl+S | Cmd+S or Control+S |
| On a form: Print | Ctrl+P | Cmd+P or Control+P |
| On a form: Delete | Ctrl+D | Control+D |
| On a form: Memorize | Ctrl+M | Control+M |
| On a form: Transaction history / journal | Ctrl+H / Ctrl+Y | Control+H / Control+Y |
| On a form: Save and close / Save and new | Alt+S / Alt+N | Option+S / Option+N |
| On a form: Clear (new) or Revert (saved) | Alt+R | Option+R |
| In a grid: insert / delete a line | Ctrl+Insert / Ctrl+Delete | right-click > Insert Line / Delete Line |
| In a list or center: edit / delete selected (where the list allows it) | Ctrl+E / Ctrl+D | Control+E / Control+D |
| In a list, center or register: Activity report of the selection | Ctrl+Q | Control+Q |
| In Chart of Accounts: open register of selected account | Ctrl+R | Control+R |
| In a report: Memorize / Print | Ctrl+M / Ctrl+P | Control+M / Cmd+P |
| Any button with an underlined letter | Alt+letter | Option+letter |

Examples of button access keys: **Pay selected bills** Alt+P (Pay Bills), **Pay sales tax**
Alt+P, **Record** Alt+R (statement charges), **Preview** / **Print** Alt+V / Alt+P (Create
Statements).

**SerieX Payroll**

| Action | Windows | Mac |
|---|---|---|
| Search box | Ctrl+K or `/` | Cmd+K or `/` |
| Find paychecks (Find and Edit Paychecks) | Ctrl+F | Control+F |
| Print the report or tax form | Ctrl+P | reports: Cmd+P or Control+P; tax forms: Control+P |
| Save and close / Save and new (forms; in edit dialogs Enter = Save and close, Alt+N = Save and new) | Alt+S / Alt+N | Option+S / Option+N |
| Close window | Esc or Ctrl+F4 | Esc or Control+F4 |
| Help | F1 | F1 |
| Payroll Items and Pay Schedules: new / edit / delete | Ctrl+N / Ctrl+E / Ctrl+D | Control+N / E / D |
| Employee Center, Payroll Items: activity report | Ctrl+Q | Control+Q |

**Desktop app** (both apps)

| Action | Windows | Mac |
|---|---|---|
| Go to SerieX Books / SerieX Payroll | Ctrl+1 / Ctrl+2 | Cmd+1 / Cmd+2 |
| Zoom in / out / actual size | Ctrl+= / Ctrl+- / Ctrl+0 | Cmd+= / Cmd+- / Cmd+0 |
| Full screen | F11 | Ctrl+Cmd+F |
| Reload the page | F5 | Cmd+R |
| Close the whole SerieX window / quit | (window x) | Cmd+W / Cmd+Q (asks first when something is unsaved) |

### 2.13 Features that hide menu items

Edit > Preferences... turns these on or off; when off, their menu items, + New entries, Home icons
and search actions disappear:

| Feature | Preference | Hides when off |
|---|---|---|
| Estimates | Sales > "Use estimates" | Create Estimates |
| Purchase orders | Items and Inventory > "Use purchase orders" | Create Purchase Orders (and receive items, unless inventory is on) |
| Inventory | Items and Inventory > "Track inventory" | Inventory Activities, Inventory reports, Inventory Part item type |
| Sales tax | Sales Tax > "Do you charge sales tax?" | Vendors > Sales Tax, Pay sales tax, sales tax item types |
| Classes | Accounting > "Track classes on transactions" | Class List, CLASS fields |

---

## 3. SerieX Books menu map

Items marked (needs company) are greyed out when no company is open.

### File
| Item | Opens |
|---|---|
| New Company... | New Company wizard (5.1) |
| Open or Restore Company... | "Open Company or Backup" (tabs Open a company file / Restore a backup): open a file, restore a backup, delete a file |
| Open Previous Company ▸ | Numbered list of recent companies |
| Back Up Company ▸ Back Up Now | Copies the open company into the backup folder at once (message shows the file name) |
| Back Up Company ▸ Create Local Backup... | "Back Up Company": downloads a backup file (.sxb) |
| Back Up Company ▸ Automatic Backup Settings... | "Backup Settings" |
| Create Copy... | "Save Copy or Backup": copy in the company list or backup download |
| Close Company | Closes the company (asks to save open windows) |
| Switch to SerieX Payroll... | Opens Payroll on the same company |
| Utilities ▸ Import ▸ Excel/CSV Files... | "Import" (customers, vendors, items, accounts, other names) |
| Utilities ▸ Import ▸ QuickBooks® Desktop (IIF files)... | QuickBooks Desktop import wizard |
| Utilities ▸ Export ▸ Lists to CSV... | "Export Lists to CSV" |
| Utilities ▸ Check Company File | "Check Company File" |
| Utilities ▸ Repair Company File | "Repair Company File" |
| Print Forms ▸ Checks... | "Select Checks to Print" |
| Print Forms ▸ Invoices... | "Select Invoices to Print" |
| Exit | Closes the company (same as Close Company; it does not quit the desktop app) |

### Edit
| Item | Opens |
|---|---|
| Revert | Undoes unsaved changes of the active window (enabled only when it has changes) |
| Use Register (Ctrl+R) | "Open a Register": pick an account, **Open register** |
| Find... (Ctrl+F) | "Find" transactions window |
| Search... | "Search" window (all matches for a text) |
| Preferences... | "Preferences" |

### View
Open Window List (left navigation on its Open Windows tab); Tabs / Floating Windows; Left
Navigation / Top Icon Bar / Hide Navigation; Collapse Navigation to Icons.

### Lists
| Item | Opens |
|---|---|
| Chart of Accounts (Ctrl+A) | Chart of Accounts |
| Item List | Item List (products and services) |
| Class List | Class List (only with class tracking) |
| Other Names List | Other Names List (owners, partners, people paid by check who are not vendors) |
| Customer & Vendor Profile Lists ▸ | Sales Rep List..., Customer Type List..., Vendor Type List..., Job Type List..., Terms List..., Customer Message List..., Payment Method List..., Ship Via List... |
| Memorized Transaction List (Ctrl+T) | Memorized Transaction List |

### Favorites
Create Invoices, Write Checks, Chart of Accounts.

### Company
| Item | Opens |
|---|---|
| Home Page | Home |
| Insights | Insights (charts for a period) |
| Calendar | Calendar (month grid of transactions, due dates, to dos) |
| My Company | My Company (details, file, backups, users, features; called Company Profile in the navigation) |
| Company Information... | "Company Information" (name, address, EIN, fiscal year) |
| Set Up Users and Passwords ▸ Set Up Users... | "User List" |
| Set Closing Date... | "Closing Date" |
| Backup Settings... | "Backup Settings" |
| Planning & Budgeting ▸ Set Up Budgets... | "Set Up Budgets" |
| To Do List | To Do List |
| Reminders | Reminders |
| Chart of Accounts (Ctrl+A) | Chart of Accounts |
| Make General Journal Entries... | "Journal Entry" |

### Customers
| Item | Opens |
|---|---|
| Customer Center (Ctrl+J) | Customer Center |
| Create Estimates | Estimate form (only with estimates on) |
| Create Invoices (Ctrl+I) | Invoice form |
| Enter Sales Receipts | Sales Receipt form |
| Enter Statement Charges | Customer A/R register with a charge entry row |
| Create Statements... | "Create Statements" |
| Receive Payments | Customer Payment form |
| Create Credit Memos/Refunds | Credit Memo form |
| Money In | Money In (all sales transactions with a money bar) |
| Item List | Item List |

### Vendors
| Item | Opens |
|---|---|
| Vendor Center | Vendor Center |
| Enter Bills | Bill form ("Enter Bills") |
| Pay Bills | "Pay Bills" |
| Sales Tax ▸ Manage Sales Tax... | "Manage Sales Tax" (only with sales tax on) |
| Sales Tax ▸ Pay Sales Tax... | "Pay Sales Tax" |
| Sales Tax ▸ Sales Tax Liability | Sales Tax Liability report |
| Create Purchase Orders | Purchase Order form (only with POs on) |
| Receive Items and Enter Bill | Bill form for received items (POs or inventory on) |
| Receive Items | "Create Item Receipts" (items received, bill later) |
| Enter Bill for Received Items | "Select Item Receipt" (turns an item receipt into a bill) |
| Inventory Activities ▸ Adjust Quantity/Value On Hand... | "Adjust Inventory" (inventory on) |
| Money Out | Money Out (POs, item receipts, bills, credits, payments with a money bar) |
| Item List | Item List |

### Banking
| Item | Opens |
|---|---|
| Write Checks (Alt+W) | Check form ("Write Checks") |
| Enter Credit Card Charges | Credit card charge / credit form |
| Use Register (Ctrl+R) | "Open a Register" |
| Make Deposits | Deposit form ("Make Deposits") |
| Transfer Funds | "Transfer Money" |
| Reconcile... | "Start Reconciling" |
| Bank Feeds ▸ Bank Feeds Center | "Bank Imports" |
| Bank Feeds ▸ Import Bank File (OFX / CSV)... | "Bank Imports" with the import panel open |
| Bank Feeds ▸ Manage Rules... | "Bank Rules" |
| Print Checks... | "Select Checks to Print" |
| Previous Reconciliation reports... | "Previous Reconciliation" |
| Other Names List | Other Names List |

### Reports
| Item | Opens |
|---|---|
| Report Center | "All Reports" |
| Memorized Reports ▸ | **Memorized Report List**, then saved reports (in their groups as submenus) |
| Insights | Insights |
| Activity Report (Ctrl+Q) | Activity report of the account, name or item selected in the active list, center or register |
| Financial Statements ▸ | Profit and Loss, Profit and Loss Detail, Profit and Loss: Year-to-Date Comparison, Profit and Loss: This Year vs. Last Year, Profit and Loss: This Period vs. Last Period, Profit and Loss by Job, Profit and Loss by Class, Profit and Loss: No Class, Income by Customer Summary, Income by Customer Detail, Expenses by Vendor Summary, Expenses by Vendor Detail, Balance Sheet, Balance Sheet Detail, Balance Sheet Summary, Balance Sheet: This Year vs. Last Year, Balance Sheet: This Period vs. Last Period, Statement of Cash Flows |
| Customers and Invoices ▸ | A/R Aging Summary, A/R Aging Detail, Customer Balance Summary, Customer Balance Detail, Open Invoices, Overdue Invoices with Contacts, Transaction List by Customer |
| Sales ▸ | Sales by Customer Summary, Sales by Customer Detail, Sales by Item Summary, Sales by Item Detail, Sales by Rep Summary, Sales by Rep Detail, Pending Sales |
| Jobs ▸ | Job Profitability Summary, Job Estimates vs. Actuals Summary |
| Vendors and Bills ▸ | 1099 Summary, 1099 Detail, A/P Aging Summary, A/P Aging Detail, Vendor Balance Summary, Vendor Balance Detail, Unpaid Bills Detail, Transaction List by Vendor, Sales Tax Liability, Sales Tax Revenue Summary, Sales Tax Sales Detail |
| Purchases ▸ | Purchases by Vendor Summary, Purchases by Vendor Detail, Purchases by Item Summary, Purchases by Item Detail, Open Purchase Orders, Open Purchase Orders Detail |
| Inventory ▸ (inventory on) | Inventory Valuation Summary, Inventory Valuation Detail, Inventory Stock Status by Item, Inventory Stock Status by Vendor, Physical Inventory Worksheet |
| Banking ▸ | Deposit Detail, Check Detail, Missing Checks |
| For Your Accountant ▸ | Trial Balance, General Ledger, Journal, Transaction Detail by Account, Transaction List by Date, Audit Trail, Custom Summary Report, Custom Transaction Detail Report |
| Budgets ▸ | Budget Overview, Budget vs. Actual, Budget Progress (Profit and Loss) |
| Lists ▸ | Account Listing, Item Listing, Item Price List, Terms Listing, Customer Phone List, Customer Contact List, Vendor Phone List, Vendor Contact List, Other Names Phone List |
| Transaction History (Ctrl+H) | Links of the transaction in the active form or the selected register row |
| Transaction Journal (Ctrl+Y) | Debits and credits of that transaction |

Account Activity, Name Activity and Item Activity are not in the menu; they open from a selected
account, name or item (Ctrl+Q, hover action, search result).

### Window
Arrange Icons (floating only), Close All, Close Others, Tile Vertically, Tile Horizontally,
Cascade (tiling switches to Floating Windows), then the numbered open windows.

### Help
SerieX Books Help (F1): pages **Getting started**, **Keyboard** (the shortcut list), **About**.
About SerieX Books...: version, license and source code links, company file, logged-in user.

---

## 4. SerieX Payroll menu map

### File
| Item | Opens |
|---|---|
| Open or Set Up Company... | Closes the company and shows the company list (Open / Set Up Payroll) |
| Open Previous Company ▸ | Recent companies |
| Close Company | Closes the company |
| Switch to SerieX Books... | Opens Books on the same company |
| Print ▸ Paychecks... | "Print Paychecks" |
| Print ▸ Pay Stubs... | "Print Pay Stubs" |
| Exit | Closes the company |

### Edit
Find Paychecks... (Ctrl+F) opens "Find and Edit Paychecks"; Preferences... opens "Preferences"
(sections Payroll & Employees, SerieX Books, Access).

### View
Same as Books (Open Window List, Tabs / Floating Windows, navigation placement, collapse).

### Lists
Payroll Items; Pay Schedules; Employee List (Employee Center).

### Employees
| Item | Opens |
|---|---|
| Employee Center | Employee Center, Employees tab |
| Payroll Center | Employee Center, Payroll tab |
| Pay Employees ▸ Run Payroll... | Payroll Center (pick a pay schedule, **Start Payroll**) |
| Pay Employees ▸ Extra Paycheck... | "Extra Paycheck" (an off-cycle paycheck, for example a bonus) |
| Pay Employees ▸ Final Paycheck... | "Final Paycheck" (the last paycheck of an employee who leaves) |
| Find and Edit Paychecks... | "Find and Edit Paychecks" |
| Payroll Taxes ▸ Pay Payroll Taxes... | "Pay Payroll Taxes" |
| Payroll Taxes ▸ Record a Tax Payment... | New "Tax Payment" |
| Payroll Taxes ▸ Adjust Tax Balances... | "Adjust Tax Balances" |
| Payroll Taxes ▸ Record Earlier Tax Payments... | "Earlier Tax Payments" (tax payments made before using SerieX Payroll) |
| Payroll Taxes ▸ Tax Payment Schedule... | "Tax Payment Schedule" |
| Tax Forms ▸ All Tax Forms... | "Tax Forms" (forms to file) |
| Tax Forms ▸ Form 941... | Form 941 for the last quarter |
| Tax Forms ▸ Form 940... | Form 940 for the year |
| Tax Forms ▸ W-2/W-3... | W-2/W-3 for the year |
| Tax Forms ▸ State Unemployment Report... | State unemployment wage report for the last quarter |
| Payroll Items ▸ All Payroll Items | "Payroll Items" |
| Payroll Items ▸ New Payroll Item... | "New Payroll Item" wizard |
| Employee Defaults... | "Employee Defaults" (settings new employees start with) |
| Enter Year-to-Date Amounts... | "Enter Year-to-Date Amounts" |
| Payroll Setup... | "Payroll Setup" interview |
| Company Payroll Information... | "Company Payroll Information" |
| Tax Tables... | "Tax Tables" |
| SerieX Books Sync... | "SerieX Books Sync" (records not posted to Books, Verify) |

### Reports
| Item | Opens |
|---|---|
| Report Center | Report Center (tabs Standard, Favorites, Recent) |
| Payroll and Employees ▸ | Payroll Summary, Payroll Item Detail, Payroll Detail Review, Payroll Register, Employee Earnings Summary, Payroll Liability Balances, Payroll Transactions by Payee, Payroll Transaction Detail, Payroll Journal (SerieX Books postings), Employee State Taxes Detail, Employee Withholding, Paid Time Off List, Employee Contact List, Payroll Item Settings |
| Tax Forms ▸ | Form 941 Worksheet, Form 940 Worksheet |
| Audit Trail | "Audit Trail" (every change to the payroll file, who and when) |

Payroll has no memorized reports.

### Window, Help
Window: same as Books. Help: SerieX Payroll Help (F1; pages **How payroll works**, **Keyboard**,
**About**), About SerieX Payroll....

---

## 5. Books: task-by-task click paths

Each path gives the main way, then shortcuts. "Save" means **Save and close** unless said
otherwise.

### 5.1 Set up a new company
1. Welcome screen: **Create a new company** (or File > New Company..., or company name button >
   New company...).
2. Wizard steps (left rail), buttons **Back** / **Next** / **Cancel**:
   - **Your business**: Company name, Industry, Type of business entity, Federal tax ID (EIN).
   - **Contact details**: Legal name, Address, City, State, ZIP, Country, Phone, Email, Website,
     First month of your fiscal year.
   - **What you track**: Invoices and bills (always on), Estimates, Inventory, Purchase orders,
     Sales tax, Classes.
   - **Sales tax** (only when Sales tax was ticked): Sales tax name, Tax rate (%), Tax agency, How
     often do you pay sales tax? (Monthly / Quarterly / Annually). Required when sales tax is on.
   - **Sign-in**: Admin password, Confirm password (recommended, at least 8 characters; left
     empty, there is no login and a warning says anyone on the computer can open the books).
   - **Bank accounts**: rows of Account name, Account type (Bank / Credit card), Opening balance;
     **Bank account** and **Credit card** add rows; the trash icon removes a row.
3. **Create company**. The Home page opens with the **Get started** checklist.
4. Later: Company > Company Information... for address and tax details; Edit > Preferences... to
   change features.
- To try first: welcome screen > **Explore the sample company** ("Harborview Landscaping &
  Supply (Sample)", 18 months of activity).

### 5.2 Add a customer (and a job)
1. Customers > Customer Center > **New Customer & Job ▾** > **New Customer…** (or + New >
   Customer).
2. "New Customer" dialog, sections: **Address info** (Customer name, Opening balance, As of,
   Company name, Mr./Ms., First name, M.I., Last name, Job title, Main phone, Alt. phone, Mobile,
   Fax, Main email, CC email, Website, Invoice / Bill to, **Copy >>**, Ship to), **Payment
   settings** (Account no., Credit limit, Payment terms, Preferred payment method), **Sales tax**
   (Tax code: Tax - Taxable / Non - Non-taxable, Tax item, Resale no.), **Additional info**
   (Customer type, Rep), **Job info**, **Notes**.
3. **Save and close** or **Save and new**.
- Opening balance creates an invoice dated "As of" for that amount (a negative amount creates a credit memo).
- A job: select the customer in the Customer Center > **New Customer & Job ▾** > **Add Job…**
  (or row **More ▾** > Add Job). Job names show as "Customer:Job". Job info has Job status, Start
  date, Projected end, End date, Job description, Job type.
- Quick way: type a new name in any CUSTOMER OR JOB field and pick **Add "<name>"**.

### 5.3 Add a vendor
1. Vendors > Vendor Center > **New vendor** (or + New > Vendor).
2. "New Vendor": **Address info** (Vendor name, Opening balance, as of, Company name, Mr./Ms.,
   First name, M.I., Last name, Job title, Main phone, Main email, Mobile, CC email, Alt. phone,
   Website, Fax, Billed from, **Copy >>**, Shipped from), **Payment settings** (Account no.,
   Payment terms, Print name on check as, Credit limit), **Tax settings** (Vendor tax ID, "Vendor
   eligible for 1099"), **Account settings** (Account 1 to 3: expense accounts filled in
   automatically on bills and checks for this vendor), **Additional info** (Vendor type, Notes).
3. **Save and close**.
- Opening balance creates a bill dated "as of" (a negative amount creates a vendor credit).

### 5.4 Add a product or service (item)
1. Lists > Item List > **Item ▾** > **New** (or + New > Product / service).
2. "New Item": choose **Item type** at the top: Service, Inventory Part, Non-inventory Part,
   Other Charge, Subtotal, Group, Discount, Payment, Sales Tax Item, Sales Tax Group (some types
   only with inventory or sales tax on). Then:
   - Service / Non-inventory Part / Other Charge: Item name, Subitem of, Description, Rate (Price,
     or Amount or % for Other Charge), Taxable, Income account. Ticking "I also buy this service
     (for example from a subcontractor)" (or the matching box: "I also buy this item ..." / "I
     also pay this charge ...") adds Purchase information: Purchase description, Cost, Expense
     account, Preferred vendor.
   - Inventory Part: Purchase information (Description, Cost, COGS account, Preferred vendor),
     Sales information (Description, Price, Taxable, Income account), Inventory information
     (Asset account, Reorder point (min), Max, and for a new item On hand, Total value, As of).
   - Discount: Description, Amount or %, Account, "Apply the discount before sales tax".
   - Sales Tax Item: Description, Tax rate (%), Tax agency (vendor that you collect for).
3. **Save and close** / **Save and new**.
- Duplicate: Item List > select > **Item ▾** > **Duplicate Item**.

### 5.5 Add an account
1. Lists > Chart of Accounts (Ctrl+A) > **Account ▾** > **New** (or + New > Account).
2. "Add New Account: Choose Account Type": Income, Expense, Fixed Asset (major purchases), Bank,
   Loan, Credit Card, Equity, or **Other account types** (Accounts receivable, Other current
   asset, Other asset, Accounts payable, Other current liability, Long term liability, Cost of
   goods sold, Other income, Other expense). A plain-English explanation shows. **Continue**.
3. Fields: Account type, Number (when account numbers are on), Account name, Subaccount of,
   Description, Bank account no. / Routing number (bank), Credit card no. (card), Tax-line
   mapping, Note; for balance sheet accounts the opening amount: **Statement ending balance** +
   **Statement ending date** (bank), **Amount you owe** + As of (credit card), **Opening
   balance** + As of (others).
4. **Save and close**.
- Subaccount: select the parent > **Account ▾** > **New Subaccount**.

### 5.6 Import lists from a CSV or Excel file
1. File > Utilities > Import > **Excel/CSV Files...** (also Customer Center > Export ▾ >
   Import from CSV…, Vendor Center > Export ▾ > Import vendors from a CSV file…, Chart of
   Accounts / Item List > Account ▾ / Item ▾ > Import from CSV...).
2. "Import": **What do you want to import?** Customers / Vendors / Items / Accounts / Other names.
3. Drop the file or **Choose file…** (CSV or tab-delimited text; from Excel: Save As "CSV
   (Comma delimited)" or "Unicode Text"). Recognized columns get a ✓; unknown ones show
   "(ignored)". The first row must hold the column names and include **Name**.
   - Columns read: customers / vendors / other names: Name, Company, Salutation, First, Last,
     Phone, Mobile, Fax, Email, Bill Line1, Bill Line2, Bill City, Bill State, Bill Zip, Ship
     Line1, Ship City, Ship State, Ship Zip, Terms, Account No, Notes, Active. Items: Name, Type,
     Description, Purchase Description, Price, Cost, Income Account, Expense/COGS Account, Asset
     Account, Taxable, Preferred Vendor, Reorder Point, Active. Accounts: Name, Type, Number,
     Description, Bank Acct No, Note, Active.
   - "Customer:Job" names create jobs; "Parent:Child" names create subaccounts / subitems.
   - Existing names are updated; blank cells keep the current value.
   - Link "Download your current ... as a sample file" gives a template.
4. **Import**. The result lists added / updated counts and problem rows; **Import another file**
   or **Close**.
- Export: File > Utilities > Export > **Lists to CSV...** > tick lists (Customers & jobs, Vendors,
  Items (products & services), Chart of accounts, Other names) > **Export** (one CSV each).

### 5.7 Create an invoice
1. Customers > Create Invoices (Ctrl+I), or + New > Invoice, or Home > Everyday tasks > Invoice.
2. **CUSTOMER OR JOB** (fills address, terms, tax and rep), **LAYOUT** at the top right
   (Standard, Services, Services with Dates: changes the columns), **DATE**, **INVOICE #**
   (next number), **BILL TO**, **SHIP TO** (Standard layout), **P.O. NO.**, **TERMS**, **DUE
   DATE**, **REP**, **SHIP DATE**, **SHIPPED BY**, **F.O.B.**, **CLASS** (class tracking).
3. Lines: **ITEM** (ITEM CODE on Standard), **QTY**, **DESCRIPTION**, **RATE** (PRICE EACH),
   **CLASS**, **AMOUNT**, **TAX** (Tax / Non); Services with Dates adds a **DATE** column.
4. Footer: **CUSTOMER MESSAGE**, **MEMO**, Subtotal, **Tax** (sales tax item picker and rate),
   totals TOTAL, PAYMENTS APPLIED, BALANCE DUE.
5. **Save and close** (or **Save and new**). **Print** prints it.
- Toolbar extras: **Receive payment**, **Create credit memo**, **Add time/costs** (billable
  expenses recorded on bills, checks and charges; a banner "N billable costs ... are not invoiced
  yet" offers **Add them** / **Not now**), **Apply credits** (use credit memos or unused payments).
- Pending invoice: **Mark as pending** (not posted until made final).
- Print several: File > Print Forms > Invoices... ("Select Invoices to Print").

### 5.8 Receive a customer payment
1. Customers > Receive Payments (or + New > Receive payment, invoice toolbar **Receive
   payment**, Customer Center **Receive payment**).
2. "Customer Payment": **RECEIVED FROM** (shows CUSTOMER BALANCE), **PAYMENT AMOUNT**, **DATE**,
   **PAYMENT METHOD** buttons (Cash, Check, Credit/Debit, e-Check, More), **CHECK #** or
   **REFERENCE #**, **DEPOSIT TO** (only when the preference "Keep payments in Undeposited
   Funds until I deposit them" is off, or when changed), **A/R ACCOUNT** (only with several A/R
   accounts), **MEMO**.
3. The open invoices table (✓, DATE, NUMBER, JOB, ORIG. AMT., AMT. DUE, DISC. DATE, DISC. &
   CREDITS, PAYMENT) fills itself from the amount (exact match first, else oldest first). Tick or
   untick invoices or type amounts. DISC. & CREDITS (**Add** link) opens discount and credit
   choices. "Apply available credits (...) to the oldest invoices" appears when credits exist.
4. Below, plain-English text: overpayment choices ("Keep it as a credit for ..." / "Refund the
   amount to the customer (opens the refund form after you save)"), underpayment choices ("Leave
   this as an underpayment..." / "Write off the extra amount as a discount to" + account).
5. **Save and close**. With Undeposited Funds on, the money waits there until you make a deposit
   (5.9).
- Toolbar extras: **Discounts and credits**, **Un-apply payment**.

### 5.9 Make a bank deposit
1. Banking > Make Deposits (or + New > Bank deposit, Home > Everyday tasks > Deposit). If
   payments wait in Undeposited Funds, "Payments to Deposit" opens by itself; later use the
   toolbar button **Payments (N waiting)**.
2. "Payments to Deposit": filter by payment method, tick rows (Date, Type, No., Chk No.,
   Payment method, Name, Amount), **Select all** / **Select none**, **OK**.
3. Deposit form: **DEPOSIT TO**, **DATE**, **MEMO**; extra lines (RECEIVED FROM, FROM ACCOUNT,
   MEMO, CHK NO., PMT METH., CLASS, AMOUNT) for other money; **CASH BACK GOES TO**, **CASH BACK
   MEMO**, **CASH BACK AMOUNT**. Totals: Deposit subtotal, Less cash back, Deposit total.
4. **Save and close**. **Print** prints the deposit (lines and total).

### 5.10 Enter a sales receipt (paid on the spot)
1. Customers > Enter Sales Receipts (or + New > Sales receipt).
2. **CUSTOMER OR JOB**, **DATE**, **SALE NO.**, **SOLD TO**, **PAYMENT METHOD**, **CHECK NO.**,
   **DEPOSIT TO**, **CLASS**; lines as on an invoice; **CUSTOMER MESSAGE**, **MEMO**, Tax, Total.
3. **Save and close**.

### 5.11 Credit memo and refund
1. Customers > Create Credit Memos/Refunds (or + New > Credit memo, invoice toolbar **Create
   credit memo**).
2. **CUSTOMER OR JOB**, **DATE**, **CREDIT NO.**, **CUSTOMER** (address), **P.O. NO.**, lines, Tax,
   Total.
3. Toolbar: **Use credit to give refund** (opens "Refund") or **Use credit to apply to
   invoice** ("Apply Credit to Invoices": Amount to use, **Apply**). Saving a new credit memo
   asks "Available Credit": **Keep it as an available credit**, **Give a refund**, **Apply to
   an invoice**, **OK**.
- Refund directly: + New > Refund. "Refund": **CUSTOMER OR JOB**, **REFUND AMOUNT**,
  **DATE**, **ADDRESS**, **ISSUE THIS REFUND VIA** (Check / Cash / Credit card), **ACCOUNT**
  (shows ENDING BALANCE), **CLASS**, **MEMO**, **To be printed**, and the list "Credits to
  refund" (tick the credit and its amount). Totals: Credit available, Refund amount.

### 5.12 Customer statements
1. Customers > Create Statements... (or Customer Center > Print ▾ > Customer Statements…).
2. **Statement date**; **Transactions in this period** (From, To) or **All open transactions as
   of the statement date**; who: **All customers**, **Multiple customers**, **One customer**
   (Customer), **Customers of type** (Customer type); "Do not create statements with a zero
   balance".
3. **Preview** (Alt+V) shows them on screen; **Print** (Alt+P); **Close**.
- Statement charges (charges billed only on statements): Customers > Enter Statement Charges.
  Pick **CUSTOMER OR JOB** (and A/R account, Dates); the register shows DATE / NUMBER / ITEM / QTY /
  RATE / AMT CHRG / AMT PAID / BALANCE; fill the bottom entry row and click **Record** (Enter or
  Alt+R). Click an existing charge to change or delete it.

### 5.13 Estimate, then invoice
1. Customers > Create Estimates (or + New > Estimate). **STATUS** at the top right (Pending,
   Accepted, Closed, Rejected), **CUSTOMER OR JOB**, **DATE**, **ESTIMATE #**, **NAME / ADDRESS**,
   **P.O. NO.**, **REP**, lines, Tax, Total. **Save and close**.
2. To invoice: open the estimate and click **Create invoice** on its toolbar (or Customer Center
   > the estimate row > **Create invoice**, or Money In > row ACTION > Create invoice). A new
   invoice opens filled from the estimate; save it. The estimate shows Closed while an invoice uses it.
- Invoicing an estimate already invoiced or closed asks "Estimate Already Invoiced ... Create
  another invoice anyway?".
- Report: Reports > Jobs > Job Estimates vs. Actuals Summary.

### 5.14 Purchase order, receive items, bill
1. Vendors > Create Purchase Orders (or + New > Purchase order). Fields: **VENDOR**, **CLASS**,
   **SHIP TO**, **DATE**, **P.O. NO.**, **VENDOR ADDRESS**, **SHIP TO ADDRESS**; lines ITEM,
   DESCRIPTION, QTY, RATE, CUSTOMER, AMOUNT, RCV'D, CLSD; **VENDOR MESSAGE**, **MEMO**. **Save
   and close**. (A PO does not post to the books.)
2. When goods and bill arrive together: open the PO and click **Create bill**, or Vendors >
   Receive Items and Enter Bill, or in a bill pick the vendor and answer "Open POs Exist" /
   click **Select PO** ("Open Purchase Orders": tick POs, **OK**).
3. Goods first, bill later: open the PO > **Receive items**, or Vendors > Receive Items ("Create
   Item Receipts": the bill form with **Bill received** unticked). When the bill comes: Vendors >
   Enter Bill for Received Items > "Select Item Receipt" (Vendor, pick the receipt, "Use the item
   receipt date for the bill date", **Enter bill**) and save the bill.
- Open POs: Reports > Purchases > Open Purchase Orders; Vendor Center money bar **Open POs**.

### 5.15 Enter a bill
1. Vendors > Enter Bills (or + New > Bill, Home > Everyday tasks > Enter a bill).
2. Top right: **Bill | Credit** switch and the **Bill received** check box (POs or inventory
   on). Header: **VENDOR**, **ADDRESS**, **DATE**, **REF. NO.**, **AMOUNT DUE** (typing it puts
   the rest on an expense line), **BILL DUE**, **TERMS**, **DISCOUNT DATE**, **MEMO**.
3. Lines on two tabs: **Expenses** (ACCOUNT, AMOUNT, MEMO, CUSTOMER OR JOB, BILLABLE?, CLASS)
   and **Items** (ITEM, DESCRIPTION, QTY, COST, AMOUNT, CUSTOMER OR JOB, BILLABLE?, CLASS, PO NO.). Tab
   names show their totals. Picking a vendor recalls its last bill or its pre-fill accounts.
4. **Save and close**.
- Vendor credit: + New > Vendor credit (or the **Credit** switch). Its total is **Credit amount**.
- Pay one bill now: saved bill > toolbar **Pay bill** ("Pay Bill": Payment date, Pay from, Check
  no., Print the check later, Discount, Discount account, Amount to pay, **Pay bill**).
- BILLABLE? ticked with a CUSTOMER OR JOB makes the cost appear in **Add time/costs** on that
  customer's next invoice.

### 5.16 Pay bills
1. Vendors > Pay Bills (or + New > Pay bills, Home > Everyday tasks > Pay bills, Money Out >
   **Pay bills**).
2. **Show bills**: Due on or before (date) / Show all bills; **Filter by vendor**; **Sort by**
   (Due date, Discount date, Vendor, Amount due).
3. Tick bills (✓, DATE DUE, VENDOR, REF. NO., DISC. DATE, AMT. DUE, DISC. USED, CREDITS USED,
   AMT. TO PAY). Change AMT. TO PAY for a partial payment. **Set discount…** / **Set credits…**
   for the highlighted bill. **Select all bills** / **Clear selections**.
4. Payment: **Date**, **Method** (Check / Credit card), **Bank account** or **Credit card**,
   **Check numbers** (To be printed / Assign check no., First check number).
5. **Pay selected bills** (Alt+P). One bill payment per vendor. "Payment Summary": **Done**, **Pay
   more bills**, **Print checks**.

### 5.17 Write and print checks
1. Banking > Write Checks (Alt+W), or + New > Check / expense.
2. Top: **BANK ACCOUNT** (shows ENDING BALANCE). Check face: **NO.**, **DATE**, **PAY TO THE ORDER
   OF** (payee), **$** amount (fills the expense line), amount in words, **ADDRESS**, **MEMO**.
   Lines: Expenses / Items tabs as on a bill.
3. Bottom: **Print later** (keeps it in the to-print list), **Clear splits**.
4. **Save and close**, or **Print** (Ctrl+P) to print it now (asks "Check number to print on this
   check:" when it was marked Print later).
- Print a batch: File > Print Forms > Checks... or Banking > Print Checks... ("Select Checks to
  Print": Bank account, First check number, ticked checks (Date, Type, Payee, Amount), **Print**).
  Afterwards it asks whether the checks printed correctly, then assigns the numbers.
- Checks print as voucher checks (check on top, two stubs).

### 5.18 Credit card charges
1. Banking > Enter Credit Card Charges (or + New > Credit card charge).
2. **CREDIT CARD** account (ENDING BALANCE), **PURCHASED FROM**, **TYPE** (Charge / Credit),
   **DATE**, **REF NO.**, **AMOUNT**, **MEMO**; Expenses / Items lines; **Clear splits**.
3. **Save and close**.
- Paying the card bill: Write Checks to the card company with the credit card account on the
  Expenses tab, or Transfer Funds from the bank to the card account. Reconciling a card offers to
  pay (5.22).

### 5.19 Transfer between accounts
1. Banking > Transfer Funds (or + New > Transfer). The window is "Transfer Money".
2. **DATE**, **TRANSFER FUNDS FROM** (shows Account balance), **TRANSFER FUNDS TO**, **TRANSFER
   AMOUNT $**, **MEMO**. A sentence explains what will happen.
3. **Save and close**.

### 5.20 Bank file import and review (Bank Imports)
1. Download a transactions file from the bank's website: .ofx, .qfx, .qbo, or .csv.
2. Banking > Bank Feeds > Import Bank File (OFX / CSV)... (or, in the "Bank Imports" window,
   **Import file**, or the Home "N to review" link). Banking > Bank Feeds > Bank Feeds Center or
   **Bank Imports** in the navigation opens the same window.
3. Import panel: **Import transactions into** (account), **Choose file…** (or drop the file on the
   window).
4. "Import Bank File" dialog: **Import into** (account; a warning shows when the file belongs to
   another account). For CSV: preview "First rows of the file" (Date, Description, Spent,
   Received), "Dates in this file are" (Month/day/year or Day/month/year) when dates are
   ambiguous, and for a credit card "Flip signs: this file lists the card's charges as positive
   amounts". Button **Import into <account>**. Already downloaded transactions are skipped.
5. Review: left list **Accounts** (count to review on each). Tabs **For review (N)**,
   **Categorized (N)**, **Excluded (N)**. Each row: Date, Bank description, Payee, Spent,
   Received, Category or match, Action button (**Add**, **Match**, or **Review**).
6. Click a row to edit it: **Categorize** (Payee, Category, Class, Memo, Ref no., **Split** into
   lines, **Create rule from this**, **Reset**, **Exclude**) or **Find match (N)** (pick the
   register transaction with the same amount). Then **Add** / **Match**.
7. Several at once: tick rows (or **Select all**), then **Accept** (adds or matches each with its
   suggestion), **Exclude**, **Clear selection**. **Undo** puts rows back in For review (and
   deletes the transaction it added).

### 5.21 Bank rules
1. Banking > Bank Feeds > Manage Rules... (or Bank Imports > **Rules**).
2. "Bank Rules": list (Priority, Rule name, Applies to, Bank text contains, Payee / Category).
   **New rule**, **Edit**, **Delete**. "Suggested rules" (patterns you categorized the same way
   several times): **Add rule**, **Review...**, **Dismiss**.
3. Rule dialog: Rule name, Applies to (Every bank and credit card account, or one), Money (In or
   out / Money in / Money out), Bank text contains, Payee, Category (account), Show payee as,
   Priority (lowest number wins). **Save rule**.
- Rules only make suggestions in Bank Imports; you still Add / Accept.

### 5.22 Reconcile a bank or credit card account
1. Banking > Reconcile... (or Home > Everyday tasks > Reconcile).
2. "Start Reconciling": **Account**, **Statement date**, **Beginning balance** (from last
   time), **Ending balance**; "Enter any service charge or interest earned shown on the
   statement": Service charge (Finance charge for a card), Date, Account; Interest earned, Date,
   Account. Buttons **Locate discrepancies**, **Undo last reconciliation**, **Continue**.
3. "Reconcile" window: cards Statement ending balance, Cleared balance, **Difference**; tabs
   **Checks and payments** / **Deposits and other credits** / **All** (card: Payments and
   credits / Charges and cash advances); tick each transaction on the statement; **Mark all**,
   **Unmark all**, **Hide after statement date** check box, search box; **Modify** (back to
   step 2), **Edit transaction**, **Save for later**, **Finish now**.
4. When the difference is 0.00 ("Balanced — you can finish now"), **Finish now**. If not balanced,
   the choices are **Return to reconcile**, **Save for later**, **Enter adjustment** (journal
   entry to "Reconciliation Discrepancies").
5. Card accounts then ask "Make Payment": **Write a check for payment now** / **Enter a bill for
   payment later**, **OK** or **Not now**.
6. "Reconciliation Complete": Report type **Summary** / **Detail** / **Both**, **Display**.
- Old reports: Banking > Previous Reconciliation reports... (Account, Type of report, pick a
  statement date, **Display**).
- In a register, the ✓ column shows cleared (✓) and reconciled (R).

### 5.23 Journal entry
1. Company > Make General Journal Entries... (or + New > Journal entry). The window is "Journal
   Entry".
2. **DATE**, **ENTRY NO.**; lines ACCOUNT, DEBIT, CREDIT, MEMO, NAME, BILLABLE?, CLASS. A new line
   is filled with the amount that balances the entry. Footer: Total debits, Total credits,
   Difference (must be 0).
3. **Save and close**. Toolbar **Reverse** prepares the reversing entry dated the first day of
   the next month. The side panel lists recent journal entries.

### 5.24 Sales tax: set up and pay
- Turn on and set up: Edit > Preferences... > **Sales Tax**: "Do you charge sales tax?" **Yes**;
  "Your most common sales tax" (pick or **Add a sales tax**: Sales tax name, Tax rate (%), Tax
  agency); "When do you owe sales tax?" (As of invoice date (accrual basis) / Upon receipt of
  payment (cash basis)); "When do you pay sales tax?" (Monthly / Quarterly / Annually). **OK**.
- One place for everything: Vendors > Sales Tax > Manage Sales Tax... (items table TAX ITEM /
  RATE / TAX AGENCY with **New item**, **New group**, **Edit**; reports **Sales Tax Liability**,
  **Sales Tax Revenue Summary**; **Pay sales tax…**, **Adjust (journal entry)…**).
- More tax rates: Item List > New > type **Sales Tax Item** (rate, agency) or **Sales Tax Group**
  (several items charged together).
- Customers: New/Edit Customer > Sales tax > Tax code and Tax item. Items: "Taxable" box.
- Pay: Vendors > Sales Tax > Pay Sales Tax... (or + New > Pay sales tax). Fields **Pay from
  account**, **Check date**, **Show tax due through**, **Starting check no.** (or **To be
  printed**); grid PAY / ITEM / VENDOR / AMT. DUE / AMT. PAID; **Pay all tax**, **Clear
  selections**; **Pay sales tax** (Alt+P). One payment per agency; "Sales Tax Paid" summary with
  **Print checks** / **Done**.

### 5.25 Inventory adjustment
1. Vendors > Inventory Activities > Adjust Quantity/Value On Hand... (or + New > Inventory
   adjustment, Item List > Activities ▾ > Adjust Inventory...). The window is "Adjust Inventory".
2. **ADJUSTMENT TYPE** (Quantity / Total value / Quantity and total value), **ADJUSTMENT DATE**,
   **REF. NO.**, **ADJUSTMENT ACCOUNT**, **CUSTOMER OR JOB**, **CLASS**.
3. Lines: ITEM, DESCRIPTION, CURRENT QTY, NEW QTY, QTY DIFFERENCE (value modes add CURRENT VALUE,
   NEW VALUE, VALUE CHANGE). Type the counted quantity in NEW QTY. **MEMO**.
4. **Save and close**.
- Count sheet: Reports > Inventory > Physical Inventory Worksheet.

### 5.26 Budgets
1. Company > Planning & Budgeting > Set Up Budgets....
2. First time: **Create New Budget** ("Create New Budget": Fiscal year, Name, Budget type
   (Profit and Loss / Balance Sheet), Additional criteria (None / Customer or Job / Class), Start
   with (An empty budget (create it from scratch) / Last year's actual amounts), **Create**).
3. Grid: ACCOUNT, ANNUAL TOTAL, one column per month. Tools: **Fill from last year**, **Copy
   Across**, **Adjust Row Amounts...** (Start at, Increase/Decrease each month by, Percent),
   **Clear**. Pick other budgets in **Budget**; **Rename**, **Delete**.
4. **Save** or **Save and close**. **Budget vs. Actual** opens the report.

### 5.27 Memorized (recurring) transactions
1. Fill a form (invoice, bill, check...) and click **Memorize** (Ctrl+M).
2. "Memorize Transaction": Name, Group (optional), **Remind me** / **Don't remind me** / **Enter
   automatically**, How often (Only once, Daily, Weekly, Every two weeks, Twice a month, Monthly,
   Quarterly, Twice a year, Annually), Next date, Remaining, Days ahead. **Memorize**.
3. Use: Lists > Memorized Transaction List (Ctrl+T). Columns Transaction Name, Type, Source
   Account, Amount, Frequency, Auto, Next Date. **Enter Transaction** opens a filled form;
   **Memorized Transaction ▾** has Enter and Save Now, Enter All Scheduled Transactions That Are
   Due, Edit, Delete, Print List.
- Due reminders show in Company > Reminders and the Home Tasks card.

### 5.28 Reports: run, customize, filter, memorize, print, export
1. Run: Reports > Report Center (window "All Reports"; tabs **Standard**, **Favorites**,
   **Recent**, **Memorized**;
   search "Find a report by name or what it shows"; click a report; ★ adds it to Favorites and
   to the Reports group of the left navigation). Or Reports > category > report, or search box.
2. Filter bar: **Report period** (All, Today, This Week, This Week-to-date, This Month, This
   Month-to-date, This Fiscal Quarter, This Fiscal Quarter-to-date, This Fiscal Year, This Fiscal
   Year-to-date, Yesterday, Last Week, Last Week-to-date, Last Month, Last Month-to-date, Last
   Fiscal Quarter, Last Fiscal Quarter-to-date, Last Fiscal Year, Last Fiscal Year-to-date, Next
   Week, Next 4 Weeks, Next Month, Next Fiscal Quarter, Next Fiscal Year, Custom), **From** /
   **To** (or **As of** / Report date), **Accounting method** (Accrual / Cash), **Display columns
   by** (Total only, Week, Month, Quarter, Year, Class, Customer or Job), **Compare to** (No
   comparison, Previous period, Same period last year, Year to date), aging (Days per aging
   period, Through days past due), Budget, Class, Customer or Job, Name, Item, Rows by, Total by,
   Sort by (depending on the report).
3. **Customize** (side panel; the button shows a count of active filters): tabs **Filters**
   (Accounts, Names, Items, Classes, Transaction types, Cleared status, Amount, Memo contains,
   Number contains), **Columns** (Columns to show), **Header** (Company name, Report title,
   Subtitle, Date prepared, Time prepared, Report basis; custom title, subtitle, footer),
   **Numbers** (negative format -300.00 / (300.00) / 300.00-, red negatives, Divided by 1000,
   Without cents, Leave zero amounts blank, Hide rows where every amount is zero). **Done**.
   Changes apply at once.
4. **Memorize** (Ctrl+M): "Memorize Report": Name, "Save in a memorized report group", Group
   (or New group…), **Memorize**. Find it under Reports > Memorized Reports, the Memorized tab of
   All Reports window, or the Memorized Report List (Display, Edit, Delete).
5. **Print** (Ctrl+P), **Export CSV** (downloads a .csv that opens in Excel), **Expand all** /
   **Collapse all**, **Hide header** / **Show header**, **Refresh** (rerun with the latest data).
6. Drill down: click an amount to open the detail behind it; double-click a transaction row to
   open the transaction.

### 5.29 Closing date
1. Company > Set Closing Date... (or Edit > Preferences... > Accounting > **Set Date/Password...**).
2. "Closing Date": **Closing date** (transactions on or before it are locked),
   **Password (recommended)** / **New password**, **Confirm password**, "Remove the closing date
   password". **OK**.
- Only administrators can set it. Changing a locked transaction later asks for the "Closing Date
  Password".

### 5.30 Users and passwords
1. Company > Set Up Users and Passwords > Set Up Users... (or user button > Users and
   passwords...).
2. "User List" (User name, Role, Password, Status): **Add User...**, **Edit User...**, **Delete
   User**, **Close**.
3. User dialog: User name, Password (New password when it has one; at least 8 characters),
   Confirm password, "Remove this
   user's password", "Administrator (full access, sets up users)", "Active (can log in)".
- While no active user has a password, the file opens without login as "Admin". Once one user
  has a password, everyone logs in (User name, Password, **Log in**). Log out: user button > Log
  out. Payroll uses these same users ("SerieX Books user name").

### 5.31 Backups and restore
- Automatic: once a day when the company changed, and when it is closed or SerieX quits; keeps
  the latest 14 by default.
- Now: File > Back Up Company > **Back Up Now** (or Home > Backup status > **Back up now**, My
  Company > **Back up now**).
- Copy to another place: File > Back Up Company > **Create Local Backup...** > **Create backup**
  (downloads the .sxb backup file to the Downloads folder). Advise copying it to an external
  drive or cloud storage now and then.
- Settings: File > Back Up Company > Automatic Backup Settings... (or Company > Backup Settings...):
  **Back up now**, "Make automatic backups of this company", Backup folder (**Use default**),
  Number of backups to keep, **OK**. Administrators only.
- Copy of the company: File > Create Copy... > "What do you want to save?" **Copy in my company
  list** (Name of the copy, **Save copy**) or **Backup file (download)**.
- Restore: File > Open or Restore Company... > **Restore a backup** > **Restore from**:
  - **Automatic backups**: pick the Company and a backup (Made, How, Size, File), then
    **Restore as new...** (a new company file) or **Replace company data...** (overwrites the
    current data; it asks to confirm).
  - **A backup file**: **Choose a backup file** (.sxb), **Save it as** (name), **Restore**.
- Delete a company file for good: File > Open or Restore Company... > select > **Delete file...**.

### 5.32 Check and repair the company file
1. File > Utilities > Check Company File > **Check** (also My Company > **Check company file**).
   It checks for unbalanced transactions, open balances that do not match payments, inventory
   values and orphan rows.
2. If problems are found, **Repair Company File...** (or File > Utilities > Repair Company File >
   **Repair**) recomputes every posting from the transactions. Back up first.

### 5.33 QuickBooks Desktop import
1. Welcome screen > **Moving from QuickBooks® Desktop? Import your books**, or File > Utilities >
   Import > **QuickBooks® Desktop (IIF files)...**.
2. Wizard steps: **Start**, **Files**, **Preview**, **Mapping**, **Check**, **Bank rules**,
   **Report**. Buttons **Back**, **Next**, **Cancel**.
   - Start: **Where should the books go?** **A new company file** (recommended; Name of the new
     company, First month of the fiscal year) or **This company file** (only when it has no
     transactions yet). **What do you want to bring?** **Every transaction** or **Opening balances
     on a conversion date**. The page explains how to export from QuickBooks: File > Utilities >
     Export > Lists to IIF Files (lists); a transactions IIF file; for opening balances the
     Trial Balance, Open Invoices and Unpaid Bills Detail reports saved as CSV.
   - Files: **IIF file from QuickBooks® Desktop**; for opening balances also **Conversion date**,
     **Trial balance**, **Open invoices**, **Unpaid bills** (CSV). **Read the files**.
   - Preview: what the files contain. Mapping ("Review the mapping"): for each unknown account,
     item or name choose **Create it**, match it to an existing record, say it is the same as
     another entry of the file, or (items) **Leave it out**; set Account type / Item type / Kind
     of name; **Apply changes**.
   - Check: a dry run listing problems per line; **Run the check** / **Check again**.
   - Bank rules ("Bank rules from your patterns"): tick the suggested rules to create.
   - **Create company and import** (or **Import**). Report: what was created, trial balance
     compared with QuickBooks; **Print report**, **Open <company>**, **Close**.

---

## 6. Payroll: task-by-task click paths

Requirements: SerieX Payroll works on SerieX Books companies. Create the company and its bank
account in Books first. Both helper programs must be running (the desktop app starts both). People
sign in with their SerieX Books user name and password when the company has passwords.

### 6.1 Set up payroll for a company (Payroll Setup)
1. Switch to Payroll (apps button). With no company open, find the company and click **Set Up
   Payroll** (or the card **Set up payroll**). Sign in if asked ("SerieX Books user name",
   Password, **Sign in**).
2. First page **Payroll file**: State where your employees work, Federal employer ID (EIN),
   Federal tax deposits (Form 941) (Monthly / Semiweekly), First payroll year, State unemployment
   rate, How often do you pay employees?, Next pay period ends, Check date of that period, Bank
   account for paychecks and tax payments, and two boxes: create the payroll accounts in SerieX
   Books (Payroll Expenses, Payroll Liabilities...) and create the tax agencies as SerieX Books
   vendors. **Create payroll file**.
3. The "Payroll Setup" window continues (left rail): **Company info** (Company name, Legal name,
   Federal employer ID (EIN), Address, City, State, ZIP, Contact name (signs the forms), Title,
   Phone, Bank account for paychecks and tax payments, Federal deposit schedule (941), Main
   state; **Copy from SerieX Books again**), **State taxes** (state account numbers and rates),
   **Pay schedules** (**New pay schedule...**, **Edit...**), **Payroll items** (**New payroll
   item...**, **Edit...**, **Add missing default items**), **Employees** (**New employee...**,
   **Edit...**, **Employee defaults...**), **Year-to-date pay** ("No, this is our first payroll
   this year" / "Yes, we paid employees earlier this year..."; **Enter Year-to-Date Amounts...**,
   **Record Earlier Tax Payments...**), **Review and finish**.
4. Buttons: **Back**, **Continue**, **Finish Later** (resume later: Employees > Payroll Setup...
   or the Home banner **Continue Payroll Setup**), **Finish** on the last step.

### 6.2 Add an employee
1. Employees > Employee Center > **New Employee…** (or + New > Employee, Payroll Center > Add
   Employee).
2. "New Employee" sections: **Personal** (First name, M.I., Last name, Suffix, Employee name (in
   lists), Print on checks as, Social Security No., Gender, Date of birth), **Address & Contact**
   (Address, Address line 2, City, State, ZIP, Main phone, Mobile, Main email), **Additional
   Info** (Employee ID, Notes), **Payroll Info** (Pay schedule, Pay frequency, Class;
   EARNINGS grid: Item name, Hourly/annual rate, Default hours; ADDITIONS, DEDUCTIONS AND COMPANY
   CONTRIBUTIONS grid: Item name, Amount, Limit; buttons **Taxes…**, **Sick/Vacation…**,
   **Direct Deposit…**), **Employment Info** (Hire date, Original hire date, Release date,
   Employee type). "Employee is inactive" for edits.
3. **Taxes…** ("Taxes for <name>"): tabs **Federal** (Form W-4 2020 or later / 2019 or earlier,
   filing status, Multiple jobs or spouse works (Step 2c checked), Claim dependents (Step 3), Other
   income (Step 4a), Deductions (Step 4b), Extra withholding (Step 4c); old form: Allowances,
   Extra withholding; Nonresident alien withholding; Exempt; Subject to Medicare, Social Security,
   Federal Unemployment Tax (Company Paid)), **State** (State worked, State subject to
   withholding, Filing status, Extra withholding, Exempt, state specific data), **Other** (local
   taxes). **OK**.
4. **Sick/Vacation…**: hours available, used, Accrual period, Hours accrued, Maximum number of
   hours, Reset hours each new year?, Year begins on. **Direct Deposit…**: Bank name, Account
   type (Checking / Savings), Routing number, Account number (recorded only; SerieX does not move
   money).
5. **Save and close** / **Save and new**.
- New employees start from Employees > Employee Defaults....

### 6.3 Run payroll (pay employees)
1. Employees > Pay Employees > Run Payroll... (or **Pay Employees** in the navigation or on
   Home). This opens the Payroll Center. (The navigation entry opens an extra paycheck directly
   when no pay schedule has a payroll to run.)
2. Payroll Center > **Pay Employees** tab: in **Payrolls to Run** select the pay schedule (Pay
   schedule, Frequency, Pay period, Check date, Status, Employees) and click **Start Payroll**.
   Also **Extra Paycheck**, **Final Paycheck**, **Pay Schedules ▾**.
3. Step 1 **Hours and Pay** (the window reads "Run Payroll - Hours and Pay"): **PERIOD END**,
   **CHECK DATE**, **BANK ACCOUNT** (BALANCE shown). Grid: ✓, Employee, one column per earnings
   item (hours or amount), Total Hours. **Select All**, **Paycheck Details…**, **Cancel**,
   **Continue**.
4. Optional **Paycheck Details…** ("Paycheck Details"): Earnings (Item name, Rate, Hours,
   Customer:Job, Class), Additions and Deductions, Company Costs, Employee Pay and Taxes (Amount,
   YTD). Typing an amount overrides it (marked "entered by you"); right-click > **Use calculated
   amount** undoes it. "Pay by direct deposit", "Earns no sick or vacation hours". **Save &
   Previous**, **Save & Next**, **Save & Close**.
5. Step 2 **Review**: Check Numbers (**Print the checks later** / **Number them now (handwritten
   checks)**); columns Employee, Gross Pay, Taxes, Deductions, Net Pay, Employer Taxes,
   Contributions, Total Hours, Direct Dep. **Back**, **Cancel**, **Create Paychecks**.
6. Step 3 **Done**: "What to do next" with **Print Paychecks**, **Print Pay Stubs**, the result of
   posting to SerieX Books (if a problem: **Open SerieX Books Sync**), **Close**.
- Paychecks post to SerieX Books automatically as checks in the bank account (when "Post
  paychecks, tax payments and adjustments to SerieX Books" is on in Preferences > SerieX
  Books).
- Final paycheck: Employees > Pay Employees > Final Paycheck... (choose employees and the
  release date first). An off-cycle paycheck (bonus): Employees > Pay Employees > Extra
  Paycheck....

### 6.4 Print paychecks and pay stubs
- File > Print > Paychecks... ("Print Paychecks"): Bank account, First check
  number, ticked paychecks (Date, Employee, Pay Period, Amount), "Company message to be printed on
  all pay stubs", **Select All** / **Select None**, **Preview**, **Print**. Then it asks whether
  they printed correctly and assigns the numbers (also in Books).
- File > Print > Pay Stubs... ("Print Pay Stubs"): Bank account, Checks dated ... thru,
  Employee, Show (Both / Paychecks / Direct Deposit), message, **Preview**, **Print**.

### 6.5 Edit or void a paycheck
1. Employees > Find and Edit Paychecks... (Ctrl+F).
2. **From**, **Through**, search box, "Show voided"; list Paycheck Date, Check No., Employee, Pay
   Period, Memo, Net Amount, SerieX Books (posting status).
3. **Edit** (opens the "Paycheck" window: check face, Paycheck summary, **Paycheck Detail…**,
   Print later, Save and close), **Paycheck Detail…**, **Void** (type YES to confirm), **Delete**,
   **Pay Stub**, **Done**.

### 6.6 Pay payroll taxes
1. Employees > Payroll Taxes > Pay Payroll Taxes... (or **Pay Payroll Taxes** in the
   navigation, Payroll Center > **Pay Taxes** tab > **Pay Selected…**).
2. "Pay Payroll Taxes": "Show taxes due" from / through, "Include paid"; grid ✓, DUE DATE,
   STATUS, PAYMENT, PERIOD, METHOD, AMOUNT DUE, AMOUNT TO PAY; **Select all**, **Clear all**;
   **Payment date**, **Bank account**, **Check numbers** (Print later / Number now), First check
   number.
3. **Pay Selected**. One tax payment per agency and period is created, posted to SerieX Books
   and opened ("Tax Payment"); a "Payments Made" summary follows.
- Due dates and methods: Employees > Payroll Taxes > Tax Payment Schedule... (per payment: How
  you pay (Check / E-pay), Payee (vendor), How often you pay).
- One-off payment: Record a Tax Payment... ("Tax Payment": Date, Pay to the order of, Memo,
  Period from, Period to, Payment method Check / E-pay, tabs Expenses / Taxes and Deductions
  (PAYROLL ITEM, AMOUNT, MEMO)).
- Corrections: Adjust Tax Balances... ("Adjust Tax Balances", saved as a tax balance adjustment:
  DATE, EFFECTIVE DATE, ADJUSTMENT IS FOR Company / Employee, CLASS, grid ITEM NAME / AMOUNT /
  INCOME SUBJECT TO TAX / MEMO, **Books Accounts...**: No, change payroll only / Yes, also
  change the liability and expense accounts).
- Payments made before using SerieX Payroll: Record Earlier Tax Payments... ("Earlier Tax
  Payments": Payment date, For period ending, Payee, taxes and deductions grid; **New Payment**,
  **Save and Add Another**, **Done**). They are never posted to Books.
- What is owed: Reports > Payroll and Employees > Payroll Liability Balances.

### 6.7 Payroll tax forms (941, 940, W-2/W-3, state unemployment)
1. Employees > Tax Forms > All Tax Forms... (or Payroll Center > **Tax Forms** tab, navigation
   Taxes & Forms > Tax Forms).
2. "Tax Forms": **Year**, tab **Forms to File** (FORM / FEDERAL/STATE / FILING PERIOD / DUE DATE /
   STATUS); select one and **Open Form**; **Forms ▾** for any period (Quarterly Form 941/Schedule
   B..., Annual Form 940/Schedule A..., Annual Form W-2/W-3..., State Unemployment Report...; asks
   Year, Quarter, State, **OK**). Tab **Forms Filed** lists saved and filed forms.
3. Form 941 / 940 / state report window: the form drawn like paper; editable cells (changed
   amounts get a "Use the calculated value" button); **Schedule B** toggle (941, semiweekly
   depositors). Buttons **Check for Errors**, **Print**, **View filed copy**, **Refresh**,
   **Revert**, **Save as Draft**, **Mark as Filed**, **Close**. State report: **Excel ▾** (Export
   the wage list (CSV)..., Export with full social security numbers...).
4. W-2/W-3 window: list ✓, EMPLOYEE, SSN, REVIEWED?, BOX 1 to BOX 6; review panel "Form W-2
   (review)" / "Form W-3 (transmittal)", **Previous** / **Next**, "I reviewed this W-2"; **Mark All
   Reviewed**, **Unmark All**, **Print W-2s...** (choose copies), **Print W-3**, **Export
   EFW2...** (SSA electronic file: BSO User ID, Submitter name, contact fields, **Create file**),
   **Mark as Filed**, **Close**.
- SerieX prepares the forms; the user files and pays them.

### 6.8 Payroll reports
- Reports > Report Center or Reports > Payroll and Employees / Tax Forms > report. The
  report window has the filter bar (dates, Employee, Item...), **Customize**, **Print**, **Export
  CSV**, **Expand all / Collapse all**, **Hide header**, **Refresh**.
- Payroll Journal (SerieX Books postings) shows what payroll posted to Books. Reports > Audit
  Trail shows every change with user and time (filters Dates, Records, User; **Print**, **Export
  CSV**).

### 6.9 Other payroll settings
- Pay schedules: Lists > Pay Schedules > **New schedule** (or **Pay Schedule ▾** > New; questions:
  "How often are these employees paid?", "Last day of the next pay period", "Payday (the date
  printed on those paychecks)"; "Use for employees…").
- Payroll items: Lists > Payroll Items (filter Wages, Additions, Deductions, Contributions,
  Taxes) > **Payroll Item ▾** > New ("New Payroll Item" wizard: Wages and other pay for work,
  Addition to the paycheck, Deduction from pay, Company-paid benefit, Federal tax, State tax,
  Local or other tax; then name, payee and accounts, expense account, tax treatment, taxes that
  apply, how it is calculated, default amount and limit; **Back**, **Next**, **Finish**). "Add
  Default Payroll Items for a State..." in the same menu.
- Year-to-date amounts: Employees > Enter Year-to-Date Amounts... (Introduction, Employees, Year-to-date
  amounts per quarter with **Calculate taxes** and **Save Amounts**, Finish).
- Company: Employees > Company Payroll Information... (sections Company, Contact person, Federal &
  state, State settings; **Copy from SerieX Books**).
- Preferences (Edit > Preferences...): **Payroll & Employees** (Copy earnings details from
  previous paycheck, Recall hour field on paychecks, Job costing, class and item tracking for
  paycheck expenses, Warn about duplicate check numbers, Bank account for paychecks and tax
  payments, Display employee social security numbers on reports, Employee Defaults..., Show
  payroll taxes as due ... days before the due date, pay stub contents), **SerieX Books** (Post
  paychecks, tax payments and adjustments to SerieX Books; **Open SerieX Books**, **Books
  Sync...**, **Verify postings...**),
  **Access** (which SerieX Books users may use payroll).
- Books link problems: Employees > SerieX Books Sync... ("Not posted" list with **Retry Selected**
  / **Retry All**, and **Verify** with From / To to compare payroll with Books).
- Tax tables: Employees > Tax Tables... (Tax year, Federal and each state; administrators can
  **Edit** and **Restore built-in**).

---

## 7. Center screens and lists: what each panel shows

### Customer Center (Customers > Customer Center, Ctrl+J)
- Toolbar: **New Customer & Job ▾** (New Customer…, Add Job…), **New Transactions ▾** (Create
  Estimates, Create Invoices, Enter Sales Receipts, Enter Statement Charges, Receive Payments,
  Create Credit Memos/Refunds), **Print ▾** (Customer & Job List, Customer & Job Information,
  Customer & Job Transaction List, Customer Statements…), **Export ▾** (Export Customer List,
  Export Transactions, Import from CSV…), **Money In**, and on the right **Create
  invoice**, **Receive payment**.
- Money bar (click to filter the list): UNBILLED (Estimates, Unbilled activity), UNPAID (Overdue,
  Open invoices), PAID (Paid · 30 days).
- Left pane tabs: **Customers & Jobs** (view: Active customers, All customers, Customers with
  open balances, Customers with overdue invoices, Inactive customers; "Find a customer"; NAME and
  BALANCE TOTAL; jobs indented under their customer; check boxes for **Batch actions ▾**: Make
  inactive, Make active, Create statements…, Export selected (CSV)) and **Transactions** (all
  transactions of one type: Estimates, Invoices, Statement Charges, Sales Receipts, Received
  Payments, Credit Memos, Refunds).
- Right pane for the selected customer: info card (name, phone, email, terms, tax status;
  **Details** shows addresses and report links such as **Customer Activity**; **Edit**
  (Ctrl+E); **More ▾**: Edit Customer or Job, Add Job, Make Inactive (or Make Active), Delete
  Customer or Job, Activity Report (Ctrl+Q), Open Balance, the new-transaction items, Create Statement…), then tabs
  **Transactions** (SHOW type, FILTER BY status, DATE; columns TYPE, NUM, DATE, JOB / DUE DATE,
  ACCOUNT, AMOUNT, OPEN BALANCE, STATUS; row actions Receive payment / Create invoice from
  estimate / Transaction journal), **Contacts**, **To Do's** (To do, Due date, **Add to do**),
  **Notes** (**Save notes**).
- Right-click a customer for the same menu as More ▾.

### Vendor Center (Vendors > Vendor Center)
- Toolbar: **New vendor**, **New transactions ▾** (Enter bills, Pay bills, Purchase orders,
  Receive items, Enter bill for received items, Vendor credit, Write checks, Credit card
  charges), **Print ▾** (Vendor list, Vendor information), **Export ▾** (Export vendor list,
  Export transactions, Import vendors from a CSV file…), **Money Out**, **Pay bills**.
- Money bar: Open POs, Overdue, Open bills, Paid.
- Left tabs: **Vendors** (views: Active vendors, All vendors, Inactive vendors, Vendors with open
  balances, Vendors with overdue bills, Vendors with open purchase orders, Vendors paid in the last
  30 days; NAME, BALANCE; batch Make inactive / Export) and **Transactions** (by type).
- Right pane: vendor card (**Edit**, report links such as **Vendor Activity**), tabs **Transactions** (types: All
  transactions, Purchase orders, Item receipts, Bills, Vendor credits, Bill payments, Checks,
  Credit card activities, Sales tax payments; columns TYPE, NUM, DATE, DUE DATE, ACCOUNT, AMOUNT,
  OPEN BAL., STATUS; row menu Open, Pay bill…, Create bill, Receive items, Enter bill for these
  items, Transaction journal), **Contacts**, **To Do's**, **Notes**.
- Row menu: Edit vendor…, New vendor…, Delete vendor, Enter bill, Pay bills, Create purchase
  order, Write check, Enter vendor credit, Activity Report.

### Money In (Customers > Money In) and Money Out (Vendors > Money Out)
- Money In: money bar (Estimates, Unbilled activity, Overdue, Open invoices, Paid · 30 days),
  filters CUSTOMER OR JOB, Type, Status, Date, **Clear filters**; one list (TYPE, CUSTOMER OR
  JOB, NUMBER, DATE, DUE DATE, AMOUNT, OPEN BALANCE, STATUS, ACTION ▾: Receive payment, Create
  invoice, Open, Print, Customers); **Batch actions ▾** (Print selected forms, Create statements for
  these customers…, Export selected (CSV)); bottom **New invoice**, **Receive payment**, **New
  estimate**. "Unbilled activity" lists billable costs not invoiced yet.
- Money Out: toolbar **New ▾** (Bill, Purchase order, Receive items, Vendor credit), **Pay
  bills**, **Vendors**, **Export**; money bar Open POs, Overdue, Open bills, Paid; filters
  and "Find by number or memo"; list TYPE, VENDOR, NUMBER, DATE, DUE DATE, AMOUNT, OPEN BAL.,
  STATUS, ACTION (Pay, Create bill, Enter bill, Open); tick bills and **Pay selected bills**.

### Chart of Accounts (Ctrl+A)
- Columns Name (tree), Type, Balance Total, Description. Search, type chips (Bank, Assets,
  Liabilities, Equity, Income, Expenses), **Include inactive**, hover actions (Register or
  Activity Report, Edit).
- **Account ▾**: New, Edit Account, Delete Account, New Subaccount, Show Inactive Accounts,
  Hierarchical View / Flat View, Open Register, Find Transactions in Account..., Print List...,
  Import from CSV..., Export to CSV. **Activities ▾**: Write Checks, Make Deposits, Transfer
  Funds, Make General Journal Entries, Enter Credit Card Charges, Reconcile, Open Register.
  **Reports ▾**: Activity Report, Account Listing, Profit & Loss Standard (opens Profit and
  Loss), Balance Sheet, Trial Balance, General Ledger.
- Double-click: balance sheet accounts open their register; income and expense accounts open
  Account Activity. Accounts used by the app itself are marked and cannot be deleted.

### Register (Banking > Use Register, or double-click a balance sheet account)
- Two-line rows (a **1-line** toggle), running balance, ✓ column (click to mark cleared; R =
  reconciled). Filter bar: From, To, Type, Cleared status (Any status, Uncleared, Cleared,
  Reconciled), search, sort (Date, Number; Number / Ref; Amount (largest first); Payee; Type;
  Cleared status; Order entered). Toolbar: **Edit transaction**, **Activity Report**, **Print**,
  **Reconcile**, **Refresh**; quick links (Create invoice / Receive payment on A/R, Enter bill /
  Pay bills on A/P).
- Bottom entry row adds a Check or Deposit (bank), Charge or Credit (card), or a Journal entry
  (other accounts): Date, Number, payee, Account, Memo, amount, **Record** (Enter), **Restore**
  (Esc). Double-click a row opens its form.

### Item List
- Columns Name, Description, Type, Account, On Hand, On P.O., Price; chips Services, Inventory,
  Non-inventory, Other charges, Discounts & groups, Sales tax.
- **Item ▾**: New, Edit Item, Duplicate Item, Delete Item, Show Inactive Items, views, Print
  List..., Import from CSV..., Export to CSV. **Activities ▾**: Create Invoices, Enter Sales
  Receipts, Create Purchase Orders, Receive Items, Adjust Inventory.... **Reports
  ▾**: Item Listing, Item Price List, Sales by Item Summary, Purchases by Item Summary, Inventory
  Valuation Summary, Inventory Stock Status by Item.

### Other Names List, profile lists, Class List
- Other Names: Name, Company, Phone, Email; **Other Names ▾** (New, Edit Name, Delete Name, Show
  Inactive Names, Print List..., Import from CSV..., Export to CSV), **Activities ▾** (Write
  Check, Make General Journal Entries), **Reports ▾** (Activity Report, Other Names Phone List).
- Profile lists (Terms, Payment Method, Sales Rep, Customer Type, Vendor Type, Job Type, Customer
  Message, Shipping Method; the menu still says Ship Via List...) and Class List: one bottom menu (New, Edit, Delete, Show Inactive Entries,
  views, Print List...). Terms entries: Standard (net days, discount % and days) or Date driven.

### Bank Imports (Banking > Bank Feeds > Bank Feeds Center)
Left: **Accounts** (each bank and credit card account, count to review), **Import file**,
**Rules**. Right: optional import panel; tabs **For review**, **Categorized**, **Excluded**;
search "Search description or amount"; rows with Date, Bank description, Payee, Spent, Received,
Category or match (Added or matched to, on Categorized), action button; selection bar **Accept /
Exclude / Undo / Clear selection**. Details in 5.20.

### All Reports (Reports > Report Center)
Search box, **Memorized Report List** button, tabs **Standard** (categories on the left, each
report with a plain description; click to run; ★ to favorite), **Favorites**, **Recent**,
**Memorized** (rename, change group, delete).

### Reminders and To Do List (Company menu)
- Reminders: groups (overdue invoices, bills to pay, money to deposit, checks or invoices to
  print, inventory to reorder, memorized transactions due, open purchase orders, sales tax due, to
  dos), each with its action (Receive payments, Pay bills, Print checks, Print invoices, Make
  deposits, Create purchase order, Memorized transactions, Receive items, To Do list, Pay sales
  tax). **Expand all**, **Collapse all**, **Refresh**, **Preferences**.
- To Do List: **New To Do** (To do, Due date, About (customer, vendor or other name), Notes,
  Done), **Edit**, **Delete**; Show Open / Done / All.

### My Company and Insights (Company menu)
- My Company: company details (**Edit company information**), the company file (location, size,
  backups: **Back up now**, **Backup settings**, **Save a copy**, **Check company file**), users and
  closing date (**Set up users**, **Set closing date**), features on (**Preferences**), product
  information.
- Insights: Period, Income / Expenses / Net income, Income and expenses by month, This year and
  last year, Where the money goes, Best customers, Biggest suppliers, Balances; clicking a bar
  opens the report.

### Find and Search (Edit menu)
- Find (Ctrl+F): **Simple** (Transaction type, Name, Dates, Number, Amount, Text (number, name,
  memo)) or **Advanced** (add filters Account, Amount, Date, Item, Memo, Name, Number, Paid status,
  Transaction type, Text (anywhere)). **Find**, **Reset**. Results Date, Type, Num, Name, Account,
  Memo, Status, Amount; **Go To** (Enter / double-click), **Report**, **Export**.
- Search: every match for a text grouped by kind; Up / Down and Enter.

### Preferences (Edit > Preferences...) sections
Accounting (Use account numbers, Show only the last subaccount name, Track classes on
transactions, Number journal entries for me, date warnings "Warn me about dates more than ...
days back / days ahead", closing date **Set Date/Password...**), Bills (Bills are due days after
receipt, Warn about duplicate bill numbers from the same vendor, Take early payment discounts for
me, Default discount account), Checking (Warn about duplicate check numbers, default accounts for
Write Checks, Pay Bills, Make Deposits), Workspace (Tabs / Floating windows, Navigation, Show the
Home page), General (Fill in a payee's last accounts and amounts), Items and Inventory (Track
inventory, Use purchase orders, Warn about duplicate purchase order numbers, Warn me when a sale
needs more than the quantity on hand), Reminders (Show the Reminders list when opening a company
file), Reports (Summary reports basis Accrual / Cash, Aging reports, Reports show accounts by Name
only / Description only / Name and description), Sales (Usual invoice layout, Usual shipping
method, Usual FOB, Warn about duplicate invoice numbers, Use estimates, Apply payments to open
invoices for me, Add up the invoices I check into the payment amount, Keep payments in
Undeposited Funds until I deposit them, Default account for customer discounts), Sales Tax
(5.24). Company-wide preferences can be changed only by administrators; others can change
Workspace, automatic recall (General), the Reminders choice and the Checking default accounts.
Buttons **OK** / **Cancel**.

### Payroll: Employee Center and Payroll Center
- Employee Center (Employees > Employee Center): toolbar **New Employee…**, **Employee
  Settings ▾** (Defaults for New Employees…, Edit Employee, Delete Employee, Payroll Items, Pay
  Schedules), **Print ▾** (Employee List, Employee Information, Employee Transaction List,
  Paychecks…, Pay Stubs…), **Excel ▾** (Export Employee List, Export Transactions), **Word**
  (not available), **Pay employees**, **Pay payroll taxes**.
- Left tabs: **Employees** (View: Active Employees, All Employees, Released Employees; search;
  NAME), **Transactions** (Paychecks, Tax Payments, Tax Balance Adjustments, Year-to-Date
  Entries; date filters This Month ... Last Calendar Year), **Payroll** (the Payroll Center).
- Right pane for an employee: Employee Information card (Full name, SSN masked with **Show** for
  administrators (logged in the audit trail), Address, Main phone, Mobile, Main email, Hire date,
  Release date, Pay schedule, Pay rate, Work state, Paid by, Last paycheck; **Edit** (Ctrl+E),
  **More ▾**: Edit Employee, New Employee…, Delete Employee, Pay This Employee…, Final
  Paycheck…, Year-to-Date Amounts…, Activity Report), tabs **Transactions** (Show: All
  Transactions, Paychecks, Tax Balance Adjustments, Year-to-Date Entries; columns Transaction
  type, Num, Date, Account, Amount, SerieX Books; row menu Open, Paycheck Details…, Print Pay
  Stub…, Find and Edit Paychecks…) and **Notes**.
- Payroll Center (Employees > Payroll Center): right tabs (a "!" marks something due):
  - **Pay Employees**: **Payrolls to Run** (one row per pay schedule) and buttons (6.3), **Past
    Payrolls** (last 6 months: Date, Status, Paycheck count, Gross pay, Net pay), Other
    activities (Add Employee, Find and Edit Paychecks, Print Paychecks, Print Pay Stubs, Final
    Paycheck), Setup (Enter Year-to-Date Amounts, Payroll Items, Pay Schedules, Employee
    Defaults), Reports (Payroll Summary, Payroll Detail Review, Payroll Register, Report
    Center…).
  - **Pay Taxes**: **Taxes and Deductions Due** (Due date, Status, Payment, Period, Method, Amount
    due) with **More Tax Tasks ▾**, **Adjust Tax Balances…**, **Pay Selected…**; **Payments
    Made** (All Payments / E-Payments).
  - **Tax Forms**: **Forms to File** (Form, Federal/State, Filing period, Due date, Status, Year)
    with **All Tax Forms…**, **Forms ▾**, **File Form**; **Forms Filed**.
  - Left side: SerieX Books link status, a two-month calendar of paydays and due dates, links to
    Payroll Items, Pay Schedules, Employee Defaults, Payroll Setup.

### Payroll Items and Pay Schedules
- Payroll Items: Name, Type, Amount, Yearly Limit, Tax Treatment, Paid To, Account;
  **Payroll Item ▾** (New, Edit Payroll Item, Delete Payroll Item, Show Inactive Payroll Items,
  Add Default Payroll Items for a State..., Print List..., Export to CSV), **Activities ▾** (Pay
  Employees..., Pay Payroll Taxes..., Adjust Tax Balances..., Tax Forms..., Tax Payment
  Schedule..., Enter Year-to-Date Amounts...), **Reports ▾** (Payroll Item Settings, Payroll
  Item Detail, Payroll Summary, Payroll Liability Balances).
- Pay Schedules: Schedule, Pay Frequency, Next Pay Period, Next Check Date, Employees;
  menus **Pay Schedule ▾** (New / Edit Pay Schedule / Delete Pay Schedule...) and **Activities ▾**
  (Start Payroll, Extra Paycheck..., Payroll Center, Employee Defaults...).

---

## 8. Where to see what the API did

The screens do not refresh by themselves after changes made through the API. Windows that were
already open keep showing old data. Tell the user to close and reopen the window, or click
**Refresh** (Home, reports, registers, Reminders, Books Sync), or reload the page (F5 on
Windows and Linux, Cmd+R on Mac, or right-click > Reload). The **Recent transactions** lists
only hold transactions opened in that browser, not ones created by the API: use the search box
instead.

| Created or changed through the API | Where the user sees it |
|---|---|
| Company file (`POST /api/companies...`) | Books welcome screen "Your companies", or company name button > recent list; File > Open or Restore Company... |
| Customer or job | Customers > Customer Center (type the name in "Find a customer"), or the top search box |
| Vendor | Vendors > Vendor Center, or search box |
| Other name | Lists > Other Names List |
| Item | Lists > Item List (search "Search items") |
| Account | Lists > Chart of Accounts; balance sheet accounts: double-click for the register |
| Invoice (INV) | Customer Center > customer > Transactions; Money In; or search the invoice number. Opens in Create Invoices |
| Sales receipt (SALESRCPT) | Customer Center / Money In; opens in Enter Sales Receipts |
| Customer payment (PMT) | Customer Center (Received Payments); opens in Receive Payments; with Undeposited Funds it waits in Make Deposits > Payments |
| Credit memo (CREDMEM) | Customer Center (Credit Memos); opens in Create Credit Memos/Refunds |
| Statement charge (STMTCHG) | Customers > Enter Statement Charges (pick the customer) |
| Estimate (EST) | Customer Center (Estimates), Money In; opens in Create Estimates |
| Refund (REFUND) | Customer Center (Refunds); opens in "Refund" |
| Deposit (DEP) | Bank account register; opens in Make Deposits |
| Check (CHK) | Bank register; Vendor Center (Checks); opens in Write Checks |
| Bill (BILL), vendor credit (BILLCRED) | Vendor Center, Money Out, Pay Bills list; open in Enter Bills |
| Bill payment (BILLPMT) | Vendor Center (Bill payments), bank register; opens in "Bill Payment by Check" (or "Bill Payment by Credit Card") |
| Item receipt (ITEMRCPT) | Money Out (Item receipts); Vendors > Enter Bill for Received Items |
| Purchase order (PURCHORD) | Money Out (Open POs), Vendor Center; Reports > Purchases > Open Purchase Orders |
| Credit card charge / credit (CCCHARGE, CCCREDIT) | Credit card account register; opens in Enter Credit Card Charges |
| Transfer (TRANSFER) | Registers of both accounts; opens in "Transfer Money" |
| Journal entry (GENJRNL) | Reports > For Your Accountant > Journal; registers of its balance sheet accounts; opens in "Journal Entry" |
| Inventory adjustment (INVADJ) | Item List (On Hand), Reports > Inventory > Inventory Valuation Detail |
| Sales tax payment (TAXPMT) | Vendors > Sales Tax > Manage Sales Tax; bank register |
| Downloaded bank transactions | Banking > Bank Feeds > Bank Feeds Center ("Bank Imports") > For review |
| Bank rule | Banking > Bank Feeds > Manage Rules... |
| Reconciliation | Banking > Previous Reconciliation reports...; register shows R |
| Budget | Company > Planning & Budgeting > Set Up Budgets...; Reports > Budgets |
| Memorized transaction | Lists > Memorized Transaction List |
| Memorized report | Reports > Memorized Reports |
| Preferences | Edit > Preferences... (section per setting) |
| Closing date | Company > Set Closing Date... |
| Users | Company > Set Up Users and Passwords > Set Up Users... |
| Backup | File > Open or Restore Company... > Restore a backup > Automatic backups; Home > Backup status |
| Payroll employee | Payroll: Employees > Employee Center |
| Paycheck | Payroll: Employees > Find and Edit Paychecks...; Employee Center > Transactions; in Books as a check in the bank register |
| Tax payment / tax balance adjustment | Payroll: Employee Center > Transactions tab (Tax Payments / Tax Balance Adjustments); Payroll Liability Balances report; in Books as a check / journal entry |
| Payroll posting problems | Payroll: Employees > SerieX Books Sync... |

Any transaction can also be found with Edit > Find (Ctrl+F) or by typing its number or exact
amount in the search box. To show its postings, open it and press Ctrl+Y (Transaction journal).

Opening a company by address: `http://127.0.0.1:<books port>/?company=<company id>` opens that
company in a web browser (Payroll accepts the same `?company=`). The desktop app's own window
already shows the company it opened last.
