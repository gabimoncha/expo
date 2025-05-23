/**
 * Defines a small polyfill for process.nextTick. Eventually we'd like to replace this polyfill with
 * a native implementation with the correct timing semantics.
 */

if (!process.nextTick) {
  process.nextTick = (callback: (...args: any[]) => any, ...args: any[]) => {
    setTimeout(() => callback(...args), 0);
  };
}
