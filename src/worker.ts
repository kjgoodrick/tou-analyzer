const CANONICAL_HOST = "www.offpeakadvisor.com";
const PRODUCTION_HOSTS = new Set([CANONICAL_HOST, "offpeakadvisor.com"]);

interface Env {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
}

export function canonicalizeRequestUrl(requestUrl: string): string | null {
  const url = new URL(requestUrl);

  if (!PRODUCTION_HOSTS.has(url.hostname)) {
    return null;
  }

  if (url.protocol === "https:" && url.hostname === CANONICAL_HOST) {
    return null;
  }

  url.protocol = "https:";
  url.hostname = CANONICAL_HOST;
  url.port = "";

  return url.toString();
}

export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    const canonicalUrl = canonicalizeRequestUrl(request.url);

    if (canonicalUrl) {
      return Response.redirect(canonicalUrl, 301);
    }

    return env.ASSETS.fetch(request);
  }
};
