import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from './auth';
import { db } from './db';
import { sync } from './sync';
import { APP_ORIGIN, isApexHost } from './hosts';
import { isDemoMode } from './demo';
import { detectPlatform } from './devices';
import type { NoteConflict } from './sync';
import { Banner, FeedbackButton, Spinner } from './ui';

/**
 * The two user-facing halves of the domain move, both rendered as
 * in-flow bars at the top of NotesView's column (the DemoBanner
 * pattern from ui-patterns.md section 39 - a bar in the flow cannot
 * occlude anything):
 *
 *   - MoveBanner (apex): the MoveScreen in one line. It says where the
 *     app lives and how to sign in there, and its button refuses to leave
 *     with unsynced work: it runs a full sync, then counts dirty rows,
 *     and only a clean state opens use.privacynotes.app. Nothing on the
 *     apex is ever wiped. NotesView on the apex is reachable only
 *     through the MoveScreen's stuck-state escape hatch, so this banner
 *     is the second chance after the user fixed what blocked the sync.
 *
 * Spec: docs/internal/domain-split.md (cutover checklist: move trigger +
 * user comms)
 */

type MoveState = 'idle' | 'syncing' | 'error' | 'conflict';

const DISMISS_KEY = 'pn:moveBannerDismissed';

const APP_HOME = `${APP_ORIGIN}/`;

/** Retirement banner on the apex: a button to the app host behind a forced sync. */
export function MoveBanner({ onConflict }: { onConflict: (conflict: NoteConflict) => void }) {
  const { t } = useTranslation('notesChrome');
  const { auth, supabase } = useAuth();
  const [state, setState] = useState<MoveState>('idle');
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });

  if (dismissed) return null;
  if (!isApexHost() || isDemoMode() || detectPlatform() !== 'web') return null;
  if (auth.status !== 'authenticated') return null;

  // Capture the authenticated fields for the async handler: the state
  // union narrows here, and the handler must not re-read a possibly
  // changed auth object mid-flight.
  const { pubkey, encryptionKey, deviceId } = auth;

  async function handleMove() {
    setState('syncing');
    let pushErrors = 0;
    let conflicts = 0;
    try {
      await sync(
        supabase,
        pubkey,
        encryptionKey,
        deviceId,
        undefined,
        () => {
          pushErrors++;
        },
        (conflict) => {
          conflicts++;
          onConflict(conflict);
        },
      );
      const dirty = await db.notes.where('dirty').anyOf(1, 2).count();
      if (conflicts > 0) {
        setState('conflict');
        return;
      }
      if (pushErrors > 0 || dirty > 0) {
        setState('error');
        return;
      }
    } catch {
      setState('error');
      return;
    }
    // Clean state confirmed - leave for the app host's sign-in screen.
    // Navigates away; nothing wiped.
    window.location.assign(APP_HOME);
  }

  function handleDismiss() {
    try {
      sessionStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* ignore */
    }
    setDismissed(true);
  }

  const showFeedback = state === 'error' || state === 'conflict';
  const tone = state === 'error' ? 'danger' : state === 'conflict' ? 'warning' : 'info';

  return (
    <Banner
      tone={tone}
      action={
        state === 'syncing' ? (
          <FeedbackButton icon={<Spinner size={14} />} disabled>
            {t('moveBanner.syncing')}
          </FeedbackButton>
        ) : (
          <FeedbackButton action="next" onClick={() => void handleMove()}>
            {t('moveBanner.cta')}
          </FeedbackButton>
        )
      }
      onDismiss={handleDismiss}
      dismissLabel={t('common:updateToast.dismiss')}
    >
      <span className={showFeedback ? 'hidden sm:inline font-semibold' : 'font-semibold'}>
        {t('moveScreen.title')}
      </span>
      {/* Mini on phones: the description drops, leaving title + CTA.
          Error/conflict feedback instead REPLACES the title there and
          is allowed to wrap - feedback inside the hidden span made a
          failed move look like a dead button on phones. */}
      <span className={`${showFeedback ? 'inline' : 'hidden sm:inline'} ${state === 'error' ? 'text-danger' : 'text-pn-soft'}`}>
        {' '}
        {state === 'conflict'
          ? t('moveBanner.conflict')
          : state === 'error'
            ? t('moveBanner.error')
            : t('moveBanner.bodySignIn', { scanQr: t('importPhrase.scanQr', { ns: 'auth' }) })}
      </span>
    </Banner>
  );
}
