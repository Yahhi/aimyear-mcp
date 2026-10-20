/**
 * THE Pro check point. Everything that docs/pricing.md puts in Pro and that the server
 * enforces asks here, and only here.
 *
 * There is no subscription status on the server yet: Pro will be one status per account
 * kept by RevenueCat (docs/pricing.md, "Where Pro is bought"). Until that is wired, Pro is
 * granted by hand: AIMYEAR_PRO_UIDS is a comma-separated list of Firebase uids. Anyone
 * not on it is not Pro, so a missing setting fails closed.
 *
 * TODO(pro): replace the env list with the RevenueCat entitlement for the account
 * (e.g. the REST API or a webhook-fed users/{uid} field), keeping this signature.
 */
export async function isPro(uid: string): Promise<boolean> {
  const list = (process.env.AIMYEAR_PRO_UIDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return !!uid && list.includes(uid);
}
