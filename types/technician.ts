/**
 * The signed-in technician.
 *
 * Imported from both server and client code, so nothing here may touch secrets
 * or server-only modules.
 */

export interface Technician {
  /** Shown on the dashboard. Never sent to Salesforce. */
  id: string;
  /** The name Salesforce knows the technician by; the Copilot uses it to look up their work. */
  fullName: string;
  /** Derived from fullName, not collected separately. */
  firstName: string;
}

/** POST /api/session */
export interface SignInRequest {
  name: string;
  id: string;
}
