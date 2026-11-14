/**
 * The change listeners of a module-level store: `subscribe` fits
 * `useSyncExternalStore` (one stable function per store) and returns the
 * unsubscribe, `notify` calls every listener.
 */
export function createListeners(): { subscribe: (cb: () => void) => () => void; notify: () => void } {
  const set = new Set<() => void>();
  return {
    subscribe(cb) {
      set.add(cb);
      return () => {
        set.delete(cb);
      };
    },
    notify() {
      set.forEach((cb) => cb());
    },
  };
}
