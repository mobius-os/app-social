# Social

Federated social for Möbius people. Three surfaces:

- **Board** — one global community feed for every Social installation.
- **Messages** — private conversations delivered directly between Möbius
  instances. Each side keeps its own copy; changing directory never moves them.
- **People** — one opt-in global directory, hosted at `mobius.hamzamerzic.info`.
  Fresh installs browse it before joining. Joining shares the owner's handle
  and profile picture and enables posting and new conversations.

Older installations that joined a separate directory see **Join global Social**,
not an apparently empty global board. This explicit action preserves their
publication consent; Social no longer offers multiple community destinations.
Existing conversations remain accessible before joining the global directory.
Registration is checked against the global directory whenever the profile loads,
so a failed join remains discoverable after reopening. **Try joining again** repairs
a missing listing; an unavailable directory is shown separately from a missing
registration. Handle search accepts both `name` and `@name`. Other installations must receive this app update;
changing one instance does not update a friend's copy.

The server side lives in the platform's `/api/common` federation router
(protocol `common/0`): Ed25519-signed envelopes, a public actor card per
instance, and an inbox each instance exposes to its peers. This app is the
client UI; it only ever talks to its own server.

Conversation data lives in this app's per-app storage
(`conversations/<peer-host>/…`); incoming deliveries bump `state/version.json`,
which the open app watches to refresh live.

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
