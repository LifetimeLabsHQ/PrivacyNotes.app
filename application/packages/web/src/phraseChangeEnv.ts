/**
 * What the phrase change (phraseChange.ts) uses of the app's boot modules,
 * handed to it at run time through `registerChangeEnv`.
 *
 * phraseChange.ts loads only when a change is made or a change this device
 * did not finish is found. The bundler gives a lazy module's static imports
 * chunks of their own, so each boot module it imported was split out of the
 * chunk it shared with the rest of the boot path: four new boot chunks and
 * about 2 kB more boot path, measured 2026-11-12 (docs/contrib/bundle-size.md).
 * Through this object the lazy module imports none of them. Its own imports
 * are types, the shared package (one fixed chunk) and lazy modules.
 * Spec: docs/internal/plans/phrase-change.md (section 5)
 */
import { parseAccountLoginStatus } from './accountLoginsCore';
import {
  PHRASE_CHANGE_KEY,
  PHRASE_STORAGE_KEY,
  PUBKEY_OWNER_KEY,
  removePendingPhraseChange,
} from './authStorage';
import {
  buildPinWrap,
  commitPreparedBiometric,
  discardPreparedBiometric,
  hasBiometricCredential,
  hasPinWrappedPhrase,
  openPinWrapBlob,
  prepareBiometricForPhrase,
  removeBiometricCredential,
  removePinWrappedPhrase,
  storeBuiltPinWrap,
} from './biometric';
import { isDemoMode } from './demo';
import { readFnErrorBody } from './devices';
import { forgetResolveAnswers, resolveRegistered, resolveSigningKey } from './identity';
import { ringKeyCopies } from './keyRing';
import { signInStamp } from './liveSignIn';
import { ensureLevel2, isMfaRefusal } from './mfaStep';
import { appLockArmed, sealPhraseForDevice, unwrapStoredEnvelope } from './phraseAtRest';
import { trustAwareStorage } from './trustStorage';
import { readSettingsRowForChange } from './userSettings';

export const phraseChangeEnv = {
  parseAccountLoginStatus,
  PHRASE_CHANGE_KEY,
  PHRASE_STORAGE_KEY,
  PUBKEY_OWNER_KEY,
  removePendingPhraseChange,
  buildPinWrap,
  commitPreparedBiometric,
  discardPreparedBiometric,
  hasBiometricCredential,
  hasPinWrappedPhrase,
  openPinWrapBlob,
  prepareBiometricForPhrase,
  removeBiometricCredential,
  removePinWrappedPhrase,
  storeBuiltPinWrap,
  isDemoMode,
  readFnErrorBody,
  forgetResolveAnswers,
  resolveRegistered,
  resolveSigningKey,
  ringKeyCopies,
  signInStamp,
  ensureLevel2,
  isMfaRefusal,
  appLockArmed,
  sealPhraseForDevice,
  unwrapStoredEnvelope,
  trustAwareStorage,
  readSettingsRowForChange,
};

export type ChangeEnv = typeof phraseChangeEnv;
