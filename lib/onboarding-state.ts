"use client";

import { useEffect, useState } from "react";
import type { FrameworkKey, IntegrationCategory } from "./onboarding-data";
import { INTEGRATIONS } from "./onboarding-data";

const STORAGE_KEY = "dealripe:onboarding";

export type ConnectionInfo = {
  user: string;
  connectedAt: string;
};

export type OnboardingState = {
  connections: Record<string, ConnectionInfo>;
  framework: FrameworkKey | null;
  selectedTeam: string[];
  selectedDeals: string[];
};

const DEFAULT_STATE: OnboardingState = {
  connections: {},
  framework: null,
  selectedTeam: [],
  selectedDeals: [],
};

export function useOnboardingState() {
  const [state, setState] = useState<OnboardingState>(DEFAULT_STATE);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<OnboardingState>;
        setState({ ...DEFAULT_STATE, ...parsed });
      }
    } catch {
      // ignore corrupt session storage
    }
    setHydrated(true);
  }, []);

  function update(updater: (prev: OnboardingState) => OnboardingState) {
    setState((prev) => {
      const next = updater(prev);
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore storage errors (quota, disabled)
      }
      return next;
    });
  }

  return { state, update, hydrated };
}

export function categoryHasConnection(
  state: OnboardingState,
  category: IntegrationCategory,
): boolean {
  return INTEGRATIONS.filter((i) => i.category === category).some(
    (i) => state.connections[i.id],
  );
}

export function allRequiredCategoriesConnected(state: OnboardingState): boolean {
  return (
    categoryHasConnection(state, "call_recording") &&
    categoryHasConnection(state, "crm") &&
    categoryHasConnection(state, "communication")
  );
}
