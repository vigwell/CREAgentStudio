/**
 * Voice appointment agents are out of scope for now (Medilis, 15 Nov 2026:
 * scheduling goes through RADICAL's APIs and a separate Twilio agent). The
 * code stays; set VITE_VOICE_AGENTS=true to show it again.
 */
export const VOICE_AGENTS = import.meta.env.VITE_VOICE_AGENTS === "true";
