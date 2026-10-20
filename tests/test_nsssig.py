"""Unit tests for scripts/certs/nsssig.py. Run: python3 -m unittest discover -s tests -p 'test_*.py'"""
import hashlib
import hmac
import os
import sqlite3
import struct
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts', 'certs'))
import nsssig  # noqa: E402


class SignatureTests(unittest.TestCase):
    def test_mac_matches_independent_computation(self):
        pkey = nsssig.pass_key(b'\x01' * 20)
        self.assertEqual(pkey, hashlib.sha1(b'\x01' * 20).digest())
        salt = b'\x02' * 32
        value = bytes.fromhex('ce534352')
        key = hashlib.pbkdf2_hmac('sha256', pkey, salt, 1, 32)
        expected = hmac.new(key, struct.pack('>II', 0x3032eae, 0xce536358) + value, hashlib.sha256).digest()
        self.assertEqual(nsssig.mac_for(pkey, salt, 1, 0x3032eae, 0xce536358, value), expected)

    def test_encode_parse_round_trip(self):
        salt, mac = os.urandom(32), os.urandom(32)
        for null_params in (True, False):
            der = nsssig.encode(salt, 1, mac, null_params)
            self.assertEqual(der[0], 0x30)
            self.assertEqual(nsssig.parse(der), (salt, 1, mac, null_params))

    def test_encoding_layout_matches_nss(self):
        # Prefix of a signature NSS wrote on the phone (salt/mac replaced): SEQUENCE(0x80) { PBMAC1 ... }
        der = nsssig.encode(b'\x00' * 32, 1, b'\x00' * 32)
        self.assertEqual(der[:24].hex(), '308180305c06092a864886f70d01050e304f304106092a86')
        self.assertEqual(len(der), 0x83)

    def test_sign_uses_fresh_salt_and_verifies(self):
        pkey = nsssig.pass_key(b'salt')
        a = nsssig.sign(pkey, 5, 0xce536358, b'v')
        b = nsssig.sign(pkey, 5, 0xce536358, b'v')
        self.assertNotEqual(a, b)
        salt, it, mac, _ = nsssig.parse(a)
        self.assertEqual(nsssig.mac_for(pkey, salt, it, 5, 0xce536358, b'v'), mac)

    def test_verify_existing_detects_good_and_bad(self):
        gsalt = b'\x07' * 20
        pkey = nsssig.pass_key(gsalt)
        key4 = sqlite3.connect(':memory:')
        cert9 = sqlite3.connect(':memory:')
        key4.execute('create table metaData (id primary key unique on conflict replace, item1, item2)')
        cert9.execute('create table nssPublic (id primary key, ace536358)')
        cert9.execute('insert into nssPublic values (?, ?)', (7, bytes.fromhex('ce534352')))
        cert9.execute('insert into nssPublic values (?, ?)', (8, bytes.fromhex('ce534352')))
        key4.execute('insert into metaData (id, item1) values (?, ?)',
                     ('sig_cert_00000007_ce536358', nsssig.sign(pkey, 7, 0xce536358, bytes.fromhex('ce534352'))))
        self.assertEqual(nsssig.verify_existing(key4, cert9, pkey), (1, 0))
        # A signature over the wrong object id must fail.
        key4.execute('insert into metaData (id, item1) values (?, ?)',
                     ('sig_cert_00000008_ce536358', nsssig.sign(pkey, 9, 0xce536358, bytes.fromhex('ce534352'))))
        self.assertEqual(nsssig.verify_existing(key4, cert9, pkey), (1, 1))
        # A wrong database salt fails everything.
        self.assertEqual(nsssig.verify_existing(key4, cert9, nsssig.pass_key(b'other')), (0, 2))


if __name__ == '__main__':
    unittest.main()
