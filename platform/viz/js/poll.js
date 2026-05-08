// Lightweight polling registry. Replaces the ad-hoc setIntervals scattered
// across the legacy app.js. Each poller runs at its own cadence and can be
// started/stopped collectively (e.g. when the auto-refresh checkbox toggles).

const pollers = [];
let started = false;

export function register(name, fn, intervalMs) {
  pollers.push({ name, fn, intervalMs, timer: null });
}

export function startAll() {
  if (started) return;
  started = true;
  for (const p of pollers) {
    // Fire once immediately, then on interval.
    Promise.resolve()
      .then(() => p.fn())
      .catch((err) => console.warn(`[poll] ${p.name} failed:`, err));
    p.timer = setInterval(() => {
      Promise.resolve()
        .then(() => p.fn())
        .catch((err) => console.warn(`[poll] ${p.name} failed:`, err));
    }, p.intervalMs);
  }
}

export function stopAll() {
  if (!started) return;
  started = false;
  for (const p of pollers) {
    if (p.timer) {
      clearInterval(p.timer);
      p.timer = null;
    }
  }
}

export function isRunning() {
  return started;
}
