/**
 * Recipient Module
 *
 * Exports for recipient resolution operations.
 */

export {
  Nip05Resolver,
  createNip05Resolver,
  type Nip05ResolverConfig,
} from './Nip05Resolver';

export {
  RelayDiscovery,
  createRelayDiscovery,
  type RelayDiscoveryConfig,
  type RelayList,
} from './RelayDiscovery';

export {
  ProfileFetcher,
  createProfileFetcher,
  type ProfileFetcherConfig,
  type ProfileResult,
} from './ProfileFetcher';

export {
  RecipientResolver,
  createRecipientResolver,
  type RecipientResolverConfig,
  type ResolveOptions,
} from './RecipientResolver';
