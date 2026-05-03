"use client";

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import type { ExtractionResult } from "@/lib/scotsman";

type DealState = {
  extraction: ExtractionResult;
  currentCallId?: string;
};

type ContextValue = {
  getDealState: (dealId: string) => DealState | undefined;
  setDealState: (dealId: string, state: DealState) => void;
};

const DemoStateContext = createContext<ContextValue | undefined>(undefined);

export function DemoStateProvider({ children }: { children: ReactNode }) {
  const [states, setStates] = useState<Record<string, DealState>>({});

  const getDealState = useCallback(
    (dealId: string) => states[dealId],
    [states],
  );

  const setDealState = useCallback((dealId: string, state: DealState) => {
    setStates((prev) => ({ ...prev, [dealId]: state }));
  }, []);

  return (
    <DemoStateContext.Provider value={{ getDealState, setDealState }}>
      {children}
    </DemoStateContext.Provider>
  );
}

export function useDemoState() {
  const ctx = useContext(DemoStateContext);
  if (!ctx) {
    throw new Error("useDemoState must be used within DemoStateProvider");
  }
  return ctx;
}
