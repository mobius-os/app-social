"""Offline legacy handoff; never imported by normal independent Kanban requests.

Deploy the request lease in the OLD object's owning service and drain older
unguarded workers before freezing. No environment/default paths, network,
platform imports, or private identity reads. All paths are explicit operator
inputs. A local freeze receipt is evidence only within that trusted host.
"""
from contextlib import contextmanager
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
from urllib.parse import unquote

OID = re.compile(r'^[a-f0-9]{32}$')


class HandoffError(ValueError):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def fingerprint(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(dir=path.parent, prefix='.handoff-')
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(canonical(value)); out.flush(); os.fsync(out.fileno())
        os.replace(name, path)
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)
    finally:
        Path(name).unlink(missing_ok=True)


class LegacyAuthority:
    def __init__(self, objects_root, host):
        self.root = Path(objects_root)
        if not self.root.is_absolute() or not self.root.is_dir():
            raise HandoffError('An explicit existing objects root is required.')
        self.host = host
        self.handoffs = self.root / '.handoff'

    @contextmanager
    def lease(self, *, exclusive=False):
        self.handoffs.mkdir(mode=0o700, exist_ok=True)
        # This inode is permanent: unlinking a lock would create two lock owners.
        with (self.handoffs / 'authority.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
            try: yield
            finally: fcntl.flock(lock, fcntl.LOCK_UN)

    def marker(self, oid):
        if not isinstance(oid,str) or not OID.fullmatch(oid):
            raise HandoffError('Invalid board identity.')
        return self.handoffs / (oid + '.json')

    @contextmanager
    def request(self, path):
        """Wrap the complete OLD /objects dispatch, including awaited handlers.

        The exclusive freezer waits for all earlier leased requests to finish.
        Once frozen, local/peer state, assets, invites, revocation and deletion
        of that board stop at the same boundary. Social messages are untouched.
        """
        parts = [unquote(p) for p in path.strip('/').split('/') if p]
        if not parts or parts[0] != 'objects':
            yield; return
        with self.lease():
            for part in parts[1:]:
                if OID.fullmatch(part) and self.marker(part).exists():
                    raise HandoffError('Board authority is frozen for migration; retain pending edits.')
            yield

    def snapshot(self, oid):
        """Caller must hold an exclusive lease, or use on a detached fixture."""
        self.marker(oid)
        source = self.root / 'hosted' / oid
        def read(path, limit):
            if path.is_symlink() or not path.is_file() or path.stat().st_size > limit:
                raise HandoffError('Unexpected or oversized snapshot input.')
            return path.read_bytes()
        obj = json.loads(read(source/'object.json', 1024*1024))
        doc = json.loads(read(source/'doc.json', 256*1024))
        if obj.get('id') != oid or obj.get('app') != 'kanban':
            raise HandoffError('This is not the requested Kanban board.')
        assets=[]; total=0
        directory=source/'assets'
        if directory.is_symlink(): raise HandoffError('Unexpected attachment directory.')
        for path in sorted(directory.iterdir()) if directory.exists() else []:
            raw=read(path,5*1024*1024);total+=len(raw)
            if len(assets)>=100 or total>100*1024*1024:
                raise HandoffError('Attachment inventory exceeds the legacy contract.')
            assets.append({'filename':path.name,'data':base64.b64encode(raw).decode(),
                           'sha256':hashlib.sha256(raw).hexdigest()})
        return {'format':'kanban-handoff/1','host':self.host,'object':obj,'doc':doc,'assets':assets}

    def freeze(self, oid, transition):
        if not isinstance(transition,str) or not OID.fullmatch(transition):
            raise HandoffError('An explicit transition identity is required.')
        with self.lease(exclusive=True):
            marker=self.marker(oid)
            if marker.exists():
                archive=self.verify(oid)
                if archive['transition'] != transition:
                    raise HandoffError('Another transition already owns this board.')
                return archive
            archive={**self.snapshot(oid),'transition':transition}
            receipt={'transition':transition,'digest':fingerprint(archive),'host':self.host,'id':oid}
            # Snapshot is durable BEFORE the marker stops subsequent old reads.
            # A crash between these writes leaves old authority active; retry
            # captures current state again, never trusts the partial snapshot.
            atomic_json(self.handoffs/(oid+'.snapshot.json'),archive)
            atomic_json(marker,receipt)
            return archive

    def verify(self, oid):
        receipt=json.loads(self.marker(oid).read_text())
        archive=json.loads((self.handoffs/(oid+'.snapshot.json')).read_text())
        if (receipt.get('host') != self.host or receipt.get('id') != oid
            or archive.get('host') != self.host or archive.get('object',{}).get('id') != oid
            or receipt.get('transition') != archive.get('transition')
            or receipt.get('digest') != fingerprint(archive)):
            raise HandoffError('Frozen archive does not match its receipt.')
        return archive
