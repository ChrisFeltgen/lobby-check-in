# Lobby Check-In (formerly Virtual Queue)

A walk-in queue system for a public counter. One Node.js server and a MySQL/MariaDB database drive these screens:

| Screen | Path | Who uses it |
|---|---|---|
| Sign-in page | `/index.html` | Staff, managers and admins sign in here. Also links to the public screens. |
| Customer kiosk | `/kiosk.html` | Touch screen. The customer picks a language and a service, types their name, and gets a ticket. |
| Queue portal | `/queue.html` | Staff sign in with their own account and a counter name. They call, complete, transfer, or remove customers, and add walk-ins. |
| My account | `/account.html` | Everyone signed in. Change your display name, User ID, and password. |
| Management | `/manage.html` | Managers and Admins. Tabs: **Services**, **Staff**, **Reports** and, for Admins only, **Settings** and **Health & audit**. |
| Lobby monitor | `/monitor.html` | Public display for a TV. Shows who is being helped and who is waiting. |

For step-by-step hosting instructions aimed at non-technical readers, see [DEPLOY-CPANEL.md](DEPLOY-CPANEL.md). For Windows Server, see [DEPLOY-WINDOWS.md](DEPLOY-WINDOWS.md).

## Stack

- Node.js 18+ with Express and Socket.IO (live updates to every screen)
- MySQL 8 or MariaDB 10.5+ (runs on cPanel and on Windows Server)
- Plain HTML and JavaScript front ends, no build step. All URLs are built from the page's own location, so the app works at a domain root or under a sub-path.

## Local development

1. Create a database and a user (see [Database setup](#database-setup)).
2. Copy `.env.example` to `.env` and fill in the values. The server reads plain environment variables, so load the file with your shell or a process manager.
3. Install and run:

```bash
npm install
npm start
```

4. Open `http://localhost:3000`.

Leave `BASE_PATH` empty for local development.

To run the automated tests, use `npm test`. Admins can also run them from **Management → Health & audit → Automated tests**, which is useful on hosts without a command line.

## Database setup

Run once in phpMyAdmin (cPanel) or the MySQL command line:

```sql
CREATE DATABASE virtual_queue CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'queue_app'@'localhost' IDENTIFIED BY 'a-strong-password';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, ALTER ON virtual_queue.* TO 'queue_app'@'localhost';
```

On shared cPanel hosting, the database and user names get your account prefix (for example `youraccount_virtual_queue`). Use the full names in the environment variables.

The app creates its tables, adds any newer columns, and seeds the default services on startup (`db/schema.sql`). Every statement is safe to run again. Services are rows in the `services` table.

## Accounts and roles

Staff sign in with their own User ID and password. Each account has:

- a **User ID**, the username used to sign in. It must be unique and can be changed;
- a **display name**, shown on the screens and in the reports. It can also be changed;
- a permanent internal number, which the system uses to tell accounts apart.

Past tickets keep the staff name as it was when the customer was called. Renaming someone changes how their new calls are labelled, not old records.

| Role | Can do |
|---|---|
| **Staff** | Use the queue portal: call, complete, transfer, remove, and add customers. Edit their own profile and password on My account. |
| **Manager** | Everything Staff can do. On Management: **Services** and **Reports**, plus the **Staff** tab for **Staff accounts only**: add, edit name and User ID, reset password, disable, and remove. Managers can't change roles. |
| **Admin** | Everything Manager can do, plus manage every account, including other Managers and Admins, change roles, and use the **Settings** and **Health & audit** tabs. |

Nobody can change their own role, disable their own account, or remove their own account. The last active admin can't be disabled, demoted or removed.

**Disable** keeps an account and its history, but it can't sign in. Turn it back on from the same row. **Remove** deletes the account. Use disable for people who may return.

**Password resets end sessions:** when an admin or manager resets someone's password, every browser that person was signed in on is signed out straight away. Disabling an account does the same. Changing your own password signs out your other browsers too.

**Forced password change:** when an account is added or its password is reset, **Require user to change password on next sign-on** is ticked by default. That person is taken to My account after signing in and can't use the queue portal or Management until they choose their own password. Untick it only when you have a reason to.

**My account** lets anyone signed in change their display name and User ID, and change their password. A new password must be at least as long as the minimum set in Settings (8 characters by default). Changing it signs out every other browser, and keeps you signed in on this one.

**The first admin account** is created on first startup, from the `ADMIN_USERNAME` and `ADMIN_PASSWORD` environment variables, but only if no admin exists yet. Sign in with it, then change its password on My account, or remove those two variables. They're ignored once an admin exists.

Passwords are hashed with Node's built-in `scrypt`. Sessions are a signed cookie (`SESSION_SECRET`), so staff stay signed in across restarts as long as that secret doesn't change. A session lasts 12 hours from sign-in by default, and Settings → Security and sessions can change that and add an idle sign-out.

**Sign-in lockout:** after a set number of failed sign-ins for a User ID (5 by default), that User ID is locked for a set time (15 minutes by default), even with the right password. A successful sign-in starts the count again. Settings → Security and sessions changes both numbers, and 0 turns the lockout off. The count comes from the audit log, so a lockout also ends when the failed attempts are older than the lockout time.

## Management: Services tab

Services are listed alphabetically, one card each. The card's edge is green when the service is open and red when it's closed. Closed services show the reason in a red banner.

Two kinds of closure exist, and a manual choice always takes precedence over a recurring one:

**Manual choices (on the card's buttons):**

| Button | When it appears | What it does |
|---|---|---|
| **Close now…** | Service is open | Closes it until you reopen it. You can set a reopen time. |
| **Keep closed…** | Closed by a recurring closure | Keeps it closed after the scheduled end time, until you reopen it. |
| **Open now** | Closed by a recurring closure | Opens it now, but only until the scheduled closure ends. Then it closes as scheduled. |
| **Reopen** | Closed manually | Lifts the manual closure. Recurring closures apply again. |
| **Return to schedule** | A manual open or close is in place | Drops any manual choice, so recurring closures apply again. |

Managers and Admins can also reopen a closed queue from the queue portal's **⋯** menu.

**Recurring closures:** each has a reason, a day of the week, a start and end time, and either every week or specific weeks of the month (1st, 2nd, 3rd, 4th, and/or last). For example: "Code Compliance is closed 12 pm to 4 pm on the 1st and 3rd Wednesday of every month." Pause, edit or delete them from the card.

Nothing runs on a timer. Availability is worked out from the current time on every request (`availability.js`), so there's no scheduled job to keep running.

A closed service still shows on the kiosk, queue portal and monitor, dimmed, with the reason. Customers can't check in while it's closed; the kiosk and the server both enforce this.

## Management: Reports tab

- **Date range:** From and To dates, up to a year at a time. Changing one keeps the range in order.
- **Ticket history:** every ticket created in the range, with its times, staff and status. A **Search name** box filters the list as you type, ignoring case. **Export CSV** downloads what's on screen. Dates and times are separate columns, so the file opens cleanly in a spreadsheet. **Print** prints the current view.
- **Service summary:** per service, the number arrived, served, removed and still open, with average wait and service time, and a total row.
- **Staff performance:** each person's total calls and completions, with average service time, and their per-service breakdown underneath. A final row totals everyone.
- **Hourly trends:** arrivals and completions by hour of the day, with average wait.

The report reads from `GET /api/reports/range?from=YYYY-MM-DD&to=YYYY-MM-DD`. The older `/api/reports/day?date=` address still works, as a one-day range, for browsers that still have an old copy of the page.

## Management: Health & audit tab (Admins only)

**Health and tests**

- **Run health check** shows how long the app has been running, the Node.js version, database response time, whether the database and app clocks agree, today's waiting and served counts, and how many active admins there are. Warnings appear when something needs attention.
- **Check database** tests the connection, confirms every table and column the app needs is present, checks it can write, and reports the database size and record counts. Problems are listed first.
- **Run tests** runs the automated test suite and shows the output. Each run is recorded in the audit log.

**Activity (audit log)**

The 200 most recent changes: who signed in (and failed sign-ins), who added, changed, reset or removed accounts, service openings and closures, recurring closures, settings changes, cleanups, and test runs. Use the **Search** box to filter by a name, a User ID, or an action. A search matches the person who acted, the account that was changed, the action, and the details, so searching a User ID shows both what that person did and what was done to their account. Search covers the whole log, but results are capped at 200 rows.

The audit log is kept for the number of days set under **Audit log retention** in the same tab. The default is 0, which keeps everything. The minimum is 30 days, because sign-in lockouts count failed attempts from this log. The old-records cleanup doesn't touch the audit log.
## Management: Settings tab (Admins only)

**Old records**

Finished tickets can be cleaned up after a set number of days. Choose the number of days (0 keeps everything) and what to do:

- **Blank out names** keeps each ticket's times and staff for reports but removes the customer's name.
- **Delete** removes the tickets completely, so reports no longer include them. This can't be undone.

Press **Save settings** at the foot of the tab, then use **Run cleanup now** to act on them straight away. The cleanup also runs automatically once when the app starts and then once a day. The last cleanup time is shown beside the settings.

**Kiosk, lobby monitor, security, branding and audit retention** are on the same tab, in groups. One **Save settings** button at the foot of the tab saves all of them, including the old-records rule:

- **Kiosk:** how long the kiosk waits before returning to the start (60 seconds by default), how long the confirmation stays up (10 seconds by default), whether it is light or dark (light by default), and how many check-ins one address may make per minute (20 by default; 0 means no limit). A customer who goes over the limit sees a message asking them to wait a minute.
- **Lobby monitor:** how long the Now Calling notice stays up (15 seconds), whether the chime plays, how fast long queues scroll (slow, normal or fast), and which departments each side of the screen shows, and whether it is light or dark (dark by default). Pick a whole department or individual services, but not both. Monitors pick up changes within a minute, without a reload.
- **Security and sessions:** session length (12 hours), idle sign-out (off by default), minimum password length (8), whether new accounts must change their password on first sign-in (on by default), and the sign-in lockout (5 failed attempts, 15 minutes). A new session length applies at each sign-in. The idle sign-out applies from each person's next request.
- **End of day:** a time such as 17:30, or blank to turn it off. At that time, and once a day, every ticket still waiting, called or being served is closed as removed and the screens update. It uses the server's clock and is recorded in the audit log.
- **Branding:** the organisation name, shown above the page headings and in the page titles, and the logo. The logo is a PNG, JPEG or WebP image under 300 KB, stored in the database. The page headers show the uploaded logo. With no logo set, the headers show none. Removing the logo hides it.

## Queue portal

- **Call next** starts service right away and records the counter and the staff member.
- **Complete**, **Transfer**, **Return to waiting** and **Remove** act on customers being helped.
- **Add customer** adds a walk-in to a queue, with an appointment time for the Appointment Check-In service.
- Services are listed alphabetically in the dialogs.
- **Service Queues** is a sidebar. It collapses on narrow screens so the lobby list stays in view. Click a queue to watch or stop watching it. If you have no saved default, the foot of the sidebar offers **Save as my default**. Once one is saved, that prompt disappears, and you edit or clear the default on **My account**. The saved default is applied every time you sign in, on any computer. Changes you make during a session stay on that computer until your next sign-in.
- The **bell** turns on desktop alerts. An alert appears when someone checks in to a queue you're watching. It shows the name, the service, and their position in line, and closes after 6 seconds. The alert needs the browser's notification permission.

## Customer kiosk

Customers choose a language, then a service, type their name (and, for appointments, who they're seeing and the time), and get a ticket number. The screen returns to the start after the confirmation time, or after the inactivity time. Both are set in **Management → Settings → Kiosk** (10 seconds and 60 seconds by default).

## Lobby monitor

Open `monitor.html` full screen on the display. It updates itself.

- **Now Serving:** one card per customer being helped, showing the customer's first name and last initial (for example "Jane S."), the service, and "Helping" with the staff member and counter. The cards grow and shrink with how many people are being helped. A name with only one part is shown as given.
- **Now Calling:** when a customer is called, a notice appears with the name, service, and "[Staff] will be with you shortly.", and a short chime plays. Browsers may block sound until someone has clicked on the page once.
- **Service Queues:** a department with two or more people waiting takes the wider column, with its queues side by side. Other departments stack beside it. Departments with nobody waiting show "No customers waiting".
- **Long queues:** as many names as fit on the screen are shown. A longer queue scrolls slowly inside its box, and every customer keeps their own number.
- **Empty lobby:** a welcome message appears in place of empty panels.

Choose which departments a screen shows with the `panel` setting:

- `monitor.html?panel=left` shows Planning & Zoning, Code Compliance and Business Tax Receipts.
- `monitor.html?panel=right` shows Building Dept., Records & Alarms and Appointment Check-In.
- `monitor.html` with no setting shows every department.

Set these in **Management → Settings → Lobby monitor**. The `PANELS` setting near the top of `public/monitor.html` only supplies the defaults used if the settings can't be loaded.

## Configuration

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port. cPanel's Node.js app sets this for you. |
| `SESSION_SECRET` | Signs staff login sessions. Required. Use a long random value and keep it the same, or everyone is signed out on every restart. |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Creates the first admin account when none exists. |
| `BASE_PATH` | Sub-path the app runs under, for example `/virtual-queue`. Leave empty at a domain root. |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Database connection. |
| `DB_POOL_SIZE` | Database connection pool size (default 10). |

## Deploying

- **Shared cPanel hosting:** follow [DEPLOY-CPANEL.md](DEPLOY-CPANEL.md), which is written step by step. Shared hosts often don't install `node_modules` from the control panel. The guide explains how to upload it yourself.
- **Windows Server:** follow [DEPLOY-WINDOWS.md](DEPLOY-WINDOWS.md). It covers installing Node.js and MySQL, running the app as a Windows service with NSSM, putting IIS in front for HTTPS, backups, updates and troubleshooting. The IIS configuration is in `deploy/windows/web.config`.

### Updating

1. Upload the changed files, replacing the old ones. Don't upload `node_modules` again unless `package.json` changed.
2. Restart the Node.js app.
3. On each screen, press **Ctrl+Shift+R** once to load the new page.

`public/.htaccess` tells Apache-style hosts (including LiteSpeed) to re-check HTML pages on every visit, so browsers don't keep an old copy. Node's own server sends the same header from `server.js`. Your host must allow the `.htaccess` file for it to work.

## Security notes

- The kiosk and monitor are public. The monitor shows each customer's first name and last initial, not the full name. Only use these screens where that's acceptable.
- Give every staff member their own account, and disable (rather than delete) accounts when someone leaves, so past records stay readable.
- Never share passwords or `SESSION_SECRET` in chat, email or screenshots. If one is exposed, change it straight away. Changing `SESSION_SECRET` signs everyone out.
- Serve the site over HTTPS. The session cookie is marked `Secure` when the request arrives over HTTPS.
- Customer names are kept on finished tickets so reports work. Set an old-records policy in **Settings → Old records** if your records policy requires it.
- Sign out on shared computers. Sessions last 12 hours by default. With an idle sign-out set, a queue portal that stays open keeps asking the server for updates, which counts as activity. The idle sign-out therefore takes effect on pages that stay quiet, such as Management and My account.

## Project layout

```
server.js          Express routes, optional BASE_PATH handling, Socket.IO updates
auth.js            Password hashing, password rules and session cookies (Node's built-in crypto)
availability.js    Works out "open or closed right now" from manual choices and recurring closures
reports.js         Checks report date ranges
settings.js        App settings: names, limits and defaults for Settings → Kiosk, monitor, security, branding and audit
db.js              All database access (MySQL via mysql2), including audit log, cleanup and database check
db/schema.sql      Tables and default services (runs on startup)
tests/             Automated tests (npm test, or Health & audit → Automated tests)
public/            index.html, kiosk.html, queue.html, account.html, manage.html, monitor.html,
                   app.css, theme.js, .htaccess, images/ (logo.png, notification-icon.png)
deploy/windows/    web.config for IIS in front of the Windows Server app
DEPLOY-CPANEL.md   Step-by-step cPanel hosting guide for non-technical readers
DEPLOY-WINDOWS.md  Step-by-step Windows Server hosting guide (IIS, NSSM, MySQL)
.env.example       Environment variables template
```
