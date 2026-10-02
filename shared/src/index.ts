/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

import { StrKey } from '@stellar/stellar-sdk';

export { combineExpositions } from './metrics';
export { createSemaphore } from './semaphore';

/**
 * Validate a Stellar address (Ed25519 public key in StrKey `G...` format).
 * Thin wrapper around {@link https://developers.stellar.org/docs/start/list-of-operations-and-requests/ StrKey.isValidEd25519PublicKey}
 * from `@stellar/stellar-sdk`, centralised so all compliance-adapters packages
 * share the same validation logic without duplicating the `@stellar/stellar-sdk`
 * dependency.
 */
export function isValidStellarAddress(address: string): boolean {
  return StrKey.isValidEd25519PublicKey(address);
}
