// Web checkout for Geonix Wrench.
//
// Flow: pick a plan -> sign in or create an account -> for Team, make sure a
// shop exists and you own it -> Stripe Checkout.

const { API_BASE_URL, IS_API_CONFIGURED, TEAM_MIN_SEATS, PRICE_PER_SEAT, INDIVIDUAL_PRICE } =
  window.GEONIX_CONFIG;

const FIREBASE_APP = 'https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js';
const FIREBASE_AUTH = 'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js';

const SUCCESS_URL = new URL('wrench-billing-success.html', window.location.href).toString();
const CANCEL_URL = new URL('wrench-billing-cancel.html', window.location.href).toString();

const $ = (id) => document.getElementById(id);

const el = {
  individualButton: $('plan-individual-btn'),
  individualStatus: $('plan-individual-status'),
  teamButton: $('plan-team-btn'),
  teamStatus: $('plan-team-status'),

  seatOutput: $('seat-count'),
  seatMinus: $('seat-minus'),
  seatPlus: $('seat-plus'),
  seatTotal: $('seat-total'),

  modal: $('auth-modal'),
  modalTitle: $('auth-modal-title'),
  modalSubtitle: $('auth-modal-subtitle'),
  modalError: $('auth-error'),
  modalNote: $('auth-note'),
  modalForm: $('auth-form'),
  email: $('auth-email'),
  password: $('auth-password'),
  submit: $('auth-submit'),
  close: $('auth-close'),
  toggle: $('auth-toggle'),
  reset: $('auth-reset'),
  notConfigured: $('auth-not-configured'),

  shopModal: $('shop-modal'),
  shopForm: $('shop-form'),
  shopName: $('shop-name'),
  shopError: $('shop-error'),
  shopSubmit: $('shop-submit'),
  shopClose: $('shop-close'),

  appModal: $('app-modal'),
  appClose: $('app-close'),
  appOk: $('app-ok'),
  appPlanLabel: $('app-plan-label'),
  appPlanTotal: $('app-plan-total'),
  appStepPlan: $('app-step-plan'),

  navSignIn: $('nav-signin'),
  accountBar: $('account-bar'),
  accountEmail: $('account-email'),
  signOut: $('account-signout'),
};

let auth = null;
let firebaseReady = false;
let currentUser = null;
let pendingPlan = null;
let authMode = 'signin';
let seats = TEAM_MIN_SEATS;

// Resolves once Firebase has reported the initial auth state. Without this a
// click landing in the first few hundred milliseconds after page load saw
// currentUser === null and pushed an already-signed-in visitor back through
// the login modal.
let markAuthReady;
const authReady = new Promise((resolve) => {
  markAuthReady = resolve;
});

// ------------------------------------------------------------ seat stepper

// Seats are deliberately uncapped — only a floor of TEAM_MIN_SEATS applies —
// so the total is grouped rather than printed as a bare "26973.00".
const money = new Intl.NumberFormat('en-IE', {
  style: 'currency',
  currency: 'EUR',
});

function renderSeats() {
  if (!el.seatOutput) return;
  el.seatOutput.textContent = String(seats);
  el.seatMinus.disabled = seats <= TEAM_MIN_SEATS;
  el.seatTotal.textContent = money.format(seats * PRICE_PER_SEAT);
}

el.seatMinus?.addEventListener('click', () => {
  if (seats > TEAM_MIN_SEATS) {
    seats -= 1;
    renderSeats();
  }
});

el.seatPlus?.addEventListener('click', () => {
  seats += 1;
  renderSeats();
});

renderSeats();

// ---------------------------------------------------------------- statuses

function setStatus(node, message, kind) {
  if (!node) return;
  node.textContent = message || '';
  node.classList.toggle('hidden', !message);
  node.classList.toggle('is-error', kind === 'error');
  node.classList.toggle('is-ok', kind === 'ok');
}

const statusFor = (plan) => (plan === 'individual' ? el.individualStatus : el.teamStatus);
const buttonFor = (plan) => (plan === 'individual' ? el.individualButton : el.teamButton);

function setPlanBusy(plan, busy, label) {
  const button = buttonFor(plan);
  if (!button) return;
  button.disabled = busy;
  if (busy) {
    button.dataset.idleLabel = button.dataset.idleLabel || button.textContent;
    button.textContent = label || 'Working…';
  } else if (button.dataset.idleLabel) {
    button.textContent = button.dataset.idleLabel;
  }
}

function setError(node, message) {
  if (!node) return;
  node.textContent = message || '';
  node.classList.toggle('hidden', !message);
}

// ------------------------------------------------------------------- modal

function setAuthMode(mode) {
  authMode = mode;
  const signingIn = mode === 'signin';
  el.modalTitle.textContent = signingIn ? 'Sign in to continue' : 'Create your account';
  el.modalSubtitle.textContent = signingIn
    ? 'Same account you use in the app.'
    : 'One step. You will use this to sign in to the app too.';
  el.submit.textContent = signingIn ? 'Sign in and continue' : 'Create account and continue';
  el.toggle.textContent = signingIn ? 'New here? Create an account' : 'I already have an account';
  el.password.setAttribute('autocomplete', signingIn ? 'current-password' : 'new-password');
  el.reset.classList.toggle('hidden', !signingIn);
  setError(el.modalError, '');
  setStatus(el.modalNote, '', null);
}

function openAuthModal(plan) {
  pendingPlan = plan;
  el.password.value = '';
  setAuthMode('signin');

  // Sign-in and password reset go straight to Firebase, so they work even
  // with no backend reachable — only checkout needs the API.
  const usable = firebaseReady;
  el.modalForm.classList.toggle('hidden', !usable);
  el.toggle.classList.toggle('hidden', !usable);
  el.notConfigured.classList.toggle('hidden', usable);

  el.modal.classList.remove('hidden');
  if (usable) el.email.focus();
}

function closeAuthModal() {
  el.modal.classList.add('hidden');
  pendingPlan = null;
}

el.close?.addEventListener('click', closeAuthModal);
el.toggle?.addEventListener('click', () =>
  setAuthMode(authMode === 'signin' ? 'signup' : 'signin')
);

el.modal?.addEventListener('click', (event) => {
  if (event.target === el.modal) closeAuthModal();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!el.modal?.classList.contains('hidden')) closeAuthModal();
  if (!el.shopModal?.classList.contains('hidden')) el.shopModal.classList.add('hidden');
  if (!el.appModal?.classList.contains('hidden')) closeAppModal();
});

el.modalForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  setError(el.modalError, '');
  el.submit.disabled = true;

  try {
    const { signInWithEmailAndPassword, createUserWithEmailAndPassword } = await import(
      FIREBASE_AUTH
    );
    const run =
      authMode === 'signin' ? signInWithEmailAndPassword : createUserWithEmailAndPassword;

    // Take the user straight off the credential. onAuthStateChanged is async,
    // so reading the global here raced and threw on getIdToken() of null.
    const credential = await run(auth, el.email.value.trim(), el.password.value);
    currentUser = credential.user;

    const plan = pendingPlan;
    closeAuthModal();
    if (plan) {
      startCheckout(plan);
    } else {
      // Signed in from the header: no checkout to run, so acknowledge it.
      setStatus(el.teamStatus, `Signed in as ${currentUser.email}.`, 'ok');
    }
  } catch (err) {
    setError(el.modalError, friendlyAuthError(err));
  } finally {
    el.submit.disabled = false;
  }
});

el.reset?.addEventListener('click', async () => {
  const email = el.email.value.trim();
  if (!email) {
    setError(el.modalError, 'Enter your email address first.');
    el.email.focus();
    return;
  }
  setError(el.modalError, '');
  try {
    const { sendPasswordResetEmail } = await import(FIREBASE_AUTH);
    await sendPasswordResetEmail(auth, email);
    setStatus(el.modalNote, `Reset link sent to ${email}. Check your spam folder.`, 'ok');
  } catch (err) {
    setError(el.modalError, friendlyAuthError(err));
  }
});

// Firebase codes are not user-facing English; map the ones people actually hit.
function friendlyAuthError(err) {
  const code = String((err && err.code) || '').replace('auth/', '');
  switch (code) {
    case 'invalid-email':
      return 'That email address looks invalid.';
    case 'missing-password':
      return 'Enter your password.';
    case 'user-not-found':
    case 'wrong-password':
    case 'invalid-credential':
    case 'invalid-login-credentials':
      return 'Incorrect email or password. If you are new, switch to "Create an account".';
    case 'email-already-in-use':
      return 'An account already exists with that email — switch to signing in.';
    case 'weak-password':
      return 'Choose a longer password (at least 6 characters).';
    case 'too-many-requests':
      return 'Too many attempts. Try again in a few minutes.';
    case 'network-request-failed':
      return 'Could not reach the sign-in service. Check your connection.';
    case 'unauthorized-domain':
      return 'This domain is not authorised in Firebase yet. Add it under Authentication → Settings → Authorized domains.';
    case 'operation-not-allowed':
      return 'Email sign-in is not enabled for this project.';
    default:
      return (err && err.message) || 'Sign-in failed. Please try again.';
  }
}

// --------------------------------------------------- "subscribe in the app"

/// Web checkout needs a reachable backend. Until there is one, clicking
/// Subscribe explains how to finish in the app rather than dead-ending on an
/// error, and carries the plan and seat count over so nothing is re-decided.
function openAppModal(plan) {
  if (!el.appModal) return;

  const isTeam = plan === 'team';
  const total = isTeam ? seats * PRICE_PER_SEAT : INDIVIDUAL_PRICE;

  el.appPlanLabel.textContent = isTeam
    ? `Team · ${seats} ${seats === 1 ? 'seat' : 'seats'}`
    : 'Individual';
  el.appPlanTotal.textContent = `${money.format(total)} / month`;
  el.appStepPlan.innerHTML = isTeam
    ? `Choose <strong>Team</strong> and set <strong>${seats}</strong> seats.`
    : 'Choose <strong>Individual</strong>.';

  el.appModal.classList.remove('hidden');
}

function closeAppModal() {
  el.appModal?.classList.add('hidden');
}

el.appClose?.addEventListener('click', closeAppModal);
el.appOk?.addEventListener('click', closeAppModal);
el.appModal?.addEventListener('click', (event) => {
  if (event.target === el.appModal) closeAppModal();
});

// -------------------------------------------------------------- shop modal

function openShopModal() {
  setError(el.shopError, '');
  el.shopName.value = '';
  el.shopModal.classList.remove('hidden');
  el.shopName.focus();
}

el.shopClose?.addEventListener('click', () => el.shopModal.classList.add('hidden'));
el.shopModal?.addEventListener('click', (event) => {
  if (event.target === el.shopModal) el.shopModal.classList.add('hidden');
});

el.shopForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = el.shopName.value.trim();
  if (!name) return;

  setError(el.shopError, '');
  el.shopSubmit.disabled = true;
  try {
    // seat_limit here is only the initial local cap; the Stripe webhook
    // overwrites it with the quantity actually purchased.
    await api('/api/organizations', {
      method: 'POST',
      body: JSON.stringify({ name, seat_limit: seats }),
    });
    el.shopModal.classList.add('hidden');
    startCheckout('team');
  } catch (err) {
    setError(el.shopError, err.message);
  } finally {
    el.shopSubmit.disabled = false;
  }
});

// --------------------------------------------------------------- API calls

async function api(path, options = {}) {
  if (!currentUser) throw new Error('You are not signed in.');
  const token = await currentUser.getIdToken();

  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });
  } catch (_) {
    throw new Error('Could not reach the Geonix Wrench server. Is it running?');
  }

  if (!response.ok) {
    let detail = `Server returned ${response.status}`;
    try {
      const body = await response.json();
      if (body && body.detail) detail = body.detail;
    } catch (_) {
      /* keep the status-code fallback */
    }
    throw new Error(detail);
  }

  return response.json();
}

async function startCheckout(plan) {
  setPlanBusy(plan, true, 'Checking your account…');
  setStatus(statusFor(plan), '', null);

  try {
    const me = await api('/api/auth/me');

    // Guard against paying twice. Stripe will happily create a second
    // subscription on the same account, and nothing downstream merges them.
    const billing = await api('/api/billing/status');
    if (billing.is_active) {
      setStatus(
        statusFor(plan),
        plan === 'team' && billing.can_manage_seats
          ? 'This shop is already subscribed. Change your seat count in the app under Settings → Subscription.'
          : 'You already have an active subscription.',
        'ok'
      );
      return;
    }

    if (plan === 'individual' && me.org_id) {
      setStatus(
        statusFor(plan),
        'You belong to a shop, so the Team plan covers you. Subscribe the shop instead.',
        'error'
      );
      return;
    }

    if (plan === 'team') {
      if (!me.org_id) {
        // The web can create the shop itself rather than sending people off to
        // install the app first.
        setPlanBusy(plan, false);
        openShopModal();
        return;
      }
      if (me.org_role !== 'owner') {
        setStatus(
          statusFor(plan),
          'You are a member of this shop, not its owner. Ask the owner to handle the subscription.',
          'error'
        );
        return;
      }
    }

    setPlanBusy(plan, true, 'Opening checkout…');
    const result = await api('/api/billing/checkout-session', {
      method: 'POST',
      body: JSON.stringify({
        plan,
        ...(plan === 'team' ? { quantity: seats } : {}),
        success_url: SUCCESS_URL,
        cancel_url: CANCEL_URL,
      }),
    });

    window.location.href = result.checkout_url;
  } catch (err) {
    setStatus(statusFor(plan), err.message || 'Something went wrong.', 'error');
  } finally {
    setPlanBusy(plan, false);
  }
}

async function handlePlanClick(plan) {
  setStatus(statusFor(plan), '', null);

  if (!IS_API_CONFIGURED) {
    openAppModal(plan);
    return;
  }

  setPlanBusy(plan, true);
  await authReady;
  setPlanBusy(plan, false);

  if (!currentUser) {
    openAuthModal(plan);
    return;
  }
  startCheckout(plan);
}

el.individualButton?.addEventListener('click', () => handlePlanClick('individual'));
el.teamButton?.addEventListener('click', () => handlePlanClick('team'));

// Sign in on its own, without picking a plan first. Until now the modal was
// only reachable by clicking Subscribe, so there was no way to just log in.
//
// Opens synchronously: renderAccount() already hides this button once signed
// in, so there is nothing to await, and awaiting made the click feel dead.
el.navSignIn?.addEventListener('click', () => openAuthModal(null));

// ------------------------------------------------------------ account bar

function renderAccount() {
  const signedIn = Boolean(currentUser);

  // The header offers "Sign in" only while signed out; once in, the account bar
  // carries the identity and the sign-out control.
  el.navSignIn?.classList.toggle('hidden', signedIn);

  if (!el.accountBar) return;
  el.accountBar.classList.toggle('hidden', !signedIn);
  if (signedIn) el.accountEmail.textContent = currentUser.email || 'your account';
}

el.signOut?.addEventListener('click', async () => {
  const { signOut } = await import(FIREBASE_AUTH);
  await signOut(auth);
  setStatus(el.individualStatus, '', null);
  setStatus(el.teamStatus, '', null);
});

// ------------------------------------------------------------------- init

/// Opened straight from disk, the page renders and the seat stepper works, but
/// Firebase and the backend cannot be reached (cross-origin fetches from a
/// file:// origin are blocked). Say so instead of failing silently.
function warnIfOpenedFromDisk() {
  if (window.location.protocol !== 'file:') return false;

  const bar = document.createElement('div');
  bar.className = 'notice-bar';
  bar.innerHTML =
    '<strong>Preview mode.</strong> This page was opened from a file, so sign-in ' +
    'and checkout are blocked by the browser. Serve it over http to use them: ' +
    '<code>cd geonix_website &amp;&amp; python3 -m http.server 8000</code> then open ' +
    '<code>http://localhost:8000/geonix_wrench.html</code>';
  document.body.prepend(bar);
  return true;
}

async function init() {
  renderAccount();

  const fromDisk = warnIfOpenedFromDisk();
  if (fromDisk) {
    // No point attempting the Firebase import; it cannot succeed here.
    firebaseReady = false;
    markAuthReady();
    return;
  }

  try {
    const { initializeApp } = await import(FIREBASE_APP);
    const { getAuth, onAuthStateChanged } = await import(FIREBASE_AUTH);
    const firebaseConfig = window.GEONIX_FIREBASE;
    if (!firebaseConfig) throw new Error('missing firebase-config.js');

    auth = getAuth(initializeApp(firebaseConfig));
    firebaseReady = true;

    onAuthStateChanged(auth, (user) => {
      currentUser = user;
      renderAccount();
      markAuthReady();
    });
  } catch (_) {
    // Missing or invalid firebase-config.js. Plan buttons still render; the
    // modal explains the gap instead of failing silently.
    firebaseReady = false;
    markAuthReady();
  }
}

init();
