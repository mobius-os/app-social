# Social community image

This is the reproducible image for Social's shared public Community board and
members-only People directory at `www.mobius.you`. Private messages and owner
identity keys remain on each person's own Möbius instance.

Personal Social installations may update before the shared host: joined users
use the old public GET directory only while the host returns 404 for signed
search. The local People route still refuses unjoined users. Deploying this
image switches those updated installations to signed search and closes public
GET, so older installations must update or their People search stops working.
Merging this PR does not itself deploy the image or update an installation.

Build only from a committed revision and pass that exact revision into the
image:

```bash
sha="$(git rev-parse HEAD)"
docker build \
  --build-arg "SOURCE_SHA=$sha" \
  -f deploy/community/Dockerfile \
  -t "mobius-social:$sha" .
```

The image exposes `/healthz`, `/version`, and Social's public router under
`/api/common`. Production routing maps
`/api/app-services/social/{directory,board,...}` to that internal prefix.

GIF search uses one shared KLIPY app key. Set it as the private runtime setting
`KLIPY_APP_KEY` on the host (never in this repository or the image). The host
hands it only to signed, joined members at `/api/common/gifs/key`; without it,
members' GIF pickers say search isn't set up. KLIPY requires searches to go from
each member's own device, so members' devices do see the key: this keeps it out
of public source and lets the operator replace it without a Social update.

Community roles start from two private runtime settings: `COMMUNITY_OWNER_HOSTS`
names the owner and `COMMUNITY_ADMIN_HOSTS` the admins, each as comma-separated
member hosts (for example `mobius.example.org`). The owner and admins may delete
any post or reply and edit the Community's name and description; everyone else
is an ordinary member. These settings only seed the roles: once the owner
promotes, demotes or hands over ownership from Social (a signed
`community_role` envelope to `board/role`), the host saves the roles in
`common/roles.json` under its data directory and ignores the settings from then
on. To reset roles, remove that file. The board lists the current roles under
`capabilities.roles` so each member's Social can label them.

Merging prepares an immutable candidate; it does not authorize or perform a
production deployment. Production promotion belongs to the host's separate,
service-scoped controller so application maintainers cannot turn repository
write access into general host access.

The repository workflow publishes only the immutable
`ghcr.io/mobius-os/app-social-community:sha-<commit>` candidate and its build
attestation. There is deliberately no moving production tag and no host
credential in this repository.

The Python base image and every Python dependency are digest/version pinned.
Their updates are deliberate reviewed source changes, never an automatic
production replacement.
