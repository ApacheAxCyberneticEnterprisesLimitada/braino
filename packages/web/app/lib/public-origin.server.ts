interface PublicOriginEnvironment {
  DOCO_PUBLIC_HOST?: string;
}

export function publicOrigin(request: Request, env: PublicOriginEnvironment = process.env): string {
  const configured = env.DOCO_PUBLIC_HOST?.trim();
  const url = new URL(configured || request.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("DOCO_PUBLIC_HOST must be an HTTP or HTTPS origin.");
  }
  return url.origin;
}

export function mcpResource(request: Request, env: PublicOriginEnvironment = process.env): string {
  return `${publicOrigin(request, env)}/mcp`;
}

export function protectedResourceMetadataUrl(
  request: Request,
  env: PublicOriginEnvironment = process.env,
): string {
  return `${publicOrigin(request, env)}/.well-known/oauth-protected-resource/mcp`;
}
