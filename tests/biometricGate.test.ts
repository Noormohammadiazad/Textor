import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  confirmBiometric,
  GateCancelledError,
  hintsFor,
  PRESENCE_TTL_MS,
  spendPresence,
  verified,
  type GateRefusedError,
  type Presence,
} from '@/core/crypto/biometricGate'
import {
  biometricSupport,
  enrolBiometric,
  forgetBiometric,
  platformFamily,
} from '@/core/crypto/biometricEnrol'
import { b64urlToBytes, bytesToB64url, randomBytes } from '@/core/util/bytes'
import { authData, created, credential, VERIFIED, webauthn } from './webauthnFakes'

/**
 * A gate in front of a local key (ADR-058, ADR-059): a credential on this
 * device's authenticator or a security key, made with user verification
 * required, asked again each time Textor opens, and a proof of that answer
 * which the vault spends once. No key comes out of WebAuthn.
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

const refused = (reason: string) => expect.objectContaining({ name: 'GateRefusedError', reason })
const UA = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.1 Safari/605.1.15',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_2 like Mac OS X) AppleWebKit/605.1.15 CriOS/140.0',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
  android: 'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36',
  chromeos: 'Mozilla/5.0 (X11; CrOS x86_64 16181.0.0) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
  bsd: 'Mozilla/5.0 (X11; FreeBSD amd64; rv:140.0) Gecko/20100101 Firefox/140.0',
}

describe('which system this is', () => {
  it('tells the families apart, Android and ChromeOS before Linux, iPadOS as a Mac', () => {
    expect(platformFamily(UA.mac)).toBe('apple')
    expect(platformFamily(UA.iphone)).toBe('apple')
    expect(platformFamily(UA.windows)).toBe('windows')
    expect(platformFamily(UA.android)).toBe('android')
    expect(platformFamily(UA.chromeos)).toBe('chromeos')
    expect(platformFamily(UA.linux)).toBe('linux')
    expect(platformFamily(UA.bsd)).toBe('linux')
    expect(platformFamily('')).toBe('other')
  })
})

describe('what can guard Textor here', () => {
  it('offers the device’s own authenticator where it is set up, and a security key everywhere', async () => {
    webauthn()
    expect(await biometricSupport(UA.windows)).toEqual({
      platform: 'yes',
      securityKey: true,
      family: 'windows',
    })
    // Read from the browser's own user agent when none is given.
    expect(await biometricSupport()).toMatchObject({ platform: 'yes', family: 'apple' })
  })

  it('says it is not set up where the platform has nothing to verify with, or will not say', async () => {
    webauthn({ platform: false })
    expect(await biometricSupport(UA.android)).toMatchObject({ platform: 'not-set-up', securityKey: true })
    webauthn({ platform: 'throws' })
    expect(await biometricSupport(UA.windows)).toMatchObject({ platform: 'not-set-up' })
  })

  it('believes the capability where iOS 26.2 said no platform authenticator was there', async () => {
    const getClientCapabilities = vi.fn(async () => ({ userVerifyingPlatformAuthenticator: true }))
    webauthn({ platform: false, statics: { getClientCapabilities } })
    expect(await biometricSupport(UA.iphone)).toMatchObject({ platform: 'yes' })

    // Either saying yes is enough; a capability call that fails is no answer.
    getClientCapabilities.mockResolvedValueOnce({ userVerifyingPlatformAuthenticator: false })
    webauthn({ statics: { getClientCapabilities } })
    expect(await biometricSupport(UA.mac)).toMatchObject({ platform: 'yes' })
    getClientCapabilities.mockRejectedValueOnce(new Error('unsupported'))
    webauthn({ platform: false, statics: { getClientCapabilities } })
    expect(await biometricSupport(UA.mac)).toMatchObject({ platform: 'not-set-up' })
  })

  it('never offers Linux its own authenticator, and offers a security key there', async () => {
    webauthn()
    expect(await biometricSupport(UA.linux)).toEqual({
      platform: 'unsupported',
      securityKey: true,
      family: 'linux',
    })
  })

  it('offers nothing without WebAuthn, WebCrypto or a secure context', async () => {
    const none = { platform: 'unsupported', securityKey: false }
    webauthn({ statics: null })
    expect(await biometricSupport(UA.mac)).toMatchObject(none)

    webauthn()
    vi.stubGlobal('navigator', {})
    expect(await biometricSupport(UA.mac)).toMatchObject(none)
    vi.stubGlobal('navigator', undefined)
    expect(await biometricSupport()).toEqual({ ...none, family: 'other' })

    webauthn()
    vi.stubGlobal('isSecureContext', false)
    expect(await biometricSupport(UA.mac)).toMatchObject(none)
    vi.stubGlobal('isSecureContext', true)
    expect(await biometricSupport(UA.mac)).toMatchObject({ platform: 'yes' })

    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
    expect(await biometricSupport(UA.mac)).toMatchObject(none)
    vi.stubGlobal('crypto', undefined)
    expect(await biometricSupport(UA.mac)).toMatchObject(none)
  })
})

describe('setting a gate up', () => {
  it('makes a platform credential that must verify the person, then asks it once, the same way', async () => {
    const fake = webauthn()
    const presence = await enrolBiometric()

    const { publicKey } = fake.create.mock.calls[0]?.[0] as CredentialCreationOptions
    expect(publicKey?.authenticatorSelection).toEqual({
      authenticatorAttachment: 'platform',
      userVerification: 'required',
      residentKey: 'discouraged',
    })
    expect(publicKey).toMatchObject({ hints: ['client-device'], attestation: 'none', rp: { name: 'Textor' } })
    // Nothing asks for a key: no PRF, no extension at all.
    expect(publicKey?.extensions).toBeUndefined()

    const id = bytesToB64url(fake.lastId() as Uint8Array)
    expect(presence).toEqual({ credentialId: id, authenticator: 'platform', transports: ['internal'] })
    const asked = (fake.get.mock.calls[0]?.[0] as CredentialRequestOptions).publicKey
    expect(asked).toMatchObject({ userVerification: 'required', hints: ['client-device'] })
    expect(asked?.extensions).toBeUndefined()
    expect(asked?.allowCredentials?.[0]?.transports).toEqual(['internal'])
    expect(bytesToB64url(new Uint8Array(asked?.allowCredentials?.[0]?.id as Uint8Array))).toBe(id)
  })

  it('asks a security key as one: cross-platform, and by the transports it said', async () => {
    const fake = webauthn()
    fake.create.mockImplementationOnce(async () =>
      created(randomBytes(16), { flags: VERIFIED, transports: ['usb', 'nfc', 'carrier-pigeon'] }),
    )
    const presence = await enrolBiometric('security-key')
    const { publicKey } = fake.create.mock.calls[0]?.[0] as CredentialCreationOptions
    expect(publicKey?.authenticatorSelection).toMatchObject({ authenticatorAttachment: 'cross-platform' })
    expect(publicKey).toMatchObject({ hints: ['security-key'] })
    // Only the transports WebAuthn knows are kept.
    expect(presence).toMatchObject({ authenticator: 'security-key', transports: ['usb', 'nfc'] })
    const asked = (fake.get.mock.calls[0]?.[0] as CredentialRequestOptions).publicKey
    expect(asked).toMatchObject({ hints: ['security-key'] })
    expect(asked?.allowCredentials?.[0]?.transports).toEqual(['usb', 'nfc'])
  })

  it('makes do where the browser shows neither the flags nor the transports', async () => {
    const fake = webauthn()
    fake.create.mockImplementationOnce(async () => created(randomBytes(16)))
    const presence = await enrolBiometric()
    expect(presence).not.toHaveProperty('transports')
    const asked = (fake.get.mock.calls[0]?.[0] as CredentialRequestOptions).publicKey
    expect(asked?.allowCredentials?.[0]).not.toHaveProperty('transports')
  })

  it('turns down a credential made without verifying anyone, and has it forgotten', async () => {
    const fake = webauthn()
    fake.create.mockImplementationOnce(async () => created(randomBytes(16), { flags: 0x41 }))
    await expect(enrolBiometric()).rejects.toEqual(refused('unverified'))
    expect(fake.get).not.toHaveBeenCalled()
    expect(fake.signal).toHaveBeenCalledOnce()
  })

  it('turns down one whose answer, like a synced Windows Hello passkey’s, comes back unverified', async () => {
    const fake = webauthn()
    fake.get.mockImplementationOnce(async () => credential(fake.lastId() as Uint8Array, 0x19))
    await expect(enrolBiometric()).rejects.toEqual(refused('unverified'))
    expect(fake.signal).toHaveBeenCalledWith({
      rpId: 'textor.test',
      credentialId: bytesToB64url(fake.lastId() as Uint8Array),
    })
  })

  it('says a dismissed first prompt was dismissed, and made nothing', async () => {
    const fake = webauthn()
    fake.create.mockRejectedValueOnce(new DOMException('no', 'NotAllowedError'))
    const error = await enrolBiometric().catch((err: unknown) => err)
    expect(error).toBeInstanceOf(GateCancelledError)
    expect((error as GateCancelledError).made).toBeUndefined()

    fake.create.mockResolvedValueOnce(null)
    await expect(enrolBiometric()).rejects.toThrow(GateCancelledError)
  })

  it('keeps the credential when only the confirming ask did not happen, however it was refused', async () => {
    const fake = webauthn()
    fake.get.mockRejectedValueOnce(new DOMException('timed out', 'AbortError'))
    const error = (await enrolBiometric().catch((err: unknown) => err)) as GateCancelledError
    expect(error).toBeInstanceOf(GateCancelledError)
    expect(error.made).toEqual({
      credentialId: bytesToB64url(fake.lastId() as Uint8Array),
      authenticator: 'platform',
      transports: ['internal'],
    })
    expect(fake.signal).not.toHaveBeenCalled()
    // Asked again, the same credential answers.
    expect((await confirmBiometric(error.made as Presence)).credentialId).toBe(error.made?.credentialId)
  })

  it('reports what the browser refused, with the reason behind it', async () => {
    const fake = webauthn()
    const cause = new DOMException('bad', 'SecurityError')
    fake.create.mockRejectedValueOnce(cause)
    const error = (await enrolBiometric().catch((err: unknown) => err)) as GateRefusedError
    expect(error).toEqual(refused('unavailable'))
    expect(error.cause).toBe(cause)

    fake.create.mockRejectedValueOnce(new TypeError('not a DOMException'))
    await expect(enrolBiometric()).rejects.toEqual(refused('unavailable'))
  })

  it('refuses where there is no WebAuthn to ask', async () => {
    vi.stubGlobal('navigator', {})
    await expect(enrolBiometric()).rejects.toEqual(refused('unavailable'))
    vi.stubGlobal('navigator', undefined)
    await expect(confirmBiometric({ credentialId: 'abc' })).rejects.toEqual(refused('unavailable'))
  })
})

describe('confirming the person', () => {
  const id = bytesToB64url(randomBytes(16))
  const credentialFor = (flags?: number) => credential(b64urlToBytes(id), flags)

  it('accepts a verified answer from the credential asked for, reached as it was made', async () => {
    const fake = webauthn()
    // A slot from before security keys: this device's own, no transports.
    expect(await confirmBiometric({ credentialId: id })).toEqual({
      credentialId: id,
      authenticator: 'platform',
    })
    expect((fake.get.mock.calls[0]?.[0] as CredentialRequestOptions).publicKey).toMatchObject({
      hints: ['client-device'],
    })
  })

  it('refuses an answer from another credential, or one that did not verify the person', async () => {
    const fake = webauthn()
    fake.get.mockResolvedValueOnce(credential(randomBytes(16), VERIFIED))
    await expect(confirmBiometric({ credentialId: id })).rejects.toEqual(refused('other'))

    // Present, not verified.
    fake.get.mockResolvedValueOnce(credentialFor(0x01))
    await expect(confirmBiometric({ credentialId: id })).rejects.toEqual(refused('unverified'))
    // No authenticator data at all, or too little of it.
    fake.get.mockResolvedValueOnce(credentialFor())
    await expect(confirmBiometric({ credentialId: id })).rejects.toEqual(refused('unverified'))
    fake.get.mockResolvedValueOnce({
      ...credentialFor(),
      response: { authenticatorData: new Uint8Array(10).buffer },
    })
    await expect(confirmBiometric({ credentialId: id })).rejects.toEqual(refused('unverified'))
  })

  it('reads the UV flag, and nothing else, from authenticator data', () => {
    expect(verified(authData(0x04).buffer as ArrayBuffer)).toBe(true)
    expect(verified(authData(0x1d).buffer as ArrayBuffer)).toBe(true)
    expect(verified(authData(0x19).buffer as ArrayBuffer)).toBe(false)
    expect(verified(undefined)).toBe(false)
    expect(hintsFor(undefined)).toEqual(['client-device'])
    expect(hintsFor('security-key')).toEqual(['security-key'])
  })
})

describe('a proof of presence', () => {
  const a = bytesToB64url(randomBytes(16))
  const b = bytesToB64url(randomBytes(16))

  it('is spent once, for its own credential, while fresh', async () => {
    webauthn()
    const presence = await confirmBiometric({ credentialId: a })
    expect(spendPresence(presence, a)).toBe(true)
    expect(spendPresence(presence, a)).toBe(false)

    expect(spendPresence(await confirmBiometric({ credentialId: a }), b)).toBe(false)
    const stale = await confirmBiometric({ credentialId: a })
    expect(spendPresence(stale, a, Date.now() + PRESENCE_TTL_MS)).toBe(false)
  })

  it('cannot be made anywhere but here, nor changed once made', async () => {
    const forged: Presence = Object.freeze({ credentialId: a, authenticator: 'platform' })
    expect(spendPresence(forged, a)).toBe(false)
    webauthn()
    const presence = await confirmBiometric({ credentialId: a, transports: ['internal'] })
    expect(Object.isFrozen(presence)).toBe(true)
    expect(Object.isFrozen(presence.transports)).toBe(true)
  })
})

describe('forgetting a credential', () => {
  it('asks the browser to drop it where it can, and quietly does nothing where it cannot', async () => {
    const fake = webauthn()
    forgetBiometric('cred-a')
    expect(fake.signal).toHaveBeenCalledWith({ rpId: 'textor.test', credentialId: 'cred-a' })

    fake.signal.mockRejectedValueOnce(new Error('unsupported'))
    forgetBiometric('cred-b')
    await Promise.resolve()

    webauthn({ statics: { signalUnknownCredential: undefined } })
    expect(() => forgetBiometric('cred-c')).not.toThrow()
    webauthn({ statics: null })
    expect(() => forgetBiometric('cred-d')).not.toThrow()
  })
})
