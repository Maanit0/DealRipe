// ---------------------------------------------------------------------------
// MOVED: demo tenant data now lives in lib/demos/ (one folder per prospect).
// This file is a thin back-compat shim so existing imports keep working.
// New code should import from "@/lib/demos".
// ---------------------------------------------------------------------------
export * from "./demos/types";
export {
  DEMOS as TENANTS,
  DEMO_LIST as TENANT_LIST,
  getDemo as getTenant,
} from "./demos";
