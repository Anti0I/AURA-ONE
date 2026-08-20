"use client";

import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

/**
 * Reads a browser capability without a render cascade.
 *
 * The tempting version is `useState(false)` plus an effect that sets the real
 * value — which renders twice on every mount and, more to the point, is exactly
 * what `useSyncExternalStore` exists to replace. React already knows how to
 * read a value that differs between server and client; `getServerSnapshot`
 * is the supported way to say so.
 *
 * `getValue` must be cheap and stable: it is called on every render.
 */
export function useClientValue<T>(getValue: () => T, serverValue: T): T {
  return useSyncExternalStore(noopSubscribe, getValue, () => serverValue);
}
