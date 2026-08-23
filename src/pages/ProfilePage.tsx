import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Check,
  Clock,
  Copy,
  Globe,
  Info,
  Pencil,
  QrCode,
  Share2,
  type LucideIcon,
} from "lucide-react";
import QRCode from "qrcode";
import { nip19 } from "nostr-tools";

import { Avatar, Screen, BackLink } from "../components/ui";
import { formatDate, handleLabel, shortPubkey } from "../lib/format";
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
 * hold — `Pass`: an optional strip, an identity row, and the controls that act
 * on it. Your identity is the one pass you carry that is not a coupon, and
 * where a coupon puts its balance, this puts your handle.
 *
 * The handle sits under the name as a contact card's second line rather than in
 * a labelled slot of its own: "Your address" was a word spent saying what the
 * string beneath it already looked like, on the one screen where the string is
 * the subject. The buttons under it say what it is for.
 *
 * The code is behind the QR glyph on the identity row rather than open on the
 * card. A coupon's barcode is inline because a coupon exists to be scanned; a
 * profile is a screen you also visit alone, and a permanent white slab in the
 * middle of it is the brightest thing there for the nine visits in ten where
 * nobody is holding up a camera.
 *
 * ## Shown short, shared whole
 *
 * The screen says `@song`, the same form `handleLabel` gives it everywhere else
 * in the app — every account on a deployment shares the domain, so the domain
 * is the half that identifies nobody, and under a name it reads as an email
 * address.
 *
 * What Copy, Share and the QR hand over is the FULL `song@domain`, because that
 * is the string that resolves: `/api/v1/resolve` and a scanner both need the
 * domain the short form drops. The two differ on purpose and nothing on screen
 * pretends otherwise — the word is "handle" throughout, and a handle is a name
 * for a person, not a transcription of a payload.
 *
 * It is also why the noun changes for an account with no NIP-05: what it has is
 * a key, and calling an npub a handle would be the one lie in the vocabulary.
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
  const handle = profile.nip05 ?? npub;

  return (
    <Screen>
      <BackLink to="/" label="Wallet" />

      <IdentityCard
        profile={profile}
        handle={handle}
        onEnlarge={() => setEnlarged(true)}
      />

      {handle && <HandleActions profile={profile} handle={handle} />}

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

      <Field icon={Clock} label="Updated">
        <p className="text-sm text-mono-500">
          {formatDate(profile.updatedAt) ?? "—"}
        </p>
      </Field>

      {enlarged && handle && (
        <HandleDialog
          profile={profile}
          handle={handle}
          onClose={() => setEnlarged(false)}
        />
      )}
    </Screen>
  );
}

/**
 * What the screen calls this account's address, and what it shows for it.
 *
 * Two functions rather than one string because they are read in different
 * places: the noun goes in button copy, the label goes where the value would.
 */
function handleNoun(profile: Profile): string {
  return profile.nip05 ? "handle" : "key";
}

function handleShown(profile: Profile, handle: string): string {
  return profile.nip05 ? handleLabel(profile.nip05) : shortPubkey(handle);
}

/**
 * Name over handle — the two-line block every contact card uses.
 *
 * Shared by the card and the enlarged code so the rule lives once: the handle
 * takes the name's own weight when there is no name, so the block always leads
 * with something that identifies the account and never states one thing twice.
 * Without it, a keyless account showed a truncation of its key on the line
 * above its key.
 */
function IdentityLines({
  profile,
  shown,
  className,
}: {
  profile: Profile;
  shown: string;
  className?: string;
}) {
  return (
    <div className={className}>
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
        {shown}
      </p>
    </div>
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
  handle,
  onEnlarge,
}: {
  profile: Profile;
  handle: string | null;
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
          {/* Deliberately not `profileName`, which falls back through the
              handle to a shortened npub — see `IdentityLines`. */}
          <IdentityLines
            profile={profile}
            shown={handle ? handleShown(profile, handle) : "No handle yet"}
            className="min-w-0 flex-1"
          />
          {/* Both controls belong on the card, next to what they act on — not
              as full-width buttons below the fold. 44px targets, 16px glyphs,
              and only the last one pulled out to the card's own padding.

              Show, then Edit: showing the code is what this screen is for, and
              the pencil is the rarer errand. The code itself stays behind the
              glyph rather than sitting open on the card — you reach for it when
              somebody is in front of you, and until then it is a white slab in
              the middle of your own profile. */}
          {handle && (
            <button
              type="button"
              onClick={onEnlarge}
              aria-label={`Show ${handleNoun(profile)} code`}
              className={ICON_BUTTON}
            >
              <QrCode className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            onClick={() => navigate("/settings/profile")}
            aria-label="Edit profile"
            className={`${ICON_BUTTON} -mr-2`}
          >
            <Pencil className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}

const ICON_BUTTON =
  "pressable flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-mono-500 outline-none ring-mono-400 hover:text-mono-900 focus-visible:ring-2 dark:hover:text-mono-50";

/**
 * The code with the account's face in the middle of it.
 *
 * The face is the point: a code held up across a counter is anonymous, and the
 * person on the other side is being asked to trust that it is yours before they
 * can read a single character of it. The avatar answers that at arm's length,
 * from the same record the name above it comes from.
 *
 * It is only safe because a QR carries its own redundancy: `useQrCode` asks for
 * error-correction level H, which recovers 30% of the symbol, and the face plus
 * its white gutter covers about a quarter of the width — well inside that, and
 * away from the three finder squares in the corners. Grow the avatar and the
 * code stops scanning, silently, on somebody else's phone.
 *
 * The white gutter is not decoration either: modules touching the avatar would
 * be read as part of it.
 */
function CodeWithFace({
  profile,
  dataUrl,
  shown,
  className,
}: {
  profile: Profile;
  dataUrl: string;
  shown: string;
  className?: string;
}) {
  return (
    <div className={`relative ${className ?? ""}`}>
      <img src={dataUrl} alt={`QR code for ${shown}`} className="w-full" />
      {/* aria-hidden: the code above already names whose it is, and the badge
          would otherwise announce "Merchant" in the middle of it. */}
      <span
        className="absolute inset-0 flex items-center justify-center"
        aria-hidden="true"
      >
        <span className="rounded-full bg-white p-1.5">
          <Avatar
            src={profile.picture}
            name={profileName(profile)}
            pubkey={profile.pubkey}
            size="lg"
          />
        </span>
      </span>
    </div>
  );
}

/**
 * Copy and Share: the two ways to hand somebody a handle that are not a camera.
 * Both are RedeemPage's, verbatim — same job, so the same controls and the same
 * words. Share renders only where the API exists.
 *
 * What goes on the clipboard and into the share sheet is the FULL `song@domain`
 * while the screen says `@song`. That is deliberate and it is the whole reason
 * these buttons exist: the short form is a name, and the long one is the string
 * that resolves.
 */
function HandleActions({
  profile,
  handle,
}: {
  profile: Profile;
  handle: string;
}) {
  const [copied, setCopied] = useState(false);
  const canShare = typeof navigator.share === "function";
  const noun = handleNoun(profile);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(handle);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied. Share is the other way out, and the code still scans.
    }
  };

  const share = async () => {
    try {
      await navigator.share({ text: handle });
    } catch {
      // Cancelled, almost always — the button only renders where share exists.
    }
  };

  return (
    <div className="mt-3 flex gap-3">
      <button type="button" onClick={copy} className={ACTION}>
        {copied ? (
          <Check className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Copy className="h-4 w-4" aria-hidden="true" />
        )}
        {/* The control keeps its name through the action: Copy → Copied. */}
        <span aria-live="polite">{copied ? "Copied" : `Copy ${noun}`}</span>
      </button>
      {canShare && (
        <button type="button" onClick={share} className={ACTION}>
          <Share2 className="h-4 w-4" aria-hidden="true" />
          Share
        </button>
      )}
    </div>
  );
}

const ACTION =
  "pressable flex min-h-11 flex-1 items-center justify-center gap-2 rounded-2xl border border-mono-200 text-sm font-medium text-mono-900 outline-none ring-mono-400 focus-visible:ring-2 dark:border-mono-800 dark:text-mono-50";

/**
 * The code, big enough to scan across a counter, with who it belongs to.
 *
 * The name and handle come with it because this is the one view where the
 * screen is turned away from its owner: the person reading it is looking at a
 * code and a face, and the two lines are how they check they are paying the
 * right person before they scan.
 *
 * A native `<dialog>`: the top layer, the backdrop, focus containment, Escape
 * and the returned focus all come from the platform. A hand-rolled overlay
 * would get at least three of those wrong.
 */
function HandleDialog({
  profile,
  handle,
  onClose,
}: {
  profile: Profile;
  handle: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const dataUrl = useQrCode(handle);

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
          <CodeWithFace
            profile={profile}
            dataUrl={dataUrl}
            shown={handleShown(profile, handle)}
            className="w-full rounded-2xl bg-white p-4"
          />
        ) : (
          <p className="p-8 text-sm text-mono-500">
            The code could not be drawn.
          </p>
        )}
        <IdentityLines
          profile={profile}
          shown={handleShown(profile, handle)}
          className="w-full text-center"
        />
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

/**
 * One QR, drawn once per value. Null until it lands, or if it never does.
 *
 * Level H because the codes on this screen wear a face — see `CodeWithFace`.
 * It costs modules, not legibility: a handle is short enough that the symbol
 * stays coarse even at the highest redundancy.
 */
function useQrCode(message: string): string | null {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    QRCode.toDataURL(message, {
      width: 512,
      margin: 1,
      errorCorrectionLevel: "H",
    }).then(
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
