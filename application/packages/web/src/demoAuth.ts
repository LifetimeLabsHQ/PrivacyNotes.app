import {
  phraseToSeed,
  deriveSigningKey,
  deriveEncryptionKey,
  deriveFpPepper,
  bytesToHex,
} from '@notes/shared';
import { clearLocalDatabase } from './notesRepo';
import { clearLocalSettings, loadLocalSettings, saveLocalSettings } from './userSettings';
import { DEMO_PHRASE, demoSessionIsFresh } from './demo';
import { demoShowcaseDashboard, writeDashboardSetting } from './dashboard/dashboardLayout';
import {
  DEMO_WATER_COUNTER_ID,
  demoMedications,
  demoWaterCounter,
  seedOnboardingNotes,
  withSeedFactors,
} from './welcomeNote';
import type { AuthState } from './auth';

export async function buildDemoAuthState(): Promise<AuthState> {
  const seed = phraseToSeed(DEMO_PHRASE);
  const { privateKey, publicKey } = await deriveSigningKey(seed);
  const encryptionKey = deriveEncryptionKey(seed);
  const fpPepper = deriveFpPepper(seed);
  const pubkey = bytesToHex(publicKey);
  // Fresh tab session → clean slate; an in-tab refresh keeps edits.
  // Settings live in a demo-only localStorage bucket (see
  // userSettings.ts localKey) and reset alongside the notes so
  // every fresh session starts from defaults.
  const fresh = demoSessionIsFresh();
  if (fresh) {
    await clearLocalDatabase();
    clearLocalSettings();
  }
  await seedOnboardingNotes(pubkey); // idempotent
  // Seed the demo medications, Water counter, factors, and showcase Home
  // dashboard so every new widget opens with live interactive data.
  const s = loadLocalSettings();
  const meds = demoMedications();
  const existingMedIds = new Set((s.medications ?? []).map((m) => m.id));
  const nextMeds = [...(s.medications ?? []), ...meds.filter((m) => !existingMedIds.has(m.id))];
  const existingCustom = s.trackerSettings?.customTrackers ?? [];
  const hasWater = existingCustom.some((c) => c.id === DEMO_WATER_COUNTER_ID);
  const nextCustomTrackers = hasWater ? existingCustom : [...existingCustom, demoWaterCounter()];
  const needsDashboard = fresh || !s.dashboard?.layout;
  const nextDashboard = needsDashboard
    ? writeDashboardSetting(s.dashboard ?? {}, demoShowcaseDashboard(DEMO_WATER_COUNTER_ID))
    : s.dashboard;
  if (nextMeds.length !== (s.medications ?? []).length || (s.factors ?? []).length === 0 || !hasWater || needsDashboard) {
    saveLocalSettings({
      ...s,
      medications: nextMeds,
      factors: withSeedFactors(s.factors),
      ...(s.trackerSettings ? { trackerSettings: { ...s.trackerSettings, customTrackers: nextCustomTrackers } } : {}),
      dashboard: nextDashboard,
    });
  }
  return {
    status: 'authenticated',
    method: 'phrase',
    phrase: DEMO_PHRASE,
    pubkey,
    // The demo phrase is its own account: it never changes.
    signingPubkey: pubkey,
    encryptionKey,
    signingPrivateKey: privateKey,
    fpPepper,
    deviceId: 'demo',
    isPro: false,
    isEarlySupporter: false,
    isCustodial: false,
    localOnly: false,
  };
}
