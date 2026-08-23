export type AbortScope = Readonly<{
  signal: AbortSignal;
  abortForDeadline: () => void;
  dispose: () => void;
}>;

// Each timed phase gets a child signal. Expiring fetch cannot abort the
// attempt-wide lifecycle signal or a later verified-image decode phase.
export function createAbortScope(lifecycleSignal: AbortSignal): AbortScope {
  const controller = new AbortController();
  const abortFromLifecycle = () => controller.abort();
  if (lifecycleSignal.aborted) controller.abort();
  else lifecycleSignal.addEventListener("abort", abortFromLifecycle, { once: true });

  return Object.freeze({
    signal: controller.signal,
    abortForDeadline: () => controller.abort(),
    dispose: () => lifecycleSignal.removeEventListener("abort", abortFromLifecycle),
  });
}
