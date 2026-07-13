"use client";

import { UserButton } from "@clerk/nextjs";
import { useSyncExternalStore, type ComponentProps } from "react";

const subscribe = () => () => {};

export function HydrationSafeUserButton({
  fallbackClassName,
  ...props
}: ComponentProps<typeof UserButton> & { fallbackClassName: string }) {
  // Clerk may finish loading before React hydrates. UserButton then renders a
  // client-only host div against an empty server slot, forcing React to throw
  // away the layout. useSyncExternalStore keeps the server and first client
  // snapshots identical, then reveals Clerk immediately after hydration.
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);

  if (!hydrated) {
    return <div aria-hidden="true" className={fallbackClassName} />;
  }

  return <UserButton {...props} />;
}
