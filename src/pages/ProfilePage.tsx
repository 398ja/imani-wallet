import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Check,
  Clock,
  Copy,
  Globe,
  Info,
  Key,
  Pencil,
  Share2,
  type LucideIcon,
} from "lucide-react";
import QRCode from "qrcode";
import { nip19 } from "nostr-tools";

import { Avatar, Screen, BackLink } from "../components/ui";
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
 * hold — `Pass`: an optional strip, an identity row, a barcode. Your identity
 * is the one pass you carry that is not a coupon, and where a coupon puts its
 * balance, this puts your address. That is what the card is for.
 *
 * The address sits under the name as a contact card's second line rather than
 * in a labelled slot of its own: "Your address" was a word spent saying what
 * the string beneath it already looked like, on the one screen where the string
 * is the subject. The QR and the two buttons under it say what it is for.
 *
 * The handle is the FULL `song@domain`, deliberately. `handleLabel`
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
        <Field icon={Info} label="About">
          <p className="whitespace-pre-wrap text-mono-900 dark:text-mono-50">
            {profile.about}
          </p>
        </Field>
      )}

      {profile.website && (
        <Field icon={Globe} label="Website">
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
        </Field>
      )}

      {/* Only what the card does not already show. Without a NIP-05 the card's
          own line IS this key, shortened, and printing it again underneath
          would be one string in two truncations. */}
      {npub && profile.nip05 && (
        <Field icon={Key} label="Public key">
          <p className="break-all font-mono text-xs text-mono-400">{npub}</p>
        </Field>
      )}

      <Field icon={Clock} label="Updated">
        <p className="text-sm text-mono-500">
          {formatDate(profile.updatedAt) ?? "—"}
        </p>
      </Field>

      {enlarged && address && (
        <AddressDialog address={address} onClose={() => setEnlarged(false)} />
      )}
    </Screen>
  );
}

/**
 * Everything below the card: a glyph in a gutter, the content beside it.
 *
 * The headings this replaces — About, Website, Details — named categories, not
 * content: the prose under "About" says it is about you, and a URL announces
 * itself. A row of words in mono-500 down the page competed with the only text
 * worth reading. The glyph marks the kind of field at a glance and gives the
 * column its alignment, which is the iOS Contacts arrangement and the reason it
 * survives on a phone.
 *
 * The word is not gone, it is `sr-only`: a screen reader still hears "About",
 * because an icon with no accessible name is a decoration announced as nothing.
 * That is also the honest cost of the trade — a glyph carries less than a word,
 * so this only holds while the metaphors stay obvious ones.
 */
function Field({
  icon: Icon,
  label,
  children,
}: {
  icon: LucideIcon;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-5 flex gap-3">
      {/* mt-0.5 optically centres a 16px glyph on the first line of text
          beside it; items-start alone hangs it a shade high. */}
      <Icon
        className="mt-0.5 h-4 w-4 shrink-0 text-mono-400"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <span className="sr-only">{label}: </span>
        {children}
      </div>
    </div>
  );
}

/**
 * The card. A `Pass` for the one thing in the wallet that is not a coupon.
 *
 * The strip, the identity row and the barcode are `Pass`'s layout, on the app's
 * own surface rather than an issuer's colours —
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
            Name over address, the two-line block every contact card uses —
            deliberately NOT `profileName`, which falls back through the handle
            to a shortened npub and would put a truncation of the key on the
            line above the key itself.

            The address takes the name's own weight when there is no name, so
            the block always leads with something that identifies the account
            and never states one thing twice. The pencil beside a card carrying
            only an address is the invitation to give yourself a name.
          */}
          <div className="min-w-0 flex-1">
            {profile.displayName && (
              <p className="truncate text-lg font-semibold text-mono-900 dark:text-mono-50">
                {profile.displayName}
              </p>
            )}
            <p
              className={
                profile.displayName
                  ? "break-words text-sm text-mono-500"
                  : "break-words text-lg font-semibold text-mono-900 dark:text-mono-50"
              }
            >
              {/* An npub is 63 characters and unreadable whole, so a keyless
                  account gets the short form; a handle is a word and is shown
                  as one. Either way the code below carries the full string. */}
              {address
                ? (profile.nip05 ?? shortPubkey(address))
                : "No address yet"}
            </p>
          </div>
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
