#!/usr/bin/env python3
"""Trust a root CA on a rooted KaiOS 2.5 phone (Gecko 48 / 2016 NSS). Kuling needs this for api.met.no.

See README.md, "Certificates", for the full story. Steps:
  1. modern `certutil` (Homebrew nss) adds the certificate object to a copy of cert9.db;
  2. the trust record it writes (PKCS#11 3.2 CKO_TRUST) is unreadable by the phone's NSS, so it is
     replaced with a legacy CKO_NSS_TRUST record: SSL server auth only;
  3. the record's authenticated attributes are signed into key4.db (nsssig.py), after first proving
     the signing code reproduces every signature already in the database;
  4. NSS checks the result (`certutil -L`, and `vfychain` on --chain if given);
  5. both databases are backed up on the phone, pushed, and b2g is restarted.
Nothing is pushed unless every check passes.

Usage:
  python3 scripts/certs/add_root.py ROOT.pem --sha256 AA:BB:... [--chain LEAF.pem INTER.pem ...]
  python3 scripts/certs/add_root.py ROOT.pem --sha256 AA:BB:... --dry-run DIR   # copies only

Kuling's root (HARICA RootCA 2015), taken from the macOS trust store:
  python3 scripts/certs/add_root.py harica2015.pem \\
    --sha256 A0:40:92:9A:02:CE:53:B4:AC:F4:F2:FF:C6:98:1C:E4:49:6F:75:5E:6D:45:FE:0B:2A:69:2B:CD:52:52:3F:36
"""
import argparse
import hashlib
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nsssig  # noqa: E402

NSS_BIN = os.environ.get('NSS_BIN', '/opt/homebrew/opt/nss/bin')
PROFILE_GLOB = '/data/b2g/mozilla/*.default'
DB_FILES = ('cert9.db', 'key4.db', 'pkcs11.txt')
B2G_STOP_WAIT_S = 3

CKO_CERTIFICATE = '00000001'
CKO_TRUST_NEW = '0000000b'      # PKCS#11 3.2, written by recent NSS
CKO_NSS_TRUST = 'ce534353'      # legacy, the only kind Gecko 48's NSS reads
TRUSTED_DELEGATOR = bytes.fromhex('ce534352')
VALID_DELEGATOR = bytes.fromhex('ce53435b')
NULL_MARKER = bytes.fromhex('a5005a')  # how NSS stores an empty attribute (e.g. no label)
ATTR_SERVER, ATTR_CLIENT, ATTR_CODE, ATTR_EMAIL = 0xce536358, 0xce536359, 0xce53635a, 0xce53635b
ATTR_STEP_UP, ATTR_SHA1, ATTR_MD5 = 0xce536360, 0xce5363b4, 0xce5363b5
# The set NSS itself writes and signs for a trust object.
SIGNED_ATTRS = (ATTR_SERVER, ATTR_CLIENT, ATTR_CODE, ATTR_EMAIL, ATTR_STEP_UP, ATTR_SHA1, ATTR_MD5)
OBJECT_ID_MASK = 0x3fffffff


def run(cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout


def adb(*args):
    return run(['adb'] + list(args))


def hx(v):
    return bytes(v).hex() if v is not None else None


def pem_to_der(pem_path):
    return subprocess.run(['openssl', 'x509', '-in', pem_path, '-outform', 'DER'],
                          check=True, capture_output=True).stdout


def fingerprint(der):
    return ':'.join('%02X' % b for b in hashlib.sha256(der).digest())


def nickname(pem_path):
    subject = run(['openssl', 'x509', '-in', pem_path, '-noout', '-subject', '-nameopt', 'multiline'])
    for line in subject.splitlines():
        if 'commonName' in line:
            return line.split('=', 1)[1].strip()
    raise SystemExit('the root has no common name')


def legacy_trust(workdir, der):
    """Replace any trust rows for the certificate with one legacy row. Returns its object id."""
    db = sqlite3.connect(os.path.join(workdir, 'cert9.db'))
    try:
        cols = [r[1] for r in db.execute('pragma table_info(nssPublic)')]
        rows = [dict(zip(cols, r)) for r in db.execute('select * from nssPublic')]
        certs = [d for d in rows if hx(d['a0']) == CKO_CERTIFICATE and d['a11'] is not None and bytes(d['a11']) == der]
        if len(certs) != 1:
            raise SystemExit('expected one certificate object for the root, found %d' % len(certs))
        cert = certs[0]
        for d in rows:
            if (hx(d['a0']) in (CKO_TRUST_NEW, CKO_NSS_TRUST)
                    and hx(d.get('a81')) == hx(cert['a81']) and hx(d.get('a82')) == hx(cert['a82'])):
                db.execute('delete from nssPublic where id=?', (d['id'],))
        used = {d['id'] for d in rows}
        trust_id = cert['id'] + 1
        while trust_id in used:
            trust_id = (trust_id + 1) & OBJECT_ID_MASK
        row = {
            'a0': bytes.fromhex(CKO_NSS_TRUST), 'a1': b'\x01', 'a2': b'\x00', 'a170': b'\x01', 'a3': NULL_MARKER,
            'a81': bytes(cert['a81']), 'a82': bytes(cert['a82']),
            'a%x' % ATTR_SERVER: TRUSTED_DELEGATOR,
            'a%x' % ATTR_CLIENT: VALID_DELEGATOR,
            'a%x' % ATTR_CODE: VALID_DELEGATOR,
            'a%x' % ATTR_EMAIL: VALID_DELEGATOR,
            'a%x' % ATTR_STEP_UP: b'\x00',
            'a%x' % ATTR_SHA1: hashlib.sha1(der).digest(),
            'a%x' % ATTR_MD5: hashlib.md5(der).digest(),
        }
        keys = ['id'] + list(row)
        db.execute('insert into nssPublic (%s) values (%s)' % (','.join(keys), ','.join('?' * len(keys))),
                   [trust_id] + list(row.values()))
        db.commit()
        return trust_id
    finally:
        db.close()


def sign_trust(workdir, trust_id):
    key4 = sqlite3.connect(os.path.join(workdir, 'key4.db'))
    cert9 = sqlite3.connect(os.path.join(workdir, 'cert9.db'))
    try:
        global_salt = bytes(key4.execute("select item1 from metaData where id='password'").fetchone()[0])
        pkey = nsssig.pass_key(global_salt)
        ok, bad = nsssig.verify_existing(key4, cert9, pkey)
        if bad or not ok:
            raise SystemExit('cannot prove the signing scheme on this database (%d ok, %d bad); '
                             'a master password or an unknown format. Nothing written.' % (ok, bad))
        print('signing scheme verified against %d existing signatures' % ok)
        for attr in SIGNED_ATTRS:
            value = bytes(cert9.execute('select a%x from nssPublic where id=?' % attr, (trust_id,)).fetchone()[0])
            name = 'sig_cert_%08x_%08x' % (trust_id, attr)
            key4.execute('delete from metaData where id=?', (name,))
            key4.execute('insert into metaData (id, item1) values (?, ?)',
                         (name, nsssig.sign(pkey, trust_id, attr, value)))
        key4.commit()
    finally:
        key4.close()
        cert9.close()


def check(workdir, nick, chain):
    listing = run([NSS_BIN + '/certutil', '-L', '-d', 'sql:' + workdir])
    line = [l for l in listing.splitlines() if l.startswith(nick)]
    trust = line[0].split()[-1] if line else 'missing'
    if not trust.startswith('C'):
        raise SystemExit('NSS does not see the root as a trusted CA (trust: %s). Nothing pushed.' % trust)
    print('NSS trust for %r: %s' % (nick, trust))
    if chain:
        ders = []
        for i, pem in enumerate(chain):
            path = os.path.join(workdir, 'chain%d.der' % i)
            with open(path, 'wb') as fh:
                fh.write(pem_to_der(pem))
            ders.append(path)
        result = subprocess.run([NSS_BIN + '/vfychain', '-d', 'sql:' + workdir, '-pp', '-u', '1'] + ders,
                                capture_output=True, text=True)
        output = result.stdout + result.stderr  # vfychain reports on stderr
        if 'Chain is good' not in output:
            raise SystemExit('chain does not validate:\n' + output)
        print('chain validates')


def prepare(workdir, pem, chain):
    """All changes and checks, on the database copies in workdir. Returns the nickname."""
    der = pem_to_der(pem)
    nick = nickname(pem)
    run([NSS_BIN + '/certutil', '-A', '-d', 'sql:' + workdir, '-n', nick, '-t', 'C,,', '-i', pem])
    trust_id = legacy_trust(workdir, der)
    sign_trust(workdir, trust_id)
    check(workdir, nick, chain)
    return nick


def on_phone(pem, chain):
    profile = adb('shell', 'ls -d ' + PROFILE_GLOB).strip()
    if not profile.startswith('/data/'):
        raise SystemExit('could not find the b2g profile: %r' % profile)
    ts = int(time.time())
    work = tempfile.mkdtemp(prefix='kaios-nss-')
    print('stopping b2g (the phone UI goes dark) ...')
    adb('shell', 'stop b2g')
    time.sleep(B2G_STOP_WAIT_S)
    try:
        for f in DB_FILES:
            adb('pull', '%s/%s' % (profile, f), os.path.join(work, f))
        nick = prepare(work, pem, chain)
        adb('shell', 'cp {p}/cert9.db {p}/cert9.db.bak-{t} && cp {p}/key4.db {p}/key4.db.bak-{t}'.format(p=profile, t=ts))
        print('backups on phone: %s/cert9.db.bak-%d, key4.db.bak-%d' % (profile, ts, ts))
        for f in ('cert9.db', 'key4.db'):
            adb('push', os.path.join(work, f), '%s/%s' % (profile, f))
        adb('shell', 'chmod 600 %s/cert9.db %s/key4.db' % (profile, profile))
        print('trusted %r on the phone' % nick)
    finally:
        adb('shell', 'start b2g')
        shutil.rmtree(work, ignore_errors=True)
        print('b2g restarting (~20-30 s)')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('root', help='root CA certificate (PEM)')
    ap.add_argument('--sha256', required=True, help='expected SHA-256 fingerprint of the root (AA:BB:...)')
    ap.add_argument('--chain', nargs='+', metavar='PEM', help='leaf + intermediates to validate before pushing')
    ap.add_argument('--dry-run', metavar='DIR', help='work on cert9.db/key4.db/pkcs11.txt copies in DIR only')
    args = ap.parse_args()

    if not os.path.exists(os.path.join(NSS_BIN, 'certutil')):
        raise SystemExit('needs Mozilla NSS tools: brew install nss (or set NSS_BIN)')
    actual = fingerprint(pem_to_der(args.root))
    if actual.replace(':', '').upper() != args.sha256.replace(':', '').upper():
        raise SystemExit('fingerprint mismatch, refusing:\n  got      %s\n  expected %s' % (actual, args.sha256))
    if args.dry_run:
        nick = prepare(args.dry_run, args.root, args.chain)
        print('dry run OK: %r trusted in %s (phone untouched)' % (nick, args.dry_run))
    else:
        on_phone(args.root, args.chain)


if __name__ == '__main__':
    main()
