"use client";

import type { ReactNode } from "react";
import { AppProvider } from "../lib/app-context";

export function Providers({ children }: { children: ReactNode }) {
  return <AppProvider>{children}</AppProvider>;
}
