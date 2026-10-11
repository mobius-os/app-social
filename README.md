# Social

Federated social for Möbius people. Three surfaces:

- **Board** — one global community feed for every Social installation.
- **Messages** — private conversations delivered directly between Möbius
  instances. Each side keeps its own copy; changing directory never moves them.
- **People** — one global members-only directory, hosted at `www.mobius.you`.
  Joining shares the owner's handle and profile picture and enables directory
  search, posting, and private conversations.

The Board stays readable while the owner is signed out or has not joined.
People and Messages show Join instead of their contents. The Board composer
also shows Join instead of a message input. Posting, replying, and reacting
remain member actions. Social saves any existing pending action (including a post photo)
in app-scoped storage, then asks the shell to open the installed **Möbius · You**
app. If that app is absent, Social opens the App Store with its supported
`app:identity` intent so the exact listing owns installation and capability
review. Möbius · You currently owns sign-in from its own account screen; it does
not expose an app intent that may open or complete sign-in directly.

Returning to Social refreshes the authoritative profile and offers the saved
action again. Sign-in never joins the directory, and neither sign-in nor join
publishes the saved post/reply/reaction. Each transition still needs its own
explicit button. Cancelled sign-in leaves the draft waiting.

Older installations that joined a separate directory see **Join global Social**,
not an apparently empty global board. This explicit action preserves their
publication consent; Social no longer offers multiple community destinations.
Existing conversations are preserved, but require joining before they can be read.
Registration is checked against the global directory whenever the profile loads,
so a failed join remains discoverable after reopening. **Try joining again** repairs
a missing listing; an unavailable directory is shown separately from a missing
registration. Handle search accepts both `name` and `@name`. Other installations must receive this app update;
changing one instance does not update a friend's copy.
The host can read a named actor card and photo while verifying Join; if that
registration fails, the actor returns to keys only and the photo is hidden.

Social owns its server side as a reviewed app service (protocol `common/0`):
Ed25519-signed envelopes, a public actor card per instance, an inbox each
instance exposes to peers, groups, and collaborative objects. Möbius supplies
only the bounded service process, app identity, and explicit public ingress.
The app UI calls `/api/services/social`; peers call the same accepted Social
service through `/api/app-services/social`. There is no second Social server or
legacy platform route.

All Social data lives in this app's per-app storage
(`conversations/<peer-host>/…`); incoming deliveries bump `state/version.json`,
which the open app watches to refresh live.

### The shared board

The board and People directory live only on the central community host,
`www.mobius.you`. Each Möbius reads and writes them through its own Social
service (`feed`, `people`, `replies`, board media, publish, like, reply), which
talks to that host over the DNS-pinned federation transport. Board browsing
never joins or submits an interaction. Directory search requires a registered,
signed member request; direct and group conversation routes require local
membership. A personal Möbius hosts no board of its own.

### Editing and deleting

Authors can edit the text of their own posts and replies inline (Enter saves,
Escape cancels) and delete their own posts and replies. Edited items show
"(edited)". Only the authoring Möbius may edit or delete an item; replies use
their own `board_reply_delete` and `board_edit` envelopes so an older host
refuses them rather than treating them as a whole-post delete. The host remembers
deleted reply ids so a delayed retry cannot restore them, and an older or
replayed edit never overwrites a newer one. Until the Community host is updated,
these actions report that the server does not support them yet.

### Photos and captions

Direct messages, group messages, and Community posts send photo attachments
and text together. Community replies also support one photo with optional text;
text-only and photo-only replies both work. A selected photo can be removed
without losing the caption. Reply drafts retain both on a failed send, and an
unchanged retry reuses the reply identity rather than publishing twice.

Reply photos use the existing image preparation and limits (a 1 MiB image,
with a separate compact thumbnail). Their media is scoped to the parent post
and reply and removed with the post. The Community host must advertise
`reply_attachments: true` before the reply attachment button is enabled; the
personal service checks that capability again before sending. Deploy the
companion Community host release as well as this app update.

Animated GIFs use those same attachment-and-caption controls. Preparation keeps
original bytes, timing, looping and transparency instead of converting the first
frame into a JPEG. Feed and conversation previews show a still poster with a GIF
label; opening it plays the original, so scrolling never starts animation.
Selected draft previews may animate after deliberate selection.

GIF originals retain the 1 MiB per-image and 2 MiB envelope limits, with at most
1600 pixels on the longest side, 300 frames, and 32 million logical canvas pixels
summed across frames. The protocol validates complete GIF framing before decoding
all frames, on both private and public paths. Oversized animations are rejected,
not resized or flattened. A gallery may have a smaller per-image budget.
Community GIF posts/replies require explicit `gif_attachments: true`; discovery
and the signed write share a bounded deadline. Older private peers can reject
GIF delivery visibly, and the existing retry keeps the original and caption.
Private messages and their media remain on personal instances. Video is not
supported by this change.

### Group conversations

Messages lists saved groups and direct conversations. Creating a group opens
that exact conversation; if opening fails after creation, **Open group** retries
without creating another group. Loading and delivery failures stay visible.

Open a group's **Details** to see its members. The creator can add someone from
the directory or invite an explicit Möbius deployment address. Existing members
can be reinvited to retry delivery; new members receive future messages, not the
earlier conversation history. Group invitations currently target deployments,
not every deployment linked to an account.

**Delete group** requires typing the group name. The host stops accepting new
messages and hides the group from the creator's Messages; other members retain
their existing history. Closure notices are signed and best-effort. Unreachable
or older deployments may not display closure until they receive a supported
notice; the host still rejects new messages. The sheet reports those failures
and offers an explicit retry, never an automatic delivery promise. This lifecycle
requires the companion group-service update on the Möbius backend.
