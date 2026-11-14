# TiVBook — Installation

TiVBook comes as **two downloads**, and both are free to run:

| | For | File |
|---|---|---|
| **TiVBook Staff** | Admin, Manager, Cashier, Floor, Front Desk, Dealer | `TiVBook-Staff-Setup.exe` (Windows 10/11) |
| **TiVBook** | Players' phones | `TiVBook-Player.apk` (Android) |

Everything is stored online in the casino's own **free Supabase database** (no bank card needed). All staff computers and all players' phones stay in sync.

---

## 1 · First computer (once, about 5 minutes)

1. Double-click **TiVBook-Staff-Setup.exe**. It installs by itself and opens. If Windows shows "Windows protected your PC", click **More info → Run anyway**. This appears because the app is new and not yet signed.
2. Click **Set up TiVBook for the casino**.
3. Click **Create a free account at supabase.com** and sign up (free, no card).
4. Click **Open "Access Tokens"** → **Generate new token** → name it "TiVBook" → **copy** it.
5. Paste the token into TiVBook. Type your name, email and a password (at least 10 characters).
6. Click **Install TiVBook online** and wait 2–4 minutes with the window open.

When it says **"TiVBook is online"**, you are signed in as Super Administrator and this computer is approved.

> If anything stops halfway, just click **Install TiVBook online** again. It continues where it stopped.

## 2 · Other staff computers (1 minute each)

1. Install **TiVBook-Staff-Setup.exe**.
2. Paste the **connection code**. On the first computer it's in **Settings → Copy code**.
3. Sign in, then name the computer (for example "Cashier 1").
4. On your computer, approve it in **Devices → Approve**.

Create each person's login in **Staff accounts**. They choose their own password at first sign-in.

## 3 · Players' phones

1. Send **TiVBook-Player.apk** to players (WhatsApp, or a QR code at the cashier).
2. They open it and install. Android asks once to allow installing from this source.
3. In the app they **scan the QR code** printed from **Settings → Print QR**, or paste the connection code.
4. They sign in with their mobile number and a WhatsApp code, then register.

**iPhone:** Apple allows installs only through the App Store. That needs an Apple Developer account (USD 99/year) and a Mac. Until then, iPhone players register at the Front Desk or Cashier.

## 4 · Sign-in without WhatsApp (free, works now)

When a player signs in, the app tells them to ask the cashier or front desk for their code. In TiVBook Staff, open **Sign-in codes**, check the player's ID card, and read them the 6-digit code for their number. Codes are valid for 15 minutes.

## 5 · Cash tables and booking

**Set up the tables (Manager, once):**
1. Open **Tables → + Add table**.
2. Fill in the name, game, blinds, minimum and maximum buy-in, number of seats, the start time, the **arrive by** time (cut-off), and the days the table runs.
3. Click **Save**. The next two weeks of that table appear by themselves.
4. In **Booking calendar** below, choose when bookings open for the following week (default: Sunday 10:00) and add closed dates.

**Players book in the app:** **Cash Games** → pick the day → **Book a place**. One place per day. If the table is full, they tap **Join the waiting list** and see their position.

**On the floor:** open **Floor**, choose the day, then click a table.
- **Arrived**: the player has checked in.
- **Seat**: click the player, then a free seat on the drawing.
- **Left** / **No-show**: frees the place. The first player on the waiting list immediately gets the **PLACE AVAILABLE** alarm with 5 minutes to accept. If they don't, the next player gets it.
- Bookings not checked in by the **arrive by** time are released automatically.
- Use **+ seat / − seat** and **Close table** for that day.

## 6 · Phone alarms when the app is closed (free, optional)

The alarm (sound, vibration and full screen) already works whenever the player has TiVBook open. To also wake phones that are locked or have the app closed, connect the free Firebase notification service. It needs no bank card.

1. Go to **console.firebase.google.com** → **Create a project** → name it **TiVBook** → you can turn Google Analytics off → **Create**.
2. On the project page, click the **Android** icon ("Add app"). Package name: **mu.tivegas.tivbook** → **Register app** → **Download google-services.json** → click **Next** until finished.
3. On GitHub, in your **tivbook-app** repository, open the folder **apps → player → native → android**. Click **Add file → Upload files**, drop **google-services.json** there, then click **Commit changes**. A new app build starts by itself and includes alarms.
4. Back in Firebase, click the gear icon ⚙ → **Project settings** → **Service accounts** → **Generate new private key** → **Generate key**. A file downloads.
5. Open that file with **Notepad**, select all, copy, and paste it into **TiVBook Staff → Settings → Phone alarms** → **Save**.
6. Install the new app on the phones. The first time, the app asks to allow notifications: tap **Allow**.

Keep the key file from step 4 private: anyone with it can send notifications to your players.

## 7 · WhatsApp codes (once, optional)

Players receive their sign-in code by WhatsApp. To switch it on:

1. In **Meta WhatsApp Manager**, add the casino's WhatsApp Business number.
2. Create a template: category **Authentication**, name **tivbook_otp**, button **Copy code**.
3. Copy the **Phone Number ID** and create a **permanent access token**.
4. Paste both in **TiVBook Staff → Settings → WhatsApp codes → Save**.

Meta charges a small amount per WhatsApp code. Until this is set up, players use the free **Sign-in codes** from the cashier (section 4).

---

## Free limits (Supabase free plan)

| | Free allowance | Enough for |
|---|---|---|
| Database | 500 MB | Many years of records |
| ID photos | 1 GB | About 4,000 players (photos are shrunk to about 200 KB) |
| Users | 50,000 a month | Far more than needed |

A free database that is unused for 7 days is paused. A casino uses it every day, so this won't happen. The free plan has **no automatic backups**, so a daily backup is planned in a later phase.

## Updating

1. Install the new **TiVBook-Staff-Setup.exe** over the old one.
2. On the Super Administrator's computer, go to **Settings → Update TiVBook online**, paste a new Supabase access token, and click **Update now**. This updates the online server and database and keeps every record.
3. Upload the new source files to GitHub. The player app rebuilds by itself; install the new **TiVBook-Player.apk** on the phones.
