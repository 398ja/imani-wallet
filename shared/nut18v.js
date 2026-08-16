/**
 * NUT-18V Voucher Payment Request Module
 *
 * Implements voucher payment requests as defined in cashu-lib's VoucherPaymentRequest.
 * Uses vreqA prefix with CBOR + URL-safe Base64 encoding.
 *
 * Compatible with: cashu-lib VoucherPaymentRequest.java
 *
 * @see https://github.com/cashubtc/nuts/blob/main/18.md
 */

const NUT18V = (function() {
    'use strict';

    // Constants matching VoucherPaymentRequest.java
    const REQUEST_PREFIX = 'vreq';
    const VERSION_CODE = 'A';
    const FULL_PREFIX = REQUEST_PREFIX + VERSION_CODE;  // 'vreqA'
    const URI_SCHEME = 'cashu:';

    // Transport types matching VoucherTransportType.java
    const TRANSPORT_TYPES = {
        NOSTR: 'nostr',
        POST: 'post',
        MERCHANT: 'merchant'
    };

    // ========================================
    // Minimal CBOR Encoder/Decoder
    // ========================================
    // Only implements what we need for NUT-18V

    const CBOR = {
        /**
         * Encode a JavaScript value to CBOR bytes
         */
        encode(value) {
            const parts = [];
            this._encodeValue(value, parts);

            // Flatten parts into a single Uint8Array
            const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
            const result = new Uint8Array(totalLength);
            let offset = 0;
            for (const part of parts) {
                result.set(part, offset);
                offset += part.length;
            }
            return result;
        },

        _encodeValue(value, parts) {
            if (value === null || value === undefined) {
                parts.push(new Uint8Array([0xf6]));  // null
            } else if (typeof value === 'boolean') {
                parts.push(new Uint8Array([value ? 0xf5 : 0xf4]));
            } else if (typeof value === 'number') {
                this._encodeInteger(value, parts);
            } else if (typeof value === 'string') {
                this._encodeString(value, parts);
            } else if (Array.isArray(value)) {
                this._encodeArray(value, parts);
            } else if (typeof value === 'object') {
                this._encodeMap(value, parts);
            } else {
                throw new Error('Unsupported CBOR type: ' + typeof value);
            }
        },

        _encodeInteger(n, parts) {
            if (!Number.isInteger(n)) {
                throw new Error('CBOR: Only integers supported, got: ' + n);
            }
            if (n >= 0) {
                // Major type 0: unsigned integer
                this._encodeTypeAndValue(0, n, parts);
            } else {
                // Major type 1: negative integer (-1 - n)
                this._encodeTypeAndValue(1, -1 - n, parts);
            }
        },

        _encodeTypeAndValue(majorType, value, parts) {
            const typeHeader = majorType << 5;
            if (value < 24) {
                parts.push(new Uint8Array([typeHeader | value]));
            } else if (value < 256) {
                parts.push(new Uint8Array([typeHeader | 24, value]));
            } else if (value < 65536) {
                parts.push(new Uint8Array([typeHeader | 25, value >> 8, value & 0xff]));
            } else if (value < 4294967296) {
                parts.push(new Uint8Array([
                    typeHeader | 26,
                    (value >> 24) & 0xff,
                    (value >> 16) & 0xff,
                    (value >> 8) & 0xff,
                    value & 0xff
                ]));
            } else {
                // 8-byte integer
                const hi = Math.floor(value / 4294967296);
                const lo = value % 4294967296;
                parts.push(new Uint8Array([
                    typeHeader | 27,
                    (hi >> 24) & 0xff,
                    (hi >> 16) & 0xff,
                    (hi >> 8) & 0xff,
                    hi & 0xff,
                    (lo >> 24) & 0xff,
                    (lo >> 16) & 0xff,
                    (lo >> 8) & 0xff,
                    lo & 0xff
                ]));
            }
        },

        _encodeString(s, parts) {
            const encoder = new TextEncoder();
            const bytes = encoder.encode(s);
            // Major type 3: text string
            this._encodeTypeAndValue(3, bytes.length, parts);
            parts.push(bytes);
        },

        _encodeArray(arr, parts) {
            // Major type 4: array
            this._encodeTypeAndValue(4, arr.length, parts);
            for (const item of arr) {
                this._encodeValue(item, parts);
            }
        },

        _encodeMap(obj, parts) {
            // Filter out null/undefined values (JsonInclude.NON_NULL behavior)
            const entries = Object.entries(obj).filter(([, v]) => v !== null && v !== undefined);
            // Major type 5: map
            this._encodeTypeAndValue(5, entries.length, parts);
            for (const [key, value] of entries) {
                this._encodeString(key, parts);
                this._encodeValue(value, parts);
            }
        },

        /**
         * Decode CBOR bytes to a JavaScript value
         */
        decode(bytes) {
            if (!(bytes instanceof Uint8Array)) {
                bytes = new Uint8Array(bytes);
            }
            const state = { bytes, offset: 0 };
            return this._decodeValue(state);
        },

        _decodeValue(state) {
            const byte = state.bytes[state.offset++];
            const majorType = byte >> 5;
            const additionalInfo = byte & 0x1f;

            switch (majorType) {
                case 0: // unsigned integer
                    return this._decodeInteger(state, additionalInfo);
                case 1: // negative integer
                    return -1 - this._decodeInteger(state, additionalInfo);
                case 2: // byte string
                    return this._decodeByteString(state, additionalInfo);
                case 3: // text string
                    return this._decodeTextString(state, additionalInfo);
                case 4: // array
                    return this._decodeArray(state, additionalInfo);
                case 5: // map
                    return this._decodeMap(state, additionalInfo);
                case 7: // simple/float
                    switch (additionalInfo) {
                        case 20: return false;
                        case 21: return true;
                        case 22: return null;
                        case 23: return undefined;
                        default:
                            throw new Error('Unsupported CBOR simple value: ' + additionalInfo);
                    }
                default:
                    throw new Error('Unsupported CBOR major type: ' + majorType);
            }
        },

        _decodeInteger(state, additionalInfo) {
            if (additionalInfo < 24) {
                return additionalInfo;
            } else if (additionalInfo === 24) {
                return state.bytes[state.offset++];
            } else if (additionalInfo === 25) {
                const val = (state.bytes[state.offset] << 8) | state.bytes[state.offset + 1];
                state.offset += 2;
                return val;
            } else if (additionalInfo === 26) {
                const val = (state.bytes[state.offset] << 24) |
                           (state.bytes[state.offset + 1] << 16) |
                           (state.bytes[state.offset + 2] << 8) |
                           state.bytes[state.offset + 3];
                state.offset += 4;
                return val >>> 0;  // Unsigned
            } else if (additionalInfo === 27) {
                // 8-byte integer - combine as BigInt then convert if safe
                let val = 0;
                for (let i = 0; i < 8; i++) {
                    val = val * 256 + state.bytes[state.offset++];
                }
                return val;
            }
            throw new Error('Invalid CBOR integer additional info: ' + additionalInfo);
        },

        _decodeByteString(state, additionalInfo) {
            const length = this._decodeInteger({ bytes: state.bytes, offset: state.offset - 1 }, additionalInfo);
            if (additionalInfo >= 24) {
                // Re-decode to advance offset properly
                const tempState = { bytes: state.bytes, offset: state.offset };
                this._decodeInteger(tempState, additionalInfo);
                state.offset = tempState.offset;
            }
            const bytes = state.bytes.slice(state.offset, state.offset + length);
            state.offset += length;
            return bytes;
        },

        _decodeTextString(state, additionalInfo) {
            const length = additionalInfo < 24 ? additionalInfo : this._getLengthAndAdvance(state, additionalInfo);
            const bytes = state.bytes.slice(state.offset, state.offset + length);
            state.offset += length;
            const decoder = new TextDecoder();
            return decoder.decode(bytes);
        },

        _getLengthAndAdvance(state, additionalInfo) {
            if (additionalInfo === 24) {
                return state.bytes[state.offset++];
            } else if (additionalInfo === 25) {
                const val = (state.bytes[state.offset] << 8) | state.bytes[state.offset + 1];
                state.offset += 2;
                return val;
            } else if (additionalInfo === 26) {
                const val = (state.bytes[state.offset] << 24) |
                           (state.bytes[state.offset + 1] << 16) |
                           (state.bytes[state.offset + 2] << 8) |
                           state.bytes[state.offset + 3];
                state.offset += 4;
                return val >>> 0;
            }
            throw new Error('Invalid length additional info: ' + additionalInfo);
        },

        _decodeArray(state, additionalInfo) {
            const length = additionalInfo < 24 ? additionalInfo : this._getLengthAndAdvance(state, additionalInfo);
            const arr = [];
            for (let i = 0; i < length; i++) {
                arr.push(this._decodeValue(state));
            }
            return arr;
        },

        _decodeMap(state, additionalInfo) {
            const length = additionalInfo < 24 ? additionalInfo : this._getLengthAndAdvance(state, additionalInfo);
            const obj = {};
            for (let i = 0; i < length; i++) {
                const key = this._decodeValue(state);
                const value = this._decodeValue(state);
                obj[key] = value;
            }
            return obj;
        }
    };

    // ========================================
    // Base64 URL-safe encoding/decoding
    // ========================================

    function base64UrlEncode(bytes) {
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary)
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
    }

    function base64UrlDecode(str) {
        // Add padding if needed
        let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
        while (base64.length % 4) {
            base64 += '=';
        }
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    // ========================================
    // Payment Request Functions
    // ========================================

    /**
     * Generate a NUT-18V voucher payment request
     *
     * @param {Object} options
     * @param {number} options.amount - Amount in minor units (e.g., 50000 for 500.00 XAF)
     * @param {string} options.unit - Currency code (e.g., 'XAF', 'SAT')
     * @param {string} options.issuerId - REQUIRED: Merchant's hex-encoded public key (64 chars)
     * @param {string} [options.description] - Optional memo/description
     * @param {boolean} [options.singleUse=true] - Whether request is single-use
     * @param {boolean} [options.offlineVerification=false] - Require DLEQ proofs
     * @param {string[]} [options.mints] - Array of accepted mint URLs
     * @param {number} [options.expiresAt] - Expiry Unix timestamp (seconds)
     * @param {Array} [options.transports] - Transport options (auto-generated if not provided)
     * @param {string} [options.paymentId] - Custom payment ID (auto-generated if not provided)
     *
     * @returns {Object} { paymentId, requestString, clickableUri, request }
     */
    function generateVoucherPaymentRequest(options) {
        const {
            amount,
            unit,
            issuerId,
            description = null,
            singleUse = true,
            offlineVerification = false,
            mints = null,
            expiresAt = null,
            transports = null,
            paymentId = null
        } = options;

        // Validate required fields (matching VoucherPaymentRequest.java validate())
        if (!issuerId || (typeof issuerId === 'string' && issuerId.trim() === '')) {
            throw new Error('Issuer ID (issuerId) is required for voucher payment requests');
        }
        if (amount !== null && amount !== undefined && !unit) {
            throw new Error('Unit is required when amount is specified');
        }

        // Generate payment ID if not provided
        const id = paymentId || generatePaymentId();

        // Build request object matching VoucherPaymentRequest.java structure
        // Field order: i, r, a, u, s, o, m, d, e, t, nut10 (matching @JsonPropertyOrder)
        const request = {
            i: id,                              // paymentId
            r: issuerId                         // issuerId (REQUIRED)
        };

        if (amount !== null && amount !== undefined) {
            request.a = amount;                 // amount
        }
        if (unit) {
            request.u = unit;                   // unit
        }
        if (singleUse !== null && singleUse !== undefined) {
            request.s = singleUse;              // singleUse
        }
        if (offlineVerification !== null && offlineVerification !== undefined) {
            request.o = offlineVerification;    // offlineVerification
        }
        if (mints && mints.length > 0) {
            // Strip trailing slashes from mint URLs
            request.m = mints.map(m => m.replace(/\/+$/, ''));
        }
        if (description) {
            request.d = description;            // description
        }
        if (expiresAt) {
            request.e = expiresAt;              // expiresAt
        }
        if (transports && transports.length > 0) {
            request.t = transports;             // transports
        }

        // Encode as CBOR + URL-safe Base64
        const cborBytes = CBOR.encode(request);
        const encoded = FULL_PREFIX + base64UrlEncode(cborBytes);

        return {
            paymentId: id,
            requestString: encoded,
            clickableUri: URI_SCHEME + encoded,
            request: request
        };
    }

    /**
     * Parse a NUT-18V voucher payment request
     *
     * @param {string} requestString - Encoded payment request (with or without cashu: prefix)
     * @returns {Object} Parsed payment request
     */
    function parseVoucherPaymentRequest(requestString) {
        let input = requestString.trim();

        // Strip URI scheme if present
        if (input.toLowerCase().startsWith(URI_SCHEME.toLowerCase())) {
            input = input.substring(URI_SCHEME.length);
        }

        // Validate prefix
        if (!input.startsWith(FULL_PREFIX)) {
            throw new Error('Invalid voucher payment request. Expected prefix: ' + FULL_PREFIX);
        }

        // Extract base64 payload
        const base64Payload = input.substring(FULL_PREFIX.length);

        // Decode Base64 and CBOR
        const cborBytes = base64UrlDecode(base64Payload);
        const request = CBOR.decode(cborBytes);

        // Validate required fields
        if (!request.r) {
            throw new Error('Invalid voucher payment request: missing issuer ID (r)');
        }

        // Return parsed object with friendly field names
        return {
            paymentId: request.i,
            issuerId: request.r,
            amount: request.a,
            unit: request.u,
            singleUse: request.s,
            offlineVerification: request.o,
            mints: request.m || [],
            description: request.d,
            expiresAt: request.e,
            transports: request.t || [],
            nut10: request.nut10
        };
    }

    /**
     * Check if a string is a valid voucher payment request
     *
     * @param {string} str - String to check
     * @returns {boolean}
     */
    function isVoucherPaymentRequest(str) {
        if (!str || typeof str !== 'string') return false;
        const trimmed = str.trim().toLowerCase();
        return trimmed.startsWith(FULL_PREFIX.toLowerCase()) ||
               trimmed.startsWith((URI_SCHEME + FULL_PREFIX).toLowerCase());
    }

    /**
     * Generate a unique payment ID
     *
     * @returns {string} 16-character hex payment ID
     */
    function generatePaymentId() {
        const bytes = crypto.getRandomValues(new Uint8Array(8));
        return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Create a Nostr NIP-17 transport
     *
     * @param {string} pubkeyHex - Recipient's hex public key
     * @param {string[]} [relays] - Optional array of relay URLs
     * @returns {Object} Transport object
     */
    function createNostrTransport(pubkeyHex, relays = null) {
        const transport = {
            t: TRANSPORT_TYPES.NOSTR,
            a: pubkeyHex
        };

        // Add NIP-17 tag and optional relay tags
        transport.g = [['n', '17']];
        if (relays && relays.length > 0) {
            for (const relay of relays) {
                transport.g.push(['r', relay]);
            }
        }

        return transport;
    }

    /**
     * Create an HTTP POST transport
     *
     * @param {string} url - Callback URL
     * @returns {Object} Transport object
     */
    function createHttpTransport(url) {
        return {
            t: TRANSPORT_TYPES.POST,
            a: url
        };
    }

    /**
     * Create a merchant transport
     *
     * @param {string} endpoint - Merchant redemption endpoint URL
     * @param {string} [merchantId] - Optional merchant identifier
     * @returns {Object} Transport object
     */
    function createMerchantTransport(endpoint, merchantId = null) {
        const transport = {
            t: TRANSPORT_TYPES.MERCHANT,
            a: endpoint
        };

        if (merchantId) {
            transport.g = [['merchant_id', merchantId]];
        }

        return transport;
    }

    /**
     * Get the preferred transport from a payment request
     *
     * @param {Object} request - Parsed payment request
     * @returns {Object|null} Preferred transport or null
     */
    function getPreferredTransport(request) {
        if (!request.transports || request.transports.length === 0) {
            return null;
        }
        return request.transports[0];
    }

    /**
     * Get recipient pubkey from payment request transports
     *
     * @param {Object} request - Parsed payment request
     * @returns {string|null} Recipient hex pubkey or null
     */
    function getRecipientPubkey(request) {
        if (!request.transports) return null;

        // Find Nostr transport
        const nostrTransport = request.transports.find(t => t.t === TRANSPORT_TYPES.NOSTR);
        if (nostrTransport && nostrTransport.a) {
            return nostrTransport.a;
        }

        return null;
    }

    /**
     * Check if a payment request has expired
     *
     * @param {Object} request - Parsed payment request
     * @returns {boolean}
     */
    function isExpired(request) {
        if (!request.expiresAt) return false;
        const now = Math.floor(Date.now() / 1000);
        return now > request.expiresAt;
    }

    /**
     * Check if a mint URL is permitted by the payment request
     *
     * @param {Object} request - Parsed payment request
     * @param {string} mintUrl - Mint URL to check
     * @returns {boolean}
     */
    function isMintPermitted(request, mintUrl) {
        if (!request.mints || request.mints.length === 0) {
            return true;  // No restrictions
        }
        const normalized = mintUrl.replace(/\/+$/, '').toLowerCase();
        return request.mints.some(m => m.replace(/\/+$/, '').toLowerCase() === normalized);
    }

    // ========================================
    // Public API
    // ========================================

    return {
        // Constants
        REQUEST_PREFIX: FULL_PREFIX,
        URI_SCHEME: URI_SCHEME,
        TRANSPORT_TYPES: TRANSPORT_TYPES,

        // Main functions
        generate: generateVoucherPaymentRequest,
        parse: parseVoucherPaymentRequest,
        isVoucherPaymentRequest: isVoucherPaymentRequest,

        // Transport helpers
        createNostrTransport: createNostrTransport,
        createHttpTransport: createHttpTransport,
        createMerchantTransport: createMerchantTransport,
        getPreferredTransport: getPreferredTransport,
        getRecipientPubkey: getRecipientPubkey,

        // Utility functions
        generatePaymentId: generatePaymentId,
        isExpired: isExpired,
        isMintPermitted: isMintPermitted,

        // Low-level access (for debugging/testing)
        _CBOR: CBOR
    };
})();

// Make available globally
if (typeof window !== 'undefined') {
    window.NUT18V = NUT18V;
}
