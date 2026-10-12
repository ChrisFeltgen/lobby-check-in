# Lobby Check-In (formerly Virtual Queue)

A walk-in queue system for a public counter. One Node.js server and a MySQL/MariaDB database drive these screens:

| Screen | Path | Who uses it |
|---|---|---|
| Sign-in page | `/index.html` | Staff, managers and admins sign in here. Also links to the public screens. |
| Customer kiosk | `/kiosk.html` | Touch screen. The customer picks a language and a service, types their name, and gets a ticket. Open to anyone unless an admin locks it (see [Locking the kiosk and monitor](#locking-the-kiosk-and-monitor)). |
| Queue portal | `/queue.html` | Staff sign in with their own account and a counter name. They call, complete, transfer, or remove customers, and add walk-ins. |
| My account | `/account.html` | Everyone signed in. Change your display name, User ID, and password. |
| Management | `/manage.html` | Managers and Admins. Tabs: **Operations**, **Staff**, **Reports** and, for Admins only, **Service Configuration**, **Settings**, **Security** and **Health and Audit**. |
| Lobby monitor | `/monitor.html` | Display for a TV. Shows who is being helped and who is waiting. Open to anyone unless an admin locks it. |

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

To run the automated tests, use `npm test`. Admins can also run them from **Management → Health and Audit → Automated tests**, which is useful on hosts without a command line.

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
| **Manager** | Everything Staff can do. On Management: **Operations** and **Reports**, plus the **Staff** tab for **Staff accounts only**: add, edit name and User ID, reset password, disable, and remove. Managers can't change roles. |
| **Admin** | Everything Manager can do, plus manage every account, including other Managers and Admins, change roles, and use **Service Configuration** and the **Settings**, **Security** and **Health and Audit** tabs. |

Nobody can change their own role, disable their own account, or remove their own account. The last active admin can't be disabled, demoted or removed.

**Disable** keeps an account and its history, but it can't sign in. Turn it back on from the same row. **Remove** deletes the account. Use disable for people who may return.

**Password resets end sessions:** when an admin or manager resets someone's password, every browser that person was signed in on is signed out straight away. Disabling an account does the same. Changing your own password signs out your other browsers too.

**Forced password change:** when an account is added or its password is reset, **Require user to change password on next sign-on** is ticked by default. That person is taken to My account after signing in and can't use the queue portal or Management until they choose their own password. Untick it only when you have a reason to.

**My account** lets anyone signed in change their display name and User ID, and change their password. A new password must be at least as long as the minimum set in Settings (8 characters by default). Changing it signs out every other browser, and keeps you signed in on this one.

**The first admin account** is created on first startup, from the `ADMIN_USERNAME` and `ADMIN_PASSWORD` environment variables, but only if no admin exists yet. Sign in with it, then change its password on My account, or remove those two variables. They're ignored once an admin exists.

Passwords are hashed with Node's built-in `scrypt`. Sessions are a signed cookie (`SESSION_SECRET`), so staff stay signed in across restarts as long as that secret doesn't change. A session lasts 12 hours from sign-in by default, and Security → Security and sessions can change that and add an idle sign-out.

**Sign-in lockout:** after a set number of failed sign-ins for a User ID (5 by default), that User ID is locked for a set time (15 minutes by default), even with the right password. A successful sign-in starts the count again. Security → Security and sessions changes both numbers, and 0 turns the lockout off. The count comes from the audit log, so a lockout also ends when the failed attempts are older than the lockout time.

## Management: Operations tab

Services are listed in the order the kiosk shows them, under the heading of the department group they belong to (services with no group are under **Other services**), one compact card each. The card's edge is green when the service is open and red when it's closed. Closed services show the reason in a red banner. At the top, a search box finds a service by name or code, **All / Closed / With recurring closures** filters the list, and a line counts how many services are open and closed. A card's recurring closures are folded away behind its **Recurring closures** button, which stays open while you work on them.

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

**Recurring closures:** each has a reason, a day of the week, a start and end time, and either every week or specific weeks of the month (1st, 2nd, 3rd, 4th, and/or last). For example: "Code Compliance is closed 12 pm to 4 pm on the 1st and 3rd Wednesday of every month." Pause, edit or delete them from the card, under **Recurring closures**.

Nothing runs on a timer. Availability is worked out from the current time on every request (`lib/availability.js`), so there's no scheduled job to keep running.

A closed service still shows on the kiosk, queue portal and monitor, dimmed, with the reason. Customers can't check in while it's closed; the kiosk and the server both enforce this.

## Service Configuration (admins only)

Open the **Service Configuration** tab on Management, after **Reports**. It has four sections:

- **Services:** one card per service. Add a service with a code (2 to 10 letters or numbers), a name, a description, an icon, a department group and a colour for the monitor (used when the service is not in a group). Change any of these and press **Save** on that card. The **Kiosk layout** panel at the top of the tab is where you arrange the kiosk: drag a service to move it along its row or to another row, drop it on **Add a row** to start a new row, and use **Remove row** on an empty row. With a service selected, the arrow keys move it too. Press **Save layout** to apply it, or **Discard changes** to go back; nothing changes on the kiosk until you save, and empty rows are left out. The panel warns when a row has more than four services, which may wrap on a smaller screen. A new service goes at the end of the last row, or on a new row when that one has four. Existing services are put in rows of at most four, in their old order, the first time the app starts with this feature. Two switches on each card change how a service behaves. **Asks who they are seeing and the appointment time** makes the kiosk, the server and the **Add customer** form ask those two questions for it; Appointment Check-In has it on by default. **Always in staff watched queues** pins it in every staff member's Your Watched Queues, where it cannot be unwatched and sits first (hidden while it is empty and open); Appointment Check-In has this on too. Any service can have either or both. Turning such a service off or deleting it asks you first, because it loses these behaviours. An install that already had Appointment Check-In keeps both behaviours when the app is first started with this feature. Turn a service off by clearing **Show on kiosk**; if customers are waiting for it, you are asked first, because they would disappear from the queue screens. A service with customers on record cannot be deleted, because its history must stay in the reports. Turn it off instead.
- **Department groups:** services in the same group share one card on the lobby monitor, such as Building Dept. Add a group with an id (lower case letters, numbers and dashes), a name, an icon and a colour. **Order** sets where the group is listed in Settings, under Monitor configuration. The order on each monitor itself is the order chosen there. A group that still has services cannot be deleted. Deleting a group, or a service, also takes it out of the left and right monitor panels in Settings; a panel left empty goes back to its default.
- **Languages:** add a language with its code (for example `pt-br`) and its name as people in that language write it. Turn a language on or off here. **Delete** removes a language and every translation in it for good; turn it off instead to keep them. The kiosk offers the languages that are on, and its welcome screen greets in each one that has a translation of the welcome line (under Kiosk wording). English is always on and cannot be deleted.
- **Translations:** choose a language and translate each service name and description, each group name, and each line of kiosk wording. The English is shown beside each item. An empty box uses the English. Tick **Show only items still to translate** to work through what is left.

  **A new service is in the list at once, with nothing translated.** Until it is, the kiosk shows its English name and description in the other languages (nothing is translated by machine). The page says so: after you add a service it offers **Translate it now**, a service that still needs translating carries a **Needs translation** pill (click it to go straight to its items), each language on the Languages tab says how many items it still lacks, and the **Translations** tab shows the total as a number. A service with no description has no description to translate. The same goes for a new language: everything in it starts untranslated.

  The kiosk wording covers everything the kiosk says to a customer: the screens, the buttons, the "Select a Language" line, the messages when a check-in cannot be made (such as the check-in limit), and the "Kiosk unavailable" screen, which is shown in every language that is on. The reason for a closure that staff type in Operations is shown exactly as typed, in every language, so write it in the languages your kiosk offers. The monitor, the queue portal and Management are in English only.

Changes show on the kiosk, the queue portal and the monitors straight away, without a reload. Changes you have made on a card but not saved are kept when you save another card, and the page asks before it throws them away.

The default services are set up on the first start only. A default service you delete stays deleted after a restart, and a code that used to belong to a retired service (for example PRM) can be reused.

The lobby monitor draws any group or service set in **Management → Settings → Monitor configuration**, including new ones. A department and one of its own services cannot both be chosen.

Spanish is set up by default. The Spanish group names and any Spanish service text were written for the first setup and should be reviewed with staff before use.

## Management: Reports tab

- **Date range:** From and To dates, up to a year at a time. Changing one keeps the range in order.
- **Ticket history:** every ticket created in the range, with its times, staff and status. A **Search name** box filters the list as you type, ignoring case. **Export CSV** downloads what's on screen. Dates and times are separate columns, so the file opens cleanly in a spreadsheet. **Print** prints the current view.
- **Service summary:** per service, the number arrived, served, removed and still open, with average wait and service time, and a total row.
- **Staff performance:** each person's total calls and completions, with average service time, and their per-service breakdown underneath. A final row totals everyone.
- **Hourly trends:** arrivals and completions by hour of the day, with average wait.

The report reads from `GET /api/reports/range?from=YYYY-MM-DD&to=YYYY-MM-DD`. The older `/api/reports/day?date=` address still works, as a one-day range, for browsers that still have an old copy of the page.

## Management: Health and Audit tab (Admins only)

**Health and tests**

- **Run health check** shows how long the app has been running, the Node.js version, database response time, whether the database and app clocks agree, today's waiting and served counts, and how many active admins there are. Warnings appear when something needs attention.
- **Check database** tests the connection, confirms every table and column the app needs is present, checks it can write, and reports the database size and record counts. Problems are listed first.
- **Run tests** runs the automated test suite and shows the output. Each run is recorded in the audit log.

**Activity (audit log)**

The 200 most recent changes: who signed in (and failed sign-ins), who added, changed, reset or removed accounts, service openings and closures, recurring closures, settings changes, cleanups, and test runs. Use the **Search** box to filter by a name, a User ID, or an action. A search matches the person who acted, the account that was changed, the action, and the details, so searching a User ID shows both what that person did and what was done to their account. Search covers the whole log, but results are capped at 200 rows.

The audit log is kept for the number of days set under **Audit log retention** on the Security tab. The default is 0, which keeps everything. The minimum is 30 days, because sign-in lockouts count failed attempts from this log. The old-records cleanup doesn't touch the audit log.

## Management: Settings tab (Admins only)

The Settings tab has five groups, in this order. One **Save settings** button at the foot of the tab saves all of them.

- **Site branding:** the organisation name, shown above the page headings and in the page titles, and the logo. The logo is a PNG, JPEG or WebP image under 300 KB, stored in the database. The page headers show the uploaded logo. With no logo set, the headers show none. Removing the logo hides it.
- **Kiosk configuration:** how long the kiosk waits before returning to the start (60 seconds by default), how long the confirmation stays up (10 seconds by default), whether it is light or dark (light by default), and how many check-ins one address may make per minute (20 by default; 0 means no limit). A customer who goes over the limit sees a message asking them to wait a minute. Kiosks pick up changes within a minute, without a reload.
- **Monitor configuration:** how long the Now Calling notice stays up (15 seconds), whether the chime plays, how fast long queues scroll (slow, normal or fast), which departments each side of the screen shows, and whether it is light or dark (dark by default). Pick a whole department or individual services, but not both. Monitors pick up changes within a minute, without a reload.
- **End of day setting:** a time such as 17:30, or blank to turn it off. At that time, and once a day, every ticket still waiting, called or being served is closed as removed and the screens update. It uses the server's clock and is recorded in the audit log.
- **Old record retention:** finished tickets can be cleaned up after a set number of days. Choose the number of days (0 keeps everything) and what to do:
  - **Blank out names** keeps each ticket's times and staff for reports but removes the customer's name.
  - **Delete** removes the tickets completely, so reports no longer include them. This can't be undone.

  Press **Save settings** at the foot of the tab, then use **Run cleanup now** to act on them straight away. The cleanup also runs automatically once when the app starts and then once a day. The last cleanup time is shown beside the settings.

## Management: Security tab (Admins only)

The Security tab has three groups, in this order. Its own **Save settings** button at the foot of the tab saves all of them. It is separate from the Settings tab's button, so each tab keeps its unsaved changes until you save it.

- **Security and sessions:** session length (12 hours), idle sign-out (off by default), minimum password length (8), whether new accounts must change their password on first sign-in (on by default), and the sign-in lockout (5 failed attempts, 15 minutes). A new session length applies at each sign-in. The idle sign-out applies from each person's next request.
- **Kiosk and monitor access:** a switch that makes the kiosk and the monitor open only for someone who is signed in or for a screen set up with an access link, and the list of access links. See [Locking the kiosk and monitor](#locking-the-kiosk-and-monitor).
- **Audit log retention:** how many days the audit log is kept (see Activity above).

## Queue portal

- **Call next** starts service right away and records the counter and the staff member.
- **Complete**, **Transfer**, **Return to waiting** and **Remove** act on customers being helped.
- **Add customer** adds a walk-in to a queue, with who the customer is seeing and the appointment time for a service set up for appointments (Appointment Check-In by default).
- Services are listed alphabetically in the dialogs.
- **Service Queues** is a sidebar. It collapses on narrow screens so the lobby list stays in view. Click a queue that is not watched to watch it; to stop watching one, use the small **✕** on its row (an **Undo** appears for a few seconds). A queue that has someone waiting has a **▶** button to call them. If you have no saved default, the foot of the sidebar offers **Save as my default**. Once one is saved, that prompt disappears, and you edit or clear the default on **My account**. The saved default is applied every time you sign in, on any computer. Changes you make during a session stay on that computer until your next sign-in.
- **Connection warning:** the portal checks the server every 10 seconds (every 3 after a failed check) and gets live updates besides. If two checks in a row fail, the browser reports no network, or 25 seconds pass with no good update, a banner across the top says **Connection lost** (or **This computer is offline**) with the time of the last update, the **Updated** time turns red, and the buttons that change things are paused, so nothing is sent against an out-of-date list. **Retry now** checks at once. When the server answers again the banner says **Back online** for a few seconds and everything resumes. Every request has a 10-second time limit, so a connection that hangs is caught too. Errors from actions also pop up for a few seconds instead of sitting at the foot of the page.
- The **bell** turns on desktop alerts. An alert appears when someone checks in to a queue you're watching. It shows the name, the service, and their position in line, and closes after 6 seconds. The alert needs the browser's notification permission.

## Customer kiosk

Customers choose a language, then a service, type their name (and, for appointments, who they're seeing and the time), and get a ticket number. The screen returns to the start after the confirmation time, or after the inactivity time. Both are set in **Management → Settings → Kiosk configuration** (10 seconds and 60 seconds by default).

**When the server cannot be reached:** the kiosk checks the server every 15 seconds (every 3 while something looks wrong). After two failed checks in a row, or as soon as the browser reports it is offline, or when a check-in cannot be sent, it covers the screen with "Kiosk unavailable" in English and Spanish and sends people to a staff member. When the server answers again the message goes away within a few seconds and the kiosk starts over from the welcome screen. Nobody needs to touch it. A check-in that was in progress is lost, so the customer starts again. A kiosk that is restarted while the server is down still opens; see **When the app is stopped** below.

## When the app is stopped

If the app is stopped (for example with **Stop App** on cPanel's Node.js page), the web server has nothing at the address and answers every page, including the screens themselves, with its own **404 Not Found**. A screen that is already open is not affected: it carries on and says the connection is lost (the kiosk's full-screen message, the portal's banner, the monitor's "Connection lost, retrying…") and starts working again by itself when the app is back.

A screen that is reloaded or restarted during that time is covered by `public/sw.js`, a small service worker every screen registers. It keeps a copy of the pages, scripts and styles, asks the server first every time (so an upload is picked up at once), and uses the copy only when the server cannot supply the page. The screen then opens, says it cannot reach the server, and carries on when it can. Customer data is never kept: nothing from `/api/` is saved.

- It needs HTTPS (or localhost), and each computer has to open a screen once after the update so it can save its copy. Open the kiosk and the portal once on each machine after uploading.
- To test the warnings without stopping the app, open the screen, then use the browser's developer tools (**Network**, then **Offline**), or switch the network off. A page that was open before the app was stopped shows the warning; to test a reload, reload a page you have already visited.
- To test the **404** case itself, stop the app, then reload a screen that this computer has opened before.

## Lobby monitor

Open `monitor.html` full screen on the display. It updates itself.

- **Now Serving:** one card per customer being helped, showing the customer's first name and last initial (for example "Jane S."), the service, and "Helping" with the staff member and counter. The cards grow and shrink with how many people are being helped. A name with only one part is shown as given.
- **Now Calling:** when a customer is called, a notice appears with the name, service, and "[Staff] will be with you shortly.", and a short chime plays. Browsers may block sound until someone has clicked on the page once.
- **Service Queues:** a department with two or more people waiting takes the wider column, with its queues side by side. Other departments stack beside it. When nobody is waiting anywhere, a department shows "No customers waiting". Beside a department that has two or more queues waiting, or when there are more than six departments, or when the screen is too short for the full cards, a department with nobody waiting shrinks to a slim bar with just its icon and name (a closed one also says "Closed"), so a busy department can never push the quiet ones off the bottom of the screen. If the busiest lobby still does not fit, which can happen when most departments have people waiting at once or on a smaller screen, the whole page is drawn a little smaller, down to half size, rather than letting the bottom run off a screen nobody can scroll. The monitor shows no scrollbar.
- **Long queues:** as many names as fit on the screen are shown. A longer queue scrolls slowly inside its box, and every customer keeps their own number.
- **Empty lobby:** a welcome message appears in place of empty panels.

Choose which departments a screen shows with the `panel` setting in its address:

- `monitor.html?panel=left` shows the departments chosen for the left screen. By default these are Planning & Zoning, Code Compliance and Business Tax Receipts.
- `monitor.html?panel=right` shows the departments chosen for the right screen. By default these are Building Dept., Records & Alarms and Appointment Check-In.
- `monitor.html` with no setting shows every department.

Choose the departments for each side in **Management → Settings → Monitor configuration**. The sign-in page lists what each side currently shows. The defaults above are in `settings.js`.

## Locking the kiosk and monitor

By default anyone who has the address can open the kiosk and the monitor, and the monitor shows customers' first names and last initials. An admin can lock both: **Management → Security → Kiosk and monitor access**.

**Setting it up**

1. In **Access links**, type a name for a screen (for example "Lobby kiosk"), choose **Kiosk** or **Monitor**, and press **Make a link**. The address appears once, with a **Copy link** button. For a monitor, a **Monitor mode** choice appears: **Full** shows every department, **Left screen** or **Right screen** shows the departments chosen for that side under Monitor configuration on the Settings tab (for a lobby with two displays). The mode is saved with the link and is part of its address (`monitor.html?panel=left#key=...`), and the list shows it. Make one link per display, and a new key for a link keeps its mode.
2. Open that address on that screen, once. That is all it takes: the screen is unlocked from then on, even after the computer restarts, and the key is removed from the address bar. If the screen's browser forgets everything each time it starts, set the address as its start page instead, and it unlocks itself each time.
3. Make a link for every kiosk and monitor, one each, so you can tell them apart and revoke just one. A link made for the kiosk does not open the monitor, and the other way round, so a monitor that is stolen cannot be used to check customers in.
4. Tick **Restrict access to signed-in users, or to screens opened with an access link** and press **Save settings**. It asks first, and tells you how many active links there are. You can try a link before you turn the switch on.

**What it does.** With the switch on, the kiosk and monitor open for someone who is signed in (any staff account) and for a browser holding the key of a link of the right kind. Everything else sees a lock screen. The lock screen shows no customers and no services, because the server refuses the data as well: the pages themselves are only a frame, so hiding them alone would protect nothing. That covers the services, wording and department list the kiosk reads, the check-in itself, the queue the monitor reads, and the live connection. The sign-in page, the staff pages and the pages' colours and logo are not affected, so an admin can always sign in and change this.

**Revoking.** **Revoke** locks every screen using that link within seconds, with nobody touching them, and the link stops working. **New link** gives the same screen a new key (the old one stops working at once, and a revoked link is switched back on). **Remove** takes it off the list. A screen that has been locked opens again by itself, within a few seconds, when it is let back in: a new link is opened on it, someone signs in on it, or the switch is turned off. Turning the switch on or off, and revoking, also drops every live connection, so each screen is checked again.

**Keeping it safe.** The key is shown once, when the link is made or replaced. The server keeps only a hash of it, so a copy of the database opens nothing, and if a link is lost the answer is a new link for the same screen. A link is like a password: anyone who has it can open that kind of screen until it is revoked, so do not email it or post it. The browser holds the key in a cookie that scripts on the page cannot read, and it is renewed while the screen is in use. The key sits after a # in the link (kiosk.html#key=...), and a browser never sends that part of an address to the web server, so it does not appear in the host's logs. It is sent once, when the screen is opened, to unlock it, so use HTTPS (see Security notes). Each link shows when it was last used, and every change to links and to the switch is in the audit log.

## Configuration

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port. cPanel's Node.js app sets this for you. |
| `SESSION_SECRET` | Signs staff login sessions. Required. Use a long random value and keep it the same, or everyone is signed out on every restart. |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Creates the first admin account when none exists. |
| `BASE_PATH` | Sub-path the app runs under, for example `/virtual-queue`. Leave empty at a domain root. |
| `TRUST_PROXY` | Optional. How many proxies are in front of the app. Empty trusts every hop, which works behind any proxy but lets a visitor choose the address the per-minute check-in limit sees by sending an `X-Forwarded-For` header. Set `1` when exactly one proxy (the web server) is in front, `2` if something such as Cloudflare is in front of that too. |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Database connection. |
| `DB_POOL_SIZE` | Database connection pool size (default 10). |

## Deploying

- **Shared cPanel hosting:** follow [DEPLOY-CPANEL.md](DEPLOY-CPANEL.md), which is written step by step. Shared hosts often don't install `node_modules` from the control panel. The guide explains how to upload it yourself.
- **Windows Server:** follow [DEPLOY-WINDOWS.md](DEPLOY-WINDOWS.md). It covers installing Node.js and MySQL, running the app as a Windows service with NSSM, putting IIS in front for HTTPS, backups, updates and troubleshooting. The IIS configuration is in `deploy/windows/web.config`.

### Updating

1. Upload the changed files, replacing the old ones. Don't upload `node_modules` again unless `package.json` changed.
2. Restart the Node.js app.
3. On each screen, press **Ctrl+Shift+R** once to load the new page.

`public/.htaccess` tells Apache-style hosts (including LiteSpeed) to re-check pages, scripts and styles on every visit, so browsers don't keep an old copy, or run an updated page against an older script. A file that has not changed costs only a short "not modified" reply. Node's own server sends the same header from `server.js`. Your host must allow the `.htaccess` file for it to work.

## Security notes

- The kiosk and monitor are open to anyone who has the address, unless an admin locks them (see [Locking the kiosk and monitor](#locking-the-kiosk-and-monitor)). The monitor shows each customer's first name and last initial, not the full name, and the data behind it (`/api/queue`) carries only that: full names and appointment details are sent only to signed-in staff, through `/api/staff/queue`. Only leave these screens open where that's acceptable, and lock them if the address could reach people outside the building.
- Give every staff member their own account, and disable (rather than delete) accounts when someone leaves, so past records stay readable.
- Never share passwords or `SESSION_SECRET` in chat, email or screenshots. If one is exposed, change it straight away. Changing `SESSION_SECRET` signs everyone out.
- Serve the site over HTTPS. The session cookie is marked `Secure` when the request arrives over HTTPS.
- Customer names are kept on finished tickets so reports work. Set an old-records policy in **Settings → Old record retention** if your records policy requires it.
- Sign out on shared computers. Sessions last 12 hours by default. With an idle sign-out set, a queue portal that stays open keeps asking the server for updates, which counts as activity. The idle sign-out therefore takes effect on pages that stay quiet, such as Management and My account.

## Project layout

```
server.js          Express routes, optional BASE_PATH handling, Socket.IO updates
db.js              All database access (MySQL via mysql2), including audit log, cleanup and database check
db/schema.sql      Tables and default services (runs on startup)
lib/               The rules the server and database use, each in its own file, with no database inside:
  auth.js            Password hashing, password rules and session cookies (Node's built-in crypto)
  availability.js    Works out "open or closed right now" from manual choices and recurring closures
  reports.js         Checks report date ranges
  privacy.js         What the public queue data may show (customers as first name and last initial)
  screens.js         Access links for the kiosk and monitor: keys, hashes, and the cookie that keeps a screen open
  settings.js        App settings: names, limits and defaults for the Settings and Security tabs
  catalog.js         Rules for services, department groups, languages, translations and the kiosk layout
  catalog-seed.js    The groups, descriptions, icons and Spanish text the catalogue starts with (set up once)
  ui-strings.js      The kiosk's wording, in English and Spanish
tests/             Automated tests (npm test, or Health and Audit → Automated tests)
public/            index.html, kiosk.html, queue.html, account.html, manage.html, monitor.html,
                   app.css, theme.js, app-settings.js, access.js, icons.js, .htaccess, images/ (logo.png, notification-icon.png)
public/sw.js       Service worker: lets the screens open while the app is stopped (see When the app is stopped)
deploy/windows/    web.config for IIS in front of the Windows Server app
DEPLOY-CPANEL.md   Step-by-step cPanel hosting guide for non-technical readers
DEPLOY-WINDOWS.md  Step-by-step Windows Server hosting guide (IIS, NSSM, MySQL)
.env.example       Environment variables template
```
