/**
 * Sign-in with the CRE account (Entra External ID / CIAM): the same tenant and
 * API scope as CRE web, so Studio accepts the same users. Studio has its own
 * app registration ("CRE AgentStudio", Vigen, 25 Nov 2026); its redirect URIs
 * are the Studio address and https://localhost:3000 (development).
 */
import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
  type Configuration,
} from "@azure/msal-browser";

export const CRE_TENANT_ID = "8b95a7b3-effb-4d96-a5c2-118fe047e71a";
export const CRE_CLIENT_ID = "8936e09d-4506-41ba-b51e-63796364d70e"; // CRE AgentStudio
export const API_SCOPE = "api://790433ef-9282-4ca5-91df-bbb9369bb43e/access_as_user";

export const msalConfig: Configuration = {
  auth: {
    clientId: CRE_CLIENT_ID,
    authority: `https://creenterprise.ciamlogin.com/${CRE_TENANT_ID}`,
    knownAuthorities: ["creenterprise.ciamlogin.com"],
    redirectUri: window.location.origin,
    postLogoutRedirectUri: window.location.origin,
    navigateToLoginRequestUrl: false,
  },
  cache: { cacheLocation: "localStorage" },
};

export const msal = new PublicClientApplication(msalConfig);

export async function initAuth(): Promise<AccountInfo | null> {
  await msal.initialize();
  const result = await msal.handleRedirectPromise();
  const account = result?.account ?? msal.getActiveAccount() ?? msal.getAllAccounts()[0] ?? null;
  if (account) msal.setActiveAccount(account);
  return account;
}

export function signIn(): Promise<void> {
  return msal.loginRedirect({ scopes: [API_SCOPE], prompt: "select_account" });
}

export function signOut(): Promise<void> {
  return msal.logoutRedirect({ account: msal.getActiveAccount() ?? undefined });
}

/** Access token for the Studio API (silent; redirects to sign-in when needed). */
export async function accessToken(): Promise<string> {
  const account = msal.getActiveAccount();
  if (!account) {
    await signIn();
    throw new Error("signing in");
  }
  try {
    return (await msal.acquireTokenSilent({ scopes: [API_SCOPE], account })).accessToken;
  } catch (err) {
    if (err instanceof InteractionRequiredAuthError) {
      await msal.acquireTokenRedirect({ scopes: [API_SCOPE], account });
    }
    throw err;
  }
}
