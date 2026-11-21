/**
 * The public half of the key that signs the update policy files: the base64
 * line of its minisign .pub file (key id 84A3DAFF29E6A0DA). The one home of
 * this value: policySignature.ts checks each policy against it, and
 * packages/desktop/scripts/sign-policy.sh reads this file to check each
 * signature it makes. It signs nothing else; the updater key in
 * tauri.conf.json is another key.
 *
 * Spec: docs/internal/android-update-check.md (The policy signature)
 */
export const POLICY_PUBLIC_KEY = 'RWTaoOYp/9qjhA8lyFIY1tqw12EcZJ+BMpVpdFPIMNeVHxkWBtOBFpYf';
