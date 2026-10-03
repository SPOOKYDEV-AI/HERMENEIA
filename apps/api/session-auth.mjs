export function createBearerAuthenticator({ sessionRegistry, credentialReference }) {
  if (!sessionRegistry || typeof sessionRegistry.authenticateCredential !== "function") {
    throw new TypeError("sessionRegistry is required");
  }
  if (typeof credentialReference !== "function") {
    throw new TypeError("credentialReference(token) is required");
  }

  return async function authenticate(req) {
    const header = req.headers.authorization;
    if (typeof header !== "string") {
      return null;
    }

    const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(header);
    if (!match) {
      return null;
    }

    return sessionRegistry.authenticateCredential(
      credentialReference(match[1]),
    );
  };
}
