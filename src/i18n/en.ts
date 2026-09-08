export const en = {
  common: {
    next: 'Next',
    back: 'Back',
    cancel: 'Cancel',
    save: 'Save',
    done: 'Done',
    close: 'Close',
    copy: 'Copy',
    copied: 'Copied',
    remove: 'Remove',
    add: 'Add',
    confirm: 'Confirm',
    loading: 'Loading',
    search: 'Search',
    unknown: 'Unknown',
    show: 'Show',
    hide: 'Hide',
    working: 'Working',
  },

  onboarding: {
    eyebrow: 'End-to-end encrypted',
    welcomeTitle: 'Welcome to Textor',
    welcomeBody:
      'Textor is a messenger with no accounts and no servers we run. Your identity is a key that lives on this device, and your messages are encrypted before they ever leave it.',
    point1: 'No phone number, no email, no sign-up',
    point2: 'Messages are end-to-end encrypted; relays only ever see ciphertext',
    point3: 'Everything is stored encrypted on this device and nowhere else',
    createIdentity: 'Create a new identity',
    restoreIdentity: 'I already have one',

    nameTitle: 'What should people call you?',
    nameBody: 'This name is only shared with people you exchange invites with. It is not published anywhere.',
    namePlaceholder: 'Your display name',

    passphraseTitle: 'Protect this device',
    passphraseBody:
      'Your messages and keys are encrypted on this device with a passphrase. Nobody can reset it for you — not us, not anyone.',
    passphrase: 'Passphrase',
    passphraseConfirm: 'Confirm passphrase',
    passphraseHint: 'Use at least 10 characters. A few unrelated words works well.',
    passphraseMismatch: 'The two passphrases do not match',
    passphraseTooShort: 'Use at least 10 characters',
    passphraseStrength: 'Strength',
    strengthWeak: 'Weak',
    strengthFair: 'Fair',
    strengthGood: 'Good',
    strengthStrong: 'Strong',

    backupTitle: 'Write down your recovery phrase',
    backupBody:
      'These twelve words are the only way to restore your identity if you lose this device. Write them on paper. Anyone who reads them can read your messages.',
    backupReveal: 'Reveal the phrase',
    backupConfirm: 'I have written it down',
    verifyTitle: 'Confirm your recovery phrase',
    verifyBody: 'Enter word number {n} to confirm you saved it.',
    verifyWrong: 'That is not the right word',
    skipBackup: 'Skip for now',
    skipBackupWarning:
      'You can find the phrase later in Settings, but only while you can unlock this device.',

    creating: 'Creating your identity',

    restoreTitle: 'Restore your identity',
    restoreBody: 'Enter your twelve-word recovery phrase, or import an encrypted backup file.',
    restorePhrase: 'Recovery phrase',
    restorePhrasePlaceholder: 'twelve words separated by spaces',
    restoreInvalid: 'That does not look like a valid recovery phrase',
    restoreFromFile: 'Import a backup file instead',
    restoreFilePassphrase: 'Backup passphrase',
  },

  lock: {
    title: 'Textor is locked',
    body: 'Enter your passphrase to unlock this device.',
    unlock: 'Unlock',
    wrong: 'Wrong passphrase',
    unlocking: 'Unlocking',
    autoLocked: 'Locked automatically after a period of inactivity.',
    forgot: 'Forgotten your passphrase?',
    forgotBody:
      'There is no recovery. If you have your twelve-word phrase or an encrypted backup you can start over on this device; otherwise this vault cannot be opened.',
    startOver: 'Erase this device and start over',
    startOverConfirm:
      'This permanently deletes the identity, contacts, and messages stored on this device. This cannot be undone.',
  },

  nav: { chats: 'Chats', contacts: 'Contacts', settings: 'Settings' },

  chats: {
    title: 'Chats',
    empty: 'No conversations yet',
    emptyBody: 'Add a contact to start your first encrypted conversation.',
    addContact: 'Add a contact',
    requests: 'Message requests',
    requestsBody: 'People who messaged you but are not in your contacts.',
    draft: 'Draft',
    you: 'You: ',
    noMessages: 'No messages yet',
    searchPlaceholder: 'Search conversations',
  },

  chat: {
    placeholder: 'Write a message',
    send: 'Send',
    typing: 'typing…',
    today: 'Today',
    yesterday: 'Yesterday',
    reply: 'Reply',
    messageActions: 'Message actions',
    openContact: 'Open contact details for {name}',
    fromYou: 'You said',
    fromThem: '{name} said',
    replyingTo: 'Replying to',
    copyText: 'Copy text',
    deleteEveryone: 'Delete for everyone',
    deleteEveryoneConfirm:
      'Delete this message for both of you? Their device is asked to remove it, which cannot be guaranteed.',
    deleteEveryoneHint: 'Asks their device to delete it too. Cannot be guaranteed.',
    deleteLocal: 'Delete for me',
    deleteLocalHint: 'Removes it from this device only. It cannot be unsent.',
    retrySend: 'Retry sending',
    failed: 'Not delivered',
    verifyPromptBody: 'Compare safety numbers to be sure nobody is in the middle.',
    requestBanner: 'This person is not in your contacts.',
    accept: 'Accept',
    block: 'Block',
    blocked: 'You blocked this contact. They cannot reach you.',
    unblock: 'Unblock',
    loadEarlier: 'Load earlier messages',
    startOfConversation: 'This is the beginning of your conversation.',
    encryptedNote: 'Messages are end-to-end encrypted. Nobody else can read them.',
  },

  status: {
    queued: 'Queued',
    sending: 'Sending',
    sent: 'Sent',
    delivered: 'Delivered',
    read: 'Read',
    failed: 'Failed',
    direct: 'Direct connection',
    relayed: 'Sent via relays',
  },

  /*
   * Connection state. Two registers on purpose: `*Short` fits the header badge,
   * which is always on screen, while the long form goes in the status bar,
   * which only appears when there is something to say and can afford a sentence.
   */
  attachment: {
    play: 'Play',
    pause: 'Pause',
    seek: 'Seek within the voice note',
    transferring: 'Transferring',
    unavailable: 'This attachment could not be loaded',
    unplayable: 'This browser cannot play this audio format',
    openImage: 'Open image',
    save: 'Save',
    file: 'File',
    attach: 'Attach a file',
    recordStart: 'Record a voice note',
    recordStop: 'Send voice note',
    recordCancel: 'Discard recording',
    recording: 'Recording',
    tooLarge: 'That file is too large to send',
    needsDirect: 'A file this large needs a direct connection to {name}',
    captionVoice: 'Voice message',
    captionImage: 'Photo',
    captionVideo: 'Video',
    captionFile: 'File',
    micDenied: 'Microphone access was refused',
  },

  connection: {
    offline: 'Offline',
    offlineDetail: 'Offline — messages will send when you reconnect',
    connecting: 'Connecting…',
    connectingDetail: 'Reaching relays…',
    degraded: 'Relay trouble',
    degradedDetail: 'Connected, but no relay is carrying messages',
    sending: 'Sending {n}',
    sendingDetail: 'Sending {n} message(s)…',
    syncing: 'Updating',
    syncingDetail: 'Checking for new messages…',
    connected: 'Connected',
    relays: '{n} of {total} relays',
    openRelays: 'Open relay settings',
  },

  contacts: {
    title: 'Contacts',
    empty: 'No contacts yet',
    add: 'Add contact',
    addTitle: 'Add a contact',
    addBody: 'Exchange an invite in person or over any channel you already trust.',
    myInvite: 'My invite',
    myInviteBody: 'Show this to someone, or send them the link.',
    scan: 'Scan a QR code',
    scanBody: 'Point your camera at the other person’s invite code.',
    pasteInvite: 'Paste an invite or npub',
    pastePlaceholder: 'Invite link, npub…, or nostr address',
    invalidInvite: 'That is not a valid invite or key',
    alreadyAdded: 'This contact is already in your list',
    cannotAddSelf: 'That is your own key',
    added: 'Contact added',
    staleInvite: 'This invite is old. Its relay hints may be out of date.',
    nameLabel: 'Name',
    noteLabel: 'Note',
    noteHint: 'Only you can see this.',
    verified: 'Verified',
    unverified: 'Not verified',
    verify: 'Verify safety number',
    removeConfirm: 'Remove this contact? Your message history stays on this device.',
    blockConfirm: 'Block this contact? You will stop receiving their messages.',
    copyKey: 'Copy public key',
    cameraDenied: 'Camera access was refused. You can paste an invite instead.',
    cameraUnavailable: 'No camera is available on this device.',
  },

  verify: {
    title: 'Safety number',
    body: 'Compare these numbers with {name} in person or over a call you trust. If they match, nobody is intercepting your conversation.',
    markVerified: 'They match — mark as verified',
    markUnverified: 'Mark as not verified',
    verifiedAt: 'Verified on this device',
    mismatchTitle: 'If they do not match',
    mismatchBody:
      'Someone may have given you the wrong key. Do not send anything sensitive, and exchange invites again in person.',
  },

  settings: {
    title: 'Settings',
    profile: 'Profile',
    profileBody: 'Your name and picture are shared only with your contacts.',
    displayName: 'Display name',
    about: 'About',
    avatarChoose: 'Choose an image',
    avatarRemove: 'Remove picture',
    avatarTooLarge: 'Pick an image under 1 MB',

    appearance: 'Appearance',
    language: 'Language',
    theme: 'Theme',
    themeSystem: 'Match system',
    themeLight: 'Light',
    themeDark: 'Dark',
    displayControls: 'Language and appearance',
    enterToSend: 'Enter sends the message',

    security: 'Security',
    autoLock: 'Lock after inactivity',
    autoLockNever: 'Never',
    autoLockMinutes: '{n} minutes',
    lockOnHide: 'Lock when the app goes to the background',
    changePassphrase: 'Change passphrase',
    currentPassphrase: 'Current passphrase',
    newPassphrase: 'New passphrase',
    passphraseChanged: 'Passphrase changed',
    lockNow: 'Lock now',
    recoveryPhrase: 'Recovery phrase',
    recoveryPhraseBody: 'Anyone who sees these words controls your identity.',

    privacy: 'Privacy',
    readReceipts: 'Send read receipts',
    typingIndicators: 'Send typing indicators',
    directConnection: 'Use direct connections when possible',
    directConnectionBody:
      'Connects straight to your contact for faster delivery. Reveals your IP address to them, as any direct connection does.',
    notifications: 'Show notifications for new messages',
    notificationsBody:
      'Only while Textor is open in a tab — delivering notifications to a closed app would require a server we do not run. The notification shows who messaged you, never the message.',
    notificationsDenied: 'Your browser has blocked notifications for this site.',
    publicProfile: 'Publish a public profile',
    publicProfileBody:
      'Makes your name and picture readable by anyone on the relay network, linked to your key. Off by default.',
    retention: 'Keep message history',
    retentionForever: 'Forever',
    retentionDays: '{n} days',
    messageExpiry: 'Ask relays to delete messages after',
    messageExpiryBody: 'Relays that support expiration will drop your messages after this long. Not all do.',

    relays: 'Relays',
    relaysBody:
      'Relays are public servers that hold your encrypted messages until you fetch them. They cannot read anything. Add or remove any you like.',
    relayAdd: 'Add a relay',
    relayPlaceholder: 'wss://relay.example.com',
    relayInvalid: 'That is not a valid relay address',
    relayExists: 'That relay is already in your list',
    relayRemove: 'Remove relay',
    relayRead: 'Read',
    relayWrite: 'Write',
    relayResetDefaults: 'Restore default relays',
    relaySuggested: 'Suggested relays',
    relayHealthy: 'Healthy',
    relayDegraded: 'Unreliable',
    relayOffline: 'Not connecting',
    relayNever: 'Not used yet',
    relayCannotRead:
      'This relay requires sign-in to read your inbox, so it cannot deliver messages to you. Textor does not sign in to relays.',
    relayLatency: '{n} ms',
    relayStats: '{ok} delivered / {fail} failed',
    noRelaysWarning: 'You have no active relays. Messages cannot be sent or received.',

    data: 'Data',
    storagePersisted: 'This browser has promised to keep your data',
    storageNotPersisted: 'This browser may delete your data',
    storageNotPersistedBody:
      'Browsers can clear website storage to reclaim space, and Safari does so after about a week without visits. There is no server copy to restore from, so keep an encrypted backup and your recovery phrase.',
    storageUsage: '{used} of {quota} used',
    exportBackup: 'Export an encrypted backup',
    exportBackupBody:
      'A single encrypted file with your identity, contacts, and history. Use it to move to another device.',
    exportPassphrase: 'Backup passphrase',
    exportIncludeMessages: 'Include message history',
    exportCreate: 'Create backup',
    exportReady: 'Backup ready',
    importBackup: 'Import a backup',
    importChoose: 'Choose a backup file',
    importDone: 'Imported {messages} messages and {contacts} contacts',
    storageUsed: '{messages} messages, {contacts} contacts',
    deleteEverything: 'Delete everything on this device',
    deleteEverythingBody:
      'Erases your identity, contacts, and messages from this browser. Without your recovery phrase or a backup this cannot be undone.',
    deleteEverythingConfirm: 'Type DELETE to confirm',

    aboutSection: 'About',
    version: 'Version',
    sourceCode: 'Source code',
    whatLeaves: 'What leaves your device',
    licence: 'Licence',
  },

  privacy: {
    title: 'What leaves your device',
    intro:
      'Textor is a static web page. There is no Textor server, no account database, and no analytics. Here is precisely what goes out over the network, and what each party can see.',
    relaysTitle: 'To relays you choose',
    relaysBody:
      'Encrypted, gift-wrapped messages addressed to your contact. Every message is signed by a throwaway key, so a relay cannot tell who sent it — only who it is for. Timestamps are randomised by up to two days.',
    relaysSee:
      'A relay can see: that someone sent a message to a given public key, at a fuzzy time, and the size class of the ciphertext.',
    relaysCannot: 'A relay cannot see: the message text, who sent it, your name, or your contact list.',
    hostTitle: 'To the web host',
    hostBody:
      'Only requests for the app files themselves, the first time you visit or after an update. Invite links keep their payload in the URL fragment, which browsers never send to a server.',
    directTitle: 'To your contacts',
    directBody:
      'If a direct connection succeeds, your contact learns your IP address — the same as any peer-to-peer call. Turn direct connections off in Settings to always route through relays.',
    stunTitle: 'To STUN servers',
    stunBody:
      'When setting up a direct connection, your browser asks a public STUN server for your externally visible address. It learns your IP and nothing else.',
    deviceTitle: 'On this device',
    deviceBody:
      'Your keys, contacts, and messages are stored in your browser, encrypted with your passphrase. Index keys are blinded, so even the database structure does not reveal who you talk to.',
    limitsTitle: 'Known limits',
    limitsForwardSecrecy:
      'No forward secrecy yet: if your key is stolen, an attacker who also kept copies of old ciphertexts could read them. Messages are asked to expire from relays after 30 days.',
    limitsMetadata:
      'Your relay set is visible to your network provider, and the fact that a public key is fetching mail is visible to relays.',
    limitsNoPush:
      'No push notifications. Delivering them would need a server we do not run, so new messages arrive when the app is open.',
    limitsXss:
      'A cross-site scripting flaw in this app would defeat all of the above. There is no inline script, no eval, no third-party code, and a strict Content-Security-Policy.',
  },

  errors: {
    generic: 'Something went wrong',
    storageBlocked:
      'This browser is blocking local storage, which Textor needs to keep your vault. Private browsing sometimes causes this.',
    unsupported: 'This browser is missing features Textor needs',
  },

  update: { available: 'A new version is ready', reload: 'Reload' },
}

/**
 * The shape every locale must fill in. Deliberately not `as const`: literal
 * types would make each translation "not assignable" to the English original.
 * Missing or misspelled keys are still compile errors.
 */
export type Dictionary = typeof en
