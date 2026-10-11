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

### Photos and captions

Direct messages, group messages, and Community posts send photo attachments
and text together. Community replies also support one photo with optional text;
text-only and photo-only replies both work. A selected photo can be removed
without losing the caption. Reply drafts retain both on a failed send, and an
unchanged retry reuses the reply identity rather than publishing twice.

Static photos are prepared at up to 5 MiB and 1600 pixels on their longest
side, with JPEG quality 0.82 for opaque photos and PNG for transparency.
They have a separate compact thumbnail (at most 120 KiB). Reply media is scoped to the parent post
and reply and removed with the post. The Community host must advertise
`reply_attachments: true` before the reply attachment button is enabled; the
personal service checks that capability again before sending. Deploy the
companion Community host release as well as this app update.

Animated GIFs use those same attachment-and-caption controls. Preparation keeps
original bytes, timing, looping and transparency instead of converting the first
frame into a JPEG. Feed and conversation previews show a still poster with a GIF
label; opening it plays the original, so scrolling never starts animation.
Selected draft previews may animate after deliberate selection.

GIF originals allow up to 20 MiB, with at most
1600 pixels on the longest side, 300 frames, and 32 million logical canvas pixels
summed across frames. The protocol validates complete GIF framing before decoding
all frames, on both private and public paths. That walk is also capped at 524,288
blocks (extensions, images and data sub-blocks; ordinary 255-byte sub-blocks need
about 82,000 at 20 MiB), and repeated graphic controls are folded for decoding
without changing the stored original. Oversized animations are rejected,
not resized or flattened. Community galleries allow up to four images and
20 MiB of originals combined; no GIF is flattened to fit a gallery. Signed
content envelopes allow 60 MiB for base64, encryption, thumbnails and the
legacy first-image compatibility copy. The app declares that reviewed service
transfer allowance; other apps retain the platform's 8 MiB default.
The reviewed service contract also caps `GET /actor` and `POST /activity` at
1 MiB per serialized request and response. Their smaller admission reservations
can fit alongside a receiving large upload without increasing the platform's
memory budgets. The activity body has its stricter 32 KiB receive cap before
Social decodes or authenticates it. Other routes keep the 60 MiB service ceiling.
These are admission bounds, not execution priority or guaranteed availability
under total-budget saturation; the public service execution lane remains serial.
The platform release supporting reviewed `service.route_limits` must be merged
and deployed before this manifest, since older platforms reject that field.
Before JSON container decoding or authentication, every Common envelope also
allows at most 32,768 structural punctuation characters (`{}[]:,` outside
strings) and 64 nested containers. This separately bounds containers, scalar
entries and object keys, including unknown compatible fields and duplicate keys;
large media/ciphertext strings do not spend this structural budget. Exceeding
either resource bound returns HTTP 413 (`Envelope JSON is too complex.`), even
if the over-budget document is also malformed. Within budget, stdlib JSON stays
authoritative and malformed JSON returns HTTP 400. Source, signing and original
image bytes are not rewritten. Control envelopes still have their 32 KiB cap.
The standalone Community public router also admits at most two attachment-writing
POSTs (`/board` and `/board/reply`) and eight independent control POSTs at once.
It reserves before reading and holds capacity through verification and response
sending, releasing on completion, error or cancellation. Control bodies are
stream-capped at 32 KiB regardless of claimed type or Content-Length; each content
reservation allows 60 MiB. The router therefore admits at most 120 MiB + 256 KiB
of wire bodies, not an unbounded queue of decoded envelopes awaiting peer keys.
Busy capacity returns HTTP 503 (`Community request capacity is busy.`) with
`Retry-After: 1`, before reading the body; a caller may retry its unchanged request
after capacity is released. No automatic retry is added. GET/media reads use no
reservation. These are per-router/process bounds, not a deployment-wide RSS cap;
decoded scalars, image work and multiple server processes need their own headroom.
Envelope receiving has a 12-second absolute budget, not a per-chunk idle timeout;
an expired receive returns HTTP 408 (`Envelope receive deadline exceeded.`) before
JSON decoding or authentication. Every admitted public POST also has a 75-second
absolute lifetime budget, including verification and response sending. Capacity
remains reserved until cancellation has unwound a stalled operation; at lifetime
expiry the app returns without another app error send or a traceback retaining
media. This is **not** a generic ASGI transport abort: if response start never
completed, Uvicorn may send its small fallback 500, whose flow-control wait is
outside this app-owned decoded-data/admission bound. That residual server task
retains no decoded envelope or reservation. Server socket/task caps and transport
deadlines remain the server owner's responsibility. This leaves the existing
12-second signed write and each 10-second actor-fetch allowance unchanged,
including up to five fetches during named-member key/handle refresh with a full
cache. Both content and control slots recover from unauthenticated one-byte
drip/stalled streams without requiring a restart.
Deadlines use cooperative asyncio cancellation; bounded synchronous JSON/image
work is not preempted.
Quoted scalars are advanced using stdlib's C JSON string scanner, discarding its
temporary scalar before container decoding. There is no Python loop per escape,
escape-count cap, source rewrite, or loss of maximally escaped legal media/text.
At most 32,768 quoted scalars may be advanced, also returning 413 on excess;
this bounds scanner calls even for malformed adjacent strings without separators.
Valid within-budget entries already consume the punctuation allowance.
The strict lifetime contract covers the frozen standalone host's default
`debug=False` error policy. Debug HTML may be rendered again by outer error
middleware after release. Custom 500/error hooks likewise require admission
outside that outer layer; neither is covered by this router-local resource bound.
Community GIF posts/replies require explicit `gif_attachments: true`; discovery
and the signed write share a bounded deadline. Numeric media-limit discovery
also checks that the Community host accepts the selected original and total
sizes; older hosts retain their earlier allowances. Older private peers can reject
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
