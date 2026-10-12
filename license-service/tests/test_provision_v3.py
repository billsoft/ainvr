import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('validate_provision', Path(__file__).resolve().parents[1] / 'deploy/validate_provision.py')
provision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provision)

class ProvisionV3Test(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.board = self.root / 'board'; self.board.mkdir()
        self.states = self.root / 'states'; self.states.mkdir()
        self.config = dict(host='127.0.0.1', port=8001, machine_code='0'*24,
                           installation_path='/var/lib/ainvr-license-identity/identity.json',
                           device_key='1'*64, admin_api_key='2'*64,
                           signal_keys={client: str(index+3)*64 for index, client in enumerate(provision.CLIENTS)})
        for client in provision.CLIENTS:
            values = dict(AINVR_PROFILE='production', LICENSE_ENABLED='true', LICENSE_DEVICE_ID='0'*24,
                          LICENSE_SIGNAL_KEY=self.config['signal_keys'][client], LICENSE_UDS_PATH='/run/ainvr-license/license.sock')
            if client == 'console-backend': values['LICENSE_ADMIN_API_KEY'] = self.config['admin_api_key']
            (self.board / (client+'.env')).write_text('\n'.join(f'{k}={v}' for k,v in values.items()))

    def validate(self):
        (self.board / 'license-service.yaml').write_text(json.dumps(self.config))
        provision.validate(self.board,'0'*24,installed=self.root/'installed',state_root=self.states)

    def test_fresh_and_v3_install(self):
        self.validate()
        (self.states/'state.dat').write_text(json.dumps({'data':{'schema':3}}))
        self.validate()

    def test_legacy_requires_real_migration_input(self):
        (self.states/'state.dat').write_text(json.dumps({'data':{'schema':2}}))
        with self.assertRaises(ValueError): self.validate()
        self.config['migration_file']=str(self.root/'missing')
        with self.assertRaises(ValueError): self.validate()
        (self.root/'ticket').write_text('verification belongs to authority')
        self.config['migration_file']=str(self.root/'ticket')
        self.validate()

    def test_installation_path_matches_systemd(self):
        self.config['installation_path']='/unexpected/identity'
        with self.assertRaises(ValueError): self.validate()

    def test_missing_installation_path_is_rejected(self):
        del self.config['installation_path']
        with self.assertRaises(ValueError): self.validate()

if __name__ == '__main__': unittest.main()
