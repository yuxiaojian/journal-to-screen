// The permission prompt must run inside the user's tap (transient activation), so
// requestPermission() is called FIRST, before any await on SW setup. Dependencies are injected for tests.
export async function enablePush({ notification, registerSw, getSubscription, subscribe, postSubscription, hasPush, vapidKey }) {
  if (!hasPush) return { ok: false, msg: 'Push is not available here. On iPhone, open from the Home Screen icon.' };
  const perm = await notification.requestPermission(); // first call in the tap, no await before it
  if (perm !== 'granted') return { ok: false, msg: 'Notifications are off. You can still use this inbox.' };
  const reg = await registerSw();
  const sub = (await getSubscription(reg)) || (await subscribe(reg, await vapidKey()));
  const ok = await postSubscription(sub);
  return { ok, msg: ok ? 'Notifications enabled on this device.' : 'Could not register this device.' };
}
