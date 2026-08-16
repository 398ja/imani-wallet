/**
 * Transmission Module
 *
 * Handles sending tokens via Nostr DMs with automatic chunking
 * and optional NIP-60 backup publishing.
 */

// Payload building
export {
  PayloadBuilder,
  createPayloadBuilder,
  MissingFaceUnitError,
  type DmPayload,
  type ChunkReferencePayload,
  type PayloadBuilderConfig,
} from './PayloadBuilder';

// Token chunking
export {
  TokenChunker,
  createTokenChunker,
  CHUNK_THRESHOLD,
  CHUNK_SIZE,
  type ChunkData,
  type ChunkReference,
  type TokenChunkerConfig,
  type PublishChunkedOptions,
} from './TokenChunker';

// DM sending
export {
  DmSender,
  createDmSender,
  type DmSenderConfig,
  type SendOptions,
  type SendResult,
} from './DmSender';

// NIP-60 publishing
export {
  Nip60Publisher,
  createNip60Publisher,
  type CashuProof,
  type TokenEntry,
  type DecodedToken,
  type Nip60PublisherConfig,
  type PublishOptions,
  type PublishResult,
} from './Nip60Publisher';
