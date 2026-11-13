# TiVBook — Setup Guide

TiVBook has **two things to install**:

| | For whom | How |
|---|---|---|
| **TiVBook Staff** | Admin, Manager, Tournament Director, Cashier, Floor, Dealer, Front Desk | **One setup file** for Windows: `TiVBook-Staff-Setup.exe`. Or open the staff website from any browser, with nothing to install. |
| **TiVBook** (player app) | Players | Download on Android / iPhone, or use the player website. |

Everything runs **online**. Every staff PC, the staff website and every player's phone read the same live database, so a change made in one place appears everywhere within about a second. If the internet drops for a moment, screens keep working with the last data and catch up automatically.

---

## Part A — Put TiVBook online (once, about 15 minutes)

Do this once, on any Windows or Mac computer.

1. **Create the Firebase project.** Go to <https://console.firebase.google.com>, click **Add project** and name it, for example `tivbook-tivegas`. Then:
   - **Upgrade** to the **Blaze** plan (Settings → Usage and billing). This is required for the server functions. Normal casino traffic costs little.
   - **Build → Authentication → Get started → Email/Password → Enable.**
   - **Build → Firestore Database → Create database.** Choose location **europe-west1** and start in **production mode**.
   - **Build → Storage → Get started**, same location.
2. **Install Node.js 22** from <https://nodejs.org> (choose "LTS").
3. Unzip TiVBook, open a terminal in the folder, and type:

   ```
   npm run setup
   ```

   Answer the questions:
   - your project ID
   - WhatsApp details (you can skip these and add them later)
   - the administrator's email and password

   When it finishes it prints two web addresses:
   - `https://<project>-staff.web.app`: the staff software online
   - `https://<project>-play.web.app`: the player website

That's it: TiVBook is online.

### WhatsApp verification codes

Players verify their phone number with a code sent by WhatsApp. To switch this on:

1. In **Meta Business Suite → WhatsApp Manager**, add the casino's WhatsApp Business number.
2. Create a message template: category **Authentication**, name **tivbook_otp**, button **Copy code**.
3. Copy the **Phone Number ID** and create a **permanent access token** (System User).
4. Run `npm run setup` again and paste both when asked.

Until this is done, players can still be registered at the Front Desk or Cashier.

---

## Part B — The staff setup file (one installer for every staff PC)

The Windows installer and the Android app are built automatically on GitHub's servers. You don't need any programming tools on your PC.

1. Create a free GitHub account and a **private** repository, then upload the TiVBook folder to it.
2. In the repository, open **Settings → Secrets and variables → Actions** and add these six values. They are in the `.env` file created by the setup:
   `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`
3. Open **Actions → Build TiVBook → Run workflow**. About 15 minutes later, download:
   - **TiVBook-Staff-Setup.exe**
   - **TiVBook-Player.apk**

**On each staff PC:**

1. Run `TiVBook-Staff-Setup.exe` and click **Next → Install → Finish**. A desktop icon appears.
2. Open TiVBook Staff and sign in.
3. The first time, give the PC a name (for example "Cashier 1"). A manager then approves it in **Administration → Devices**. This screen updates by itself once approved.

Each staff member sees only the sections their role allows. **Administration → Staff accounts** is where you create logins (Cashier, Floor Supervisor, and so on). New staff choose their own password at first sign-in.

---

## Part C — The player app

- **Android:** share `TiVBook-Player.apk` (via WhatsApp, the website or a QR code at the cashier). Players tap it to install. They may need to allow "Install unknown apps" once. For the **Google Play Store**, add the signing-key secrets (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`) and upload the `.aab` file to Play Console.
- **iPhone:** Apple only allows installs through the App Store or TestFlight. This needs the Apple Developer account (USD 99/year) and a Mac to build: open `apps/player` and run `npm run ios`, then submit with Xcode. Until then, iPhone players can use the player website and tap **Share → Add to Home Screen**.

---

## Updates

Change the code (or receive a new version), then:

- run `npm run setup` again to update the online parts;
- run **Build TiVBook** again for a new `.exe` and `.apk`.

Existing data is never touched by an update.
