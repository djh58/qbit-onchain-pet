import base64
import hashlib
import json
from pathlib import Path
import re
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
    def test_rpc_defaults_do_not_expose_personal_paths_or_wallets(self):
        rpc = qpet.Rpc("qbit-cli", None, "main")
        self.assertEqual(rpc.base, ["qbit-cli", "-chain=main"])

    def test_noninteractive_inscription_requires_explicit_yes(self):
        calls = []

        class FakeRpc:
            def __call__(self, method, *params):
                calls.append(method)
                return {
                    "createrawtransaction": "raw",
                    "fundrawtransaction": {"hex": "funded", "fee": 0.00001381},
                    "signrawtransactionwithwallet": {"hex": "signed", "complete": True},
                    "testmempoolaccept": [{"allowed": True, "vsize": 13380}],
                }[method]

        with TemporaryDirectory() as directory:
            root = Path(directory)
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
            args = SimpleNamespace(
                cli="qbit-cli",
                datadir=None,
                chain="main",
                wallet=None,
                manifest=str(manifest_path),
                sheet=str(sheet_path),
                fee_rate=1,
                dry_run=False,
                yes=False,
            )

            with mock.patch.object(qpet, "Rpc", return_value=FakeRpc()), mock.patch.object(
                qpet.sys.stdin, "isatty", return_value=False
            ):
                with self.assertRaisesRegex(RuntimeError, "refusing to broadcast"):
                    qpet.cmd_inscribe(args)

        self.assertNotIn("sendrawtransaction", calls)


if __name__ == "__main__":
    unittest.main()
