/**
 * The generator: the app's own generator (password and passphrase, length,
 * letters, exact digits and symbols, strength in bits), with this browser's
 * remembered options. It needs no unlock: nothing it makes is stored. Copy
 * says Copied and the footer counts down to the clipboard clear after 30
 * seconds (pattern 177); inside Add login it fills the field.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.4, generator)
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { browser } from 'wxt/browser';
import { PasswordGenerator } from '@web/PasswordGeneratorPanel';
import type { PwGen } from '@web/passwordGen';
import { CLEAR_AFTER_MS } from '../../src/clipboard';
import { APP_URL } from '../../src/config';
import { copyAndClear } from '../../src/copy';
import { proHint } from '../../src/logins';
import { readPrefs, writePrefs } from '../../src/prefs';
import { useNotify } from './Footer';

export function GeneratorView({ onGenerate }: { onGenerate?: (value: string) => void }) {
  const { t } = useTranslation('extension');
  const notify = useNotify();
  const [ready, setReady] = useState<{ pwGen: PwGen; pro: boolean } | null>(null);

  useEffect(() => {
    void Promise.all([readPrefs(), proHint()]).then(([prefs, pro]) => setReady({ pwGen: prefs.pwGen, pro }));
  }, []);

  if (!ready) return null;
  return (
    <PasswordGenerator
      isPro={ready.pro}
      onOpenUpgrade={() => void browser.tabs.create({ url: APP_URL })}
      onGenerate={onGenerate}
      initial={ready.pwGen}
      onSave={(pwGen) => void writePrefs({ pwGen })}
      onCopy={async (value) => {
        const ok = await copyAndClear(value);
        notify(ok
          ? { title: t('logins.passwordCopied'), clearsAt: Date.now() + CLEAR_AFTER_MS }
          : { tone: 'danger', title: t('notice.copyFailed'), detail: t('auth:signIn.tryAgain') });
        return ok;
      }}
    />
  );
}
