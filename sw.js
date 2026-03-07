// Hydra Service Worker — handles caching + scheduled notifications

const CACHE = 'hydra-v2';
const ASSETS = ['./', './index.html', './manifest.json'];

// ── Install & cache ──────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(cached =>
      cached || fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      }).catch(() => cached)
    )
  );
});

// ── Notification click → open/focus app ─────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes(self.location.origin) && 'focus' in c) return c.focus();
      }
      return clients.openWindow('./');
    })
  );
});

// ── Message from app: schedule or cancel reminders ──────────
self.addEventListener('message', e => {
  if (e.data?.type === 'SCHEDULE_REMINDERS') scheduleReminders(e.data.payload);
  if (e.data?.type === 'CANCEL_REMINDERS')  cancelReminders();
});

// ── Schedule all reminder notifications for today + tomorrow ─
async function scheduleReminders({ intervalMin, startTime, endTime, consumed, target }) {
  // Cancel existing first
  await cancelReminders();

  const now = new Date();
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);

  const startMs = new Date(now);
  startMs.setHours(sh, sm, 0, 0);
  const endMs = new Date(now);
  endMs.setHours(eh, em, 0, 0);

  const intervalMs = intervalMin * 60 * 1000;

  // Build list of fire times for today and tomorrow
  const times = [];
  for (let day = 0; day <= 1; day++) {
    let t = new Date(startMs.getTime() + day * 86400000);
    const end = new Date(endMs.getTime() + day * 86400000);
    // snap to next interval boundary
    if (t < now) {
      const elapsed = now - t;
      t = new Date(t.getTime() + Math.ceil(elapsed / intervalMs) * intervalMs);
    }
    while (t <= end) {
      times.push(new Date(t));
      t = new Date(t.getTime() + intervalMs);
    }
  }

  // Use Notification Triggers API if available (Chrome Android)
  const usesTriggers = 'showTrigger' in Notification.prototype ||
    typeof TimestampTrigger !== 'undefined';

  if (usesTriggers) {
    // Schedule each as a triggered notification
    for (const ts of times) {
      try {
        await self.registration.showNotification('💧 Hydra — Time to hydrate!', {
          body: buildBody(consumed, target),
          tag: `hydra-reminder-${ts.getTime()}`,
          icon: './icon-192.png',
          badge: './icon-192.png',
          silent: false,
          showTrigger: new TimestampTrigger(ts.getTime())
        });
      } catch(err) {
        console.warn('Trigger failed:', err);
      }
    }
    console.log(`[SW] Scheduled ${times.length} triggered notifications`);
  } else {
    // Fallback: store schedule in cache, use periodic sync or
    // just fire the next one now and reschedule via the app.
    // Store schedule for the app to reschedule on next open.
    const scheduleData = JSON.stringify({ times: times.map(t => t.getTime()), intervalMin, startTime, endTime });
    const cache = await caches.open(CACHE);
    await cache.put('/__hydra_schedule', new Response(scheduleData));
    console.log('[SW] Stored schedule (no triggers support)');
  }
}

async function cancelReminders() {
  // Cancel all pending triggered notifications tagged hydra-reminder-*
  try {
    const pending = await self.registration.getNotifications({ includeTriggered: true });
    for (const n of pending) {
      if (n.tag && n.tag.startsWith('hydra-reminder-')) n.close();
    }
  } catch(e) {
    // getNotifications may not include triggered ones on all browsers
  }
  // Also dismiss any currently showing
  try {
    const showing = await self.registration.getNotifications();
    for (const n of showing) {
      if (n.tag && n.tag.startsWith('hydra-reminder')) n.close();
    }
  } catch(e) {}
}

function buildBody(consumed, target) {
  const left = Math.max(0, target - consumed);
  if (left === 0) return `Goal reached! 🎉 ${target}ml today`;
  const pct = Math.min(100, Math.round(consumed / target * 100));
  return `${pct}% done · ${left}ml left for today`;
}

// ── Periodic Background Sync (Android Chrome) ───────────────
// Fires even when app is closed, reschedules for next day
self.addEventListener('periodicsync', e => {
  if (e.tag === 'hydra-daily-reschedule') {
    e.waitUntil(rescheduleFromCache());
  }
});

async function rescheduleFromCache() {
  try {
    const cache = await caches.open(CACHE);
    const res = await cache.match('/__hydra_schedule');
    if (!res) return;
    const data = JSON.parse(await res.text());
    await scheduleReminders(data);
  } catch(e) {
    console.warn('[SW] reschedule error', e);
  }
}
