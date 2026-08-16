import { invalidPubkeyError, validationError } from '../types/errors.js';

/**
 * Validate a hex pubkey
 */
export function validatePubkey(pubkey: string): void {
  if (!pubkey || typeof pubkey !== 'string') {
    throw invalidPubkeyError(pubkey);
  }

  // Check length (64 hex characters)
  if (pubkey.length !== 64) {
    throw invalidPubkeyError(pubkey);
  }

  // Check if valid hex
  if (!/^[0-9a-fA-F]+$/.test(pubkey)) {
    throw invalidPubkeyError(pubkey);
  }
}

/**
 * Check if a string is a valid hex pubkey
 */
export function isValidPubkey(pubkey: string): boolean {
  try {
    validatePubkey(pubkey);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a NIP-05 identifier
 */
export function validateNip05(identifier: string): void {
  if (!identifier || typeof identifier !== 'string') {
    throw validationError('NIP-05 identifier must be a non-empty string');
  }

  const parts = identifier.split('@');
  if (parts.length !== 2) {
    throw validationError('NIP-05 identifier must be in format user@domain');
  }

  const [name, domain] = parts;

  if (!name || name.length === 0) {
    throw validationError('NIP-05 name part cannot be empty');
  }

  if (!domain || domain.length === 0) {
    throw validationError('NIP-05 domain part cannot be empty');
  }

  // Basic domain validation
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$/.test(domain)) {
    throw validationError(`Invalid domain in NIP-05 identifier: ${domain}`);
  }
}

/**
 * Check if a string is a valid NIP-05 identifier
 */
export function isValidNip05(identifier: string): boolean {
  try {
    validateNip05(identifier);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize a pubkey to lowercase hex
 */
export function normalizePubkey(pubkey: string): string {
  validatePubkey(pubkey);
  return pubkey.toLowerCase();
}

/**
 * Validate latitude/longitude
 */
export function validateLocation(lat: number, lon: number): void {
  if (typeof lat !== 'number' || isNaN(lat)) {
    throw validationError('Latitude must be a number');
  }

  if (typeof lon !== 'number' || isNaN(lon)) {
    throw validationError('Longitude must be a number');
  }

  if (lat < -90 || lat > 90) {
    throw validationError('Latitude must be between -90 and 90');
  }

  if (lon < -180 || lon > 180) {
    throw validationError('Longitude must be between -180 and 180');
  }
}
