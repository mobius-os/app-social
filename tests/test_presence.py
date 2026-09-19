"""Presence must outlive JSON-v1 request processes, never their authority.

Only fixture-owned directories are used; no platform imports or live requests.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1]
OID = 'a' * 32


class PresenceTests(unittest.TestCase):
  def setUp(self):
    self.temp = tempfile.TemporaryDirectory(prefix='social-presence-test-')
    self.addCleanup(self.temp.cleanup)
    self.storage = Path(self.temp.name) / 'data/apps/9'
    self.env = {
      'PATH': os.environ.get('PATH', ''),
      'APP_STORAGE_DIR': str(self.storage), 'APP_ID': '9', 'APP_SLUG': 'common',
      'INSTANCE_DOMAIN': 'one.test', 'INSTANCE_ORIGIN': 'https://one.test',
      'API_BASE_URL': 'http://127.0.0.1:1', 'APP_TOKEN': 'test-only',
    }

  def python(self, script):
    result = subprocess.run([sys.executable, '-c', script], cwd=SOURCE,
      env=self.env, capture_output=True, text=True, check=True, timeout=10)
    return json.loads(result.stdout or 'null')

  def test_presence_survives_fresh_process_and_expires(self):
    self.python(f"import social_objects as s; s._mark_present('{OID}', 'one.test', now=100)")
    self.assertEqual(self.python(f"""
import json, social_objects as s
print(json.dumps([s._member_is_active('{OID}', 'one.test', now=t) for t in [101, 112, 113]]))
"""), [True, True, False])

  def test_missing_future_and_revoked_presence_is_not_active(self):
    self.assertEqual(self.python(f"""
import json, social_objects as s
missing = s._member_is_active('{OID}', 'one.test', now=100)
s._mark_present('{OID}', 'one.test', now=110)
future = s._member_is_active('{OID}', 'one.test', now=100)
s._forget_present('{OID}', 'one.test')
revoked = s._member_is_active('{OID}', 'one.test', now=110)
print(json.dumps([missing, future, revoked]))
"""), [False, False, False])

  def test_presence_failure_cannot_fail_a_board_operation(self):
    parent = self.storage / 'server/common/objects/hosted' / OID
    parent.mkdir(parents=True)
    (parent / 'presence').write_text('unavailable marker directory')
    self.assertFalse(self.python(f"""
import json, social_objects as s
s._mark_present('{OID}', 'one.test', now=100)
print(json.dumps(s._member_is_active('{OID}', 'one.test', now=101)))
"""))

  def test_two_real_json_requests_see_both_members_without_changing_board(self):
    root = self.storage / 'server/common/objects/hosted' / OID
    root.mkdir(parents=True)
    obj = {'id': OID, 'app': 'kanban', 'version': 7, 'created_at': 1,
      'members': {'one.test': {'role': 'editor'}, 'two.test': {'role': 'viewer'},
                  'pending.test': {'role': 'viewer', 'pending': True}}}
    (root / 'object.json').write_text(json.dumps(obj))
    (root / 'doc.json').write_text('{"title":"unchanged"}')
    before = {name: (root / name).read_bytes() for name in ['object.json', 'doc.json']}
    for host in ['one.test', 'two.test']:
      request = {'method': 'GET', 'path': f'objects/{host}/{OID}/state',
        'query': {'since_version': '7'}, 'actor': {'scope': 'owner'}}
      result = subprocess.run([sys.executable, str(SOURCE / 'service.py')],
        input=json.dumps(request), env={**self.env, 'INSTANCE_DOMAIN': host},
        capture_output=True, text=True, check=True, timeout=10)
      reply = json.loads(result.stdout)
      self.assertEqual(reply['status'], 200)
    members = reply['body']['object']['members']
    self.assertTrue(members['one.test'].get('active'))
    self.assertTrue(members['two.test'].get('active'))
    self.assertFalse(members['pending.test'].get('active', False))
    self.assertNotIn('doc', reply['body'])
    self.assertEqual(before, {name: (root / name).read_bytes() for name in before})


if __name__ == '__main__':
  unittest.main()
