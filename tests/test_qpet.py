import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import stat
from types import SimpleNamespace
from tempfile import TemporaryDirectory
import unittest
from unittest import mock

import qpet


SHEET = b"RIFF\x00\x00\x00\x00WEBPtest-sheet"


def manifest_for(sheet=SHEET):
    return {
        "format": "codex-pet-v1",
        "id": "qbit",
        "displayName": "Qbit",
        "description": "A test pet.",
        "kind": "object",
        "author": "test",
        "frame": {"width": 192, "height": 208, "columns": 8, "rows": 9},
        "states": [
            {"id": "idle", "row": 0, "frames": 6, "fps": 6, "loop": True},
            {"id": "waving", "row": 3, "frames": 4, "fps": 5, "loop": False},
        ],
        "sheet": {
            "contentType": "image/webp",
            "length": len(sheet),
            "sha256": hashlib.sha256(sheet).hexdigest(),
        },
    }


def op_return_script(payload: bytes) -> bytes:
    if len(payload) <= 0xFF:
        push = b"\x4c" + bytes([len(payload)])
    elif len(payload) <= 0xFFFF:
        push = b"\x4d" + len(payload).to_bytes(2, "little")
    else:
        push = b"\x4e" + len(payload).to_bytes(4, "little")
    return b"\x6a" + push + payload


def pet_source_files(root: Path):
    pet = {
        "id": "qbit",
        "displayName": "Qbit",
        "description": "test",
        "kind": "object",
        "author": "test",
        "frame": {"width": 192, "height": 208, "columns": 8, "rows": 9},
    }
    manifest_path = root / "pet.json"
    sheet_path = root / "spritesheet.webp"
    manifest_path.write_text(json.dumps(pet), encoding="utf-8")
    sheet_path.write_bytes(SHEET)
    return manifest_path, sheet_path


class EnvelopeTests(unittest.TestCase):
    def test_tracked_asset_reproduces_the_mainnet_envelope(self):
        root = Path(__file__).resolve().parents[1]
        pet = json.loads((root / "assets/qbit/pet.json").read_text(encoding="utf-8"))
        sheet = (root / "assets/qbit/spritesheet.webp").read_bytes()
        envelope = qpet.encode_envelope(qpet.build_manifest(pet, sheet), sheet)

        self.assertEqual(len(envelope), 9548)
        self.assertEqual(
            hashlib.sha256(envelope).hexdigest(),
            "e9a9ce232eeee3657e87053edf27b0b1f5493c9111d9a37c41fc5cdb85a24247",
        )

    def test_tracked_miner_one_asset_reproduces_the_chain_agnostic_envelope(self):
        root = Path(__file__).resolve().parents[1]
        pet = json.loads(
            (root / "assets/miner-one/pet.json").read_text(encoding="utf-8")
        )
        sheet = (root / "assets/miner-one/spritesheet.webp").read_bytes()
        envelope = qpet.encode_envelope(qpet.build_manifest(pet, sheet), sheet)

        self.assertEqual(len(envelope), 10619)
        self.assertEqual(
            hashlib.sha256(envelope).hexdigest(),
            "ca2a0c0d16aeb3b370592521d6c02ee181684028683fe3602f214322b43d05e5",
        )

    def test_round_trip_validates_manifest_and_sheet(self):
        manifest = manifest_for()
        encoded = qpet.encode_envelope(manifest, SHEET)
        decoded_manifest, decoded_sheet = qpet.decode_envelope(encoded)

        self.assertEqual(decoded_manifest, manifest)
        self.assertEqual(decoded_sheet, SHEET)
        self.assertEqual(
            qpet.validate_manifest(decoded_manifest, decoded_sheet),
            hashlib.sha256(SHEET).hexdigest(),
        )

    def test_rejects_truncated_or_invalid_envelopes(self):
        for payload in (b"", b"QPET", b"QPET\x01\x04\x00{}"):
            with self.subTest(payload=payload):
                with self.assertRaises(ValueError):
                    qpet.decode_envelope(payload)

    def test_rejects_false_sheet_declarations(self):
        cases = []
        wrong_length = manifest_for()
        wrong_length["sheet"]["length"] += 1
        cases.append(wrong_length)

        wrong_hash = manifest_for()
        wrong_hash["sheet"]["sha256"] = "0" * 64
        cases.append(wrong_hash)

        wrong_type = manifest_for()
        wrong_type["sheet"]["contentType"] = "image/svg+xml"
        cases.append(wrong_type)

        for manifest in cases:
            with self.subTest(sheet=manifest["sheet"]):
                with self.assertRaises(ValueError):
                    qpet.validate_manifest(manifest, SHEET)

    def test_rejects_invalid_animation_bounds(self):
        manifest = manifest_for()
        manifest["states"][0]["frames"] = manifest["frame"]["columns"] + 1
        with self.assertRaises(ValueError):
            qpet.validate_manifest(manifest, SHEET)

    def test_rejects_nonstandard_nan_json_constants(self):
        manifest = manifest_for()
        encoded_json = json.dumps(manifest, separators=(",", ":"))[:-1] + ',"extension":NaN}'
        manifest_bytes = encoded_json.encode("utf-8")
        payload = (
            qpet.MAGIC
            + bytes([qpet.VERSION])
            + len(manifest_bytes).to_bytes(2, "little")
            + manifest_bytes
            + SHEET
        )
        with self.assertRaisesRegex(ValueError, "not valid UTF-8 JSON"):
            qpet.decode_envelope(payload)

        manifest["extension"] = float("nan")
        with self.assertRaises(ValueError):
            qpet.encode_envelope(manifest, SHEET)

    def test_rejects_boolean_sheet_length_and_unpaired_surrogates(self):
        one_byte_sheet = b"x"
        manifest = manifest_for(one_byte_sheet)
        manifest["sheet"]["length"] = True
        with self.assertRaisesRegex(ValueError, "declaration"):
            qpet.validate_manifest(manifest, one_byte_sheet)

        manifest = manifest_for()
        manifest["displayName"] = "\ud800"
        with self.assertRaisesRegex(ValueError, "displayName"):
            qpet.validate_manifest(manifest, SHEET)

        manifest = manifest_for()
        manifest["displayName"] = "🟢" * 31
        with self.assertRaisesRegex(ValueError, "displayName"):
            qpet.validate_manifest(manifest, SHEET)

    def test_rejects_unknown_v1_fields(self):
        manifest = manifest_for()
        manifest["futureExtension"] = "not valid in v1"
        with self.assertRaisesRegex(ValueError, "manifest fields"):
            qpet.validate_manifest(manifest, SHEET)


class OpReturnTests(unittest.TestCase):
    def test_accepts_one_direct_or_pushdata_payload(self):
        self.assertEqual(qpet.script_pushes(b"\x6a\x04QPET"), b"QPET")
        self.assertEqual(qpet.script_pushes(b"\x6a\x4c\x04QPET"), b"QPET")
        self.assertEqual(qpet.script_pushes(b"\x6a\x4d\x04\x00QPET"), b"QPET")
        self.assertEqual(qpet.script_pushes(b"\x6a\x4e\x04\x00\x00\x00QPET"), b"QPET")

    def test_rejects_truncation_and_multiple_pushes(self):
        for script in (
            b"\x6a",
            b"\x6a\x4d\x04",
            b"\x6a\x05QPET",
            b"\x6a\x01A\x01B",
        ):
            with self.subTest(script=script.hex()):
                with self.assertRaises(ValueError):
                    qpet.script_pushes(script)

    def test_skips_malformed_unrelated_outputs_before_qpet(self):
        payload = qpet.encode_envelope(manifest_for(), SHEET)
        qpet_script = b"\x6a\x4d" + len(payload).to_bytes(2, "little") + payload
        transaction = {
            "vout": [
                {"scriptPubKey": {"hex": "6a4d04"}},
                {"scriptPubKey": {"hex": "zz"}},
                {"scriptPubKey": {"hex": qpet_script.hex()}},
            ]
        }
        self.assertEqual(qpet.find_qpet_payload(transaction), payload)

    def test_rejects_ambiguous_multiple_qpet_outputs(self):
        payload = qpet.encode_envelope(manifest_for(), SHEET)
        script = op_return_script(payload).hex()
        transaction = {
            "vout": [
                {"n": 0, "scriptPubKey": {"hex": script}},
                {"n": 1, "scriptPubKey": {"hex": script}},
            ]
        }
        with self.assertRaisesRegex(RuntimeError, "multiple QPET"):
            qpet.find_qpet_output(transaction)


class ViewerSecurityTests(unittest.TestCase):
    def test_chain_metadata_is_escaped_and_manifest_is_script_safe(self):
        manifest = manifest_for()
        manifest["displayName"] = '</title><script id="owned">alert(1)</script>'
        manifest["description"] = '<img src=x onerror="alert(2)"> & hello'
        rendered = qpet.render_viewer(
            manifest,
            SHEET,
            '<main onmouseover="alert(3)">',
            '<svg onload="alert(4)">',
            7,
            '<img src=x onerror="alert(5)">',
        )

        self.assertNotIn('<script id="owned">', rendered)
        self.assertNotIn('<img src=x onerror="alert(2)">', rendered)
        self.assertNotIn('<svg onload="alert(4)">', rendered)
        self.assertEqual(rendered.count("<script>"), 1)
        self.assertIn("&lt;/title&gt;&lt;script", rendered)
        self.assertIn("&lt;img src=x onerror=&quot;alert(2)&quot;&gt; &amp; hello", rendered)

        match = re.search(r'atob\("([A-Za-z0-9+/=]+)"\)', rendered)
        self.assertIsNotNone(match)
        embedded = json.loads(base64.b64decode(match.group(1)).decode("utf-8"))
        self.assertEqual(embedded, manifest)

    def test_non_ascii_manifest_survives_script_safe_encoding(self):
        manifest = manifest_for()
        manifest["displayName"] = "Qbit 🟢"
        manifest["description"] = "orb — awake"
        rendered = qpet.render_viewer(manifest, SHEET, "main", "a" * 64)
        match = re.search(r'atob\("([A-Za-z0-9+/=]+)"\)', rendered)
        embedded = json.loads(base64.b64decode(match.group(1)).decode("utf-8"))
        self.assertEqual(embedded["displayName"], "Qbit 🟢")
        self.assertEqual(embedded["description"], "orb — awake")

    def test_manifest_text_cannot_trigger_later_template_replacements(self):
        manifest = manifest_for()
        manifest["displayName"] = "__SHEET_B64__"
        rendered = qpet.render_viewer(manifest, SHEET, "main", "a" * 64)

        self.assertEqual(rendered.count(base64.b64encode(SHEET).decode("ascii")), 1)
        self.assertEqual(rendered.count("__SHEET_B64__"), 2)
        self.assertLess(len(rendered), len(qpet.VIEWER) + 1000)


class CliSafetyTests(unittest.TestCase):
    def test_qbt_recipient_amount_is_exact_and_above_the_p2mr_dust_floor(self):
        self.assertEqual(qpet._qbt_amount_bits("0.0001"), 10_000)
        self.assertEqual(qpet._qbt_amount_bits("0.00002855"), 2_855)
        for invalid in ("0", "-1", "nan", "inf", "0.00000001", "0.000000001"):
            with self.subTest(invalid=invalid):
                with self.assertRaises(argparse.ArgumentTypeError):
                    qpet._qbt_amount_bits(invalid)

    def test_recipient_and_amount_are_required_together_before_any_rpc(self):
        with TemporaryDirectory() as directory:
            signed_path = Path(directory) / "must-not-exist.hex"
            args = SimpleNamespace(
                cli="qbit-cli",
                datadir=None,
                chain="main",
                wallet="mint",
                rpc_port=None,
                manifest="not-read.json",
                sheet="not-read.webp",
                fee_rate=1,
                dry_run=True,
                yes=False,
                out_signed=str(signed_path),
                recipient="qb1invalid",
                recipient_amount=None,
            )

            with mock.patch.object(qpet, "Rpc") as rpc_constructor:
                with self.assertRaisesRegex(RuntimeError, "must be provided together"):
                    qpet.cmd_inscribe(args)
            rpc_constructor.assert_not_called()
            self.assertFalse(signed_path.exists())

    def test_inscription_pins_recipient_at_output_one_and_change_at_output_two(self):
        calls = []
        txid = "d" * 64
        address = "qb1z8q6dsf8sla7vcn2gzxnspuzpshzrkkk80c2a67xdpea2yxkpsm4qmzhake"
        recipient_script = "5220" + "ab" * 32

        with TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path, sheet_path = pet_source_files(root)
            pet = json.loads(manifest_path.read_text(encoding="utf-8"))
            sheet = sheet_path.read_bytes()
            payload = qpet.encode_envelope(qpet.build_manifest(pet, sheet), sheet)
            signed_path = root / "recipient.signed.hex"

            class FakeRpc:
                def __call__(self, method, *params):
                    calls.append((method, params))
                    if method == "validateaddress":
                        return {"isvalid": True, "address": address, "scriptPubKey": recipient_script}
                    if method == "createrawtransaction":
                        return "00"
                    if method == "fundrawtransaction":
                        return {"hex": "11", "fee": 0.000145}
                    if method == "signrawtransactionwithwallet":
                        return {"hex": "deadbeef", "complete": True}
                    if method == "decoderawtransaction":
                        return {
                            "txid": txid,
                            "vsize": 14_500,
                            "vout": [
                                {"n": 0, "value": 0, "scriptPubKey": {"hex": op_return_script(payload).hex()}},
                                {"n": 1, "value": 0.0001, "scriptPubKey": {"hex": recipient_script}},
                                {"n": 2, "value": 0.9, "scriptPubKey": {"hex": "5220" + "cd" * 32}},
                            ],
                        }
                    if method == "testmempoolaccept":
                        return [{"allowed": True, "txid": txid, "vsize": 14_500}]
                    raise AssertionError(f"unexpected RPC {method}")

            args = SimpleNamespace(
                cli="qbit-cli",
                datadir="/node",
                chain="main",
                wallet="mint",
                rpc_port=49351,
                manifest=str(manifest_path),
                sheet=str(sheet_path),
                fee_rate=1,
                dry_run=True,
                yes=False,
                out_signed=str(signed_path),
                recipient=address,
                recipient_amount=10_000,
            )

            with mock.patch.object(qpet, "Rpc", return_value=FakeRpc()), mock.patch(
                "builtins.print"
            ) as print_mock:
                qpet.cmd_inscribe(args)

            create_call = next(params for method, params in calls if method == "createrawtransaction")
            self.assertEqual(create_call[1], [{"data": payload.hex()}, {address: "0.00010000"}])
            fund_call = next(params for method, params in calls if method == "fundrawtransaction")
            self.assertEqual(
                fund_call,
                ("00", {"fee_rate": 1, "changePosition": 2, "lockUnspents": True}),
            )
            rendered = "\n".join(" ".join(str(part) for part in call.args) for call in print_mock.call_args_list)
            self.assertIn(f"recipient: output=1 address={address} amount=0.00010000 QBT", rendered)

    def test_rpc_defaults_do_not_expose_personal_paths_or_wallets(self):
        rpc = qpet.Rpc("qbit-cli", None, "main")
        self.assertEqual(rpc.base, ["qbit-cli", "-chain=main"])

    def test_rpc_port_is_passed_as_a_global_qbit_cli_option(self):
        rpc = qpet.Rpc("qbit-cli", "/node", "testnet4", "mint", 49352)
        self.assertEqual(
            rpc.base,
            [
                "qbit-cli",
                "-chain=testnet4",
                "-datadir=/node",
                "-rpcport=49352",
                "-rpcwallet=mint",
            ],
        )

    def test_noninteractive_inscription_requires_explicit_yes(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path, sheet_path = pet_source_files(root)
            args = SimpleNamespace(
                cli="qbit-cli",
                datadir=None,
                chain="main",
                wallet=None,
                rpc_port=None,
                manifest=str(manifest_path),
                sheet=str(sheet_path),
                fee_rate=1,
                dry_run=False,
                yes=False,
                out_signed=None,
            )

            with mock.patch.object(qpet, "Rpc") as rpc_constructor, mock.patch.object(
                qpet.sys.stdin, "isatty", return_value=False
            ):
                with self.assertRaisesRegex(RuntimeError, "refusing to broadcast"):
                    qpet.cmd_inscribe(args)
            rpc_constructor.assert_not_called()

    def test_inscription_requires_a_signed_output_before_any_rpc(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path, sheet_path = pet_source_files(root)
            args = SimpleNamespace(
                cli="qbit-cli",
                datadir=None,
                chain="testnet4",
                wallet="mint",
                rpc_port=None,
                manifest=str(manifest_path),
                sheet=str(sheet_path),
                fee_rate=1,
                dry_run=True,
                yes=False,
                out_signed=None,
            )

            with mock.patch.object(qpet, "Rpc") as rpc_constructor:
                with self.assertRaisesRegex(RuntimeError, "--out-signed is required"):
                    qpet.cmd_inscribe(args)
            rpc_constructor.assert_not_called()

    def test_dry_run_saves_and_inspects_the_one_signature(self):
        calls = []
        durability_events = []
        txid = "a" * 64

        class FakeRpc:
            payload = None

            def __call__(self, method, *params):
                calls.append((method, params))
                if method == "createrawtransaction":
                    self.payload = bytes.fromhex(params[1][0]["data"])
                    return "00"
                if method == "fundrawtransaction":
                    return {"hex": "11", "fee": 0.00001381}
                if method == "signrawtransactionwithwallet":
                    durability_events.append("sign")
                    return {"hex": "deadbeef", "complete": True}
                if method == "decoderawtransaction":
                    return {
                        "txid": txid,
                        "vsize": 13380,
                        "vout": [
                            {"n": 0, "scriptPubKey": {"hex": op_return_script(self.payload).hex()}},
                            {"n": 1, "scriptPubKey": {"hex": "0014" + "00" * 20}},
                        ],
                    }
                if method == "testmempoolaccept":
                    return [{"allowed": True, "txid": txid, "vsize": 13380}]
                raise AssertionError(f"unexpected RPC {method}")

        with TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path, sheet_path = pet_source_files(root)
            signed_path = root / "mint.signed.hex"
            args = SimpleNamespace(
                cli="qbit-cli",
                datadir="/node",
                chain="testnet4",
                wallet="mint",
                rpc_port=49352,
                manifest=str(manifest_path),
                sheet=str(sheet_path),
                fee_rate=1,
                dry_run=True,
                yes=False,
                out_signed=str(signed_path),
            )

            fake = FakeRpc()
            original_durable_sync = qpet._durable_sync_file
            original_parent_sync = qpet._sync_parent_directory

            def tracked_durable_sync(fd):
                durability_events.append("file-sync")
                return original_durable_sync(fd)

            def tracked_parent_sync(path):
                durability_events.append("parent-sync")
                return original_parent_sync(path)

            with mock.patch.object(qpet, "Rpc", return_value=fake) as rpc_constructor, mock.patch(
                "builtins.print"
            ) as print_mock, mock.patch.object(
                qpet, "_durable_sync_file", side_effect=tracked_durable_sync
            ), mock.patch.object(
                qpet, "_sync_parent_directory", side_effect=tracked_parent_sync
            ):
                qpet.cmd_inscribe(args)

            rpc_constructor.assert_called_once_with(
                "qbit-cli", "/node", "testnet4", "mint", 49352
            )
            self.assertEqual(signed_path.read_text(encoding="ascii"), "deadbeef\n")
            self.assertEqual(stat.S_IMODE(signed_path.stat().st_mode), 0o600)
            methods = [method for method, _ in calls]
            self.assertEqual(methods.count("signrawtransactionwithwallet"), 1)
            self.assertNotIn("sendrawtransaction", methods)
            self.assertLess(durability_events.index("file-sync"), durability_events.index("sign"))
            self.assertLess(durability_events.index("parent-sync"), durability_events.index("sign"))
            fund_call = next(params for method, params in calls if method == "fundrawtransaction")
            self.assertEqual(
                fund_call,
                ("00", {"fee_rate": 1, "changePosition": 1, "lockUnspents": True}),
            )
            mempool_call = next(params for method, params in calls if method == "testmempoolaccept")
            self.assertEqual(mempool_call, (["deadbeef"],))
            rendered = "\n".join(" ".join(str(part) for part in call.args) for call in print_mock.call_args_list)
            self.assertIn(f"txid={txid}", rendered)
            self.assertIn("QPET output=0", rendered)
            self.assertIn(f"sheet: {len(SHEET)} bytes", rendered)

    def test_reservation_sync_failure_removes_path_before_rpc_or_signature(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path, sheet_path = pet_source_files(root)
            signed_path = root / "reservation-failed.hex"
            args = SimpleNamespace(
                cli="qbit-cli",
                datadir="/node",
                chain="testnet4",
                wallet="mint",
                rpc_port=49352,
                manifest=str(manifest_path),
                sheet=str(sheet_path),
                fee_rate=1,
                dry_run=True,
                yes=False,
                out_signed=str(signed_path),
            )

            with mock.patch.object(
                qpet, "_sync_parent_directory", side_effect=OSError("sync failed")
            ), mock.patch.object(qpet, "Rpc") as rpc_constructor:
                with self.assertRaisesRegex(OSError, "sync failed"):
                    qpet.cmd_inscribe(args)

            rpc_constructor.assert_not_called()
            self.assertFalse(signed_path.exists())

    def test_macos_fullsync_failure_removes_path_before_rpc_or_signature(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path, sheet_path = pet_source_files(root)
            signed_path = root / "fullsync-failed.hex"
            args = SimpleNamespace(
                cli="qbit-cli",
                datadir="/node",
                chain="testnet4",
                wallet="mint",
                rpc_port=49352,
                manifest=str(manifest_path),
                sheet=str(sheet_path),
                fee_rate=1,
                dry_run=True,
                yes=False,
                out_signed=str(signed_path),
            )
            fake_fcntl = SimpleNamespace(F_FULLFSYNC=51)
            fake_fcntl.fcntl = mock.Mock(side_effect=OSError("full sync failed"))

            with mock.patch.object(qpet.sys, "platform", "darwin"), mock.patch.object(
                qpet, "fcntl", fake_fcntl
            ), mock.patch.object(qpet, "Rpc") as rpc_constructor:
                with self.assertRaisesRegex(OSError, "full sync failed"):
                    qpet.cmd_inscribe(args)

            fake_fcntl.fcntl.assert_called_once()
            rpc_constructor.assert_not_called()
            self.assertFalse(signed_path.exists())

    def test_existing_signed_output_refuses_before_any_rpc_or_signature(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path, sheet_path = pet_source_files(root)
            signed_path = root / "already-there.hex"
            signed_path.write_text("do not overwrite", encoding="utf-8")
            args = SimpleNamespace(
                cli="qbit-cli",
                datadir=None,
                chain="testnet4",
                wallet="mint",
                rpc_port=None,
                manifest=str(manifest_path),
                sheet=str(sheet_path),
                fee_rate=1,
                dry_run=True,
                yes=False,
                out_signed=str(signed_path),
            )

            with mock.patch.object(qpet, "Rpc") as rpc_constructor:
                with self.assertRaises(FileExistsError):
                    qpet.cmd_inscribe(args)
            rpc_constructor.assert_not_called()
            self.assertEqual(signed_path.read_text(encoding="utf-8"), "do not overwrite")

    def test_signed_bytes_survive_a_post_signature_inspection_failure(self):
        calls = []

        class FakeRpc:
            def __call__(self, method, *params):
                calls.append(method)
                if method == "createrawtransaction":
                    return "00"
                if method == "fundrawtransaction":
                    return {"hex": "11", "fee": 0.00001381}
                if method == "signrawtransactionwithwallet":
                    return {"hex": "deadbeef", "complete": True}
                if method == "decoderawtransaction":
                    return {
                        "txid": "c" * 64,
                        "vsize": 200,
                        "vout": [{"n": 0, "scriptPubKey": {"hex": "0014" + "00" * 20}}],
                    }
                raise AssertionError(f"unexpected RPC {method}")

        with TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path, sheet_path = pet_source_files(root)
            signed_path = root / "recoverable.signed.hex"
            args = SimpleNamespace(
                cli="qbit-cli",
                datadir=None,
                chain="testnet4",
                wallet="mint",
                rpc_port=None,
                manifest=str(manifest_path),
                sheet=str(sheet_path),
                fee_rate=1,
                dry_run=True,
                yes=False,
                out_signed=str(signed_path),
            )

            with mock.patch.object(qpet, "Rpc", return_value=FakeRpc()):
                with self.assertRaisesRegex(RuntimeError, "no QPET"):
                    qpet.cmd_inscribe(args)

            self.assertEqual(signed_path.read_text(encoding="ascii"), "deadbeef\n")
            self.assertEqual(calls.count("signrawtransactionwithwallet"), 1)
            self.assertNotIn("testmempoolaccept", calls)
            self.assertNotIn("sendrawtransaction", calls)

    def test_broadcast_validates_and_sends_the_saved_bytes_without_signing(self):
        calls = []
        txid = "b" * 64
        payload = qpet.encode_envelope(manifest_for(), SHEET)

        class FakeRpc:
            def __call__(self, method, *params):
                calls.append((method, params))
                if method == "decoderawtransaction":
                    return {
                        "txid": txid,
                        "vsize": 700,
                        "vout": [
                            {"n": 0, "scriptPubKey": {"hex": op_return_script(payload).hex()}},
                            {"n": 1, "scriptPubKey": {"hex": "0014" + "00" * 20}},
                        ],
                    }
                if method == "testmempoolaccept":
                    return [{"allowed": True, "txid": txid, "vsize": 700}]
                if method == "sendrawtransaction":
                    return txid
                raise AssertionError(f"unexpected RPC {method}")

        with TemporaryDirectory() as directory:
            signed_path = Path(directory) / "mint.signed.hex"
            signed_path.write_text("cafebabe\n", encoding="ascii")
            args = SimpleNamespace(
                cli="qbit-cli",
                datadir="/node",
                chain="testnet4",
                wallet="mint",
                rpc_port=49352,
                signed=str(signed_path),
                expected_txid=txid,
                expected_envelope_sha256=hashlib.sha256(payload).hexdigest(),
                expected_pet_id="qbit",
                yes=True,
                qpet_only=True,
            )

            with mock.patch.object(qpet, "Rpc", return_value=FakeRpc()):
                qpet.cmd_broadcast(args)

        methods = [method for method, _ in calls]
        self.assertEqual(
            methods,
            ["decoderawtransaction", "testmempoolaccept", "sendrawtransaction"],
        )
        self.assertNotIn("signrawtransactionwithwallet", methods)
        self.assertEqual(calls[-1], ("sendrawtransaction", ("cafebabe",)))

    def test_broadcast_refuses_a_saved_transaction_with_the_wrong_recipient_amount(self):
        calls = []
        address = "qb1z8q6dsf8sla7vcn2gzxnspuzpshzrkkk80c2a67xdpea2yxkpsm4qmzhake"
        recipient_script = "5220" + "ab" * 32
        payload = qpet.encode_envelope(manifest_for(), SHEET)

        class FakeRpc:
            def __call__(self, method, *params):
                calls.append(method)
                if method == "validateaddress":
                    return {"isvalid": True, "address": address, "scriptPubKey": recipient_script}
                if method == "decoderawtransaction":
                    return {
                        "txid": "e" * 64,
                        "vsize": 700,
                        "vout": [
                            {"n": 0, "value": 0, "scriptPubKey": {"hex": op_return_script(payload).hex()}},
                            {"n": 1, "value": 0.0002, "scriptPubKey": {"hex": recipient_script}},
                        ],
                    }
                raise AssertionError(f"unexpected RPC {method}")

        with TemporaryDirectory() as directory:
            signed_path = Path(directory) / "wrong-recipient.signed.hex"
            signed_path.write_text("cafebabe\n", encoding="ascii")
            args = SimpleNamespace(
                cli="qbit-cli",
                datadir="/node",
                chain="main",
                wallet="mint",
                rpc_port=49351,
                signed=str(signed_path),
                expected_txid="e" * 64,
                expected_envelope_sha256=hashlib.sha256(payload).hexdigest(),
                expected_pet_id="qbit",
                yes=True,
                recipient=address,
                recipient_amount=10_000,
                qpet_only=False,
            )

            with mock.patch.object(qpet, "Rpc", return_value=FakeRpc()):
                with self.assertRaisesRegex(RuntimeError, "amount differs"):
                    qpet.cmd_broadcast(args)

        self.assertEqual(calls, ["validateaddress", "decoderawtransaction"])

    def test_broadcast_requires_an_explicit_output_validation_mode(self):
        args = SimpleNamespace(
            cli="qbit-cli",
            datadir=None,
            chain="main",
            wallet=None,
            rpc_port=None,
            signed="does-not-exist",
            expected_txid="0" * 64,
            expected_envelope_sha256="0" * 64,
            expected_pet_id="qbit",
            yes=True,
            recipient=None,
            recipient_amount=None,
            qpet_only=False,
        )
        with mock.patch.object(qpet, "Rpc") as rpc_constructor:
            with self.assertRaisesRegex(RuntimeError, "recipient expectations or explicit"):
                qpet.cmd_broadcast(args)
        rpc_constructor.assert_not_called()

    def test_broadcast_refuses_when_qpet_is_not_output_zero(self):
        payload = qpet.encode_envelope(manifest_for(), SHEET)

        class FakeRpc:
            def __call__(self, method, *params):
                if method == "decoderawtransaction":
                    return {
                        "txid": "f" * 64,
                        "vsize": 700,
                        "vout": [
                            {"n": 0, "value": 1, "scriptPubKey": {"hex": "5220" + "ab" * 32}},
                            {"n": 1, "value": 0, "scriptPubKey": {"hex": op_return_script(payload).hex()}},
                        ],
                    }
                raise AssertionError(f"unexpected RPC {method}")

        with TemporaryDirectory() as directory:
            signed_path = Path(directory) / "wrong-output.signed.hex"
            signed_path.write_text("cafebabe\n", encoding="ascii")
            args = SimpleNamespace(
                cli="qbit-cli",
                datadir="/node",
                chain="main",
                wallet="mint",
                rpc_port=49351,
                signed=str(signed_path),
                expected_txid="f" * 64,
                expected_envelope_sha256=hashlib.sha256(payload).hexdigest(),
                expected_pet_id="qbit",
                yes=True,
                recipient=None,
                recipient_amount=None,
                qpet_only=True,
            )
            with mock.patch.object(qpet, "Rpc", return_value=FakeRpc()):
                with self.assertRaisesRegex(RuntimeError, "away from output 0"):
                    qpet.cmd_broadcast(args)

    def test_broadcast_refuses_a_different_valid_qpet_artifact(self):
        calls = []
        payload = qpet.encode_envelope(manifest_for(), SHEET)

        class FakeRpc:
            def __call__(self, method, *params):
                calls.append(method)
                if method == "decoderawtransaction":
                    return {
                        "txid": "1" * 64,
                        "vsize": 700,
                        "vout": [
                            {"n": 0, "value": 0, "scriptPubKey": {"hex": op_return_script(payload).hex()}},
                        ],
                    }
                raise AssertionError(f"unexpected RPC {method}")

        with TemporaryDirectory() as directory:
            signed_path = Path(directory) / "wrong-valid-qpet.signed.hex"
            signed_path.write_text("cafebabe\n", encoding="ascii")
            args = SimpleNamespace(
                cli="qbit-cli",
                datadir="/node",
                chain="main",
                wallet="mint",
                rpc_port=49351,
                signed=str(signed_path),
                expected_txid="1" * 64,
                expected_envelope_sha256="0" * 64,
                expected_pet_id="miner-one",
                yes=True,
                recipient=None,
                recipient_amount=None,
                qpet_only=True,
            )
            with mock.patch.object(qpet, "Rpc", return_value=FakeRpc()):
                with self.assertRaisesRegex(RuntimeError, "envelope SHA-256 differs"):
                    qpet.cmd_broadcast(args)

        self.assertEqual(calls, ["decoderawtransaction"])

    def test_broadcast_refuses_a_valid_qpet_with_the_wrong_pet_id(self):
        calls = []
        payload = qpet.encode_envelope(manifest_for(), SHEET)

        class FakeRpc:
            def __call__(self, method, *params):
                calls.append(method)
                if method == "decoderawtransaction":
                    return {
                        "txid": "2" * 64,
                        "vsize": 700,
                        "vout": [
                            {"n": 0, "value": 0, "scriptPubKey": {"hex": op_return_script(payload).hex()}},
                        ],
                    }
                raise AssertionError(f"unexpected RPC {method}")

        with TemporaryDirectory() as directory:
            signed_path = Path(directory) / "wrong-pet-id.signed.hex"
            signed_path.write_text("cafebabe\n", encoding="ascii")
            args = SimpleNamespace(
                cli="qbit-cli",
                datadir="/node",
                chain="main",
                wallet="mint",
                rpc_port=49351,
                signed=str(signed_path),
                expected_txid="2" * 64,
                expected_envelope_sha256=hashlib.sha256(payload).hexdigest(),
                expected_pet_id="miner-one",
                yes=True,
                recipient=None,
                recipient_amount=None,
                qpet_only=True,
            )
            with mock.patch.object(qpet, "Rpc", return_value=FakeRpc()):
                with self.assertRaisesRegex(RuntimeError, "pet ID differs"):
                    qpet.cmd_broadcast(args)

        self.assertEqual(calls, ["decoderawtransaction"])

    def test_noninteractive_broadcast_refuses_before_file_or_rpc_access(self):
        args = SimpleNamespace(
            cli="qbit-cli",
            datadir=None,
            chain="testnet4",
            wallet=None,
            rpc_port=None,
            signed="does-not-exist",
            yes=False,
        )
        with mock.patch.object(qpet, "Rpc") as rpc_constructor, mock.patch.object(
            qpet.sys.stdin, "isatty", return_value=False
        ):
            with self.assertRaisesRegex(RuntimeError, "refusing to broadcast"):
                qpet.cmd_broadcast(args)
        rpc_constructor.assert_not_called()



if __name__ == "__main__":
    unittest.main()
