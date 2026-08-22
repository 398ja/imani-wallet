import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Copy, Pencil, Share2 } from "lucide-react";
import QRCode from "qrcode";
import { nip19 } from "nostr-tools";

import { Avatar, Screen, BackLink, RawDetails } from "../components/ui";
import { formatDate, shortPubkey } from "../lib/format";
import { profileName, type Profile } from "../lib/profile";

/**
 * Your own profile, as others see it.
 *
 * Rendered straight from the local record with no fetch — the copy is refreshed
 * from the relay on login and after every save, so re-fetching here would only
 * add a spinner to a screen that already has the answer. (bottin does the same
 * for one's own profile, and fetches only when viewing someone else's.)
 *
 * Only the current user's profile. Looking at a merchant is MerchantPage's job.
 *
 * ## Why this is a card and not a bio
 *
 * It used to be the shape every app gives a profile: centred avatar, name,
 * about, and an Edit button as the loudest thing on a screen you came to read.
 * Nothing on it could be *used*, which is a strange thing to say about the one
 * screen that answers "how does money reach me".
 *
 * So it is built from the vocabulary this wallet already has for a thing you
 * hold — `Pass`: an optional strip, an identity row, one labelled primary
 * field, a barcode. Your identity is the one pass you carry that is not a
 * coupon, and where a coupon puts its balance, this puts your address. That is
 * what the card is for.
 *
 * The primary field is the FULL `song@domain`, deliberately. `handleLabel`
 * shortens it to `@song` everywhere else in the app on the grounds that the
 * domain identifies nobody — true when it sits under a name in a list, wrong
 * here, where the whole point is the string a person types or scans to pay you.
 * This screen is where the full form lives.
 */
export function ProfilePage({ profile }: { profile: Profile }) {
  const [enlarged, setEnlarged] = useState(false);

  // Same fallback chain as Receive: accounts registered before handles existed
  // have no NIP-05, and on a dev machine nothing resolves one anyway, so the
  // npub is the address. Encoding is fallible on a malformed record.
  const npub = (() => {
    try {
      return nip19.npubEncode(profile.pubkey);
    } catch {
      return null;
    }
  })();
  const address = profile.nip05 ?? npub;

  return (
    <Screen>
      <BackLink to="/" label="Wallet" />

      <IdentityCard
        profile={profile}
        address={address}
        onEnlarge={() => setEnlarged(true)}
      />

      {address && <AddressActions address={address} />}

      {profile.about && (
        <section className="mt-6">
          <h2 className="mb-2 text-sm font-medium text-mono-500">About</h2>
          <p className="whitespace-pre-wrap text-mono-900 dark:text-mono-50">
            {profile.about}
          </p>
        </section>
      )}

      {profile.website && (
        <section className="mt-6">
          <h2 className="mb-2 text-sm font-medium text-mono-500">Website</h2>
          <a
            href={profile.website}
            target="_blank"
            // noreferrer as well as noopener: the target must not be handed
            // window.opener, nor the URL of the wallet screen it came from.
            rel="noopener noreferrer"
            className="pressable break-all text-mono-900 underline decoration-mono-300 underline-offset-4 hover:decoration-mono-900 dark:text-mono-50 dark:decoration-mono-700 dark:hover:decoration-mono-50"
          >
            {profile.website}
          </a>
        </section>
      )}

      {/* Only what the card does not already show. The address is up there in
          full, so repeating it here would be a third copy of one string. */}
      <div className="mt-6">
        <RawDetails
          entries={[
            ...(npub
              ? ([["Public key", npub]] as Array<[string, React.ReactNode]>)
              : []),
            ["Updated", formatDate(profile.updatedAt) ?? "—"],
          ]}
        />
      </div>

      {enlarged && address && (
        <AddressDialog address={address} onClose={() => setEnlarged(false)} />
      )}
    </Screen>
  );
}

/**
 * The card. A `Pass` for the one thing in the wallet that is not a coupon.
 *
 * The strip, the identity row, the labelled primary field and the barcode are
 * `Pass`'s layout, on the app's own surface rather than an issuer's colours —
 * nobody issued this one. The merchant badge on the avatar comes free: `Avatar`
 * resolves it from the pubkey, so a stall owner's card wears the same mark here
 * that their customers see.
 */
function IdentityCard({
  profile,
  address,
  onEnlarge,
}: {
  profile: Profile;
  address: string | null;
  onEnlarge: () => void;
}) {
  const navigate = useNavigate();

  return (
    <div className="overflow-hidden rounded-2xl border border-mono-200 bg-white dark:border-mono-800 dark:bg-mono-900">
      {profile.banner && (
        // Issuer-supplied URL, same treatment as the pass strip: no referrer,
        // and a dead link leaves a plain band rather than a broken-image icon.
        <img
          src={profile.banner}
          alt=""
          referrerPolicy="no-referrer"
          className="h-24 w-full bg-mono-100 object-cover dark:bg-mono-800"
        />
      )}

      <div className="p-5">
        <div className="flex items-center gap-3">
          <Avatar
            src={profile.picture}
            name={profileName(profile)}
            pubkey={profile.pubkey}
            size="lg"
          />
          {/*
            The display name and nothing else — deliberately NOT `profileName`,
            which falls back through the handle to a shortened npub. Both of
            those are about to appear in the primary field at twice the size,
            and `profileName`'s fallback truncates the npub differently from
            `shortPubkey`, so a handle-less account showed the same key twice,
            in two different truncations, on one card.

            With no display name there is no name line: the address IS the
            identity, it is stated once, and the pencil beside the gap is the
            invitation to give yourself a name.
          */}
          {profile.displayName ? (
            <p className="min-w-0 flex-1 truncate text-lg font-semibold text-mono-900 dark:text-mono-50">
              {profile.displayName}
            </p>
          ) : (
            <span className="flex-1" />
          )}
          {/* Edit belongs on the card, next to what it edits — not as a
              full-width button below the fold. 44px target, 16px glyph. */}
          <button
            type="button"
            onClick={() => navigate("/settings/profile")}
            aria-label="Edit profile"
            className="pressable -mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-mono-500 outline-none ring-mono-400 hover:text-mono-900 focus-visible:ring-2 dark:hover:text-mono-50"
          >
            <Pencil className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* The pass's primary field: its label treatment, its slot. */}
        <div className="mt-6">
          <p className="text-xs font-medium tracking-wide text-mono-500">
            Your address
          </p>
          {address ? (
            <p className="mt-1 break-words text-2xl font-semibold text-mono-900 dark:text-mono-50">
              {/* An npub is 63 characters and unreadable whole; a handle is a
                  word and is shown as one. Either way the code below carries
                  the full string, and the record at the foot of the page has
                  it in a form you can select. */}
              {profile.nip05 ?? shortPubkey(address)}
            </p>
          ) : (
            <p className="mt-1 text-sm text-mono-500">
              This account has no usable address yet.
            </p>
          )}
        </div>

        {address && <CardBarcode address={address} onEnlarge={onEnlarge} />}
      </div>
    </div>
  );
}

/**
 * The barcode slot.
 *
 * On the card rather than behind a tap, because every other pass in this wallet
 * shows its code inline and this one is no different — you open this screen in
 * front of somebody, and the code is what they came for. Tapping enlarges it,
 * for a scan across a counter or off a dim screen.
 *
 * A failure is silent, exactly as `Pass` treats it: a card without its code is
 * still a card, and the address is legible above it.
 */
function CardBarcode({
  address,
  onEnlarge,
}: {
  address: string;
  onEnlarge: () => void;
}) {
  const dataUrl = useQrCode(address);

  if (!dataUrl) return null;

  return (
    // Shrink-wrapped to the code and centred, which is `Pass`'s barcode exactly.
    // Stretched full-width it becomes a slab of white — barely visible on a
    // white card, and the brightest thing on the screen in dark mode.
    <div className="mt-5 flex justify-center">
      <button
        type="button"
        onClick={onEnlarge}
        aria-label="Show address full screen"
        // A white panel on a white card has no edge, so the code needs its own
        // hairline to read as an inset object. `Pass` gets that edge free from the
        // merchant's background colour; nobody issued this card.
        className="pressable flex flex-col items-center gap-2 rounded-xl bg-white p-3 ring-1 ring-mono-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400"
      >
        <img src={dataUrl} alt={`QR code for ${address}`} className="w-40" />
        <span className="text-xs text-mono-500">Tap to enlarge</span>
      </button>
    </div>
  );
}

/**
 * Copy and Share: the two ways to hand somebody an address that are not a
 * camera. Both are RedeemPage's, verbatim — same job, so the same controls and
 * the same words. Share renders only where the API exists.
 */
function AddressActions({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const canShare = typeof navigator.share === "function";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied. The address is on screen to be typed.
    }
  };

  const share = async () => {
    try {
      await navigator.share({ text: address });
    } catch {
      // Cancelled, almost always — the button only renders where share exists.
    }
  };

  const style =
    "pressable flex min-h-11 flex-1 items-center justify-center gap-2 rounded-2xl border border-mono-200 text-sm font-medium text-mono-900 outline-none ring-mono-400 focus-visible:ring-2 dark:border-mono-800 dark:text-mono-50";

  return (
    <div className="mt-3 flex gap-3">
      <button type="button" onClick={copy} className={style}>
        {copied ? (
          <Check className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Copy className="h-4 w-4" aria-hidden="true" />
        )}
        {/* The control keeps its name through the action: Copy → Copied. */}
        <span aria-live="polite">{copied ? "Copied" : "Copy address"}</span>
      </button>
      {canShare && (
        <button type="button" onClick={share} className={style}>
          <Share2 className="h-4 w-4" aria-hidden="true" />
          Share
        </button>
      )}
    </div>
  );
}

/**
 * The address, big enough to scan across a counter.
 *
 * A native `<dialog>`: the top layer, the backdrop, focus containment, Escape
 * and the returned focus all come from the platform. A hand-rolled overlay
 * would get at least three of those wrong.
 */
function AddressDialog({
  address,
  onClose,
}: {
  address: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const dataUrl = useQrCode(address);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      // Dim to focus: a modal task pushes everything else back.
      className="materialize m-auto w-[calc(100%-2.5rem)] max-w-sm rounded-[20px] bg-transparent p-0 backdrop:bg-mono-950/50 backdrop:backdrop-blur-sm"
      // A click landing on the element itself rather than on the card is a
      // click on the backdrop, which is a click outside.
      onClick={(e) => e.target === e.currentTarget && ref.current?.close()}
    >
      <div className="material flex flex-col items-center gap-4 rounded-[20px] p-5 shadow-xl shadow-mono-950/20 ring-1 ring-mono-900/5 dark:ring-mono-50/10">
        {dataUrl ? (
          <img
            src={dataUrl}
            alt={`QR code for ${address}`}
            className="w-full rounded-2xl bg-white p-4"
          />
        ) : (
          <p className="p-8 text-sm text-mono-500">
            The code could not be drawn.
          </p>
        )}
        <p className="break-words text-center text-lg font-semibold text-mono-900 dark:text-mono-50">
          {address}
        </p>
        <button
          type="button"
          onClick={() => ref.current?.close()}
          className="pressable min-h-11 w-full rounded-2xl bg-mono-900 text-sm font-medium text-mono-50 outline-none ring-mono-400 focus-visible:ring-2 dark:bg-mono-50 dark:text-mono-900"
        >
          Done
        </button>
      </div>
    </dialog>
  );
}

/** One QR, drawn once per address. Null until it lands, or if it never does. */
function useQrCode(message: string): string | null {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    QRCode.toDataURL(message, { width: 512, margin: 1 }).then(
      (url) => {
        if (live) setDataUrl(url);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [message]);

  return dataUrl;
}
