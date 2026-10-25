# G-squad

G-squad is a portrait-first mobile app built with Node.js, Bootstrap, and Capacitor. The supplied robot logo is used in the app, and the Bootstrap stylesheet is bundled locally for offline use.

## Run locally

Requires Node.js 20 or newer.

```sh
npm install
npm start
```

Open `http://localhost:3000` on a phone, or use the browser's mobile device emulation.

## Build an Android APK

Requires Android Studio or the Android SDK, Java 21, and an Android SDK platform/build tools installation.

```sh
npm install
npm run android:build
```

The debug APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`. To open the native project in Android Studio, run `npm run android:open`.

## Install as a web app

The app also includes a portrait-only PWA manifest and offline app shell. Serve it over HTTPS (localhost is also supported), then use the browser's install or add-to-home-screen action.

## Account behavior

Registration accepts a username, email address, and a six-digit code. The code is salted and hashed on-device, and sign-in checks that code with the numeric keypad. Accounts are stored only in the current browser/app installation; this demo does not verify email addresses or sync accounts between devices. A production launch needs a secure server-side account and recovery flow.