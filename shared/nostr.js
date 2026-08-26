/**
 * Nostr Utilities
 * Keypair generation, bech32 encoding, and event signing
 * Implements NIP-01 (basic protocol) and NIP-19 (bech32 encoding)
 *
 * Requires: nostr-tools library (lib/nostr-tools.min.js)
 */

function buildWalletSnapshotParentTags(parents) {
    const normalizedParents = Array.isArray(parents) ? parents : [];
    if (normalizedParents.length === 0) {
        return [
            ['parent_snapshot_id', ''],
            ['parent_content_hash', ''],
        ];
    }

    return normalizedParents.flatMap((parent) => ([
        ['parent_snapshot_id', parent?.snapshotId || parent?.snapshot_id || ''],
        ['parent_content_hash', parent?.contentHash || parent?.content_hash || ''],
    ]));
}

const NostrUtils = {
    // Bech32 charset
    BECH32_CHARSET: 'qpzry9x8gf2tvdw0s3jn54khce6mua7l',

    /**
     * Generate a new Nostr keypair using nostr-tools
     * Returns {privateKey: hex, publicKey: hex}
     */
    async generateKeypair() {
        // Use nostr-tools to generate a proper secp256k1 keypair
        if (typeof NostrTools !== 'undefined') {
            const privateKey = NostrTools.generateSecretKey();
            const publicKey = NostrTools.getPublicKey(privateKey);
            return {
                privateKey: this.bytesToHex(privateKey),
                publicKey: publicKey
            };
        }

        // Fallback for when nostr-tools is not loaded
        console.warn('NostrTools not loaded - using fallback key generation');
        const privateKeyBytes = crypto.getRandomValues(new Uint8Array(32));
        const privateKeyHex = this.bytesToHex(privateKeyBytes);
        const publicKeyHex = await this.derivePublicKey(privateKeyBytes);

        return {
            privateKey: privateKeyHex,
            publicKey: publicKeyHex
        };
    },

    /**
     * Derive public key from private key
     * Uses nostr-tools if available
     */
    async derivePublicKey(privateKeyBytes) {
        // If nostr-tools is loaded, use it
        if (typeof NostrTools !== 'undefined' && NostrTools.getPublicKey) {
            // NostrTools.getPublicKey expects Uint8Array or hex string
            if (privateKeyBytes instanceof Uint8Array) {
                return NostrTools.getPublicKey(privateKeyBytes);
            }
            return NostrTools.getPublicKey(this.hexToBytes(privateKeyBytes));
        }

        // Fallback: This should not be used in production
        console.warn('NostrTools not loaded - public key derivation may be incorrect');
        const hashBuffer = await crypto.subtle.digest('SHA-256', privateKeyBytes);
        return this.bytesToHex(new Uint8Array(hashBuffer));
    },

    /**
     * Encode public key as npub (NIP-19)
     */
    encodeNpub(publicKeyHex) {
        const bytes = this.hexToBytes(publicKeyHex);
        return this.bech32Encode('npub', bytes);
    },

    /**
     * Encode private key as nsec (NIP-19)
     */
    encodeNsec(privateKeyHex) {
        const bytes = this.hexToBytes(privateKeyHex);
        return this.bech32Encode('nsec', bytes);
    },

    /**
     * Decode npub to hex public key
     */
    decodeNpub(npub) {
        if (!npub.startsWith('npub1')) {
            throw new Error('Invalid npub format');
        }
        const { hrp, data } = this.bech32Decode(npub);
        if (hrp !== 'npub') {
            throw new Error('Invalid npub prefix');
        }
        return this.bytesToHex(data);
    },

    /**
     * Decode nsec to hex private key
     */
    decodeNsec(nsec) {
        if (!nsec.startsWith('nsec1')) {
            throw new Error('Invalid nsec format');
        }
        const { hrp, data } = this.bech32Decode(nsec);
        if (hrp !== 'nsec') {
            throw new Error('Invalid nsec prefix');
        }
        return this.bytesToHex(data);
    },

    /**
     * Validate npub format
     */
    isValidNpub(npub) {
        try {
            this.decodeNpub(npub);
            return true;
        } catch {
            return false;
        }
    },

    /**
     * Validate nsec format
     */
    isValidNsec(nsec) {
        try {
            this.decodeNsec(nsec);
            return true;
        } catch {
            return false;
        }
    },

    /**
     * Create unsigned Nostr event (NIP-01)
     */
    createEvent(kind, content, tags = [], pubkey) {
        const event = {
            kind: kind,
            created_at: Math.floor(Date.now() / 1000),
            tags: tags,
            content: content,
            pubkey: pubkey
        };
        return event;
    },

    /**
     * Calculate event ID (SHA256 of serialized event)
     */
    async calculateEventId(event) {
        const serialized = JSON.stringify([
            0,
            event.pubkey,
            event.created_at,
            event.kind,
            event.tags,
            event.content
        ]);
        const encoder = new TextEncoder();
        const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(serialized));
        return this.bytesToHex(new Uint8Array(hashBuffer));
    },

    /**
     * Sign event with private key
     * Returns signed event with id and sig fields
     */
    async signEvent(event, privateKeyHex) {
        // Calculate event ID
        const id = await this.calculateEventId(event);
        event.id = id;

        // Sign with nostr-tools if available
        if (typeof NostrTools !== 'undefined') {
            // NostrTools.finalizeEvent signs and adds id/sig
            // But we've already calculated the id, so just get the signature
            const privateKeyBytes = this.hexToBytes(privateKeyHex);
            const signedEvent = NostrTools.finalizeEvent(event, privateKeyBytes);
            event.sig = signedEvent.sig;
            event.id = signedEvent.id; // Use nostr-tools calculated id for consistency
        } else {
            // Placeholder - actual signing requires secp256k1
            console.warn('NostrTools not loaded - event signing not available');
            event.sig = '';
        }

        return event;
    },

    /**
     * Create and sign an authentication event for Gateway
     * Kind 22242 is used for NIP-42 AUTH
     */
    async createAuthEvent(privateKeyHex, publicKeyHex, challenge = null) {
        const event = this.createEvent(
            22242, // AUTH event kind
            challenge || '',
            [['challenge', challenge || Date.now().toString()]],
            publicKeyHex
        );
        return this.signEvent(event, privateKeyHex);
    },

    /**
     * Create and sign a profile metadata event (NIP-01 kind-0)
     * @param {string} publicKeyHex - User's public key (hex)
     * @param {string} privateKeyHex - User's private key (hex), null for bunker signing
     * @param {Object} profile - Profile metadata {name, about, picture, nip05, lud16, banner, website}
     * @returns {Object} - Signed kind-0 event
     */
    async createProfileEvent(publicKeyHex, privateKeyHex, profile) {
        const content = JSON.stringify(profile);
        const event = this.createEvent(0, content, [], publicKeyHex);
        return this.signEventWithBunkerOrLocal(event, privateKeyHex);
    },

    /**
     * Create and sign a merchant profile event (NIP-78 kind-30078)
     * @param {string} publicKeyHex - User's public key (hex)
     * @param {string} privateKeyHex - User's private key (hex), null for bunker signing
     * @param {Object} merchantProfile - Merchant profile data
     * @returns {Object} - Signed kind-30078 event
     */
    async createMerchantProfileEvent(publicKeyHex, privateKeyHex, merchantProfile) {
        const content = JSON.stringify(merchantProfile);
        const tags = [['d', 'imani:merchant']];
        const event = this.createEvent(30078, content, tags, publicKeyHex);
        return this.signEventWithBunkerOrLocal(event, privateKeyHex);
    },

    /**
     * Create and sign a settings event (NIP-78 kind-30078)
     * Used for cross-device settings sync
     * Content is encrypted with NIP-04 for privacy
     * @param {string} publicKeyHex - User's public key (hex)
     * @param {string} privateKeyHex - User's private key (hex), null for bunker signing
     * @param {Object} settings - User settings object
     * @returns {Object} - Signed kind-30078 event
     */
    async createSettingsEvent(publicKeyHex, privateKeyHex, settings) {
        const plaintext = JSON.stringify(settings);

        // Encrypt with NIP-04 (self-encryption)
        let content;
        if (privateKeyHex && window.NostrTools && window.NostrTools.nip04) {
            const privKeyBytes = this.hexToBytes(privateKeyHex);
            content = await window.NostrTools.nip04.encrypt(privKeyBytes, publicKeyHex, plaintext);
        } else {
            // Fallback to unencrypted (legacy compatibility)
            console.warn('[nostr] Settings stored unencrypted - no encryption method available');
            content = plaintext;
        }

        const tags = [['d', 'imani:settings']];
        const event = this.createEvent(30078, content, tags, publicKeyHex);
        return this.signEventWithBunkerOrLocal(event, privateKeyHex);
    },

    /**
     * Create and sign an LNbits backup event (NIP-78 kind-30078)
     * Used for cross-device LNbits credential backup
     * Content is encrypted with NIP-04 for privacy
     * @param {string} publicKeyHex - User's public key (hex)
     * @param {string} privateKeyHex - User's private key (hex), null for bunker signing
     * @param {Object} lnbitsData - LNbits data object (encryptedCredentials, walletId)
     * @returns {Object} - Signed kind-30078 event
     */
    async createLnbitsBackupEvent(publicKeyHex, privateKeyHex, lnbitsData) {
        const plaintext = JSON.stringify(lnbitsData);

        // Encrypt with NIP-04 (self-encryption)
        let content;
        if (privateKeyHex && window.NostrTools && window.NostrTools.nip04) {
            const privKeyBytes = this.hexToBytes(privateKeyHex);
            content = await window.NostrTools.nip04.encrypt(privKeyBytes, publicKeyHex, plaintext);
        } else {
            console.warn('[nostr] LNbits backup stored unencrypted - no encryption method available');
            content = plaintext;
        }

        const tags = [['d', 'imani:lnbits']];
        const event = this.createEvent(30078, content, tags, publicKeyHex);
        return this.signEventWithBunkerOrLocal(event, privateKeyHex);
    },

    /**
     * Create and sign an offline-transactions backup event (NIP-78 kind-30078)
     * Content is encrypted with NIP-44 for privacy (self-encryption)
     * @param {string} publicKeyHex - User's public key (hex)
     * @param {string} privateKeyHex - User's private key (hex), null for bunker signing
     * @param {Array} transactions - Offline transaction array
     * @returns {Object} - Signed kind-30078 event
     */
    async createOfflineTxEvent(publicKeyHex, privateKeyHex, transactions) {
        const plaintext = JSON.stringify(transactions);

        // Encrypt with NIP-44 (self-encryption)
        let content;
        if (privateKeyHex && window.NostrTools && window.NostrTools.nip44) {
            const privKeyBytes = this.hexToBytes(privateKeyHex);
            const conversationKey = window.NostrTools.nip44.v2.utils.getConversationKey(privKeyBytes, publicKeyHex);
            content = window.NostrTools.nip44.v2.encrypt(plaintext, conversationKey);
        } else {
            console.warn('[nostr] Offline tx stored unencrypted - no NIP-44 available');
            content = plaintext;
        }

        const tags = [['d', 'imani:offline-transactions']];
        const event = this.createEvent(30078, content, tags, publicKeyHex);
        return this.signEventWithBunkerOrLocal(event, privateKeyHex);
    },

    /**
     * Create and sign a paid-vreqs backup event (NIP-78 kind-30078)
     * Content is encrypted with NIP-44 for privacy (self-encryption)
     * @param {string} publicKeyHex - User's public key (hex)
     * @param {string} privateKeyHex - User's private key (hex), null for bunker signing
     * @param {Object} paidVreqs - Map of paymentId → details
     * @returns {Object} - Signed kind-30078 event
     */
    async createPaidVreqsEvent(publicKeyHex, privateKeyHex, paidVreqs) {
        const plaintext = JSON.stringify(paidVreqs);

        let content;
        if (privateKeyHex && window.NostrTools && window.NostrTools.nip44) {
            const privKeyBytes = this.hexToBytes(privateKeyHex);
            const conversationKey = window.NostrTools.nip44.v2.utils.getConversationKey(privKeyBytes, publicKeyHex);
            content = window.NostrTools.nip44.v2.encrypt(plaintext, conversationKey);
        } else {
            console.warn('[nostr] Paid vreqs stored unencrypted - no NIP-44 available');
            content = plaintext;
        }

        const tags = [['d', 'imani:paid-vreqs']];
        const event = this.createEvent(30078, content, tags, publicKeyHex);
        return this.signEventWithBunkerOrLocal(event, privateKeyHex);
    },

    /**
     * Create and sign a payment-requests backup event (NIP-78 kind-30078)
     * Content is encrypted with NIP-44 for privacy (self-encryption)
     * @param {string} publicKeyHex - User's public key (hex)
     * @param {string} privateKeyHex - User's private key (hex), null for bunker signing
     * @param {Array} requests - Payment request array
     * @returns {Object} - Signed kind-30078 event
     */
    async createPaymentRequestsEvent(publicKeyHex, privateKeyHex, requests) {
        const plaintext = JSON.stringify(requests);

        let content;
        if (privateKeyHex && window.NostrTools && window.NostrTools.nip44) {
            const privKeyBytes = this.hexToBytes(privateKeyHex);
            const conversationKey = window.NostrTools.nip44.v2.utils.getConversationKey(privKeyBytes, publicKeyHex);
            content = window.NostrTools.nip44.v2.encrypt(plaintext, conversationKey);
        } else {
            console.warn('[nostr] Payment requests stored unencrypted - no NIP-44 available');
            content = plaintext;
        }

        const tags = [['d', 'imani:payment-requests']];
        const event = this.createEvent(30078, content, tags, publicKeyHex);
        return this.signEventWithBunkerOrLocal(event, privateKeyHex);
    },

    /**
     * Create and sign a contact list event (NIP-02 kind-3)
     * This event contains the list of pubkeys the user follows
     * @param {string} publicKeyHex - User's public key (hex)
     * @param {string} privateKeyHex - User's private key (hex), null for bunker signing
     * @param {Array<string>} contacts - Array of pubkey hex strings to follow
     * @returns {Object} - Signed kind-3 event
     */
    async createContactListEvent(publicKeyHex, privateKeyHex, contacts) {
        // Create 'p' tags for each contact
        // Format: ['p', <pubkey-hex>, <relay-url-optional>, <petname-optional>]
        const tags = contacts.map(pubkey => ['p', pubkey]);

        // Kind-3 content is typically empty or contains relay recommendations
        const event = this.createEvent(3, '', tags, publicKeyHex);
        return this.signEventWithBunkerOrLocal(event, privateKeyHex);
    },

    /**
     * Create and sign a NIP-98 HTTP Auth event
     * Kind 27235 is used for HTTP request authentication
     * @see https://github.com/nostr-protocol/nips/blob/master/98.md
     *
     * @param {string} url - Full request URL
     * @param {string} method - HTTP method (GET, POST, PUT, DELETE, etc.)
     * @param {string} publicKeyHex - User's public key (hex)
     * @param {string} privateKeyHex - User's private key (hex), null for bunker signing
     * @param {string} payloadHash - Optional SHA256 hash of request body
     * @returns {Object} - Signed NIP-98 event
     */
    async createNip98AuthEvent(url, method, publicKeyHex, privateKeyHex = null, payloadHash = null) {
        const tags = [
            ['u', url],
            ['method', method.toUpperCase()]
        ];
        const nonce = globalThis.crypto?.randomUUID
            ? globalThis.crypto.randomUUID()
            : Array.from(globalThis.crypto?.getRandomValues(new Uint8Array(16)) ?? []).map(b => b.toString(16).padStart(2, '0')).join('');
        tags.push(['nonce', nonce]);

        // Add payload hash if provided (for POST/PUT with body)
        if (payloadHash) {
            tags.push(['payload', payloadHash]);
        }

        const event = this.createEvent(
            27235, // NIP-98 HTTP Auth kind
            '',
            tags,
            publicKeyHex
        );

        return this.signEventWithBunkerOrLocal(event, privateKeyHex);
    },

    /**
     * Create NIP-98 Authorization header value
     * @param {string} url - Full request URL
     * @param {string} method - HTTP method
     * @param {string} publicKeyHex - User's public key
     * @param {string} privateKeyHex - User's private key (null for bunker)
     * @param {string} body - Optional request body (will be hashed)
     * @returns {string} - Authorization header value: "Nostr <base64-event>"
     */
    async createNip98AuthHeader(url, method, publicKeyHex, privateKeyHex = null, body = null) {
        let payloadHash = null;

        // Hash the body for write methods (POST/PUT/PATCH/DELETE) — required by NIP-98
        const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase());
        if (body || isWrite) {
            const encoder = new TextEncoder();
            const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(body || ''));
            payloadHash = this.bytesToHex(new Uint8Array(hashBuffer));
        }

        const signedEvent = await this.createNip98AuthEvent(url, method, publicKeyHex, privateKeyHex, payloadHash);

        // Base64 encode the JSON event
        const eventJson = JSON.stringify(signedEvent);
        const base64Event = btoa(eventJson);

        return `Nostr ${base64Event}`;
    },

    // ==================== Bech32 Encoding ====================

    /**
     * Bech32 encode data with human-readable prefix
     */
    bech32Encode(hrp, data) {
        const converted = this.convertBits(data, 8, 5, true);
        const checksum = this.bech32Checksum(hrp, converted);
        const combined = [...converted, ...checksum];
        return hrp + '1' + combined.map(d => this.BECH32_CHARSET[d]).join('');
    },

    /**
     * Bech32 decode to get hrp and data
     */
    bech32Decode(str) {
        const lowered = str.toLowerCase();
        const pos = lowered.lastIndexOf('1');
        if (pos < 1 || pos + 7 > lowered.length) {
            throw new Error('Invalid bech32 string');
        }

        const hrp = lowered.slice(0, pos);
        const dataChars = lowered.slice(pos + 1);

        const data = [];
        for (const char of dataChars) {
            const idx = this.BECH32_CHARSET.indexOf(char);
            if (idx === -1) {
                throw new Error('Invalid bech32 character');
            }
            data.push(idx);
        }

        // Verify checksum
        if (!this.bech32VerifyChecksum(hrp, data)) {
            throw new Error('Invalid bech32 checksum');
        }

        // Remove checksum (last 6 bytes)
        const payload = data.slice(0, -6);
        const converted = this.convertBits(payload, 5, 8, false);

        return { hrp, data: new Uint8Array(converted) };
    },

    /**
     * Convert bits between bases
     */
    convertBits(data, fromBits, toBits, pad) {
        let acc = 0;
        let bits = 0;
        const result = [];
        const maxv = (1 << toBits) - 1;

        for (const value of data) {
            acc = (acc << fromBits) | value;
            bits += fromBits;
            while (bits >= toBits) {
                bits -= toBits;
                result.push((acc >> bits) & maxv);
            }
        }

        if (pad) {
            if (bits > 0) {
                result.push((acc << (toBits - bits)) & maxv);
            }
        } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
            throw new Error('Invalid padding');
        }

        return result;
    },

    /**
     * Calculate bech32 checksum
     */
    bech32Checksum(hrp, data) {
        const values = this.bech32HrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
        const polymod = this.bech32Polymod(values) ^ 1;
        const checksum = [];
        for (let i = 0; i < 6; i++) {
            checksum.push((polymod >> (5 * (5 - i))) & 31);
        }
        return checksum;
    },

    /**
     * Verify bech32 checksum
     */
    bech32VerifyChecksum(hrp, data) {
        return this.bech32Polymod(this.bech32HrpExpand(hrp).concat(data)) === 1;
    },

    /**
     * Expand human-readable part for checksum
     */
    bech32HrpExpand(hrp) {
        const result = [];
        for (const char of hrp) {
            result.push(char.charCodeAt(0) >> 5);
        }
        result.push(0);
        for (const char of hrp) {
            result.push(char.charCodeAt(0) & 31);
        }
        return result;
    },

    /**
     * Bech32 polymod calculation
     */
    bech32Polymod(values) {
        const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
        let chk = 1;
        for (const value of values) {
            const top = chk >> 25;
            chk = ((chk & 0x1ffffff) << 5) ^ value;
            for (let i = 0; i < 5; i++) {
                if ((top >> i) & 1) {
                    chk ^= GEN[i];
                }
            }
        }
        return chk;
    },

    // ==================== Utility Functions ====================

    /**
     * Convert hex string to Uint8Array
     * @param {string} hex - Hex string to convert
     * @returns {Uint8Array} - Byte array
     * @throws {Error} - If input is not a valid hex string
     */
    hexToBytes(hex) {
        if (typeof hex !== 'string') {
            console.error('[nostr] hexToBytes: input is not a string, got:', typeof hex);
            throw new Error('hexToBytes input must be a string');
        }
        if (hex.length === 0) {
            return new Uint8Array(0);
        }
        if (hex.length % 2 !== 0) {
            console.error('[nostr] hexToBytes: hex string has odd length:', hex.length);
            throw new Error('hexToBytes input must have even length');
        }
        if (!/^[0-9a-fA-F]+$/.test(hex)) {
            console.error('[nostr] hexToBytes: invalid hex characters in input');
            throw new Error('hexToBytes input contains invalid hex characters');
        }
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < hex.length; i += 2) {
            bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
        }
        return bytes;
    },

    /**
     * Convert Uint8Array to hex string
     */
    bytesToHex(bytes) {
        return Array.from(bytes)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    },

    /**
     * Truncate npub/nsec for display
     */
    truncateKey(key, chars = 8) {
        if (key.length <= chars * 2 + 3) return key;
        return key.slice(0, chars) + '...' + key.slice(-chars);
    },

    // ==================== Bunker Integration ====================

    /**
     * Sign event using local key or bunker
     * Prefers local signing when private key is available
     * @param {Object} event - Unsigned event
     * @param {string} privateKeyHex - Private key (null for bunker signing)
     * @returns {Object} - Signed event
     */
    async signEventWithBunkerOrLocal(event, privateKeyHex = null) {
        // Local signing with private key
        if (privateKeyHex) {
            return this.signEvent(event, privateKeyHex);
        }

        throw new Error('No signing method available: no private key provided');
    },

    /**
     * Create and sign auth event using appropriate method
     * @param {string} privateKeyHex - Private key (null for bunker)
     * @param {string} publicKeyHex - Public key
     * @param {string} challenge - Optional challenge
     * @returns {Object} - Signed auth event
     */
    async createAuthEventAuto(privateKeyHex, publicKeyHex, challenge = null) {
        const event = this.createEvent(
            22242,
            challenge || '',
            [['challenge', challenge || Date.now().toString()]],
            publicKeyHex
        );

        return this.signEventWithBunkerOrLocal(event, privateKeyHex);
    },

    /**
     * Connect to bunker and prepare for signing
     * @param {string} password - User's password to decrypt bunker data
     * @deprecated No longer uses bunker
     */
    async connectBunkerIfNeeded(password) {
        return false;
    },

    // ==================== NIP-42 Authenticated Connection ====================

    /**
     * Current auth credentials for NIP-42 authenticated queries
     * Set via setAuthCredentials() before making queries to auth-required relays
     * Now also syncs with NostrAppStorage.Nip42Auth if available
     */
    _authCredentials: null,

    /**
     * Set auth credentials for NIP-42 authenticated relay queries
     * @param {string} privateKeyHex - Private key for signing AUTH events
     * @param {string} publicKeyHex - Public key for AUTH events
     */
    setAuthCredentials(privateKeyHex, publicKeyHex) {
        this._authCredentials = { privateKeyHex, publicKeyHex };

        // Sync with nostr-app-storage library if available
        if (typeof NostrAppStorage !== 'undefined' && NostrAppStorage.Nip42Auth) {
            if (privateKeyHex) {
                NostrAppStorage.Nip42Auth.setCredentials({
                    pubkey: publicKeyHex,
                    privateKey: privateKeyHex
                });
            } else {
                NostrAppStorage.Nip42Auth.setCredentials({ pubkey: publicKeyHex });
            }
        }

        console.log('[nostr] Auth credentials set for NIP-42');
    },

    /**
     * Clear auth credentials
     */
    clearAuthCredentials() {
        this._authCredentials = null;

        // Clear from nostr-app-storage library if available
        if (typeof NostrAppStorage !== 'undefined' && NostrAppStorage.Nip42Auth) {
            NostrAppStorage.Nip42Auth.clearCredentials();
        }

        console.log('[nostr] Auth credentials cleared');
    },

    /**
     * Sign an AUTH event using local key
     * @param {Object} authEvent - Unsigned AUTH event
     * @returns {Promise<Object>} - Signed AUTH event
     */
    async _signAuthEvent(authEvent) {
        // Local signing with private key
        if (this._authCredentials?.privateKeyHex) {
            return await this.signEvent(authEvent, this._authCredentials.privateKeyHex);
        }

        throw new Error('No signing method available for NIP-42 AUTH');
    },

    /**
     * Create an authenticated WebSocket connection with NIP-42 support
     * Handles AUTH challenge/response before allowing queries
     * @param {string} relayUrl - Relay URL
     * @param {Function} onReady - Called when connection is ready for queries (ws passed as arg)
     * @param {Function} onMessage - Called for each message (msg array passed as arg)
     * @param {Function} onError - Called on error
     * @param {number} timeout - Connection timeout in ms
     * @returns {Object} - { ws, cleanup }
     */
    createAuthenticatedConnection(relayUrl, onReady, onMessage, onError, timeout = 5000) {
        const self = this;
        let ws = null;
        let timeoutId = null;
        let authenticated = false;
        let authPending = false;
        let pendingQueries = [];
        let closed = false;

        const cleanup = () => {
            closed = true;
            if (timeoutId) clearTimeout(timeoutId);
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
        };

        timeoutId = setTimeout(() => {
            if (!closed) {
                console.log(`[nostr] Connection timeout (relay: ${relayUrl})`);
                cleanup();
                onError(new Error('Connection timeout'));
            }
        }, timeout);

        const handleAuth = async (challenge) => {
            // Check if we have credentials available
            const hasLocalKey = self._authCredentials?.privateKeyHex;
            const hasPubkey = self._authCredentials?.publicKeyHex;

            if (!hasPubkey || !hasLocalKey) {
                console.warn('[nostr] NIP-42 auth required but no credentials available');
                // Fail immediately - relay requires auth we can't provide
                cleanup();
                onError(new Error('Authentication required but no credentials available'));
                return;
            }

            try {
                authPending = true;
                console.log('[nostr] Handling NIP-42 auth challenge');

                // Create NIP-42 AUTH event (kind 22242)
                const authEvent = {
                    kind: 22242,
                    pubkey: hasPubkey,
                    created_at: Math.floor(Date.now() / 1000),
                    tags: [
                        ['relay', relayUrl],
                        ['challenge', challenge]
                    ],
                    content: ''
                };

                // Sign the auth event using local key
                const signedAuth = await self._signAuthEvent(authEvent);

                // Send AUTH response
                ws.send(JSON.stringify(['AUTH', signedAuth]));
                console.log('[nostr] Sent NIP-42 AUTH response');
            } catch (error) {
                console.error('[nostr] NIP-42 auth failed:', error);
                authPending = false;
                cleanup();
                onError(error);
            }
        };

        try {
            ws = new WebSocket(relayUrl);

            ws.onopen = () => {
                // Wait briefly for potential AUTH challenge before proceeding
                setTimeout(() => {
                    if (!authenticated && !authPending && !closed) {
                        // No AUTH challenge received, proceed directly
                        authenticated = true;
                        onReady(ws);
                    }
                }, 200);
            };

            ws.onmessage = async (event) => {
                try {
                    const msg = JSON.parse(event.data);

                    if (msg[0] === 'AUTH') {
                        // NIP-42: Relay is requesting authentication
                        await handleAuth(msg[1]);
                    } else if (msg[0] === 'OK' && authPending) {
                        // This is likely AUTH OK response
                        const success = msg[2];
                        const message = msg[3] || '';

                        if (success) {
                            console.log('[nostr] NIP-42 auth successful');
                            authenticated = true;
                            authPending = false;
                            // Clear timeout and set new one for query
                            if (timeoutId) clearTimeout(timeoutId);
                            timeoutId = setTimeout(() => {
                                if (!closed) {
                                    console.log(`[nostr] Query timeout after auth (relay: ${relayUrl})`);
                                    cleanup();
                                    onError(new Error('Query timeout'));
                                }
                            }, timeout);
                            onReady(ws);
                        } else {
                            console.warn('[nostr] NIP-42 auth rejected:', message);
                            authPending = false;
                            cleanup();
                            onError(new Error('Auth rejected: ' + message));
                        }
                    } else {
                        // Pass other messages to handler
                        onMessage(msg);
                    }
                } catch (e) {
                    console.error('[nostr] Error parsing relay message:', e);
                }
            };

            ws.onerror = (error) => {
                console.error(`[nostr] WebSocket error on ${relayUrl}:`, error);
                cleanup();
                onError(error);
            };

            ws.onclose = (event) => {
                if (!closed) {
                    console.log(`[nostr] WebSocket closed (code: ${event.code})`);
                    cleanup();
                    onError(new Error('Connection closed'));
                }
            };

        } catch (error) {
            cleanup();
            onError(error);
        }

        return { ws, cleanup };
    },

    // ==================== Relay Queries ====================

    // Relay URLs are read lazily from GatewayConfig so they reflect the
    // env-backed /api/v1/config response as soon as it resolves — never
    // hardcode a domain here; the app may run on any host.

    /** Default relay URL (read live from GatewayConfig). */
    get DEFAULT_RELAY() { return GatewayConfig.relayUrl; },

    /** DM relay URL (bypasses NIP-42 auth proxy for DM polling). */
    get DM_RELAY() { return GatewayConfig.relayUrl; },

    /** Fallback relay URLs when primary fails. */
    get FALLBACK_RELAYS() { return [GatewayConfig.relayUrl]; },

    /**
     * No-op retained for backwards compat. Relay URLs now read lazily
     * from GatewayConfig, so an explicit update is no longer needed.
     */
    updateFromConfig(_config) { /* no-op */ },

    /**
     * Execute a relay query with retry logic and fallback relays
     * @param {Function} queryFn - Function that takes (relayUrl) and returns a Promise
     * @param {string} primaryRelay - Primary relay URL
     * @param {Object} options - Options: maxRetries, retryDelay, useFallbacks
     * @returns {Promise<any>} - Result from the query
     */
    async withRetry(queryFn, primaryRelay = null, options = {}) {
        const {
            maxRetries = 2,
            retryDelay = 1000,
            useFallbacks = true
        } = options;

        // Use DM_RELAY by default for authenticated connections
        const relay = primaryRelay || this.DM_RELAY;
        const relaysToTry = [relay];
        if (useFallbacks) {
            relaysToTry.push(...this.FALLBACK_RELAYS.filter(r => r !== relay));
        }

        let lastError = null;

        for (const relayUrl of relaysToTry) {
            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try {
                    if (attempt > 0) {
                        // Exponential backoff
                        const delay = retryDelay * Math.pow(2, attempt - 1);
                        console.log(`[nostr] Retry ${attempt}/${maxRetries} for ${relayUrl} after ${delay}ms`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }

                    const result = await queryFn(relayUrl);
                    if (result !== null && result !== undefined) {
                        return result;
                    }
                    // If result is null, try next attempt/relay
                    if (attempt === maxRetries) {
                        console.log(`[nostr] No result from ${relayUrl}, trying next relay`);
                    }
                } catch (error) {
                    lastError = error;
                    console.warn(`[nostr] Query failed on ${relayUrl} (attempt ${attempt + 1}):`, error.message);
                }
            }
        }

        // All retries exhausted
        console.error('[nostr] All relay attempts failed');
        return null;
    },

    /**
     * Query relay for recent kind-0 (profile) events
     * Uses NIP-42 authenticated connection
     * @param {number} limit - Maximum number of profiles to fetch
     * @param {string} relayUrl - Relay URL (defaults to Imani relay)
     * @returns {Promise<Array>} - Array of profile objects with pubkey, npub, and profile data
     */
    async queryRecentProfiles(limit = 20, relayUrl = null) {
        // Use DM_RELAY by default for authenticated connections
        const relay = relayUrl || this.DM_RELAY;
        const self = this;

        return new Promise((resolve) => {
            const profiles = [];
            const seenPubkeys = new Set();
            let resolved = false;
            let connection = null;

            const resolveOnce = (value) => {
                if (!resolved) {
                    resolved = true;
                    if (connection?.cleanup) connection.cleanup();
                    resolve(value);
                }
            };

            const onReady = (ws) => {
                // Subscribe to kind-0 events (profile metadata)
                // Request recent profiles sorted by created_at
                const subscriptionId = 'profiles_' + Date.now();
                const filter = {
                    kinds: [0],
                    limit: limit * 2 // Request more to account for duplicates
                };
                ws.send(JSON.stringify(['REQ', subscriptionId, filter]));
            };

            const onMessage = (msg) => {
                if (msg[0] === 'EVENT') {
                    const nostrEvent = msg[2];
                    const pubkey = nostrEvent.pubkey;

                    // Skip duplicates (keep most recent)
                    if (!seenPubkeys.has(pubkey)) {
                        seenPubkeys.add(pubkey);

                        try {
                            const profileData = JSON.parse(nostrEvent.content);
                            profiles.push({
                                pubkeyHex: pubkey,
                                npub: self.encodeNpub(pubkey),
                                profile: profileData,
                                createdAt: nostrEvent.created_at
                            });
                        } catch (e) {
                            // Invalid JSON in profile content, skip
                        }
                    }
                } else if (msg[0] === 'EOSE') {
                    // End of stored events
                    // Sort by created_at descending and limit
                    profiles.sort((a, b) => b.createdAt - a.createdAt);
                    resolveOnce(profiles.slice(0, limit));
                }
            };

            const onError = (error) => {
                console.error('[nostr] Recent profiles query error:', error);
                // Return what we have collected so far
                profiles.sort((a, b) => b.createdAt - a.createdAt);
                resolveOnce(profiles.slice(0, limit));
            };

            connection = self.createAuthenticatedConnection(relay, onReady, onMessage, onError, 12000);
        });
    },

    /**
     * Query relay for user's settings event (NIP-78 kind-30078 with d=imani:settings)
     * Uses NIP-42 authenticated connection
     * Supports both encrypted (NIP-04) and legacy unencrypted settings
     * @param {string} pubkeyHex - User's public key (hex)
     * @param {string} relayUrl - Relay URL (defaults to Imani relay)
     * @param {string} privateKeyHex - Private key for decryption (optional, uses _authCredentials if not provided)
     * @returns {Promise<Object|null>} - Settings object or null if not found
     */
    async querySettingsEvent(pubkeyHex, relayUrl = null, privateKeyHex = null) {
        // Use DM_RELAY by default for authenticated connections
        const relay = relayUrl || this.DM_RELAY;
        const self = this;

        // Get private key from auth credentials if not provided
        const privKey = privateKeyHex || (this._authCredentials && this._authCredentials.privateKeyHex);

        return new Promise((resolve) => {
            let resolved = false;
            let connection = null;

            const resolveOnce = (value) => {
                if (!resolved) {
                    resolved = true;
                    if (connection?.cleanup) connection.cleanup();
                    resolve(value);
                }
            };

            const onReady = (ws) => {
                const subscriptionId = 'settings_' + Date.now();
                const filter = {
                    kinds: [30078],
                    authors: [pubkeyHex],
                    '#d': ['imani:settings'],
                    limit: 1
                };
                ws.send(JSON.stringify(['REQ', subscriptionId, filter]));
            };

            const onMessage = async (msg) => {
                if (msg[0] === 'EVENT') {
                    const nostrEvent = msg[2];
                    try {
                        let settingsJson = nostrEvent.content;

                        // Check if content is NIP-04 encrypted (has ?iv= separator)
                        if (nostrEvent.content.includes('?iv=') && privKey) {
                            try {
                                const privKeyBytes = self.hexToBytes(privKey);
                                settingsJson = await window.NostrTools.nip04.decrypt(
                                    privKeyBytes,
                                    pubkeyHex,
                                    nostrEvent.content
                                );
                            } catch (decryptErr) {
                                console.warn('[nostr] Settings decryption failed, trying as plain JSON:', decryptErr.message);
                            }
                        }

                        const settings = JSON.parse(settingsJson);
                        resolveOnce({
                            settings,
                            createdAt: nostrEvent.created_at,
                            eventId: nostrEvent.id,
                            encrypted: nostrEvent.content.includes('?iv=')
                        });
                    } catch (e) {
                        console.error('Invalid settings JSON:', e);
                        resolveOnce(null);
                    }
                } else if (msg[0] === 'EOSE') {
                    // No settings event found
                    resolveOnce(null);
                }
            };

            const onError = (error) => {
                console.error('[nostr] Settings query error:', error);
                resolveOnce(null);
            };

            connection = self.createAuthenticatedConnection(relay, onReady, onMessage, onError, 8000);
        });
    },

    /**
     * Query relay for kind-0 profile (NIP-01 metadata)
     * Uses retry logic for better reliability
     * @param {string} pubkeyHex - User's public key (hex)
     * @param {string} relayUrl - Relay URL (defaults to Imani relay)
     * @param {number} maxRetries - Maximum retry attempts (default: 2)
     * @returns {Promise<Object|null>} - Profile object or null if not found
     */
    async queryKind0Profile(pubkeyHex, relayUrl = null, maxRetries = 2) {
        // Use DM_RELAY by default for authenticated connections
        const relay = relayUrl || this.DM_RELAY;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (attempt > 0) {
                const delay = 1000 * attempt;
                console.log(`[nostr] Retry ${attempt}/${maxRetries} for kind-0 profile after ${delay}ms`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }

            const result = await this._queryKind0ProfileOnce(pubkeyHex, relay);
            if (result !== null) {
                return result;
            }
        }

        console.warn(`[nostr] Failed to fetch kind-0 profile after ${maxRetries + 1} attempts`);
        return null;
    },

    /**
     * Single attempt to query kind-0 profile
     * Uses NIP-42 authenticated connection
     * @private
     */
    async _queryKind0ProfileOnce(pubkeyHex, relay) {
        const self = this;
        return new Promise((resolve) => {
            let resolved = false;
            let connection = null;

            const resolveOnce = (value) => {
                if (!resolved) {
                    resolved = true;
                    if (connection?.cleanup) connection.cleanup();
                    resolve(value);
                }
            };

            const onReady = (ws) => {
                const subscriptionId = 'profile_' + Date.now();
                const filter = {
                    kinds: [0],
                    authors: [pubkeyHex],
                    limit: 1
                };
                ws.send(JSON.stringify(['REQ', subscriptionId, filter]));
            };

            const onMessage = (msg) => {
                if (msg[0] === 'EVENT') {
                    const nostrEvent = msg[2];
                    const content = nostrEvent?.content;
                    if (content) {
                        try {
                            const parsed = JSON.parse(content);
                            resolveOnce(parsed);
                            return;
                        } catch (e) {
                            console.error('[nostr] Invalid profile JSON:', e);
                        }
                    }
                } else if (msg[0] === 'EOSE') {
                    resolveOnce(null);
                }
            };

            const onError = (error) => {
                console.error(`[nostr] Kind-0 profile query error:`, error);
                resolveOnce(null);
            };

            connection = self.createAuthenticatedConnection(relay, onReady, onMessage, onError, 8000);
        });
    },

    /**
     * Query relay for merchant profile (NIP-78 kind-30078 with d=imani:merchant)
     * Uses retry logic for better reliability
     * @param {string} pubkeyHex - Merchant pubkey (hex)
     * @param {string} relayUrl - Relay URL (defaults to Imani relay)
     * @param {number} maxRetries - Maximum retry attempts (default: 2)
     * @returns {Promise<Object|null>} - Merchant profile object or null if not found
     */
    async queryMerchantProfileEvent(pubkeyHex, relayUrl = null, maxRetries = 2) {
        // Use DM_RELAY by default for authenticated connections
        const relay = relayUrl || this.DM_RELAY;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (attempt > 0) {
                const delay = 1000 * attempt; // Linear backoff: 1s, 2s
                console.log(`[nostr] Retry ${attempt}/${maxRetries} for merchant profile after ${delay}ms`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }

            const result = await this._queryMerchantProfileEventOnce(pubkeyHex, relay);
            if (result !== null) {
                return result;
            }
        }

        console.warn(`[nostr] Failed to fetch merchant profile after ${maxRetries + 1} attempts`);
        return null;
    },

    /**
     * Single attempt to query merchant profile
     * Uses NIP-42 authenticated connection
     * @private
     */
    async _queryMerchantProfileEventOnce(pubkeyHex, relay) {
        const self = this;
        return new Promise((resolve) => {
            let resolved = false;
            let connection = null;

            const resolveOnce = (value) => {
                if (!resolved) {
                    resolved = true;
                    if (connection?.cleanup) connection.cleanup();
                    resolve(value);
                }
            };

            const onReady = (ws) => {
                console.log(`[nostr] Connected to ${relay}, querying merchant profile`);
                const subscriptionId = 'merchant_' + Date.now();
                const filter = {
                    kinds: [30078],
                    authors: [pubkeyHex],
                    '#d': ['imani:merchant'],
                    limit: 1
                };
                ws.send(JSON.stringify(['REQ', subscriptionId, filter]));
            };

            const onMessage = (msg) => {
                if (msg[0] === 'EVENT') {
                    const nostrEvent = msg[2];
                    const content = nostrEvent?.content;
                    if (content) {
                        try {
                            const parsed = JSON.parse(content);
                            console.log(`[nostr] Found merchant profile`);
                            resolveOnce(parsed);
                            return;
                        } catch (e) {
                            console.error('[nostr] Invalid merchant profile JSON:', e);
                        }
                    }
                } else if (msg[0] === 'EOSE') {
                    console.log(`[nostr] No merchant profile found for pubkey`);
                    resolveOnce(null);
                }
            };

            const onError = (error) => {
                console.error(`[nostr] Merchant profile query error:`, error);
                resolveOnce(null);
            };

            console.log(`[nostr] Connecting to relay: ${relay}`);
            connection = self.createAuthenticatedConnection(relay, onReady, onMessage, onError, 8000);
        });
    },

    /**
     * Generic direct relay query - bypasses backend API
     * Use when backend nostrdb is not returning correct results
     * @param {Object} filter - Nostr filter { kinds, authors, limit, since, until }
     * @param {string} relayUrl - Relay URL (defaults to Imani relay)
     * @returns {Promise<Array>} - Array of events
     */
    async queryRelayDirect(filter, relayUrl = null) {
        const self = this;
        const relay = relayUrl || this.DM_RELAY;

        return new Promise((resolve) => {
            let resolved = false;
            let connection = null;
            const events = [];

            const resolveOnce = (value) => {
                if (!resolved) {
                    resolved = true;
                    if (connection?.cleanup) connection.cleanup();
                    resolve(value);
                }
            };

            // Timeout after 10 seconds
            setTimeout(() => resolveOnce(events), 10000);

            const onReady = (ws) => {
                const subscriptionId = 'direct_' + Date.now();

                const handleMessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        if (data[0] === 'EVENT' && data[1] === subscriptionId) {
                            events.push(data[2]);
                        } else if (data[0] === 'EOSE' && data[1] === subscriptionId) {
                            console.log('[nostr] Direct query EOSE, received', events.length, 'events');
                            resolveOnce(events);
                        }
                    } catch (e) {
                        // Ignore parse errors
                    }
                };

                ws.addEventListener('message', handleMessage);
                ws.send(JSON.stringify(['REQ', subscriptionId, filter]));
            };

            const onError = (error) => {
                console.error('[nostr] Direct relay query error:', error?.message || error);
                resolveOnce(events);
            };

            connection = self.connectToRelay(relay, onReady, onError);
        });
    },

    /**
     * Query relay for relay list (NIP-65 Kind 10002)
     * Returns the user's preferred relays for read/write operations.
     * @param {string} pubkeyHex - User's public key (hex)
     * @param {string} relayUrl - Relay URL (defaults to Imani relay)
     * @param {number} maxRetries - Maximum retry attempts (default: 2)
     * @returns {Promise<Object|null>} - Object with read and write relay arrays
     */
    async queryRelayList(pubkeyHex, relayUrl = null, maxRetries = 2) {
        // Use DM_RELAY by default for authenticated connections
        const relay = relayUrl || this.DM_RELAY;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (attempt > 0) {
                const delay = 1000 * attempt;
                console.log(`[nostr] Retry ${attempt}/${maxRetries} for relay list after ${delay}ms`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }

            const result = await this._queryRelayListOnce(pubkeyHex, relay);
            if (result !== null) {
                return result;
            }
        }

        console.warn(`[nostr] Failed to fetch relay list after ${maxRetries + 1} attempts`);
        return null;
    },

    /**
     * Single attempt to query relay list (Kind 10002)
     * Uses NIP-42 authenticated connection
     * @private
     */
    async _queryRelayListOnce(pubkeyHex, relay) {
        const self = this;
        return new Promise((resolve) => {
            let resolved = false;
            let connection = null;

            const resolveOnce = (value) => {
                if (!resolved) {
                    resolved = true;
                    if (connection?.cleanup) connection.cleanup();
                    resolve(value);
                }
            };

            const onReady = (ws) => {
                const subscriptionId = 'relays_' + Date.now();
                const filter = {
                    kinds: [10002],
                    authors: [pubkeyHex],
                    limit: 1
                };
                ws.send(JSON.stringify(['REQ', subscriptionId, filter]));
            };

            const onMessage = (msg) => {
                if (msg[0] === 'EVENT') {
                    const nostrEvent = msg[2];
                    // Kind 10002 stores relays in tags, not content
                    const tags = nostrEvent?.tags || [];
                    const readRelays = [];
                    const writeRelays = [];

                    for (const tag of tags) {
                        if (tag[0] === 'r' && tag[1]) {
                            const relayUrl = tag[1];
                            const marker = tag[2];  // "read", "write", or undefined (both)

                            if (!marker || marker === 'read') {
                                readRelays.push(relayUrl);
                            }
                            if (!marker || marker === 'write') {
                                writeRelays.push(relayUrl);
                            }
                        }
                    }

                    console.log(`[nostr] Found relay list: ${readRelays.length} read, ${writeRelays.length} write`);
                    resolveOnce({ read: readRelays, write: writeRelays });
                } else if (msg[0] === 'EOSE') {
                    resolveOnce(null);
                }
            };

            const onError = (error) => {
                console.error(`[nostr] Relay list query error:`, error);
                resolveOnce(null);
            };

            connection = self.createAuthenticatedConnection(relay, onReady, onMessage, onError, 8000);
        });
    },

    /**
     * Query relay for wallet state (Kind 37375)
     * Returns the user's Cashu wallet state including tokens and mints.
     * @param {string} pubkeyHex - User's public key (hex)
     * @param {string} relayUrl - Relay URL (defaults to Imani relay)
     * @param {number} maxRetries - Maximum retry attempts (default: 2)
     * @returns {Promise<Object|null>} - Wallet state object or null if not found
     */
    async queryWalletState(pubkeyHex, relayUrl = null, maxRetries = 2) {
        // Use DM_RELAY by default for authenticated connections
        const relay = relayUrl || this.DM_RELAY;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (attempt > 0) {
                const delay = 1000 * attempt;
                console.log(`[nostr] Retry ${attempt}/${maxRetries} for wallet state after ${delay}ms`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }

            const result = await this._queryWalletStateOnce(pubkeyHex, relay);
            if (result !== null) {
                return result;
            }
        }

        console.warn(`[nostr] Failed to fetch wallet state after ${maxRetries + 1} attempts`);
        return null;
    },

    /**
     * Single attempt to query wallet state (Kind 37375)
     * Uses NIP-42 authenticated connection
     * @private
     */
    async _queryWalletStateOnce(pubkeyHex, relay) {
        const self = this;
        return new Promise((resolve) => {
            let resolved = false;
            let connection = null;

            const resolveOnce = (value) => {
                if (!resolved) {
                    resolved = true;
                    if (connection?.cleanup) connection.cleanup();
                    resolve(value);
                }
            };

            const onReady = (ws) => {
                const subscriptionId = 'wallet_' + Date.now();
                const filter = {
                    kinds: [37375],
                    authors: [pubkeyHex],
                    limit: 1
                };
                ws.send(JSON.stringify(['REQ', subscriptionId, filter]));
            };

            const onMessage = async (msg) => {
                if (msg[0] === 'EVENT') {
                    const nostrEvent = msg[2];
                    const content = nostrEvent?.content;
                    if (content) {
                        try {
                            // Try to decrypt NIP-04 encrypted content (if it has the ?iv= format)
                            let decryptedContent = content;
                            const authCreds = self._authCredentials;
                            const isNip04Encrypted = typeof content === 'string' && content.includes('?iv=');

                            if (isNip04Encrypted && authCreds?.privateKeyHex && authCreds?.publicKeyHex) {
                                try {
                                    const privKeyBytes = self.hexToBytes(authCreds.privateKeyHex);
                                    decryptedContent = await window.NostrTools.nip04.decrypt(
                                        privKeyBytes,
                                        authCreds.publicKeyHex,
                                        content
                                    );
                                    console.log('[nostr] Decrypted wallet state content');
                                } catch (decryptErr) {
                                    console.warn('[nostr] Failed to decrypt wallet state, trying as plaintext:', decryptErr.message);
                                    // Fall back to treating as plaintext
                                }
                            } else if (isNip04Encrypted) {
                                console.warn('[nostr] No auth credentials for NIP-04 decryption, trying as plaintext');
                            }

                            const parsed = JSON.parse(decryptedContent);
                            console.log('[nostr] Found wallet state');
                            resolveOnce({
                                event: nostrEvent,
                                state: parsed
                            });
                            return;
                        } catch (e) {
                            console.error('[nostr] Invalid wallet state JSON:', e);
                        }
                    }
                } else if (msg[0] === 'EOSE') {
                    resolveOnce(null);
                }
            };

            const onError = (error) => {
                console.error(`[nostr] Wallet state query error:`, error);
                resolveOnce(null);
            };

            connection = self.createAuthenticatedConnection(relay, onReady, onMessage, onError, 8000);
        });
    },

    /**
     * Publish a signed event to relay with NIP-42 authentication support
     * @param {Object} signedEvent - Signed Nostr event
     * @param {string} relayUrl - Relay URL (defaults to Imani relay)
     * @param {string} privateKeyHex - Optional private key for NIP-42 auth
     * @returns {Promise<boolean>} - True if published successfully
     */
    async publishEvent(signedEvent, relayUrl = null, privateKeyHex = null) {
        const relay = relayUrl || this.DEFAULT_RELAY;
        const self = this;

        return new Promise((resolve) => {
            let ws = null;
            let timeoutId = null;
            let resolved = false;
            let authenticated = false;
            let eventSent = false;

            const cleanup = () => {
                if (timeoutId) clearTimeout(timeoutId);
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.close();
                }
            };

            const resolveOnce = (value) => {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    resolve(value);
                }
            };

            const sendEvent = () => {
                if (!eventSent && ws && ws.readyState === WebSocket.OPEN) {
                    eventSent = true;
                    console.log('[nostr] Sending EVENT to relay, kind:', signedEvent.kind, 'id:', signedEvent.id?.substring(0, 16));
                    ws.send(JSON.stringify(['EVENT', signedEvent]));
                } else {
                    console.warn('[nostr] Cannot send event - eventSent:', eventSent, 'ws:', !!ws, 'readyState:', ws?.readyState);
                }
            };

            const handleAuth = async (challenge) => {
                // Use parameter, fall back to global auth credentials
                const authKey = privateKeyHex || self._authCredentials?.privateKeyHex;

                if (!authKey) {
                    console.warn('[nostr] NIP-42 auth required but no private key available');
                    // Try sending event anyway - some relays allow read without auth
                    sendEvent();
                    return;
                }

                try {
                    console.log('[nostr] Handling NIP-42 auth challenge');

                    // Create NIP-42 AUTH event (kind 22242)
                    const authEvent = {
                        kind: 22242,
                        pubkey: signedEvent.pubkey,
                        created_at: Math.floor(Date.now() / 1000),
                        tags: [
                            ['relay', relay],
                            ['challenge', challenge]
                        ],
                        content: ''
                    };

                    // Sign the auth event using local key
                    const signedAuth = await self.signEvent(authEvent, authKey);

                    // Send AUTH response
                    ws.send(JSON.stringify(['AUTH', signedAuth]));
                    console.log('[nostr] Sent NIP-42 AUTH response');
                } catch (error) {
                    console.error('[nostr] NIP-42 auth failed:', error);
                    resolveOnce(false);
                }
            };

            // Timeout after 10 seconds (increased for auth flow)
            timeoutId = setTimeout(() => {
                console.log('[nostr] Publish timeout');
                resolveOnce(false);
            }, 10000);

            try {
                ws = new WebSocket(relay);

                ws.onopen = () => {
                    // Don't send event immediately - wait for potential AUTH challenge
                    // Set a short delay to check if AUTH comes first
                    setTimeout(() => {
                        if (!authenticated && !eventSent) {
                            sendEvent();
                        }
                    }, 100);
                };

                ws.onmessage = async (event) => {
                    try {
                        const msg = JSON.parse(event.data);
                        console.log('[nostr] Relay message:', msg[0], msg[1]?.substring?.(0, 16) || msg[1], msg[2], msg[3] || '');

                        if (msg[0] === 'AUTH') {
                            // NIP-42: Relay is requesting authentication
                            await handleAuth(msg[1]);
                        } else if (msg[0] === 'OK') {
                            const eventId = msg[1];
                            const success = msg[2];
                            const message = msg[3] || '';

                            // Check if this is AUTH OK or EVENT OK
                            if (!authenticated && eventId !== signedEvent.id) {
                                // This is likely AUTH OK
                                if (success) {
                                    console.log('[nostr] NIP-42 auth successful');
                                    authenticated = true;
                                    sendEvent();
                                } else {
                                    console.warn('[nostr] NIP-42 auth rejected:', message);
                                    resolveOnce(false);
                                }
                            } else {
                                // This is EVENT OK
                                if (success) {
                                    console.log('[nostr] Event published:', signedEvent.id);
                                    resolveOnce(true);
                                } else {
                                    console.warn('[nostr] Event rejected:', message);
                                    resolveOnce(false);
                                }
                            }
                        }
                    } catch (e) {
                        console.error('[nostr] Error parsing relay message:', e);
                    }
                };

                ws.onerror = (error) => {
                    console.error('[nostr] Relay connection error:', error);
                    resolveOnce(false);
                };

                ws.onclose = (event) => {
                    // If we haven't resolved yet, assume failure
                    console.log('[nostr] WebSocket closed - code:', event.code, 'reason:', event.reason, 'eventSent:', eventSent, 'authenticated:', authenticated);
                    // Log specific error for 1009 (Message Too Big)
                    if (event.code === 1009) {
                        const eventSize = signedEvent ? JSON.stringify(signedEvent).length : 0;
                        console.error('[nostr] ERROR 1009: Message too big for relay. Event size:', eventSize, 'bytes. Consider enabling chunked sync or reducing data size.');
                    }
                    resolveOnce(false);
                };

            } catch (error) {
                console.error('[nostr] Failed to publish event:', error);
                resolveOnce(false);
            }
        });
    },

    // ========================================
    // Profile Sync (Kind 0)
    // ========================================

    /**
     * Create and publish a Kind 0 profile event
     * @param {Object} profile - Profile data (name, display_name, picture, about, nip05, lud16, website)
     * @param {Object} signer - Signer with signEvent method (local or bunker)
     * @param {string|null} relayUrl - Optional relay URL
     * @returns {Promise<Object>} - { success: boolean, event: Object|null, error: string|null }
     */
    async createAndPublishProfile(profile, signer, relayUrl = null) {
        try {
            // Build profile content
            const content = {
                name: profile.name || profile.username || '',
                display_name: profile.display_name || profile.displayName || profile.name || '',
                picture: profile.picture || '',
                about: profile.about || '',
                nip05: profile.nip05 || '',
                lud16: profile.lud16 || profile.lightningAddress || '',
                website: profile.website || ''
            };

            // Remove empty fields
            Object.keys(content).forEach(key => {
                if (!content[key]) delete content[key];
            });

            // Create unsigned event
            const event = {
                kind: 0,
                created_at: Math.floor(Date.now() / 1000),
                tags: [],
                content: JSON.stringify(content)
            };

            // Sign the event
            const signedEvent = await signer.signEvent(event);
            if (!signedEvent) {
                return { success: false, event: null, error: 'Failed to sign profile event' };
            }

            // Publish to relay (pass privateKey for NIP-42 auth if available)
            const privateKeyHex = signer.privateKey || signer.privateKeyHex || null;
            const published = await this.publishEvent(signedEvent, relayUrl, privateKeyHex);
            if (!published) {
                return { success: false, event: signedEvent, error: 'Failed to publish to relay' };
            }

            console.log('[nostr] Profile published:', signedEvent.id);
            return { success: true, event: signedEvent, error: null };

        } catch (error) {
            console.error('[nostr] createAndPublishProfile error:', error);
            return { success: false, event: null, error: error.message };
        }
    },

    // ========================================
    // Relay List Sync (Kind 10002)
    // ========================================

    /**
     * Create and publish a Kind 10002 relay list event
     * @param {Object} relays - { read: string[], write: string[] }
     * @param {Object} signer - Signer with signEvent method
     * @param {string|null} relayUrl - Optional relay URL to publish to
     * @returns {Promise<Object>} - { success: boolean, event: Object|null, error: string|null }
     */
    async createAndPublishRelayList(relays, signer, relayUrl = null) {
        try {
            const tags = [];

            // Add read relays
            if (relays.read && Array.isArray(relays.read)) {
                relays.read.forEach(r => {
                    if (!relays.write?.includes(r)) {
                        tags.push(['r', r, 'read']);
                    }
                });
            }

            // Add write relays
            if (relays.write && Array.isArray(relays.write)) {
                relays.write.forEach(r => {
                    if (!relays.read?.includes(r)) {
                        tags.push(['r', r, 'write']);
                    }
                });
            }

            // Add read+write relays (no marker means both)
            if (relays.read && relays.write) {
                const both = relays.read.filter(r => relays.write.includes(r));
                both.forEach(r => {
                    tags.push(['r', r]);
                });
            }

            // Create unsigned event
            const event = {
                kind: 10002,
                created_at: Math.floor(Date.now() / 1000),
                tags: tags,
                content: ''
            };

            // Sign the event
            const signedEvent = await signer.signEvent(event);
            if (!signedEvent) {
                return { success: false, event: null, error: 'Failed to sign relay list event' };
            }

            // Publish to relay (pass privateKey for NIP-42 auth if available)
            const privateKeyHex = signer.privateKey || signer.privateKeyHex || null;
            const published = await this.publishEvent(signedEvent, relayUrl, privateKeyHex);
            if (!published) {
                return { success: false, event: signedEvent, error: 'Failed to publish to relay' };
            }

            console.log('[nostr] Relay list published:', signedEvent.id);
            return { success: true, event: signedEvent, error: null };

        } catch (error) {
            console.error('[nostr] createAndPublishRelayList error:', error);
            return { success: false, event: null, error: error.message };
        }
    },

    // ========================================
    // Wallet State Sync (Kind 37375 - NIP-60 style)
    // ========================================

    /**
     * Create and publish a Kind 37375 wallet state event (encrypted)
     * @param {Object} walletState - Wallet state to sync (tokens, history, mints, etc)
     * @param {Object} signer - Signer with signEvent and nip04Encrypt methods
     * @param {string} pubkeyHex - User's public key for self-encryption
     * @param {string|null} relayUrl - Optional relay URL
     * @returns {Promise<Object>} - { success: boolean, event: Object|null, error: string|null }
     */
    async createAndPublishWalletState(walletState, signer, pubkeyHex, relayUrl = null, parents = []) {
        try {
            // Serialize wallet state
            const stateJson = JSON.stringify({
                version: 1,
                updated_at: new Date().toISOString(),
                tokens: walletState.tokens || [],
                history: walletState.history || [],
                mints: walletState.mints || [],
                defaultMint: walletState.defaultMint || null
            });
            const snapshotId = (typeof crypto !== 'undefined' && crypto.randomUUID)
                ? crypto.randomUUID()
                : `snapshot-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
            let payloadHash = '';
            try {
                if (typeof crypto === 'undefined' || !crypto.subtle) {
                    throw new Error('SubtleCrypto required for wallet state publish');
                }
                const digest = await crypto.subtle.digest(
                    'SHA-256',
                    new TextEncoder().encode(stateJson)
                );
                payloadHash = this.bytesToHex(new Uint8Array(digest));
            } catch (hashError) {
                console.error('[nostr] Failed to compute wallet-state payload hash:', hashError?.message);
                return { success: false, event: null, error: hashError?.message || 'Failed to compute payload hash' };
            }

            // Encrypt with NIP-04 (self-encryption)
            let encryptedContent;
            if (signer.nip04Encrypt) {
                encryptedContent = await signer.nip04Encrypt(pubkeyHex, stateJson);
            } else if (typeof window !== 'undefined' && window.NostrTools) {
                // Fallback to local encryption if signer doesn't support it
                const privateKey = signer.privateKey || signer.nsec;
                if (privateKey) {
                    const privKeyBytes = typeof privateKey === 'string' && privateKey.startsWith('nsec')
                        ? this.decodeNsec(privateKey)
                        : this.hexToBytes(privateKey);
                    encryptedContent = await window.NostrTools.nip04.encrypt(privKeyBytes, pubkeyHex, stateJson);
                } else {
                    return { success: false, event: null, error: 'No encryption method available' };
                }
            } else {
                return { success: false, event: null, error: 'NIP-04 encryption not available' };
            }

            // Create unsigned event (replaceable with d tag)
            const event = {
                kind: 37375,
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ['d', 'wallet-state'],  // Identifier for replaceable event
                    ['snapshot_id', snapshotId],
                    ['payload_hash', payloadHash],
                    ['hash_alg', 'sha256'],
                    ['total_chunks', '1'],
                    ...buildWalletSnapshotParentTags(parents),
                    ['client', 'imani-wallet']
                ],
                content: encryptedContent
            };

            // Sign the event
            const signedEvent = await signer.signEvent(event);
            if (!signedEvent) {
                return { success: false, event: null, error: 'Failed to sign wallet state event' };
            }

            // Publish to relay (pass privateKey for NIP-42 auth if available)
            const privateKeyHex = signer.privateKey || signer.privateKeyHex || null;
            const published = await this.publishEvent(signedEvent, relayUrl, privateKeyHex);
            if (!published) {
                return { success: false, event: signedEvent, error: 'Failed to publish to relay' };
            }

            console.log('[nostr] Wallet state published:', signedEvent.id);
            return { success: true, event: signedEvent, error: null };

        } catch (error) {
            console.error('[nostr] createAndPublishWalletState error:', error);
            return { success: false, event: null, error: error.message };
        }
    },

    /**
     * Create and publish wallet state in chunks for large wallets
     * Each chunk is a separate replaceable event with d tag: wallet-chunk-0, wallet-chunk-1, etc.
     * @param {Object} walletState - Wallet state with tokens, history, mints
     * @param {Object} signer - Signer with signEvent and nip04Encrypt methods
     * @param {string} pubkeyHex - User's public key
     * @param {number} chunkSize - Max size per chunk in bytes (default 300KB, safe under 400KB after encryption)
     * @param {string|null} relayUrl - Optional relay URL
     * @returns {Promise<Object>} - { success: boolean, chunks: number, error: string|null }
     */
    async createAndPublishWalletStateChunked(walletState, signer, pubkeyHex, chunkSize = 300000, relayUrl = null, previousChunkCountOrOptions = 0, parents = []) {
        try {
            const cleanupOptions = (previousChunkCountOrOptions && typeof previousChunkCountOrOptions === 'object')
                ? previousChunkCountOrOptions
                : { previousChunkCount: previousChunkCountOrOptions };
            const previousChunkCount = Number.isFinite(Number(cleanupOptions.previousChunkCount))
                ? Math.max(0, Math.trunc(Number(cleanupOptions.previousChunkCount)))
                : 0;
            const deferCleanup = cleanupOptions.deferCleanup === true;
            const deleteLegacyWalletState = cleanupOptions.deleteLegacyWalletState !== false;

            // Serialize wallet state with metadata
            const stateWithMeta = {
                version: 2, // v2 = chunked format
                updated_at: new Date().toISOString(),
                tokens: walletState.tokens || [],
                history: walletState.history || [],
                mints: walletState.mints || [],
                defaultMint: walletState.defaultMint || null
            };
            const fullStateJson = JSON.stringify(stateWithMeta);
            const snapshotId = (typeof crypto !== 'undefined' && crypto.randomUUID)
                ? crypto.randomUUID()
                : `snapshot-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
            let payloadHash = '';
            const hashAlgorithm = 'sha256';
            try {
                if (typeof crypto === 'undefined' || !crypto.subtle) {
                    throw new Error('SubtleCrypto required for chunked wallet publish');
                }
                const digest = await crypto.subtle.digest(
                    'SHA-256',
                    new TextEncoder().encode(fullStateJson)
                );
                payloadHash = this.bytesToHex(new Uint8Array(digest));
            } catch (hashError) {
                console.error('[nostr] Failed to compute payload hash:', hashError?.message);
                return { success: false, chunks: 0, error: hashError?.message || 'Failed to compute payload hash' };
            }
            console.log('[nostr] Full wallet state size:', fullStateJson.length, 'bytes');

            // Use nostr-chunked-events library if available
            let chunks;
            if (typeof NostrChunkedEvents !== 'undefined' && NostrChunkedEvents.createChunks) {
                const chunkObjects = NostrChunkedEvents.createChunks(fullStateJson, {
                    chunkSize: chunkSize,
                    dTagPrefix: 'wallet'
                });
                // Extract just the data from each chunk
                chunks = chunkObjects.map(c => c.data);
                console.log('[nostr] Using nostr-chunked-events library for chunking');
            } else {
                // Fallback to manual chunking
                chunks = [];
                for (let i = 0; i < fullStateJson.length; i += chunkSize) {
                    chunks.push(fullStateJson.slice(i, i + chunkSize));
                }
            }
            console.log('[nostr] Splitting wallet state into', chunks.length, 'chunks');
            console.log('[nostr] Chunk snapshot metadata:', {
                snapshotId: snapshotId,
                payloadHash: payloadHash,
                totalChunks: chunks.length,
            });

            const privateKeyHex = signer.privateKey || signer.privateKeyHex || null;

            // Sign all chunk events up-front so any signing failure aborts before any publish.
            const signedEvents = [];
            for (let i = 0; i < chunks.length; i++) {
                const chunkData = { chunk: i, total: chunks.length, data: chunks[i] };
                const chunkJson = JSON.stringify(chunkData);

                let encryptedContent;
                if (signer.nip04Encrypt) {
                    encryptedContent = await signer.nip04Encrypt(pubkeyHex, chunkJson);
                } else if (window.NostrTools && privateKeyHex) {
                    const privKeyBytes = this.hexToBytes(privateKeyHex);
                    encryptedContent = await window.NostrTools.nip04.encrypt(privKeyBytes, pubkeyHex, chunkJson);
                } else {
                    return { success: false, chunks: 0, error: 'No encryption method available' };
                }

                const event = {
                    kind: 37375,
                    created_at: Math.floor(Date.now() / 1000),
                    tags: [
                        ['d', `wallet-chunk-${i}`],
                        ['chunk', i.toString(), chunks.length.toString()],
                        ['snapshot_id', snapshotId],
                        ['payload_hash', payloadHash],
                        ['hash_alg', hashAlgorithm],
                        ['total_chunks', chunks.length.toString()],
                        ...buildWalletSnapshotParentTags(parents),
                        ['client', 'imani-wallet']
                    ],
                    content: encryptedContent
                };

                const signedEvent = await signer.signEvent(event);
                if (!signedEvent) {
                    return { success: false, chunks: 0, error: `Failed to sign chunk ${i}` };
                }
                signedEvents.push(signedEvent);
            }

            // Publish all chunks over a single WebSocket: one handshake, one AUTH,
            // events pipelined as fast as the socket drains. Per-chunk WebSocket
            // setup (as we did before) makes large snapshots O(N) round-trips and
            // blows the logout budget; batched send is roughly O(1) round-trips.
            const batchStart = performance.now();
            const batchResult = await this.publishEventsBatch(
                signedEvents, relayUrl, privateKeyHex,
                { overallTimeoutMs: Math.max(30000, signedEvents.length * 3000), label: 'wallet-chunks' }
            );
            console.log(`[nostr] First-pass chunk publish: ${batchResult.published.length}/${signedEvents.length} accepted in ${Math.round(performance.now() - batchStart)}ms`);

            const accepted = new Set(batchResult.published.map((p) => p.id));
            const toRetry = signedEvents.filter((ev) => !accepted.has(ev.id));

            if (toRetry.length > 0) {
                console.warn(`[nostr] Retrying ${toRetry.length} chunk(s) on a fresh WebSocket`);
                const retryStart = performance.now();
                const retryResult = await this.publishEventsBatch(
                    toRetry, relayUrl, privateKeyHex,
                    { overallTimeoutMs: Math.max(20000, toRetry.length * 3000), label: 'wallet-chunks-retry' }
                );
                for (const p of retryResult.published) accepted.add(p.id);
                console.log(`[nostr] Retry chunk publish: ${retryResult.published.length}/${toRetry.length} accepted in ${Math.round(performance.now() - retryStart)}ms`);
            }

            const succeededCount = accepted.size;
            if (succeededCount < signedEvents.length) {
                const missingIndexes = signedEvents
                    .map((ev, i) => (accepted.has(ev.id) ? -1 : i))
                    .filter((i) => i >= 0);
                console.error('[nostr] Chunk publish incomplete. Missing chunk indexes:', missingIndexes);
                return {
                    success: false,
                    chunks: succeededCount,
                    error: `Failed to publish ${signedEvents.length - succeededCount} of ${signedEvents.length} chunk(s) after retry`
                };
            }

            console.log(`[nostr] Published all ${chunks.length} wallet chunks (snapshot ${snapshotId.slice(0, 8)})`);

            const cleanupPlan = {
                fromIndex: Number.isFinite(Number(cleanupOptions.fromIndex))
                    ? Math.max(0, Math.trunc(Number(cleanupOptions.fromIndex)))
                    : chunks.length,
                toIndex: Number.isFinite(Number(cleanupOptions.toIndex))
                    ? Math.max(0, Math.trunc(Number(cleanupOptions.toIndex)))
                    : previousChunkCount,
                deleteLegacyWalletState,
            };

            if (!deferCleanup) {
                await this.finalizeWalletStateSnapshotPublish(
                    signer,
                    pubkeyHex,
                    relayUrl,
                    cleanupPlan,
                );
            }

            console.log('[nostr] Wallet state chunked sync complete:', chunks.length, 'chunks');
            return { success: true, chunks: chunks.length, events: signedEvents, error: null, cleanupPlan };

        } catch (error) {
            console.error('[nostr] createAndPublishWalletStateChunked error:', error);
            return { success: false, chunks: 0, error: error.message };
        }
    },

    async finalizeWalletStateSnapshotPublish(signer, pubkeyHex, relayUrl = null, cleanupPlan = {}) {
        const privateKeyHex = signer?.privateKey || signer?.privateKeyHex || null;
        const fromIndex = Number.isFinite(Number(cleanupPlan.fromIndex))
            ? Math.max(0, Math.trunc(Number(cleanupPlan.fromIndex)))
            : 0;
        const toIndex = Number.isFinite(Number(cleanupPlan.toIndex))
            ? Math.max(fromIndex, Math.trunc(Number(cleanupPlan.toIndex)))
            : fromIndex;

        // Replace any orphan chunks from a prior, larger snapshot with tombstones.
        // Without this, a 10-chunk snapshot followed by a 9-chunk snapshot leaves
        // wallet-chunk-9 on the relay and selectBestSnapshot groups it as a
        // second (invalid) candidate → pull surfaces "Missing chunk index …".
        if (toIndex > fromIndex) {
            await this._tombstoneOrphanChunks(
                signer, pubkeyHex, relayUrl, privateKeyHex,
                fromIndex, toIndex
            );
        }

        if (cleanupPlan.deleteLegacyWalletState !== false) {
            await this._deleteWalletStateEvent(signer, pubkeyHex, relayUrl, privateKeyHex);
        }

        return {
            success: true,
            cleanupPlan: {
                fromIndex,
                toIndex,
                deleteLegacyWalletState: cleanupPlan.deleteLegacyWalletState !== false,
            },
        };
    },

    async _tombstoneOrphanChunks(signer, pubkeyHex, relayUrl, privateKeyHex, fromIndex, toIndex) {
        const count = toIndex - fromIndex;
        console.log(`[nostr] Tombstoning ${count} orphan wallet chunk(s) [${fromIndex}..${toIndex - 1}]`);

        const signed = [];
        for (let i = fromIndex; i < toIndex; i++) {
            try {
                const plaintext = JSON.stringify({ deleted: true, orphan_chunk: true });
                const encryptedContent = signer.nip04Encrypt
                    ? await signer.nip04Encrypt(pubkeyHex, plaintext)
                    : await window.NostrTools.nip04.encrypt(this.hexToBytes(privateKeyHex), pubkeyHex, plaintext);

                const event = {
                    kind: 37375,
                    created_at: Math.floor(Date.now() / 1000),
                    tags: [
                        ['d', `wallet-chunk-${i}`],
                        ['client', 'imani-wallet'],
                        ['deleted', 'true']
                    ],
                    content: encryptedContent
                };
                const s = await signer.signEvent(event);
                if (s) signed.push(s);
            } catch (e) {
                console.warn('[nostr] Orphan tombstone signing failed for chunk', i, ':', e.message);
            }
        }

        if (signed.length === 0) {
            console.warn('[nostr] No tombstones could be signed; skipping tombstone publish');
            return;
        }

        // Same single-WebSocket batch path as the main chunk publish — parallel
        // fan-out would just saturate the relay again.
        const result = await this.publishEventsBatch(
            signed, relayUrl, privateKeyHex,
            { overallTimeoutMs: Math.max(15000, signed.length * 2000), label: 'orphan-tombstones' }
        );
        const failed = signed.length - result.published.length;
        if (failed > 0) {
            console.warn(`[nostr] Tombstoned ${result.published.length}/${count} orphan chunks; ${failed} unacked (non-fatal — next pull may still see rejected snapshots until the relay drops them or the next push succeeds)`);
        } else {
            console.log(`[nostr] Tombstoned all ${count} orphan chunks`);
        }
    },

    /**
     * Publish multiple signed events over a single WebSocket to one relay.
     *
     * Opens one connection, handles one NIP-42 AUTH round-trip (if challenged),
     * pipelines every EVENT in quick succession, and resolves when every event
     * has been OK-acked (or the overall timeout fires / the socket closes).
     *
     * Much cheaper than N calls to publishEvent() when pushing a large chunked
     * snapshot: one TLS+WS handshake instead of N, one AUTH instead of N, and
     * events stream in parallel on the wire even though they were sent in order.
     *
     * @param {Array<Object>} signedEvents - Pre-signed Nostr events
     * @param {string|null} relayUrl - Relay URL (defaults to DEFAULT_RELAY)
     * @param {string|null} privateKeyHex - Private key for NIP-42 AUTH (optional)
     * @param {Object} [options]
     * @param {number} [options.overallTimeoutMs=60000] - Abort and return partial result after this many ms
     * @param {string} [options.label='batch'] - Log prefix to disambiguate concurrent batches
     * @returns {Promise<{published: Array<{id:string}>, rejected: Array<{id:string,reason:string}>, unacked: Array<{id:string}>}>}
     */
    async publishEventsBatch(signedEvents, relayUrl = null, privateKeyHex = null, options = {}) {
        const relay = relayUrl || this.DEFAULT_RELAY;
        const self = this;
        const overallTimeoutMs = options.overallTimeoutMs ?? 60000;
        const label = options.label || 'batch';

        if (!Array.isArray(signedEvents) || signedEvents.length === 0) {
            return { published: [], rejected: [], unacked: [] };
        }

        const total = signedEvents.length;
        const eventIds = new Set(signedEvents.map((e) => e.id));
        const totalBytes = signedEvents.reduce((sum, e) => sum + JSON.stringify(e).length, 0);
        console.log(`[nostr][${label}] Batch publish start: ${total} event(s), ${totalBytes} bytes total → ${relay}`);

        const t0 = performance.now();

        return new Promise((resolve) => {
            const published = [];
            const rejected = [];
            let authenticated = false;
            let authPending = false;
            let sendingStarted = false;
            let finished = false;
            let ws = null;
            let overallTimeoutId = null;

            const logSummary = (tag) => {
                const acked = published.length + rejected.length;
                const elapsed = Math.round(performance.now() - t0);
                console.log(`[nostr][${label}] ${tag} after ${elapsed}ms — acked ${acked}/${total} (ok=${published.length}, rejected=${rejected.length})`);
            };

            const finalize = (tag) => {
                if (finished) return;
                finished = true;
                if (overallTimeoutId) clearTimeout(overallTimeoutId);
                if (ws && ws.readyState === WebSocket.OPEN) {
                    try { ws.close(); } catch {}
                }
                const ackedIds = new Set([...published.map((p) => p.id), ...rejected.map((r) => r.id)]);
                const unacked = signedEvents
                    .filter((e) => !ackedIds.has(e.id))
                    .map((e) => ({ id: e.id }));
                logSummary(tag);
                if (unacked.length > 0) {
                    console.warn(`[nostr][${label}] ${unacked.length} event(s) unacked (closed/timed out before OK)`);
                }
                resolve({ published, rejected, unacked });
            };

            const maybeFinalize = () => {
                if (published.length + rejected.length >= total) finalize('all acked');
            };

            const sendAll = () => {
                if (sendingStarted) return;
                sendingStarted = true;
                const sendStart = performance.now();
                let sent = 0;
                for (const ev of signedEvents) {
                    try {
                        ws.send(JSON.stringify(['EVENT', ev]));
                        sent++;
                    } catch (e) {
                        console.warn(`[nostr][${label}] send failed for ${ev.id?.slice(0, 16)}: ${e.message}`);
                        rejected.push({ id: ev.id, reason: `send_failed: ${e.message}` });
                    }
                }
                console.log(`[nostr][${label}] Pipelined ${sent}/${total} EVENTs in ${Math.round(performance.now() - sendStart)}ms; waiting for OKs`);
                maybeFinalize();
            };

            const handleAuth = async (challenge) => {
                const authKey = privateKeyHex || self._authCredentials?.privateKeyHex;
                if (!authKey) {
                    console.warn(`[nostr][${label}] AUTH challenge but no private key — attempting unauthenticated send`);
                    sendAll();
                    return;
                }
                try {
                    const authEvent = {
                        kind: 22242,
                        pubkey: signedEvents[0].pubkey,
                        created_at: Math.floor(Date.now() / 1000),
                        tags: [['relay', relay], ['challenge', challenge]],
                        content: ''
                    };
                    const signedAuth = await self.signEvent(authEvent, authKey);
                    authPending = true;
                    ws.send(JSON.stringify(['AUTH', signedAuth]));
                    console.log(`[nostr][${label}] AUTH response sent`);
                } catch (e) {
                    console.error(`[nostr][${label}] AUTH signing failed: ${e.message}`);
                    finalize('auth failed');
                }
            };

            overallTimeoutId = setTimeout(() => {
                console.warn(`[nostr][${label}] Overall timeout (${overallTimeoutMs}ms) reached`);
                finalize('timeout');
            }, overallTimeoutMs);

            try {
                ws = new WebSocket(relay);

                ws.onopen = () => {
                    console.log(`[nostr][${label}] WebSocket open`);
                    // Wait for a potential NIP-42 AUTH challenge before we
                    // start pipelining EVENTs. If we send too early and the
                    // challenge arrives afterwards, the relay drops the
                    // unauthenticated events and closes the socket with
                    // code 1005 (no status received) — observed in the field.
                    //
                    // 750 ms is a healthy compromise: short enough that
                    // non-auth relays don't sit idle on the happy path,
                    // long enough that a remote relay's AUTH challenge lands
                    // first on typical consumer networks.
                    setTimeout(() => {
                        if (!authPending && !authenticated && !sendingStarted) {
                            sendAll();
                        }
                    }, 750);
                };

                ws.onmessage = (event) => {
                    try {
                        const msg = JSON.parse(event.data);
                        if (msg[0] === 'AUTH') {
                            handleAuth(msg[1]);
                            return;
                        }
                        if (msg[0] === 'OK') {
                            const eventId = msg[1];
                            const success = !!msg[2];
                            const message = msg[3] || '';

                            if (eventIds.has(eventId)) {
                                if (success) {
                                    published.push({ id: eventId });
                                    const acked = published.length + rejected.length;
                                    // Progress ping every 5 events or at end.
                                    if (acked === total || acked % 5 === 0) {
                                        logSummary('progress');
                                    }
                                } else {
                                    rejected.push({ id: eventId, reason: message || 'rejected' });
                                    console.warn(`[nostr][${label}] Rejected ${eventId.slice(0, 16)}: ${message}`);
                                }
                                maybeFinalize();
                            } else if (authPending) {
                                if (success) {
                                    authenticated = true;
                                    authPending = false;
                                    console.log(`[nostr][${label}] AUTH accepted; sending events`);
                                    sendAll();
                                } else {
                                    console.warn(`[nostr][${label}] AUTH rejected: ${message}`);
                                    finalize('auth rejected');
                                }
                            }
                        }
                    } catch (e) {
                        console.error(`[nostr][${label}] message parse error: ${e.message}`);
                    }
                };

                ws.onerror = (err) => {
                    console.error(`[nostr][${label}] WebSocket error:`, err?.message || err);
                };

                ws.onclose = (ev) => {
                    const ackedCount = published.length + rejected.length;
                    console.log(`[nostr][${label}] WebSocket closed — code: ${ev.code}, reason: "${ev.reason || ''}", acked: ${ackedCount}/${total}, sending_started: ${sendingStarted}, auth: ${authenticated ? 'done' : authPending ? 'pending' : 'not-required'}`);
                    if (ev.code === 1009) {
                        const maxSize = Math.max(...signedEvents.map((e) => JSON.stringify(e).length));
                        console.error(`[nostr][${label}] ERROR 1009: Message too big. Max event size: ${maxSize} bytes — lower chunkSize`);
                    }
                    if (ev.code === 1005 && ackedCount === 0 && sendingStarted && !authenticated) {
                        // Socket silently closed after we started sending but
                        // before any ACK. Most likely cause: we raced ahead of
                        // a NIP-42 AUTH challenge and the relay dropped us.
                        // The retry path in pushSnapshot will re-open a fresh
                        // socket; that second attempt gets a longer AUTH
                        // grace window to land the challenge first.
                        console.warn(`[nostr][${label}] 1005 with 0/${total} ACKed + sending started — likely AUTH race. Retry path will try again on a fresh socket.`);
                    }
                    finalize('socket closed');
                };
            } catch (e) {
                console.error(`[nostr][${label}] WebSocket setup failed: ${e.message}`);
                finalize('setup failed');
            }
        });
    },

    /**
     * Delete the old single wallet-state event by publishing empty replacement
     * @private
     */
    async _deleteWalletStateEvent(signer, pubkeyHex, relayUrl, privateKeyHex) {
        try {
            // Publish empty event with same d tag to replace old single event
            const emptyContent = await (signer.nip04Encrypt
                ? signer.nip04Encrypt(pubkeyHex, JSON.stringify({ deleted: true, migrated_to_chunks: true }))
                : window.NostrTools.nip04.encrypt(this.hexToBytes(privateKeyHex), pubkeyHex, JSON.stringify({ deleted: true, migrated_to_chunks: true })));

            const event = {
                kind: 37375,
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ['d', 'wallet-state'],
                    ['client', 'imani-wallet'],
                    ['deleted', 'true']
                ],
                content: emptyContent
            };

            const signedEvent = await signer.signEvent(event);
            if (signedEvent) {
                await this.publishEvent(signedEvent, relayUrl, privateKeyHex);
                console.log('[nostr] Deleted old wallet-state event (migrated to chunks)');
            }
        } catch (e) {
            // Ignore errors - old event may not exist
            console.log('[nostr] No old wallet-state event to delete');
        }
    },

    /**
     * Query chunked wallet state from relay
     * First fetches chunk-0 to get total count, then fetches all chunks
     * @param {string} pubkeyHex - User's public key
     * @param {string|null} relayUrl - Optional relay URL
     * @returns {Promise<Object|null>} - Reconstructed wallet state or null
     */
    async queryWalletStateChunked(pubkeyHex, relayUrl = null) {
        // Use DM_RELAY by default for authenticated connections
        const relay = relayUrl || this.DM_RELAY;
        const self = this;

        try {
            // First, query for chunk-0 to get total count
            const chunk0 = await this._queryWalletChunk(pubkeyHex, 0, relay);
            if (!chunk0) {
                console.log('[nostr] No chunked wallet state found (no chunk-0)');
                return null;
            }

            const totalChunks = chunk0.total;
            console.log(`[nostr] Found chunked wallet state with ${totalChunks} chunks`);

            // Fetch all chunks
            const chunks = [chunk0];
            for (let i = 1; i < totalChunks; i++) {
                const chunk = await this._queryWalletChunk(pubkeyHex, i, relay);
                if (!chunk) {
                    console.error(`[nostr] Missing wallet chunk ${i}/${totalChunks}`);
                    return null;
                }
                chunks.push(chunk);
            }

            // Sort chunks by index and reconstruct
            // Use nostr-chunked-events library if available
            let fullStateJson;
            if (typeof NostrChunkedEvents !== 'undefined' && NostrChunkedEvents.reassembleChunks) {
                // Convert to library format
                const chunkDataArray = chunks.map(c => ({
                    index: c.chunk,
                    total: c.total,
                    data: c.data
                }));

                // Validate chunks
                const validation = NostrChunkedEvents.validateChunks(chunkDataArray);
                if (!validation.valid) {
                    console.error('[nostr] Chunk validation failed:', validation);
                    return null;
                }

                fullStateJson = NostrChunkedEvents.reassembleChunks(chunkDataArray);
                console.log('[nostr] Using nostr-chunked-events library for reassembly');
            } else {
                // Fallback to manual reassembly
                chunks.sort((a, b) => a.chunk - b.chunk);
                fullStateJson = chunks.map(c => c.data).join('');
            }

            try {
                const state = JSON.parse(fullStateJson);
                console.log('[nostr] Reconstructed chunked wallet state, tokens:', state.tokens?.length || 0);
                return { state, chunked: true, totalChunks };
            } catch (e) {
                console.error('[nostr] Failed to parse reconstructed wallet state:', e);
                return null;
            }

        } catch (error) {
            console.error('[nostr] queryWalletStateChunked error:', error);
            return null;
        }
    },

    /**
     * Query a single wallet chunk
     * @private
     */
    /**
     * Query events directly from the relay via WebSocket, bypassing the
     * backend's caching gateway.
     *
     * Needed because the backend `/api/v1/nostr/query` response is served
     * from a cache that does NOT invalidate on new writes — a push that
     * strfry already ACKed can take tens of seconds (or never) to appear
     * in the cached result, and any stale snapshot the cache currently
     * holds keeps winning the selector. This helper talks to the relay
     * directly so the read-back validation path can see the relay's true
     * current state within the budget.
     *
     * Returns a list of raw Nostr events (with real id + signature).
     *
     * @param {Object} filter - Nostr REQ filter
     * @param {string} [relayUrl] - Relay URL, defaults to DEFAULT_RELAY
     * @param {number} [timeoutMs=8000] - Timeout for EOSE / close
     * @returns {Promise<Array<Object>>}
     */
    async queryEventsDirect(filter, relayUrl = null, timeoutMs = 8000) {
        const self = this;
        const relay = relayUrl || this.DEFAULT_RELAY;
        return new Promise((resolve) => {
            const events = [];
            let resolved = false;
            let connection = null;

            const resolveOnce = () => {
                if (resolved) return;
                resolved = true;
                if (connection?.cleanup) connection.cleanup();
                resolve(events);
            };

            const onReady = (ws) => {
                const subscriptionId = 'direct_' + Date.now().toString(36);
                ws.send(JSON.stringify(['REQ', subscriptionId, filter]));
            };

            const onMessage = (msg) => {
                if (msg[0] === 'EVENT') {
                    if (msg[2]) events.push(msg[2]);
                } else if (msg[0] === 'EOSE') {
                    resolveOnce();
                }
            };

            const onError = (error) => {
                console.warn('[nostr] queryEventsDirect error:', error);
                resolveOnce();
            };

            connection = self.createAuthenticatedConnection(relay, onReady, onMessage, onError, timeoutMs);
        });
    },

    async _queryWalletChunk(pubkeyHex, chunkIndex, relay) {
        const self = this;
        return new Promise((resolve) => {
            let resolved = false;
            let connection = null;

            const resolveOnce = (value) => {
                if (!resolved) {
                    resolved = true;
                    if (connection?.cleanup) connection.cleanup();
                    resolve(value);
                }
            };

            const onReady = (ws) => {
                const subscriptionId = 'chunk_' + chunkIndex + '_' + Date.now();
                const filter = {
                    kinds: [37375],
                    authors: [pubkeyHex],
                    '#d': [`wallet-chunk-${chunkIndex}`],
                    limit: 1
                };
                ws.send(JSON.stringify(['REQ', subscriptionId, filter]));
            };

            const onMessage = async (msg) => {
                if (msg[0] === 'EVENT') {
                    const nostrEvent = msg[2];
                    const content = nostrEvent?.content;
                    if (content) {
                        try {
                            // Decrypt NIP-04 content (must have ?iv= format)
                            const authCreds = self._authCredentials;
                            if (!authCreds?.privateKeyHex || !authCreds?.publicKeyHex) {
                                console.warn('[nostr] No auth credentials for chunk decryption');
                                resolveOnce(null);
                                return;
                            }

                            // Verify content is NIP-04 encrypted format
                            if (typeof content !== 'string' || !content.includes('?iv=')) {
                                console.error(`[nostr] Chunk ${chunkIndex} content is not NIP-04 encrypted format`);
                                resolveOnce(null);
                                return;
                            }

                            const privKeyBytes = self.hexToBytes(authCreds.privateKeyHex);
                            const decrypted = await window.NostrTools.nip04.decrypt(
                                privKeyBytes,
                                authCreds.publicKeyHex,
                                content
                            );
                            const chunkData = JSON.parse(decrypted);
                            resolveOnce(chunkData);
                            return;
                        } catch (e) {
                            console.error(`[nostr] Failed to decrypt chunk ${chunkIndex}:`, e);
                        }
                    }
                } else if (msg[0] === 'EOSE') {
                    resolveOnce(null);
                }
            };

            const onError = (error) => {
                console.error(`[nostr] Chunk ${chunkIndex} query error:`, error);
                resolveOnce(null);
            };

            connection = self.createAuthenticatedConnection(relay, onReady, onMessage, onError, 8000);
        });
    },

    /**
     * Publish to multiple relays in parallel
     * @param {Object} signedEvent - Signed event to publish
     * @param {string[]} relayUrls - Array of relay URLs
     * @param {string} privateKeyHex - Optional private key for NIP-42 auth
     * @returns {Promise<Object>} - { successes: string[], failures: string[] }
     */
    async publishToMultipleRelays(signedEvent, relayUrls, privateKeyHex = null) {
        const results = await Promise.allSettled(
            relayUrls.map(url => this.publishEvent(signedEvent, url, privateKeyHex).then(success => ({ url, success })))
        );

        const successes = [];
        const failures = [];

        results.forEach((result, i) => {
            if (result.status === 'fulfilled' && result.value.success) {
                successes.push(relayUrls[i]);
            } else {
                failures.push(relayUrls[i]);
            }
        });

        console.log(`[nostr] Published to ${successes.length}/${relayUrls.length} relays`);
        return { successes, failures };
    },

    // ========================================
    // NIP-17 Private Direct Messages (Gift Wrapped)
    // ========================================

    /**
     * NIP-17 event kinds
     */
    NIP17_KINDS: {
        GIFT_WRAP: 1059,
        SEAL: 13,
        RUMOR: 14
    },

    /**
     * Active NIP-17 DM subscriptions
     */
    _nip17Subscriptions: new Map(),

    /**
     * Unwrap a NIP-17 gift wrap (kind 1059) to extract the seal.
     * Uses NIP-44 decryption with recipient's private key.
     *
     * @param {Object} giftWrapEvent - The kind 1059 event
     * @param {string} recipientPrivKeyHex - Recipient's private key (hex)
     * @returns {Promise<Object|null>} - Decrypted seal object or null
     */
    async unwrapGiftWrap(giftWrapEvent, recipientPrivKeyHex) {
        if (!giftWrapEvent || giftWrapEvent.kind !== this.NIP17_KINDS.GIFT_WRAP) {
            console.warn('[nostr] Invalid gift wrap event, kind:', giftWrapEvent?.kind);
            return null;
        }

        const ephemeralPubkey = giftWrapEvent.pubkey;
        const encryptedContent = giftWrapEvent.content;

        if (!ephemeralPubkey || !encryptedContent) {
            console.warn('[nostr] Gift wrap missing pubkey or content');
            return null;
        }

        // Check if private key is provided
        if (!recipientPrivKeyHex) {
            console.error('[nostr] No recipient private key provided for gift wrap decryption');
            return null;
        }

        try {
            // NIP-17 gift wraps use NIP-44 encryption exclusively
            const privKeyBytes = this.hexToBytes(recipientPrivKeyHex);

            console.log('[nostr] Attempting to unwrap gift wrap, ephemeral pubkey:', ephemeralPubkey.substring(0, 16) + '...');

            if (!window.NostrTools?.nip44?.decrypt) {
                console.error('[nostr] NIP-44 not available - cannot decrypt NIP-17 gift wrap');
                return null;
            }

            let decrypted;
            try {
                // NIP-44 uses conversation key derived from both keys
                const conversationKey = window.NostrTools.nip44.getConversationKey(privKeyBytes, ephemeralPubkey);
                decrypted = window.NostrTools.nip44.decrypt(encryptedContent, conversationKey);
                console.log('[nostr] Gift wrap decrypted with NIP-44');
            } catch (e44) {
                console.warn('[nostr] NIP-44 decrypt failed:', e44.message);
                return null;
            }

            if (!decrypted) {
                console.warn('[nostr] Gift wrap decryption returned empty result');
                return null;
            }

            // Parse seal JSON
            const seal = JSON.parse(decrypted);
            return seal;

        } catch (error) {
            console.error('[nostr] Failed to unwrap gift wrap:', error);
            return null;
        }
    },

    /**
     * Unseal a NIP-17 seal (kind 13) to extract the rumor.
     * Uses NIP-44 decryption with recipient's private key.
     *
     * @param {Object} sealEvent - The kind 13 seal object (decrypted from gift wrap)
     * @param {string} recipientPrivKeyHex - Recipient's private key (hex)
     * @returns {Promise<Object|null>} - Decrypted rumor object with senderPubkey added
     */
    async unsealToRumor(sealEvent, recipientPrivKeyHex) {
        if (!sealEvent || sealEvent.kind !== this.NIP17_KINDS.SEAL) {
            console.warn('[nostr] Invalid seal event');
            return null;
        }

        const senderPubkey = sealEvent.pubkey;
        const encryptedContent = sealEvent.content;

        if (!senderPubkey || !encryptedContent) {
            console.warn('[nostr] Seal missing pubkey or content');
            return null;
        }

        try {
            // NIP-17 seals use NIP-44 encryption exclusively
            const privKeyBytes = this.hexToBytes(recipientPrivKeyHex);

            if (!window.NostrTools?.nip44?.decrypt) {
                console.error('[nostr] NIP-44 not available - cannot decrypt NIP-17 seal');
                return null;
            }

            let decrypted;
            try {
                const conversationKey = window.NostrTools.nip44.getConversationKey(privKeyBytes, senderPubkey);
                decrypted = window.NostrTools.nip44.decrypt(encryptedContent, conversationKey);
                console.log('[nostr] Seal decrypted with NIP-44');
            } catch (e44) {
                console.warn('[nostr] NIP-44 seal decrypt failed:', e44.message);
                return null;
            }

            if (!decrypted) {
                console.warn('[nostr] Seal decryption returned empty result');
                return null;
            }

            // Parse rumor JSON and add sender pubkey
            const rumor = JSON.parse(decrypted);
            rumor.senderPubkey = senderPubkey;
            return rumor;

        } catch (error) {
            console.error('[nostr] Failed to unseal:', error);
            return null;
        }
    },

    /**
     * Fully unwrap a NIP-17 DM: gift wrap -> seal -> rumor
     *
     * @param {Object} giftWrapEvent - The kind 1059 event
     * @param {string} recipientPrivKeyHex - Recipient's private key (hex)
     * @returns {Promise<Object|null>} - { senderPubkey, content, createdAt, tags } or null
     */
    async unwrapNip17Dm(giftWrapEvent, recipientPrivKeyHex) {
        // Step 1: Unwrap gift wrap to get seal
        const seal = await this.unwrapGiftWrap(giftWrapEvent, recipientPrivKeyHex);
        if (!seal) {
            return null;
        }

        // Step 2: Unseal to get rumor
        const rumor = await this.unsealToRumor(seal, recipientPrivKeyHex);
        if (!rumor) {
            return null;
        }

        return {
            eventId: giftWrapEvent.id,
            senderPubkey: rumor.senderPubkey,
            content: rumor.content,
            createdAt: rumor.created_at,
            tags: rumor.tags || []
        };
    },

    /**
     * Parse a Cashu token transfer message from DM content.
     * Expected format: JSON with type "cashu_token_transfer" or just a token string.
     *
     * @param {string} content - DM content
     * @returns {Object|null} - { token, memo, faceValue, faceUnit, tokenAmount, backingStrategy, issuerId, ... }
     */
    parseTokenTransferMessage(content) {
        if (!content) return null;

        try {
            // Try parsing as JSON first
            const parsed = JSON.parse(content);

            // Check if it's a structured token transfer message
            if (parsed.type === 'cashu_token_transfer' || parsed.token) {
                // Feature 007-fix-voucher-currency: do NOT default faceUnit to
                // 'SAT' here. Leave it null so the receive-side resolution
                // chain (getTokenMetadata → inspectVoucher → receive()) can
                // recover the actual currency for rumors that omitted the
                // field. A silent 'SAT' default short-circuits step 1 of that
                // chain and causes USD/EUR/TZS vouchers to arrive as sats.
                const rawFaceUnit = parsed.face_unit || parsed.faceUnit || parsed.unit;
                const trimmedFaceUnit = typeof rawFaceUnit === 'string' ? rawFaceUnit.trim() : '';
                const normalizedFaceUnit = trimmedFaceUnit.length === 0 || trimmedFaceUnit.toUpperCase() === 'UNKNOWN'
                    ? null
                    : trimmedFaceUnit.toUpperCase();
                return {
                    token: parsed.token,
                    memo: parsed.memo || null,
                    faceValue: parsed.face_value || parsed.faceValue || parsed.amount_hint,
                    faceUnit: normalizedFaceUnit,
                    faceDecimals: parsed.face_decimals || parsed.faceDecimals,
                    tokenAmount: parsed.token_amount || parsed.tokenAmount || parsed.amount_hint,
                    backingStrategy: parsed.backing_strategy || parsed.backingStrategy || 'PROPORTIONAL',
                    issuerId: parsed.issuer_id || parsed.issuerId,
                    expiresAt: parsed.expires_at || parsed.expiresAt,
                    requestId: parsed.request_id || parsed.requestId,
                    voucherId: parsed.voucher_id || parsed.voucherId,
                    // sender_pubkey is included in the message when the seal is signed by a gateway/proxy
                    // This allows recipients to identify the actual sender
                    senderPubkey: parsed.sender_pubkey || parsed.senderPubkey,
                    // Spec 012-multi-voucher-send: bundle correlation. Absence
                    // of bundleId means this is a standalone send and the
                    // receiver's bundleReceiptIntegration will short-circuit
                    // back to the legacy per-token tx-record path. Presence
                    // routes through bundleReceiptStore for aggregation.
                    bundleId: parsed.bundle_id || parsed.bundleId || null,
                    bundleTotal: parsed.bundle_total || parsed.bundleTotal || null,
                    bundlePartIndex: typeof parsed.bundle_part_index === 'number'
                        ? parsed.bundle_part_index
                        : (typeof parsed.bundlePartIndex === 'number' ? parsed.bundlePartIndex : null),
                    bundlePartCount: parsed.bundle_part_count || parsed.bundlePartCount || null,
                    bundlePartId: parsed.bundle_part_id || parsed.bundlePartId || null,
                    bundleAttempt: typeof parsed.bundle_attempt === 'number'
                        ? parsed.bundle_attempt
                        : (typeof parsed.bundleAttempt === 'number' ? parsed.bundleAttempt : null)
                };
            }

            return null;
        } catch (e) {
            // Not JSON - check if it's a raw cashu token
            const trimmed = content.trim();
            if (trimmed.toLowerCase().startsWith('cashu')) {
                return {
                    token: trimmed,
                    memo: null,
                    backingStrategy: 'LEGACY'
                };
            }
            return null;
        }
    },

    /**
     * Parse a chunk-envelope reference from a decrypted NIP-17 rumor.
     *
     * Returns a normalized envelope shape, or null if the content is not a
     * recognizable chunk reference. Three input shapes are supported (see
     * specs/008-chunked-dm-fallback/contracts/chunked-dm-claim-fallback.md):
     *
     *   1) Backend canonical envelope: { type:"cashu_dm_chunk", ... }
     *   2) Legacy JSON reference:      { type:"cashu:chunk", eventId, ... }
     *   3) Plain text reference:       "cashu:chunk:<eventId>"
     *
     * The helper validates structural fields only and never throws on bad input.
     * It does NOT log raw payloads, tokens, or proofs.
     *
     * Returned shape:
     *   { kind, claimEventId, transferId, chunkIndex, chunkTotal,
     *     payloadType, contentEncoding, contentLength, contentSha256, metadata }
     *
     * - kind: 'backend' | 'legacy_json' | 'legacy_plain'
     * - claimEventId: 64-hex event ID to pass to api.claimTokenDm() — or null when
     *   the trigger is a follower chunk (chunk_index > 0) of a backend envelope.
     *   For backend anchors (chunk_index === 0), the caller MUST substitute the
     *   current gift-wrap event ID; we cannot derive it from the envelope alone.
     */
    parseChunkEnvelope(content) {
        if (typeof content !== 'string' || content.length === 0) return null;

        const HEX64 = /^[0-9a-fA-F]{64}$/;
        const isHex64 = (s) => typeof s === 'string' && HEX64.test(s);

        // 3) Plain "cashu:chunk:<eventId>" reference.
        const trimmed = content.trim();
        if (trimmed.toLowerCase().startsWith('cashu:chunk:')) {
            const ref = trimmed.slice('cashu:chunk:'.length).trim();
            if (!isHex64(ref)) return null;
            return {
                kind: 'legacy_plain',
                claimEventId: ref.toLowerCase(),
                transferId: null,
                chunkIndex: null,
                chunkTotal: null,
                payloadType: null,
                contentEncoding: null,
                contentLength: null,
                contentSha256: null,
                metadata: null
            };
        }

        // 1+2) JSON-shaped envelopes.
        let parsed;
        try {
            parsed = JSON.parse(content);
        } catch (_) {
            return null;
        }
        if (!parsed || typeof parsed !== 'object') return null;

        const type = parsed.type;
        if (type === 'cashu:chunk') {
            const eventId = parsed.eventId || parsed.event_id;
            if (!isHex64(eventId)) return null;
            // Optional metadata for legacy references — diagnostic only.
            const metadata = {};
            if (parsed.author) metadata.author = parsed.author;
            if (Array.isArray(parsed.relays)) metadata.relays = parsed.relays.slice(0, 16);
            if (parsed.memo != null) metadata.memo = parsed.memo;
            if (parsed.faceValue != null || parsed.face_value != null) {
                metadata.faceValue = parsed.faceValue || parsed.face_value;
            }
            if (parsed.faceUnit != null || parsed.face_unit != null) {
                metadata.faceUnit = parsed.faceUnit || parsed.face_unit;
            }
            const chunkCount = parsed.chunkCount || parsed.chunk_count;
            return {
                kind: 'legacy_json',
                claimEventId: eventId.toLowerCase(),
                transferId: null,
                chunkIndex: null,
                chunkTotal: typeof chunkCount === 'number' && chunkCount >= 2 ? chunkCount : null,
                payloadType: null,
                contentEncoding: null,
                contentLength: null,
                contentSha256: null,
                metadata: Object.keys(metadata).length > 0 ? metadata : null
            };
        }

        if (type === 'cashu_dm_chunk') {
            const transferId = parsed.transfer_id || parsed.transferId;
            const payloadType = parsed.payload_type || parsed.payloadType;
            const chunkIndex = (typeof parsed.chunk_index === 'number')
                ? parsed.chunk_index
                : (typeof parsed.chunkIndex === 'number' ? parsed.chunkIndex : null);
            const chunkTotal = (typeof parsed.chunk_total === 'number')
                ? parsed.chunk_total
                : (typeof parsed.chunkTotal === 'number' ? parsed.chunkTotal : null);
            const contentEncoding = parsed.content_encoding || parsed.contentEncoding || null;
            const contentLength = (typeof parsed.content_length === 'number')
                ? parsed.content_length
                : (typeof parsed.contentLength === 'number' ? parsed.contentLength : null);
            const contentSha256 = parsed.content_sha256 || parsed.contentSha256 || null;

            // Structural validation per contracts §3.
            if (typeof transferId !== 'string' || transferId.length === 0) return null;
            if (payloadType !== 'cashu_token_transfer') return null;
            if (typeof chunkIndex !== 'number' || !Number.isInteger(chunkIndex) || chunkIndex < 0) return null;
            if (typeof chunkTotal !== 'number' || !Number.isInteger(chunkTotal) || chunkTotal < 2) return null;
            if (chunkIndex >= chunkTotal) return null;
            if (contentSha256 != null && !isHex64(contentSha256)) return null;

            return {
                kind: 'backend',
                // claimEventId for backend anchor is the trigger gift-wrap event
                // ID (set by caller). Followers (chunk_index > 0) have null.
                claimEventId: null,
                transferId,
                chunkIndex,
                chunkTotal,
                payloadType,
                contentEncoding,
                contentLength,
                contentSha256: contentSha256 ? contentSha256.toLowerCase() : null,
                metadata: null
            };
        }

        return null;
    },

    /**
     * Subscribe to NIP-17 DMs for a recipient.
     * Calls the callback for each decrypted DM containing a token.
     * Uses pagination to avoid large WebSocket messages (error 1009).
     *
     * @param {string} recipientPubkeyHex - Recipient's public key (hex)
     * @param {string} recipientPrivKeyHex - Recipient's private key (hex) for decryption
     * @param {Function} onTokenDm - Callback(dm) where dm = { eventId, senderPubkey, token, metadata, createdAt }
     * @param {Object} options - { relayUrls: string[], since: timestamp, limit: number }
     * @returns {Object} - Subscription handle with stop() method
     */
    subscribeToNip17Dms(recipientPubkeyHex, recipientPrivKeyHex, onTokenDm, options = {}) {
        const self = this;
        // Use DM_RELAY by default for authenticated connections
        const relayUrls = options.relayUrls || [this.DM_RELAY];
        const since = options.since || Math.floor(Date.now() / 1000) - 86400; // Default: last 24 hours
        const pageLimit = options.limit || 25; // Limit per request to avoid message too big (1009)
        const subscriptionId = 'nip17_' + Date.now();
        const connections = [];

        console.log('[nostr] Starting NIP-17 DM subscription for:', recipientPubkeyHex.substring(0, 16) + '...', 'limit:', pageLimit);

        const processedEvents = new Set();

        for (const relayUrl of relayUrls) {
            try {
                const ws = new WebSocket(relayUrl);
                let authenticated = false;
                let oldestTimestamp = null; // Track oldest event for pagination
                let eventsInPage = 0; // Count events in current page
                let paginationEnabled = true; // Whether to fetch more pages

                // Build filter with pagination
                const buildFilter = (until = null) => {
                    const filter = {
                        kinds: [self.NIP17_KINDS.GIFT_WRAP],
                        '#p': [recipientPubkeyHex],
                        since: since,
                        limit: pageLimit
                    };
                    if (until) {
                        filter.until = until;
                    }
                    return filter;
                };

                ws.onopen = () => {
                    console.log('[nostr] NIP-17 subscription connected to:', relayUrl);

                    // Subscribe to gift wrap events addressed to us with pagination
                    const filter = buildFilter();
                    ws.send(JSON.stringify(['REQ', subscriptionId, filter]));
                };

                ws.onmessage = async (event) => {
                    try {
                        const msg = JSON.parse(event.data);

                        // Handle NIP-42 AUTH challenge
                        if (msg[0] === 'AUTH') {
                            console.log('[nostr] NIP-42 auth challenge for NIP-17 subscription');
                            try {
                                const authEvent = {
                                    kind: 22242,
                                    pubkey: recipientPubkeyHex,
                                    created_at: Math.floor(Date.now() / 1000),
                                    tags: [
                                        ['relay', relayUrl],
                                        ['challenge', msg[1]]
                                    ],
                                    content: ''
                                };
                                const signedAuth = await self.signEvent(authEvent, recipientPrivKeyHex);
                                ws.send(JSON.stringify(['AUTH', signedAuth]));
                            } catch (authErr) {
                                console.error('[nostr] NIP-17 auth failed:', authErr);
                            }
                            return;
                        }

                        if (msg[0] === 'OK' && !authenticated) {
                            authenticated = true;
                            console.log('[nostr] NIP-17 subscription authenticated');
                            // Re-send subscription after auth (relay requires auth for REQ)
                            const filter = buildFilter();
                            console.log('[nostr] Re-sending NIP-17 subscription after auth');
                            ws.send(JSON.stringify(['REQ', subscriptionId, filter]));
                            return;
                        }

                        if (msg[0] === 'EVENT' && msg[1] === subscriptionId) {
                            const giftWrapEvent = msg[2];

                            // Skip already processed events
                            if (processedEvents.has(giftWrapEvent.id)) {
                                return;
                            }
                            processedEvents.add(giftWrapEvent.id);
                            eventsInPage++;

                            // Track oldest timestamp for pagination
                            const eventTime = giftWrapEvent.created_at;
                            if (oldestTimestamp === null || eventTime < oldestTimestamp) {
                                oldestTimestamp = eventTime;
                            }

                            console.log('[nostr] Received gift wrap event:', giftWrapEvent.id.substring(0, 16) + '...', 'created_at:', eventTime);

                            // Unwrap the DM
                            const dm = await self.unwrapNip17Dm(giftWrapEvent, recipientPrivKeyHex);
                            if (!dm) {
                                console.log('[nostr] Could not unwrap gift wrap');
                                return;
                            }

                            // Parse token transfer message
                            const tokenMsg = self.parseTokenTransferMessage(dm.content);
                            if (tokenMsg && tokenMsg.token) {
                                // Use sender_pubkey from message content if available (set by gateway)
                                const actualSenderPubkey = tokenMsg.senderPubkey || dm.senderPubkey;
                                console.log('[nostr] Found token in DM from:', actualSenderPubkey.substring(0, 16) + '...');
                                onTokenDm({
                                    eventId: dm.eventId,
                                    senderPubkey: actualSenderPubkey,
                                    token: tokenMsg.token,
                                    metadata: {
                                        memo: tokenMsg.memo,
                                        face_value: tokenMsg.faceValue,
                                        face_unit: tokenMsg.faceUnit,
                                        face_decimals: tokenMsg.faceDecimals,
                                        token_amount: tokenMsg.tokenAmount,
                                        backing_strategy: tokenMsg.backingStrategy,
                                        issuer_id: tokenMsg.issuerId,
                                        voucher_id: tokenMsg.voucherId
                                    },
                                    createdAt: dm.createdAt
                                });
                            }
                        }

                        if (msg[0] === 'EOSE') {
                            console.log('[nostr] NIP-17 subscription EOSE received from:', relayUrl, 'events in page:', eventsInPage);

                            // Pagination: if we got a full page, fetch more older events
                            if (paginationEnabled && eventsInPage >= pageLimit && oldestTimestamp && oldestTimestamp > since) {
                                console.log('[nostr] Fetching next page of NIP-17 DMs, until:', oldestTimestamp - 1);
                                eventsInPage = 0; // Reset for next page
                                const nextFilter = buildFilter(oldestTimestamp - 1);
                                ws.send(JSON.stringify(['REQ', subscriptionId, nextFilter]));
                            } else {
                                console.log('[nostr] NIP-17 pagination complete, total events:', processedEvents.size);
                                paginationEnabled = false; // Done paginating, now just listen for new events
                            }
                        }

                    } catch (e) {
                        console.error('[nostr] Error processing NIP-17 message:', e);
                    }
                };

                ws.onerror = (error) => {
                    console.error('[nostr] NIP-17 subscription error:', relayUrl, error);
                };

                ws.onclose = () => {
                    console.log('[nostr] NIP-17 subscription closed:', relayUrl);
                };

                connections.push(ws);
            } catch (e) {
                console.error('[nostr] Failed to connect to relay:', relayUrl, e);
            }
        }

        // Store subscription for cleanup
        const handle = {
            id: subscriptionId,
            connections: connections,
            stop: () => {
                console.log('[nostr] Stopping NIP-17 subscription');
                for (const ws of connections) {
                    try {
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify(['CLOSE', subscriptionId]));
                            ws.close();
                        }
                    } catch (e) {
                        // Ignore close errors
                    }
                }
                self._nip17Subscriptions.delete(subscriptionId);
            }
        };

        this._nip17Subscriptions.set(subscriptionId, handle);
        return handle;
    },

    /**
     * Stop all NIP-17 subscriptions
     */
    stopAllNip17Subscriptions() {
        for (const [id, handle] of this._nip17Subscriptions) {
            handle.stop();
        }
        this._nip17Subscriptions.clear();
    },

    // ==================== BACKEND API INTEGRATION ====================
    // These methods use the nostrApi client when available for improved
    // performance via nostrdb caching and transparent chunk reassembly.

    /**
     * Check if nostrApi is available and configured
     * @returns {boolean}
     */
    isApiAvailable() {
        return typeof nostrApi !== 'undefined' &&
            typeof nostrApi.canAuthenticateRequests === 'function' &&
            nostrApi.canAuthenticateRequests();
    },

    /**
     * Query events via backend API (with nostrdb caching).
     * Backend handles relay fallback automatically via CachingNostrGatewayDecorator.
     *
     * @param {Object} filter - Query filter (kinds, authors, limit, etc.)
     * @returns {Promise<Array>} - Array of events
     */
    async queryEventsWithApi(filter) {
        if (!this.isApiAvailable()) {
            console.warn('[nostr] API not available for event query');
            return [];
        }

        try {
            const events = await nostrApi.queryEvents(filter);
            console.log(`[nostr] API query returned ${events.length} events`);
            return events;
        } catch (err) {
            console.warn('[nostr] API query failed:', err.message);
            return [];
        }
    },

    /**
     * Get profile via backend API (cached in nostrdb).
     * Backend handles relay fallback automatically via CachingNostrGatewayDecorator.
     *
     * @param {string} pubkeyHex - Public key in hex
     * @param {Object} options - Options
     * @param {boolean} [options.refresh=false] - Force refresh from relay
     * @returns {Promise<Object|null>} - Profile object or null
     */
    async getProfileWithApi(pubkeyHex, options = {}) {
        if (!this.isApiAvailable()) {
            console.warn('[nostr] API not available for profile fetch');
            return null;
        }

        try {
            const profile = await nostrApi.getProfile(pubkeyHex, options.refresh || false);
            if (profile) {
                console.log(`[nostr] API returned profile for ${pubkeyHex.substring(0, 8)}...`);
                return {
                    pubkeyHex: profile.pubkey,
                    npub: this.encodeNpub(profile.pubkey),
                    profile: {
                        name: profile.name,
                        display_name: profile.displayName,
                        about: profile.about,
                        picture: profile.picture,
                        nip05: profile.nip05,
                        lud16: profile.lud16
                    }
                };
            }
        } catch (err) {
            console.warn('[nostr] API profile fetch failed:', err.message);
        }

        // No fallback to direct relay - backend handles relay queries via nostrdb
        return null;
    },

    /**
     * Query NIP-60 wallet events via backend API.
     * Backend handles chunk reassembly transparently.
     *
     * @param {string} pubkeyHex - Wallet owner's public key
     * @param {Object} options - Query options
     * @param {number} [options.since] - Fetch events after this timestamp
     * @param {number} [options.limit] - Maximum events
     * @returns {Promise<Object>} - { proofs, history, wallets }
     */
    async queryNip60EventsWithApi(pubkeyHex, options = {}) {
        if (this.isApiAvailable()) {
            try {
                const result = await nostrApi.queryNip60Events(pubkeyHex, options);
                console.log(`[nostr] API returned NIP-60 events: ${result.proofs.length} proofs, ${result.history.length} history`);
                return result;
            } catch (err) {
                console.warn('[nostr] API NIP-60 query failed:', err.message);
            }
        }

        // Fallback: return empty result (direct relay query is complex)
        console.warn('[nostr] NIP-60 API unavailable, returning empty result');
        return { proofs: [], history: [], wallets: [] };
    },

    /**
     * Search events via backend API full-text search.
     *
     * @param {string} query - Search query
     * @param {Object} options - Search options
     * @param {number} [options.kind] - Filter by event kind
     * @param {number} [options.limit=50] - Maximum results
     * @returns {Promise<Array>} - Matching events
     */
    async searchEventsWithApi(query, options = {}) {
        if (this.isApiAvailable()) {
            try {
                const events = await nostrApi.searchEvents(query, options.kind, options.limit || 50);
                console.log(`[nostr] API search returned ${events.length} events`);
                return events;
            } catch (err) {
                console.warn('[nostr] API search failed:', err.message);
            }
        }

        // No relay fallback for search - requires nostrdb
        console.warn('[nostr] Search requires API/nostrdb');
        return [];
    },

    /**
     * Subscribe to events via backend SSE.
     * Uses nostrApi's SSE subscription for real-time events.
     *
     * @param {Object} filter - Subscription filter
     * @param {Function} onEvent - Event callback
     * @param {Function} [onError] - Error callback
     * @returns {Object|null} - Subscription handle or null if unavailable
     */
    subscribeEventsWithApi(filter, onEvent, onError) {
        if (this.isApiAvailable()) {
            try {
                return nostrApi.subscribeEvents(filter, onEvent, onError);
            } catch (err) {
                console.warn('[nostr] API subscription failed:', err.message);
            }
        }

        console.warn('[nostr] SSE subscription requires API');
        return null;
    }
};

// Export to window for use by ES modules (web components)
window.NostrUtils = NostrUtils;
