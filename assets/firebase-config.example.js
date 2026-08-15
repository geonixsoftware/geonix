// Template for assets/firebase-config.js (which is gitignored).
//
// Copy this file to firebase-config.js and fill in the values from
// Firebase console -> Project settings -> Your apps -> Web app.
//
// Plain script, not an ES module: the pages are often opened straight from disk
// (file:///…), where module loading is blocked by CORS.
//
// Deploying: add your domain under
// Firebase console -> Authentication -> Settings -> Authorized domains,
// or sign-in fails with auth/unauthorized-domain.

window.GEONIX_FIREBASE = {
  apiKey: 'REPLACE_ME_API_KEY',
  authDomain: 'REPLACE_ME.firebaseapp.com',
  projectId: 'REPLACE_ME_PROJECT_ID',
  storageBucket: 'REPLACE_ME.firebasestorage.app',
  messagingSenderId: 'REPLACE_ME_SENDER_ID',
  appId: 'REPLACE_ME_APP_ID',
};
