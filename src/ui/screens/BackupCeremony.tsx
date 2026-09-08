import { useMemo, useState } from 'react'
import { getRepo, useApp } from '../../app/store'
import { useT } from '../../i18n'
import { Banner, Field } from '../components/primitives'
import { randomInt } from '../../core/util/bytes'

/**
 * The recovery-phrase ceremony.
 *
 * Driven by persisted identity state (`mnemonicBackedUp`) rather than local
 * component state, so it survives a reload, a crash, or a closed tab. Someone
 * who abandons it halfway is asked again next time rather than silently ending
 * up with an unrecoverable identity — which is what happens when this step is
 * treated as one screen in a wizard.
 */
export function BackupCeremony({ mnemonic }: { mnemonic: string }) {
  const t = useT()
  const deferBackup = useApp((s) => s.deferBackup)
  const setIdentity = useApp((s) => s.updateProfile)

  const words = useMemo(() => mnemonic.split(' '), [mnemonic])
  const [revealed, setRevealed] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [index] = useState(() => randomInt(words.length))
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState<string | null>(null)

  const complete = async () => {
    await getRepo().updateIdentity({ mnemonicBackedUp: true })
    // Re-read through the store so the shell drops this screen.
    await setIdentity({ mnemonicBackedUp: true })
  }

  return (
    <div className="screen-scroll">
      <div className="container stack" style={{ maxWidth: '32rem', paddingBlock: 'var(--space-6)' }}>
        {!verifying ? (
          <>
            <div className="stack-sm">
              <h1>{t('onboarding.backupTitle')}</h1>
              <p className="muted">{t('onboarding.backupBody')}</p>
            </div>

            <div className={revealed ? 'mnemonic-grid' : 'mnemonic-grid blurred'} aria-hidden={!revealed}>
              {words.map((word, position) => (
                <div key={position} className="mnemonic-word">
                  <span>{position + 1}</span>
                  {word}
                </div>
              ))}
            </div>

            {!revealed ? (
              <button className="btn btn-outline btn-block" onClick={() => setRevealed(true)}>
                {t('onboarding.backupReveal')}
              </button>
            ) : (
              <button className="btn btn-primary btn-block" onClick={() => setVerifying(true)}>
                {t('onboarding.backupConfirm')}
              </button>
            )}

            <button className="btn btn-ghost btn-block" onClick={() => deferBackup()}>
              {t('onboarding.skipBackup')}
            </button>
            <p className="hint center">{t('onboarding.skipBackupWarning')}</p>
          </>
        ) : (
          <>
            <div className="stack-sm">
              <h1>{t('onboarding.verifyTitle')}</h1>
              <p className="muted">{t('onboarding.verifyBody', { n: index + 1 })}</p>
            </div>

            <Field error={error ?? undefined}>
              <input
                className="input mono"
                dir="ltr"
                autoFocus
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={answer}
                onChange={(event) => {
                  setAnswer(event.target.value)
                  setError(null)
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  if (answer.trim().toLowerCase() === words[index]) void complete()
                  else setError(t('onboarding.verifyWrong'))
                }}
              />
            </Field>

            <button
              className="btn btn-primary btn-block"
              disabled={!answer.trim()}
              onClick={() => {
                if (answer.trim().toLowerCase() === words[index]) void complete()
                else setError(t('onboarding.verifyWrong'))
              }}
            >
              {t('common.confirm')}
            </button>
            <button className="btn btn-ghost btn-block" onClick={() => setVerifying(false)}>
              {t('common.back')}
            </button>
          </>
        )}

        <Banner tone="warning">
          <span className="small">{t('lock.forgotBody')}</span>
        </Banner>
      </div>
    </div>
  )
}
