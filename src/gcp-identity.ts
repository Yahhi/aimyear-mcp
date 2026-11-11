/**
 * Cloud Run's Google identity token for this service (the aimyear-mcp service account), from
 * the metadata server. Other clouds trade it for their own short-lived credentials, so the
 * server stores no API key for them: Anthropic (social/wip-match.ts) and AWS SES
 * (review/deliver.ts). Each asks with its own audience.
 */
export async function googleIdentityToken(audience: string): Promise<string> {
  const url = `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}&format=full`;
  const r = await fetch(url, { headers: { 'Metadata-Flavor': 'Google' } });
  if (!r.ok) throw new Error(`metadata server answered ${r.status}`);
  return r.text();
}
