# Lobby Check-In: Windows Server Deployment Guide

This guide is for the team hosting Lobby Check-In on a Windows Server machine. It sets up:

- **MySQL** (the database),
- **Node.js** running the app as a Windows service, so it starts after a reboot,
- **IIS** as the public front door, handling HTTPS and passing requests to the app.

The app only listens on the server itself (port 3000). Only IIS is exposed to the network.

Work through the steps in order. Each step ends with a **Check** so you know it worked before moving on.

---

## 1. What you need

| Item | Requirement |
|---|---|
| Server | Windows Server 2016, 2019 or 2022, with administrator access |
| Node.js | Version 18 or newer. Use the **LTS** installer from nodejs.org |
| Database | MySQL 8 or MariaDB 10.5 or newer. SQL Server is **not** supported |
| IIS modules | **URL Rewrite** and **Application Request Routing (ARR)** |
| Windows features | IIS with the **WebSocket Protocol** feature |
| HTTPS certificate | A certificate for the public address, installed in IIS |
| Project files | The Virtual Queue project folder (without `node_modules`) |
| Internet access | Needed during installation, to download packages |

**Ask the owner for these before starting** (send them through a secure channel, never by plain email or chat):

- the public domain name, for example `queue.example.gov`,
- the HTTPS certificate (or permission to request one),
- the values for `SESSION_SECRET`, `ADMIN_USERNAME` and `ADMIN_PASSWORD` (see section 6),
- a name for the database and its user.

---

## 2. Prepare the server

1. Install any pending Windows updates and restart.
2. Confirm the correct **time zone** is set (Settings → Time & language). Reports and "today" depend on this clock.
3. Create a folder for the app: `C:\apps\virtual-queue`.
4. Copy the project files into it. **Leave out** `node_modules`, `.env` (if present) and `.claude`.

**Check:** `C:\apps\virtual-queue` contains `server.js`, `package.json`, `db.js`, `auth.js`, `availability.js`, the `db` folder and the `public` folder.

---

## 3. Install Node.js

1. Download the **LTS** Windows installer (64-bit) from https://nodejs.org.
2. Run it with the default options. Tick **Add to PATH** if offered.
3. Open a new **PowerShell** window and run:

```powershell
node --version
npm --version
```

**Check:** both print a version number. Node should be 18 or higher.

---

## 4. Install MySQL and create the database

1. Download **MySQL Installer for Windows** from https://dev.mysql.com/downloads/installer/ (or install MariaDB from https://mariadb.org).
2. Choose **Server only** (or the Developer Default, which includes it). Set a strong **root** password and write it down.
3. Keep the default port **3306**.
4. Open the **MySQL Command Line Client** (or MySQL Shell) as root and run this, replacing the placeholder password with a strong one:

```sql
CREATE DATABASE virtual_queue CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'queue_app'@'localhost' IDENTIFIED BY 'REPLACE-WITH-STRONG-PASSWORD';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, ALTER ON virtual_queue.* TO 'queue_app'@'localhost';
FLUSH PRIVILEGES;
```

5. Confirm the database clock matches the server's clock:

```sql
SELECT NOW();
```

**Check:** the time shown is the local time. If it's several hours out, fix the time zone for MySQL before going live (see the MySQL documentation for `default_time_zone`).

Write the database password down with the other secrets. The app creates its tables automatically the first time it starts.

---

## 5. Install the app's packages

Open PowerShell as administrator:

```powershell
cd C:\apps\virtual-queue
npm install --omit=dev
```

**Check:** a `node_modules` folder appears, and `node_modules\express` exists.

If the server can't reach the internet, do the install on another machine with the same Node version, then copy its `node_modules` folder across.

---

## 6. Set the app's secrets

These values stay on the server. Don't store them in a file inside `C:\apps\virtual-queue` that anyone with file access could read. The NSSM service in section 7 holds them.

| Name | Value |
|---|---|
| `PORT` | `3000` |
| `SESSION_SECRET` | A long random value, 40+ characters. Never change it casually: changing it signs everyone out. |
| `ADMIN_USERNAME` | The first admin's username |
| `ADMIN_PASSWORD` | The first admin's password (8+ characters) |
| `DB_HOST` | `localhost` |
| `DB_PORT` | `3306` |
| `DB_NAME` | `virtual_queue` |
| `DB_USER` | `queue_app` |
| `DB_PASSWORD` | The `queue_app` password from section 4 |
| `BASE_PATH` | Leave **empty** if the app has its own address (recommended). See the note in section 9 if it doesn't. |

To generate a `SESSION_SECRET`, run this in PowerShell and copy the result:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 7. Run the app as a Windows service

A normal Node window stops when you log out or the server restarts. A service keeps running. We use **NSSM** (the Non-Sucking Service Manager).

1. Download NSSM from https://nssm.cc/download and unzip it to `C:\tools\nssm`.
2. Open PowerShell as administrator and install the service:

```powershell
C:\tools\nssm\win64\nssm.exe install VirtualQueue "C:\Program Files\nodejs\node.exe" server.js
C:\tools\nssm\win64\nssm.exe set VirtualQueue AppDirectory "C:\apps\virtual-queue"
C:\tools\nssm\win64\nssm.exe set VirtualQueue DisplayName "Lobby Check-In"
C:\tools\nssm\win64\nssm.exe set VirtualQueue Start SERVICE_AUTO_START
C:\tools\nssm\win64\nssm.exe set VirtualQueue AppStdout "C:\apps\virtual-queue\logs\service.log"
C:\tools\nssm\win64\nssm.exe set VirtualQueue AppStderr "C:\apps\virtual-queue\logs\service.log"
New-Item -ItemType Directory -Force C:\apps\virtual-queue\logs | Out-Null
```

3. Add the secrets from section 6. The easiest way is the NSSM editor:

```powershell
C:\tools\nssm\win64\nssm.exe edit VirtualQueue
```

   Open the **Environment** tab and enter one `NAME=value` per line, for example `SESSION_SECRET=...`. Then click **Edit service**.

4. Start the service:

```powershell
C:\tools\nssm\win64\nssm.exe start VirtualQueue
```

**Check:** open `http://localhost:3000/api/services` in a browser **on the server**. You should see text starting with `[`, listing the services. The log file in `C:\apps\virtual-queue\logs\service.log` should say `Virtual queue listening on port 3000`.

If the service doesn't start, read the log file first. Common causes are a wrong database password or a missing environment variable.

---

## 8. Set up IIS as the front door

### 8a. Install the components

1. Open **Server Manager → Add roles and features**.
2. Add the **Web Server (IIS)** role.
3. Under **Web Server → Application Development**, tick **WebSocket Protocol**.
4. Finish the wizard.
5. Install **URL Rewrite** and **Application Request Routing** from the Microsoft Web Platform Installer, or download them from https://www.iis.net. Restart the server afterwards.

### 8b. Turn on proxying

1. Open **IIS Manager**. Click the **server name** (top level, not a site).
2. Double-click **Application Request Routing Cache**, then choose **Server Proxy Settings** on the right.
3. Tick **Enable proxy** and click **Apply**.

### 8c. Create the site

1. In IIS Manager, right-click **Sites → Add Website**.
2. Site name: `VirtualQueue`. Physical path: `C:\inetpub\virtualqueue-site` (create this empty folder).
3. Binding: type **https**, port **443**, the public host name (for example `queue.example.gov`), and select the installed certificate.
4. Also add an **http** binding on port 80 for the same name. This is only used to redirect to HTTPS (see step 8e).
5. Click **OK**.

### 8d. Add the proxy rules

1. Copy `deploy\windows\web.config` from the project into `C:\inetpub\virtualqueue-site`.
   - If that file isn't in the project, use the copy supplied with this guide, or ask for it.
2. In IIS Manager, select the **VirtualQueue** site, then open **URL Rewrite**. Check that the rule **VirtualQueueNode** appears.

### 8e. Redirect HTTP to HTTPS

The `web.config` file already includes this redirect as the rule **ForceHttps**. In **URL Rewrite**, check that **ForceHttps** is listed **above** **VirtualQueueNode**. If it isn't, use the move-up arrow to fix the order.

**Check:**

- `https://queue.example.gov/api/services` (your real address) shows the JSON list.
- `http://queue.example.gov/` redirects to the `https://` address.
- Sign in at `https://queue.example.gov/queue.html`. If sign-in works but the staff screens keep asking you to sign in again, see the troubleshooting section.

---

## 9. Sub-path option (only if needed)

If the app must live under a path such as `https://example.gov/virtual-queue/`, not on its own address:

1. Set `BASE_PATH` to `/virtual-queue` in the service's environment (section 7).
2. Change the rule's **match** in `web.config` to `^virtual-queue/(.*)` and the action to `http://localhost:3000/virtual-queue/{R:1}`.

Test every screen under that path. The own-address setup is simpler and less likely to break, so use it unless the owner requires a path.

---

## 10. Open the firewall

1. Open **Windows Defender Firewall with Advanced Security → Inbound Rules → New Rule**.
2. Choose **Port**, TCP, and enter **80, 443**. Allow the connection, apply to all profiles, and name it `Lobby Check-In HTTP and HTTPS`.
3. Do **not** open port 3000 or 3306 to the network. The app and database should be reachable only from the server itself.

**Check:** from a different computer, `https://queue.example.gov/` loads, and `http://queue.example.gov:3000` does not.

---

## 11. Create the first admin and set up staff

1. Sign in at `https://queue.example.gov/queue.html` with `ADMIN_USERNAME` and `ADMIN_PASSWORD`.
2. Open **Management → Staff**.
3. Add an account for each real staff member and manager. Leave **Require user to change password on next sign-on** ticked, so each person picks their own password when they first sign in.
4. Change the admin password on **My account** (top right), then remove `ADMIN_USERNAME` and `ADMIN_PASSWORD` from the service environment (section 7), and restart the service. They're only used when no admin exists.

**Check:** you can sign out and sign back in with the new admin password.

---

## 12. Check the screens

| Screen | Address | Check |
|---|---|---|
| Kiosk | `https://queue.example.gov/kiosk.html` | Ticket prints or confirms |
| Queue portal | `https://queue.example.gov/queue.html` | Staff can sign in and call a customer |
| Management | `https://queue.example.gov/manage.html` | Open & close, Staff, Reports, Settings and Health & audit tabs load |
| Health & audit (admin) | `https://queue.example.gov/manage.html?tab=health` | **Run health check** and **Check database** both report healthy |
| Monitor | `https://queue.example.gov/monitor.html?panel=left` | Updates within seconds of a change in the queue portal |

The monitor should update as soon as a customer is called. If it takes up to 30 seconds, WebSockets aren't reaching the app (see troubleshooting).

**Settings → Old records:** decide the retention policy with the owner before go-live. Keep everything (0 days), or blank out names or delete finished tickets after a set number of days. The cleanup runs at startup and then daily. Audit log entries are kept.

---

## 13. Backups

The database holds all ticket history, so back it up every night.

1. Create a folder `C:\backups\virtual-queue`.
2. Create a file `C:\apps\virtual-queue\backup.ps1` with this content:

```powershell
$stamp = Get-Date -Format "yyyy-MM-dd_HHmm"
$out = "C:\backups\virtual-queue\vq_$stamp.sql"
& "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqldump.exe" -u queue_app -pREPLACE-WITH-PASSWORD --single-transaction virtual_queue | Out-File -Encoding utf8 $out
# Keep the last 30 backups
Get-ChildItem C:\backups\virtual-queue\*.sql | Sort-Object LastWriteTime -Descending | Select-Object -Skip 30 | Remove-Item
```

Adjust the MySQL path if your version differs. Storing the password in this script is a risk, so limit who can read the file. A more secure option is a MySQL option file.

3. Open **Task Scheduler → Create Task**. Run it every night at a quiet time, running with the highest privileges, and set the action to run PowerShell with `-File C:\apps\virtual-queue\backup.ps1`.

**Check:** run the task once manually and confirm a `.sql` file appears in the backup folder.

Copy backups to another machine or storage too. A backup on the same disk doesn't protect against disk failure.

---

## 14. Updating the app

1. Stop the service: `C:\tools\nssm\win64\nssm.exe stop VirtualQueue`
2. Keep a copy of the current folder, for example `C:\apps\virtual-queue-previous`.
3. Copy the new files over `C:\apps\virtual-queue`, leaving `logs` alone.
4. If `package.json` changed, run `npm install --omit=dev` in the app folder.
5. Start the service: `C:\tools\nssm\win64\nssm.exe start VirtualQueue`
6. On each screen, press **Ctrl+Shift+R** once to load the new page.

**If the update fails:** stop the service, copy the previous folder back, and start the service again.

---

## 15. Troubleshooting

| What you see | What to do |
|---|---|
| Site shows "502 Bad Gateway" or a blank page | The app service isn't running. Check the log file and restart the service. |
| `/api/services` gives an error or a database message | Check `DB_PASSWORD`, `DB_NAME` and `DB_USER` in the service environment. Test the password with the MySQL command line. |
| Nobody can sign in, or staff are signed out after a restart | `SESSION_SECRET` is missing or was changed. Set it once and keep it. |
| Sign-in works, then staff keep being asked to sign in | The app isn't told the connection is HTTPS. Check the `HTTP_X_FORWARDED_PROTO` line in `web.config`, and that ARR is passing headers through. |
| Screens take up to 30 seconds to update | WebSockets aren't reaching the app. Check the WebSocket Protocol feature is installed and that the URL Rewrite rule matches all paths. |
| Page shows an old version after an update | Press Ctrl+Shift+R. The app already tells browsers not to keep old pages. |
| Times in reports are wrong by several hours | The server's time zone or MySQL's time zone is wrong. Fix both to local time, restart the service. |
| Service stops after a while or after a reboot | Confirm the service is set to automatic start, and check `service.log` for errors. |

**Logs:** the app's own messages are in `C:\apps\virtual-queue\logs\service.log`. IIS errors are in the **Failed Request Tracing** feature and the Windows Event Viewer (Application log).

---

## 16. Handover checklist

Give the hosting team:

- [ ] This guide and `deploy\windows\web.config`
- [ ] The public domain name, and the HTTPS certificate or request process
- [ ] The secret values, sent through a secure channel: `SESSION_SECRET`, the database password, and the first admin's username and password
- [ ] Who to contact about the app's behaviour (queue, monitor, reports)

Confirm they have done these:

- [ ] Changed the first admin password and removed the `ADMIN_*` settings
- [ ] Agreed the old-records policy in Settings, and recorded it (keep everything, blank out names, or delete after N days)
- [ ] Ran the health check and database check in Health & audit and saw no problems
- [ ] Set up the nightly backup, and tested a restore on another machine
- [ ] Opened only ports 80 and 443 to the public
- [ ] Recorded where the secrets are stored, and who can read them

---

## Appendix: `deploy\windows\web.config`

The file is in the project at `deploy\windows\web.config`. It has two rules, in this order:

1. **ForceHttps** sends any `http://` visitor to the `https://` address.
2. **VirtualQueueNode** passes every other request to the app on port 3000, and tells the app the visitor used HTTPS, so sign-in cookies are marked secure.

Copy it to `C:\inetpub\virtualqueue-site`. Keep the rules in that order. If you change the public address, nothing in the file needs changing, because the redirect uses whatever address was requested.
