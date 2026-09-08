import { useState } from 'react'
import { getRepo, getVault, useApp } from '../../app/store'
import { useI18n } from '../../i18n'
import { Banner, Field, Modal, Spinner, Toggle } from '../components/primitives'
import { PatternPad } from '../components/PatternPad'
import { SettingsPage } from './SettingsPage'
import { type KeyslotSummary, type SlotSecret } from '../../core/vault/vault'
import { canOpenInstantly, isGuarded, isValidPin } from '../../core/vault/keyslots'
import { confirmBiometric, type GateAuthenticator } from '../../core/crypto/biometricGate'
import { forgetBiometric } from '../../core/crypto/biometricEnrol'
import { capitalize, gateName, unlockError } from '../biometric'
import { formatDate } from '../format'
import { useAccessText } from '../access/accessText'
import {
  biometricBlocked,
  digitsOnly,
  explainBiometric,
  PassphraseFields,
  passphraseProblem,
  PatternSetup,
  PinFields,
  pinProblem,
  useBiometricEnrolment,
  useBiometricSupport,
} from '../access/protection'

const AUTO_LOCK_CHOICES = [0, 1, 5, 15, 30, 60]

/** Strongest first, and the recovery phrase, which every vault has, last. */
const ORDER: KeyslotSummary['type'][] = ['passphrase', 'biometric', 'pin', 'device', 'recovery']

type Adding = 'biometric' | 'security-key' | 'pin' | 'pattern' | 'passphrase' | 'instant'

/** One change to how the device opens, or showing the recovery phrase. */
type Flow = { kind: Adding | 'reveal' } | { kind: 'remove'; slot: KeyslotSummary }

/**
 * Whether a change must first be confirmed by opening Textor again. A device
 * that opens instantly has nothing to confirm with, and does not pretend to;
 * one that only the recovery phrase opens is confirmed with the phrase.
 */
const canConfirm = (keyslots: KeyslotSummary[]): boolean =>
  keyslots.length > 0 && !keyslots.some((slot) => slot.type === 'device')

/**
 * How this device opens Textor, and how long it stays open (ADR-054, ADR-058,
 * ADR-059).
 *
 * Every way in is listed with what it protects against, and the level shown is
 * the weakest one's, because that is the level the vault has. Adding or
 * removing a way in, and showing the recovery phrase, first ask the person to
 * open Textor again — each would otherwise be one tap away for anyone holding
 * the unlocked device. Opening instantly is offered only while nothing else
 * guards the device, and setting anything else up turns it off.
 */
export function SecuritySettings() {
  const { t, locale } = useI18n()
  const text = useAccessText()
  const settings = useApp((s) => s.settings)
  const saveSettings = useApp((s) => s.saveSettings)
  const toast = useApp((s) => s.toast)
  const keyslots = useApp((s) => s.keyslots)
  const refreshKeyslots = useApp((s) => s.refreshKeyslots)
  const support = useBiometricSupport()
  const gate = keyslots.find((slot) => slot.type === 'biometric')
  const method = gateName(gate?.authenticator, t)
  const platform = gateName('platform', t)
  const blocked = biometricBlocked(support, text, platform)

  const [flow, setFlow] = useState<Flow | null>(null)
  const [phrase, setPhrase] = useState<string[] | null>(null)

  const has = (type: KeyslotSummary['type']) => keyslots.some((slot) => slot.type === type)
  const everyday = keyslots.filter((slot) => slot.type !== 'recovery')
  const guarded = keyslots.some(isGuarded)
  const slots = [...keyslots].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type))
  const pin = keyslots.find((slot) => slot.type === 'pin')
  const pattern = pin?.style === 'pattern'
  // A lockout erases a PIN, so one is offered only with something to fall back on.
  const pinAllowed = has('recovery') || has('passphrase')

  // The weakest way in sets the level: instant, then a PIN, then biometrics.
  const level = has('device')
    ? { tone: 'warning' as const, line: text('levelInstant') }
    : pin
      ? { tone: 'info' as const, line: text(pattern ? 'levelPattern' : 'levelPin') }
      : has('biometric')
        ? { tone: 'info' as const, line: text('levelBiometric', { method }) }
        : has('passphrase')
          ? { tone: 'accent' as const, line: text('levelPassphrase') }
          : { tone: 'warning' as const, line: text('levelRecoveryOnly') }

  const name = (slot: KeyslotSummary): string =>
    slot.type === 'biometric'
      ? slot.authenticator === 'security-key'
        ? text('securityKeyName')
        : capitalize(platform)
      : slot.type === 'pin'
        ? text(slot.style === 'pattern' ? 'pattern' : 'pin')
        : slot.type === 'passphrase'
          ? text('passphrase')
          : slot.type === 'device'
            ? text('choiceInstant')
            : text('wayRecovery')

  const describe = (slot: KeyslotSummary): string =>
    slot.type === 'biometric'
      ? text('wayBiometricBody')
      : slot.type === 'pin'
        ? text('wayPinBody')
        : slot.type === 'passphrase'
          ? text('wayPassphraseBody')
          : slot.type === 'device'
            ? text('wayInstantBody')
            : text('wayRecoveryBody')

  const reveal = async () => {
    const identity = await getRepo().getIdentity()
    if (identity?.mnemonic) setPhrase(identity.mnemonic.split(' '))
    else toast(t('errors.generic'), 'danger')
  }

  const start = (next: Flow) =>
    canConfirm(keyslots) || next.kind !== 'reveal' ? setFlow(next) : void reveal()

  return (
    <SettingsPage title={t('settings.security')}>
      <Banner tone={level.tone}>
        <span className="stack-sm">
          <strong>{text('levelTitle')}</strong>
          <span className="small">{level.line}</span>
        </span>
      </Banner>

      <div className="stack-sm">
        <h3 style={{ fontSize: 'var(--step-0)' }}>{text('waysTitle')}</h3>
        <p className="muted small">{text('waysBody')}</p>
      </div>
      <div className="card-section">
        {slots.map((slot) => {
          // The last everyday way can go only where the recovery phrase still opens the device.
          const onlyWay = slot.type !== 'recovery' && everyday.length === 1 && !has('recovery')
          return (
            <div key={slot.id} className="list-row" style={{ cursor: 'default' }}>
              <span className="grow stack-sm" style={{ minWidth: 0 }}>
                <strong>{name(slot)}</strong>
                <span className="small muted">{describe(slot)}</span>
                {slot.failures ? (
                  <span className="hint">{text('wrongTries', { n: slot.failures })}</span>
                ) : null}
                {slot.createdAt > 0 ? (
                  <span className="hint">{text('added', { date: formatDate(slot.createdAt, locale) })}</span>
                ) : null}
                {onlyWay ? <span className="hint">{text('onlyWay')}</span> : null}
              </span>
              {slot.type !== 'recovery' && !onlyWay ? (
                <button className="btn btn-ghost small" onClick={() => start({ kind: 'remove', slot })}>
                  {t('common.remove')}
                </button>
              ) : null}
            </div>
          )
        })}
      </div>

      <div className="stack-sm">
        <h3 style={{ fontSize: 'var(--step-0)' }}>{text('addTitle')}</h3>
        {gate ? null : support?.platform === 'yes' ? (
          <button className="btn btn-outline btn-block" onClick={() => start({ kind: 'biometric' })}>
            {text('addBiometric', { method: platform })}
          </button>
        ) : blocked ? (
          <p className="hint">
            <strong>{text('addBiometric', { method: platform })}</strong> — {blocked}
          </p>
        ) : null}
        {!gate && support?.securityKey ? (
          <button className="btn btn-outline btn-block" onClick={() => start({ kind: 'security-key' })}>
            {text('addKey')}
          </button>
        ) : null}
        {pinAllowed ? (
          <>
            <button className="btn btn-outline btn-block" onClick={() => start({ kind: 'pin' })}>
              {pin && !pattern ? text('changePin') : text('addPin')}
            </button>
            <button className="btn btn-outline btn-block" onClick={() => start({ kind: 'pattern' })}>
              {pattern ? text('changePattern') : text('addPattern')}
            </button>
            {pin ? <p className="hint">{text('onePin')}</p> : null}
          </>
        ) : null}
        <button className="btn btn-outline btn-block" onClick={() => start({ kind: 'passphrase' })}>
          {has('passphrase') ? text('changePassphrase') : text('addPassphrase')}
        </button>
        {/* Only while nothing else guards the device (ADR-059). */}
        {!canOpenInstantly() || has('device') ? null : guarded ? (
          <p className="hint">
            <strong>{text('choiceInstant')}</strong> — {text('instantExclusive')}
          </p>
        ) : (
          <button className="btn btn-outline btn-block" onClick={() => start({ kind: 'instant' })}>
            {text('choiceInstant')}
          </button>
        )}
        <p className="hint">{text('notRetroactive')}</p>
      </div>

      <h3 style={{ fontSize: 'var(--step-0)' }}>{text('sessionTitle')}</h3>
      <div className="card stack-sm">
        <Field label={text('autoLock')}>
          <select
            className="input select"
            value={String(settings.autoLockMinutes)}
            onChange={(event) => void saveSettings({ autoLockMinutes: Number(event.target.value) })}
          >
            {AUTO_LOCK_CHOICES.map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes === 0 ? text('autoLockNever') : text('autoLockMinutes', { n: minutes })}
              </option>
            ))}
          </select>
        </Field>
        {has('device') ? <p className="hint">{text('instantSession')}</p> : null}
      </div>

      <div className="card-section">
        <Toggle
          label={text('lockOnHide')}
          checked={settings.lockOnHide}
          onChange={(lockOnHide) => void saveSettings({ lockOnHide })}
        />
      </div>

      <div className="card stack-sm">
        <h3 style={{ fontSize: 'var(--step-0)' }}>{t('settings.recoveryPhrase')}</h3>
        <p className="muted small">{text('recoveryPhraseBody')}</p>
        {phrase ? (
          <>
            <div className="mnemonic-grid">
              {phrase.map((word, index) => (
                <div key={index} className="mnemonic-word">
                  <span>{index + 1}</span>
                  {word}
                </div>
              ))}
            </div>
            <button className="btn btn-ghost btn-block" onClick={() => setPhrase(null)}>
              {t('common.hide')}
            </button>
          </>
        ) : (
          <button className="btn btn-outline btn-block" onClick={() => start({ kind: 'reveal' })}>
            {t('common.show')}
          </button>
        )}
      </div>

      <Banner tone="accent">
        <span className="small">{t('privacy.deviceBody')}</span>
      </Banner>

      {flow ? (
        <MethodFlow
          flow={flow}
          keyslots={keyslots}
          onClose={() => setFlow(null)}
          onDone={async (message) => {
            setFlow(null)
            if (flow.kind === 'reveal') return reveal()
            await refreshKeyslots()
            toast(message)
          }}
        />
      ) : null}
    </SettingsPage>
  )
}

/**
 * Confirm it is the owner, then do one thing: set up biometrics or a security
 * key, set a PIN or a pattern, change the passphrase, turn on instant opening,
 * remove a way in, or show the recovery phrase. A device that opens instantly
 * has nothing to confirm with, and says so by not asking.
 */
function MethodFlow({
  flow,
  keyslots,
  onClose,
  onDone,
}: {
  flow: Flow
  keyslots: KeyslotSummary[]
  onClose: () => void
  onDone: (message: string) => void | Promise<void>
}) {
  const t = useI18n().t
  const text = useAccessText()
  const { kind } = flow
  const gate: GateAuthenticator = kind === 'security-key' ? 'security-key' : 'platform'
  const method = gateName(gate, t)
  const enrolBiometricSlot = useBiometricEnrolment()
  const [confirmed, setConfirmed] = useState(!canConfirm(keyslots))
  const [value, setValue] = useState('')
  const [repeat, setRepeat] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const pin = keyslots.find((slot) => slot.type === 'pin')
  const changing = (type: KeyslotSummary['type']) => keyslots.some((slot) => slot.type === type)
  // Anything that asks for something turns opening instantly off (ADR-059):
  // said before it is set up, and again once it is.
  const endsInstant = changing('device') && kind !== 'instant' && kind !== 'remove' && kind !== 'reveal'
  const added = endsInstant ? text('instantOff') : text('addedToast')
  const lastWay = flow.kind === 'remove' && keyslots.filter((slot) => slot.type !== 'recovery').length === 1

  const run = async (step: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    setProgress(0)
    try {
      await step()
    } catch (err) {
      setError(
        kind === 'biometric' || kind === 'security-key'
          ? explainBiometric(err, text, t, method)
          : err instanceof Error
            ? err.message
            : String(err),
      )
    } finally {
      setBusy(false)
    }
  }

  if (!confirmed || kind === 'reveal') {
    return (
      <Modal title={text('confirmTitle')} onClose={onClose}>
        <ConfirmIdentity
          keyslots={keyslots}
          onConfirmed={() => (kind === 'reveal' ? void onDone('') : setConfirmed(true))}
        />
      </Modal>
    )
  }

  const titles: Record<Exclude<Flow['kind'], 'reveal'>, string> = {
    biometric: text('addBiometric', { method }),
    'security-key': text('addKey'),
    remove: t('common.remove'),
    pin: pin?.style === 'digits' ? text('changePin') : text('addPin'),
    pattern: pin?.style === 'pattern' ? text('changePattern') : text('addPattern'),
    passphrase: changing('passphrase') ? text('changePassphrase') : text('addPassphrase'),
    instant: text('choiceInstant'),
  }

  const errorLine = error ? (
    <p className="error-text" role="alert">
      {error}
    </p>
  ) : null
  const progressBar = busy ? (
    <div className="progress">
      <div style={{ width: `${Math.round(progress * 100)}%` }} />
    </div>
  ) : null

  return (
    <Modal title={titles[kind]} onClose={onClose}>
      <div className="stack">
        {endsInstant ? <p className="hint">{text('instantWillStop')}</p> : null}

        {kind === 'biometric' || kind === 'security-key' ? (
          <>
            <p className="muted small">{capitalize(text('twoPrompts', { method }))}</p>
            {errorLine}
            <button
              className="btn btn-primary btn-block"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await getVault().addSlot(await enrolBiometricSlot(gate))
                  await onDone(added)
                })
              }
            >
              {busy ? <Spinner label={t('common.working')} /> : titles[kind]}
            </button>
          </>
        ) : null}

        {flow.kind === 'remove' ? (
          <>
            <Banner tone="warning">
              <span className="small">{lastWay ? text('removeLast') : text('removeConfirm')}</span>
            </Banner>
            {errorLine}
            <button
              className="btn btn-danger-soft btn-block"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await getVault().removeSlot(flow.slot.id)
                  if (flow.slot.credentialId) forgetBiometric(flow.slot.credentialId)
                  await onDone(text('removed'))
                })
              }
            >
              {busy ? <Spinner label={t('common.working')} /> : t('common.remove')}
            </button>
          </>
        ) : null}

        {kind === 'pin' ? (
          <>
            <PinFields
              value={value}
              confirm={repeat}
              error={error}
              onChange={setValue}
              onConfirmChange={setRepeat}
              onSubmit={() => undefined}
            />
            {progressBar}
            <button
              className="btn btn-primary btn-block"
              disabled={busy || !value}
              onClick={() => {
                const problem = pinProblem(value, repeat, text)
                if (problem) return setError(problem)
                void run(async () => {
                  await getVault().addSlot({
                    type: 'pin',
                    style: 'digits',
                    code: value,
                    onProgress: setProgress,
                  })
                  await onDone(pin?.style === 'digits' ? text('pinChanged') : added)
                })
              }}
            >
              {busy ? <Spinner label={t('common.working')} /> : t('common.save')}
            </button>
          </>
        ) : null}

        {kind === 'pattern' ? (
          <>
            <PatternSetup
              disabled={busy}
              onComplete={(code) =>
                void run(async () => {
                  await getVault().addSlot({ type: 'pin', style: 'pattern', code, onProgress: setProgress })
                  await onDone(pin?.style === 'pattern' ? text('patternChanged') : added)
                })
              }
            />
            {progressBar}
            {errorLine}
          </>
        ) : null}

        {kind === 'passphrase' ? (
          <>
            <PassphraseFields
              value={value}
              confirm={repeat}
              error={error}
              onChange={setValue}
              onConfirmChange={setRepeat}
              onSubmit={() => undefined}
            />
            {progressBar}
            <button
              className="btn btn-primary btn-block"
              disabled={busy || !value}
              onClick={() => {
                const problem = passphraseProblem(value, repeat, text)
                if (problem) return setError(problem)
                void run(async () => {
                  await getVault().addSlot({ type: 'passphrase', passphrase: value, onProgress: setProgress })
                  await onDone(changing('passphrase') ? text('passphraseChanged') : added)
                })
              }}
            >
              {busy ? <Spinner label={t('common.working')} /> : t('common.save')}
            </button>
          </>
        ) : null}

        {kind === 'instant' ? (
          <>
            <Banner tone="warning">
              <span className="small">{text('instantConfirm')}</span>
            </Banner>
            {errorLine}
            <button
              className="btn btn-danger-soft btn-block"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await getVault().addSlot({ type: 'device' })
                  await onDone(text('addedToast'))
                })
              }
            >
              {busy ? <Spinner label={t('common.working')} /> : text('choiceInstant')}
            </button>
          </>
        ) : null}
      </div>
    </Modal>
  )
}

type Way = 'biometric' | 'pin' | 'passphrase' | 'recovery'

/**
 * Open Textor again, without locking it: biometrics or a security key, the PIN
 * or pattern, the passphrase, or the recovery phrase, checked against the vault that is
 * already open. A wrong PIN here counts towards erasing it, as on the lock
 * screen.
 */
function ConfirmIdentity({ keyslots, onConfirmed }: { keyslots: KeyslotSummary[]; onConfirmed: () => void }) {
  const t = useI18n().t
  const text = useAccessText()
  const refreshKeyslots = useApp((s) => s.refreshKeyslots)
  const biometric = keyslots.find((slot) => slot.type === 'biometric')
  const method = gateName(biometric?.authenticator, t)
  const pin = keyslots.find((slot) => slot.type === 'pin')
  const style = pin?.style ?? 'digits'
  const offered = (['biometric', 'pin', 'passphrase', 'recovery'] as const).filter((type) =>
    keyslots.some((slot) => slot.type === type),
  )

  const [chosen, setWay] = useState<Way>(offered[0] as Way)
  // A PIN erased by a wrong try here gives way to the next.
  const way = offered.includes(chosen) ? chosen : (offered[0] as Way)
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const check = async (make: () => Promise<SlotSecret>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await getVault().verify(await make())
      onConfirmed()
    } catch (err) {
      setError(unlockError(err, t, { style, method }))
      setSecret('')
      // Too many wrong tries erase the PIN; the list behind this dialog says so.
      if (way === 'pin') await refreshKeyslots()
    } finally {
      setBusy(false)
    }
  }

  const other: Record<Way, string> = {
    biometric: capitalize(text('confirmWith', { method })),
    pin: t('lock.useCode', { what: t(style === 'pattern' ? 'lock.pattern' : 'lock.pin') }),
    passphrase: t('lock.usePassphrase'),
    recovery: t('lock.useRecovery'),
  }

  const errorLine = error ? (
    <p className="error-text" role="alert">
      {error}
    </p>
  ) : null

  return (
    <div className="stack">
      <p className="muted small">{text('confirmBody')}</p>

      {way === 'biometric' && biometric?.credentialId ? (
        <>
          <button
            className="btn btn-primary btn-block"
            disabled={busy}
            onClick={() =>
              void check(async () => ({
                type: 'biometric',
                presence: await confirmBiometric({
                  credentialId: biometric.credentialId as string,
                  authenticator: biometric.authenticator,
                  transports: biometric.transports,
                }),
              }))
            }
          >
            {busy ? <Spinner label={t('common.working')} /> : other.biometric}
          </button>
          {errorLine}
        </>
      ) : way === 'pin' && style === 'pattern' ? (
        <>
          <PatternPad
            label={t('lock.drawPattern')}
            disabled={busy}
            onDone={(code) => void check(async () => ({ type: 'pin', code }))}
          />
          {errorLine}
        </>
      ) : (
        <>
          <Field
            label={
              way === 'recovery'
                ? t('lock.recoveryPhrase')
                : way === 'pin'
                  ? t('lock.pin')
                  : t('lock.passphrase')
            }
            error={error ?? undefined}
          >
            {way === 'recovery' ? (
              <textarea
                className="textarea mono"
                dir="ltr"
                autoFocus
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={secret}
                onChange={(event) => {
                  setSecret(event.target.value)
                  setError(null)
                }}
              />
            ) : (
              <input
                className={way === 'pin' ? 'input pin-input' : 'input'}
                type="password"
                dir={way === 'pin' ? 'ltr' : undefined}
                inputMode={way === 'pin' ? 'numeric' : undefined}
                autoFocus
                autoComplete={way === 'pin' ? 'off' : 'current-password'}
                value={secret}
                onChange={(event) => {
                  setSecret(way === 'pin' ? digitsOnly(event.target.value) : event.target.value)
                  setError(null)
                }}
              />
            )}
          </Field>
          <button
            className="btn btn-primary btn-block"
            disabled={busy || (way === 'pin' ? !isValidPin('digits', secret) : !secret.trim())}
            onClick={() =>
              void check(async () =>
                way === 'recovery'
                  ? { type: 'recovery', mnemonic: secret }
                  : way === 'pin'
                    ? { type: 'pin', code: secret }
                    : { type: 'passphrase', passphrase: secret },
              )
            }
          >
            {busy ? <Spinner label={t('common.working')} /> : t('common.confirm')}
          </button>
        </>
      )}

      {offered
        .filter((candidate) => candidate !== way)
        .map((candidate) => (
          <button
            key={candidate}
            className="btn btn-ghost small"
            onClick={() => {
              setWay(candidate)
              setSecret('')
              setError(null)
            }}
          >
            {other[candidate]}
          </button>
        ))}
    </div>
  )
}
