/**
 * The Generator tab: the app's own generator (password and passphrase, length,
 * letters, exact digits and symbols, strength in bits), with this browser's
 * remembered options. It needs no unlock: nothing it makes is stored. Copy
 * clears the clipboard after 30 seconds; inside Add login it fills the field.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.4, generator)
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { browser } from 'wxt/browser';
import { PasswordGenerator } from '@web/PasswordGeneratorPanel';
import { StatusLine } from '@web/ui/feedback';
import type { PwGen } from '@web/passwordGen';
import { APP_URL } from '../../src/config';
import { copyAndClear } from '../../src/copy';
import { proHint } from '../../src/logins';
import { readPrefs, writePrefs } from '../../src/prefs';

export function GeneratorView({ onGenerate }: { onGenerate?: (value: string) => void }) {
  const { t } = useTranslation('extension');
  const [ready, setReady] = useState<{ pwGen: PwGen; pro: boolean } | null>(null);
  const [status, setStatus] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  useEffect(() => {
    void Promise.all([readPrefs(), proHint()]).then(([prefs, pro]) => setReady({ pwGen: prefs.pwGen, pro }));
  }, []);

  if (!ready) return null;
  return (
    <div>
      <PasswordGenerator
        isPro={ready.pro}
        onOpenUpgrade={() => void browser.tabs.create({ url: APP_URL })}
        onGenerate={onGenerate}
        initial={ready.pwGen}
        onSave={(pwGen) => void writePrefs({ pwGen })}
        onCopy={(value) => {
          void copyAndClear(value).then((ok) =>
            setStatus(ok ? { tone: 'success', text: `${t('logins.passwordCopied')}. ${t('logins.clears')}` } : { tone: 'danger', text: t('clip.failed') }),
          );
        }}
      />
      {status && (
        <div className="px-3 pb-3">
          <StatusLine tone={status.tone}>{status.text}</StatusLine>
        </div>
      )}
    </div>
  );
}
