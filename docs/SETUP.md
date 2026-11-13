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

## 4 · WhatsApp codes (once)

Players receive their sign-in code by WhatsApp. To switch it on:

1. In **Meta WhatsApp Manager**, add the casino's WhatsApp Business number.
2. Create a template: category **Authentication**, name **tivbook_otp**, button **Copy code**.
3. Copy the **Phone Number ID** and create a **permanent access token**.
4. Paste both in **TiVBook Staff → Settings → WhatsApp codes → Save**.

Meta charges a small amount per WhatsApp code. Until this is set up, the Front Desk and Cashier can still register players.

---

## Free limits (Supabase free plan)

| | Free allowance | Enough for |
|---|---|---|
| Database | 500 MB | Many years of records |
| ID photos | 1 GB | About 4,000 players (photos are shrunk to about 200 KB) |
| Users | 50,000 a month | Far more than needed |

A free database that is unused for 7 days is paused. A casino uses it every day, so this won't happen. The free plan has **no automatic backups**, so a daily backup is planned in a later phase.

## Updating

Install the new **TiVBook-Staff-Setup.exe** over the old one. On the Super Administrator's computer, run **Set up TiVBook for the casino** again with a new access token. It updates the server and keeps every record.
