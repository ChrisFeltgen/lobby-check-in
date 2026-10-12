# Lobby Check-In: Step-by-Step Deployment Guide

This guide is for putting the Lobby Check-In program on a web host (for example, your cPanel account). Follow the steps in order. Don't skip ahead.

If something doesn't match what you see, stop and look at the **If something goes wrong** section at the end.

---

## Before you begin: write these down

Keep this list in a safe place (a password manager is best). **Don't** email it or paste it into chat.

| Item | What it is | Your value |
|---|---|---|
| Domain | Your website address, for example `scrapcraft.dev` | |
| Folder name | Where the app lives on the host, for example `virtual-queue` | |
| Database name | Created in step 2 | |
| Database user | Created in step 2 | |
| Database password | Made up in step 2 | |
| Admin username | The first admin account's username | |
| Admin password | The first admin account's password (at least 8 characters) | |
| Session secret | A long random text (see step 4) | |

---

## What you need

- A web host that has **Setup Node.js App** in its control panel (cPanel does).
- Your login to that control panel.
- The Lobby Check-In project folder on your computer.
- About 30 minutes.

---

## Step 1: Upload the project files

1. Log in to your host's control panel.
2. Open **File Manager**.
3. Go to your home folder (not `public_html`). Click **+ Folder** and create a folder named `virtual-queue`.
4. Open that folder.
5. Click **Upload**, and upload everything from your project folder **except** the folder named `node_modules` and the file named `node_modules.tar.gz`.
   - You can upload the files one at a time or drag them in.
   - Make sure `server.js`, `db.js`, `package.json`, the `db` folder, the `lib` folder and the `public` folder all end up inside `virtual-queue`.

**Check:** inside `virtual-queue` you should see `server.js` and `package.json`.

---

## Step 2: Create the database

1. In the control panel, open **MySQL® Databases**.
2. Under **Create New Database**, type a name such as `virtual_queue` and click **Create Database**.
   - Your host may add a prefix to the name (for example `yourname_virtual_queue`). Write down the **full** name it shows you.
3. Under **MySQL Users → Add New User**, type a username such as `queue_app`, then a strong password. Click **Create User**.
   - Write down the full username (it may also have a prefix) and the password.
4. Under **Add User To Database**, choose the user and the database, then click **Add**.
5. On the privileges screen, tick **ALL PRIVILEGES**, then click **Make Changes**.

**Check:** the database and user both appear under the same account, with the user attached to the database.

---

## Step 3: Create the Node.js app

1. In the control panel, open **Setup Node.js App**.
2. Click **Create Application**.
3. Fill in:
   - **Node.js version:** choose 18 or newer (the highest available is fine).
   - **Application mode:** Production.
   - **Application root:** `virtual-queue`
   - **Application URL:** your domain (for example `scrapcraft.dev`), and if it asks for a path, type `virtual-queue`.
   - **Application startup file:** `server.js`
4. Click **Create**.

Leave this page open. You'll come back to it in the next steps.

---

## Step 4: Install the program's parts

1. On the same Node.js App page, find your app and click **Run NPM Install**.
2. Wait until it says it has finished.
3. Check that a folder called `node_modules` now exists inside `virtual-queue`, and that it contains a folder called `express`.

**If `node_modules` is missing or empty:** your host didn't install it. Do this instead:

1. On your own computer, open a terminal in the project folder and run:
   ```
   npm install --omit=dev
   ```
2. Make an archive of the `node_modules` folder called `node_modules.tar.gz`.
3. Upload that file into `virtual-queue`, then right-click it in File Manager and choose **Extract**.
4. Check again that `node_modules/express` exists.

---

## Step 5: Set the secret settings

These settings are kept on the host, not in the files you uploaded.

1. On the Node.js App page, open your app.
2. Find **Environment variables** and add each of these, one at a time. Type the name exactly as shown, and your value next to it:

| Name | What to enter |
|---|---|
| `SESSION_SECRET` | A long random text (see below) |
| `ADMIN_USERNAME` | The first admin's username (from your list) |
| `ADMIN_PASSWORD` | The first admin's password (from your list) |
| `DB_HOST` | `localhost` |
| `DB_PORT` | `3306` |
| `DB_NAME` | The full database name from step 2 |
| `DB_USER` | The full database username from step 2 |
| `DB_PASSWORD` | The database password from step 2 |
| `BASE_PATH` | `/virtual-queue` (the folder name, with a slash in front) |
| `TZ` | Optional but worth setting: your time zone, for example `America/New_York`. Recurring closures and the end-of-day time follow the app's clock, so this keeps them on local time when the host's clock is set to another zone. |

**Making the SESSION_SECRET:** it needs to be a long mix of letters and numbers, at least 40 characters. Don't use a word or a name. If you can't make one, use a password generator website from a reputable source, and copy the result. Keep it the same forever: changing it signs everyone out.

**Check:** no value has a space before or after it.

After the first start, an admin can open **Management → Health and Audit → Run health check**. It says whether the database and the app agree on the time. If they don't, closures and "today" can be hours out: ask the host to set the database time zone, or set `TZ` as above.

---

## Step 6: Start the app

1. On the Node.js App page, click **Restart**.
2. Wait about 30 seconds.
3. In a new browser tab, go to:
   `https://your-domain/virtual-queue/api/services`
   (replace `your-domain` with your domain)

**Check:** you see text starting with `[` and containing service names such as "Zoning". That means the app and the database are working.

---

## Step 7: Sign in as the admin

1. Go to `https://your-domain/virtual-queue/queue.html`.
2. Type the **ADMIN_USERNAME** and **ADMIN_PASSWORD** you set in step 5.
3. Type a counter name (for example `Admin`) and click **Sign in**.
4. Click **Management** at the top right.
5. Go to the **Staff** tab.
6. Create an account for each real staff member (**Add an account**). Leave **Require user to change password on next sign-on** ticked, so each person picks their own password when they first sign in.
7. Change the admin password on **My account** (top right), or delete the two `ADMIN_` settings in step 5 and restart the app.

**Check:** you can see the Operations, Staff, Reports, Service Configuration, Settings, Security and Health and Audit tabs.

---

## Step 8: Open the screens

Open each of these in a browser and check that it loads:

| Screen | Address |
|---|---|
| Customer kiosk (touch screen) | `https://your-domain/virtual-queue/kiosk.html` |
| Staff queue portal | `https://your-domain/virtual-queue/queue.html` |
| Management | `https://your-domain/virtual-queue/manage.html` |
| My account (change your own password) | `https://your-domain/virtual-queue/account.html` |
| Lobby monitor (TV) | `https://your-domain/virtual-queue/monitor.html` |

For the TV, you can use `monitor.html?panel=left` or `monitor.html?panel=right` to show a different set of departments on each screen.

---

## Updating the program later

1. Upload the changed files into `virtual-queue` in File Manager, replacing the old ones.
2. If you changed `package.json`, repeat step 4.
3. On the Node.js App page, click **Restart**.
4. On each screen, press **Ctrl+Shift+R** (or Ctrl+F5) once to clear the old copy from the browser.

---

## If something goes wrong

| What you see | What to do |
|---|---|
| The `/api/services` page is blank or shows an error | Check the environment variables in step 5 for typos and extra spaces. Then click **Restart**. |
| "Database initialization failed" or a database error | The database name, username or password is wrong. Check them against your list, and check the user is attached to the database with all privileges. |
| Staff are signed out every time the app restarts | `SESSION_SECRET` changed or isn't set. Set it once and keep it. |
| The admin can't sign in | Check `ADMIN_USERNAME` and `ADMIN_PASSWORD` in step 5, then restart. |
| A page shows an old version after an update | Press Ctrl+Shift+R once. |
| Changes take up to 30 seconds to show on the screens | The host isn't passing live updates through. The screens still refresh on their own. |
| Nothing loads at all | Check that **Restart** completed and that `server.js` is the startup file. |
| Closures start or end at the wrong time, or the health check says the clocks differ | The host's time zone is not yours. Set `TZ` (step 5), and ask the host to set the database time zone if the health check still shows a difference. |
| Every page shows **404 Not Found** | The app is stopped. On the Node.js App page click **Start** (or **Restart**). Screens that were open before it stopped say the connection is lost and start again by themselves; ones that have been opened on that computer before still open and wait. |

If you're stuck, write down the exact message you see (take a screenshot, but don't include passwords) and ask for help.

---

## Security: please read

- Never share your passwords or `SESSION_SECRET`.
- Give every staff member their own account. When someone leaves, **disable** their account in Management instead of deleting it.
- Use the `https://` addresses only.
- The kiosk and TV screens are public. The TV shows each customer's first name and last initial (for example "Jane S."), so only place the screens where that's acceptable.
- Admins can check the app from **Management → Health and Audit**: run the health check and database check, and review the audit log for who changed what.
- Sign out on shared computers. Sessions last 12 hours.
