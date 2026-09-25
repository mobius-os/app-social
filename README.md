# Social

Federated social for Möbius people. Three surfaces:

- **Board** — one global community feed for every Social installation.
- **Messages** — private conversations delivered directly between Möbius
  instances. Each side keeps its own copy; changing directory never moves them.
- **People** — one opt-in global directory, hosted at `www.mobius.you`.
  Fresh installs browse it before joining. Joining shares the owner's handle
  and profile picture and enables posting and new conversations.

The Board and People surfaces stay readable while the owner is signed out or
has not joined the public directory. Posting, replying, and reacting remain
account actions. Social saves the exact pending action (including a post photo)
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
Existing conversations remain accessible before joining the global directory.
Registration is checked against the global directory whenever the profile loads,
so a failed join remains discoverable after reopening. **Try joining again** repairs
a missing listing; an unavailable directory is shown separately from a missing
registration. Handle search accepts both `name` and `@name`. Other installations must receive this app update;
changing one instance does not update a friend's copy.

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
talks to that host over the DNS-pinned federation transport. Browsing never
joins or submits an interaction. A personal Möbius hosts no board of its own.

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
