#!/usr/bin/env python3
"""qpet: inscribe and view animated codex-style pets on the qbit chain.

Envelope (QPET v1), carried as the single data push of one OP_RETURN output:

    bytes 0..3   magic "QPET"
    byte  4      version (0x01)
    bytes 5..6   manifest length, uint16 little-endian
    ...          manifest JSON (UTF-8)
    rest         spritesheet bytes (content type declared in the manifest)

The manifest embeds the codex-pets v1 animation table (state -> spritesheet
row, frame count, fps, loop flag) so the pet can be re-animated from chain
data alone.

    qpet.py inscribe --manifest pet.json --sheet spritesheet.webp [--dry-run]
    qpet.py broadcast --signed qpet.signed.hex
    qpet.py view <txid> [--out pet.html]
"""

import argparse
import base64
from decimal import Decimal, InvalidOperation
try:
    import fcntl
except ImportError:  # pragma: no cover - non-POSIX fallback
    fcntl = None
import hashlib
import html
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

MAGIC = b"QPET"
VERSION = 1

# codex-pets v1 stage semantics (from codex-pet-share src/playground/core/config.ts)
V1_STATES = [
    {"id": "idle", "row": 0, "frames": 6, "fps": 6, "loop": True},
    {"id": "running-right", "row": 1, "frames": 8, "fps": 12, "loop": True},
    {"id": "running-left", "row": 2, "frames": 8, "fps": 12, "loop": True},
    {"id": "waving", "row": 3, "frames": 4, "fps": 5, "loop": False},
    {"id": "jumping", "row": 4, "frames": 5, "fps": 14, "loop": False},
    {"id": "failed", "row": 5, "frames": 8, "fps": 6, "loop": False},
    {"id": "waiting", "row": 6, "frames": 6, "fps": 4, "loop": True},
    {"id": "running", "row": 7, "frames": 6, "fps": 12, "loop": True},
    {"id": "review", "row": 8, "frames": 6, "fps": 6, "loop": True},
]

DEFAULT_CLI = "qbit-cli"
DEFAULT_CHAIN = "main"
MAX_SHEET_BYTES = 16 * 1024 * 1024
MAX_SIGNED_TRANSACTION_HEX_CHARACTERS = 2 * (MAX_SHEET_BYTES + 1024 * 1024)
MAX_STATES = 32
BITS_PER_QBT = 100_000_000
MIN_P2MR_RECIPIENT_BITS = 2_855
MAX_QBT_BITS = 210_000_000 * BITS_PER_QBT
SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
HEX_RE = re.compile(r"^[0-9a-fA-F]+$")
VIEWER_PLACEHOLDER_RE = re.compile(
    r"__(?:TITLE|CHAIN|DESC|CTYPE|SHEET_B64|TXID|CONF|MANIFEST_B64)__"
)


def _reject_json_constant(value: str):
    raise ValueError(f"invalid JSON constant {value}")


class Rpc:
    def __init__(self, cli, datadir, chain, wallet=None, rpc_port=None):
        self.base = [cli, f"-chain={chain}"]
        if datadir:
            self.base.append(f"-datadir={datadir}")
        if rpc_port is not None:
            self.base.append(f"-rpcport={rpc_port}")
        if wallet:
            self.base.append(f"-rpcwallet={wallet}")

    def __call__(self, method, *params):
        cmd = self.base + [method] + [
            p if isinstance(p, str) else json.dumps(p) for p in params
        ]
        out = subprocess.run(cmd, capture_output=True, text=True)
        if out.returncode != 0:
            raise RuntimeError(f"{method} failed: {out.stderr.strip()}")
        text = out.stdout.strip()
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text


def encode_envelope(manifest: dict, sheet: bytes) -> bytes:
    validate_manifest(manifest, sheet)
    mjson = json.dumps(
        manifest,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode()
    if len(mjson) > 0xFFFF:
        raise ValueError("manifest too large")
    return MAGIC + bytes([VERSION]) + len(mjson).to_bytes(2, "little") + mjson + sheet


def decode_envelope(blob: bytes):
    if len(blob) < 7:
        raise ValueError("truncated QPET envelope")
    if blob[:4] != MAGIC:
        raise ValueError("not a QPET payload")
    if blob[4] != VERSION:
        raise ValueError(f"unsupported QPET version {blob[4]}")
    mlen = int.from_bytes(blob[5:7], "little")
    sheet_offset = 7 + mlen
    if mlen == 0 or sheet_offset > len(blob):
        raise ValueError("truncated QPET manifest")
    try:
        manifest = json.loads(
            blob[7:sheet_offset].decode("utf-8", errors="strict"),
            parse_constant=_reject_json_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError) as exc:
        raise ValueError("QPET manifest is not valid UTF-8 JSON") from exc
    return manifest, blob[sheet_offset:]


def script_pushes(script: bytes) -> bytes:
    """Return the sole data push from a QPET OP_RETURN scriptPubKey."""
    if not script or script[0] != 0x6A:
        raise ValueError("not an OP_RETURN script")
    if len(script) == 1:
        raise ValueError("OP_RETURN has no data push")

    i = 1
    op = script[i]
    i += 1
    if op <= 0x4B:
        n = op
    elif op in (0x4C, 0x4D, 0x4E):
        length_bytes = {0x4C: 1, 0x4D: 2, 0x4E: 4}[op]
        if i + length_bytes > len(script):
            raise ValueError("truncated pushdata length")
        n = int.from_bytes(script[i : i + length_bytes], "little")
        i += length_bytes
    else:
        raise ValueError(f"unexpected opcode 0x{op:02x} in data script")

    end = i + n
    if end > len(script):
        raise ValueError("truncated OP_RETURN payload")
    if end != len(script):
        raise ValueError("QPET v1 requires exactly one OP_RETURN data push")
    return script[i:end]


def _positive_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _bounded_utf8_string(value, maximum: int, allow_empty=False) -> bool:
    if not isinstance(value, str) or (not allow_empty and not value):
        return False
    try:
        encoded = value.encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        return False
    return len(encoded) <= maximum


def _required_string(manifest: dict, field: str, maximum: int) -> str:
    value = manifest.get(field)
    if not _bounded_utf8_string(value, maximum):
        raise ValueError(f"QPET {field} is invalid")
    return value


def _require_exact_keys(value: dict, expected: set, label: str):
    if set(value) != expected:
        raise ValueError(f"QPET {label} fields are invalid")


def validate_manifest(manifest, sheet: bytes) -> str:
    """Validate the QPET v1 schema and return the verified sheet digest."""
    if not isinstance(manifest, dict):
        raise ValueError("QPET manifest is not an object")
    _require_exact_keys(
        manifest,
        {
            "format",
            "id",
            "displayName",
            "description",
            "kind",
            "author",
            "frame",
            "states",
            "sheet",
        },
        "manifest",
    )
    if manifest.get("format") != "codex-pet-v1":
        raise ValueError("unsupported pet format")

    _required_string(manifest, "id", 64)
    _required_string(manifest, "displayName", 120)
    description = manifest.get("description")
    if not _bounded_utf8_string(description, 2000, allow_empty=True):
        raise ValueError("QPET description is invalid")
    _required_string(manifest, "kind", 64)
    _required_string(manifest, "author", 120)

    frame = manifest.get("frame")
    if not isinstance(frame, dict):
        raise ValueError("QPET frame geometry is invalid")
    _require_exact_keys(frame, {"width", "height", "columns", "rows"}, "frame")
    for field in ("width", "height", "columns", "rows"):
        if not _positive_int(frame.get(field)):
            raise ValueError("QPET frame geometry is invalid")
    if (
        frame["width"] > 4096
        or frame["height"] > 4096
        or frame["columns"] > 256
        or frame["rows"] > 256
        or frame["width"] * frame["columns"] > 32768
        or frame["height"] * frame["rows"] > 32768
    ):
        raise ValueError("QPET frame geometry is out of bounds")

    states = manifest.get("states")
    if not isinstance(states, list) or not 1 <= len(states) <= MAX_STATES:
        raise ValueError("QPET animation table is invalid")
    state_ids = set()
    for state in states:
        if not isinstance(state, dict):
            raise ValueError("QPET animation state is invalid")
        _require_exact_keys(state, {"id", "row", "frames", "fps", "loop"}, "animation state")
        state_id = state.get("id")
        if (
            not _bounded_utf8_string(state_id, 64)
            or state_id in state_ids
            or not isinstance(state.get("row"), int)
            or isinstance(state.get("row"), bool)
            or not 0 <= state["row"] < frame["rows"]
            or not _positive_int(state.get("frames"))
            or state["frames"] > frame["columns"]
            or not _positive_int(state.get("fps"))
            or state["fps"] > 60
            or not isinstance(state.get("loop"), bool)
        ):
            raise ValueError("QPET animation state is invalid")
        state_ids.add(state_id)

    if not isinstance(sheet, bytes) or not 1 <= len(sheet) <= MAX_SHEET_BYTES:
        raise ValueError("QPET spritesheet size is invalid")
    declaration = manifest.get("sheet")
    if not isinstance(declaration, dict):
        raise ValueError("QPET spritesheet declaration is invalid")
    _require_exact_keys(declaration, {"contentType", "length", "sha256"}, "spritesheet")
    declared_length = declaration.get("length")
    if (
        declaration.get("contentType") != "image/webp"
        or not isinstance(declared_length, int)
        or isinstance(declared_length, bool)
        or declared_length != len(sheet)
        or not isinstance(declaration.get("sha256"), str)
        or not SHA256_RE.fullmatch(declaration["sha256"])
    ):
        raise ValueError("QPET spritesheet declaration is invalid")

    digest = hashlib.sha256(sheet).hexdigest()
    if digest != declaration["sha256"].lower():
        raise ValueError("spritesheet hash mismatch — corrupt payload")
    return digest


def build_manifest(pet: dict, sheet: bytes) -> dict:
    return {
        "format": "codex-pet-v1",
        "id": pet["id"],
        "displayName": pet.get("displayName", pet["id"]),
        "description": pet.get("description", ""),
        "kind": pet.get("kind", "object"),
        "author": pet.get("author", "dan"),
        "frame": pet["frame"],
        "states": V1_STATES,
        "sheet": {
            "contentType": "image/webp",
            "length": len(sheet),
            "sha256": hashlib.sha256(sheet).hexdigest(),
        },
    }


def _rpc_for_args(args):
    return Rpc(
        args.cli,
        args.datadir,
        args.chain,
        args.wallet,
        getattr(args, "rpc_port", None),
    )


def _validate_signed_hex(value: str) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > MAX_SIGNED_TRANSACTION_HEX_CHARACTERS
        or len(value) % 2
        or not HEX_RE.fullmatch(value)
    ):
        raise ValueError("signed transaction is not valid bounded hex")
    return value


def _read_signed_hex(path_value: str) -> str:
    path = Path(path_value)
    if path.stat().st_size > MAX_SIGNED_TRANSACTION_HEX_CHARACTERS + 1:
        raise ValueError("signed transaction file is too large")
    try:
        value = path.read_text(encoding="ascii").strip()
    except UnicodeDecodeError as exc:
        raise ValueError("signed transaction file is not ASCII hex") from exc
    return _validate_signed_hex(value)


def _durable_sync_file(fd: int):
    """Request stable storage, using macOS F_FULLFSYNC when available."""
    if sys.platform == "darwin" and fcntl is not None and hasattr(fcntl, "F_FULLFSYNC"):
        fcntl.fcntl(fd, fcntl.F_FULLFSYNC)
        return
    os.fsync(fd)


def _sync_parent_directory(path: Path):
    flags = os.O_RDONLY
    if hasattr(os, "O_DIRECTORY"):
        flags |= os.O_DIRECTORY
    directory_fd = os.open(path.parent, flags)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def _reserve_signed_output(path_value: str):
    """Exclusively reserve a private file before any stateful signing RPC."""
    path = Path(path_value)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    fd = os.open(path, flags, stat.S_IRUSR | stat.S_IWUSR)
    try:
        os.fchmod(fd, stat.S_IRUSR | stat.S_IWUSR)
        _durable_sync_file(fd)
        _sync_parent_directory(path)
    except Exception:
        os.close(fd)
        path.unlink(missing_ok=True)
        raise
    return path, fd


def _write_reserved_signed_output(fd: int, signed_hex: str):
    with os.fdopen(fd, "w", encoding="ascii", newline="\n") as handle:
        handle.write(signed_hex)
        handle.write("\n")
        handle.flush()
        _durable_sync_file(handle.fileno())


def _print_transaction_inspection(inspection: dict):
    print(
        f"signed transaction: txid={inspection['txid']} "
        f"vsize={inspection['vsize']} QPET output={inspection['output_index']}"
    )
    print(
        f"envelope: {inspection['envelope_length']} bytes "
        f"sha256={inspection['envelope_sha256']}"
    )
    print(
        f"sheet: {inspection['sheet_length']} bytes "
        f"sha256={inspection['sheet_sha256']}"
    )
    if "recipient_output_index" in inspection:
        print(
            f"recipient: output={inspection['recipient_output_index']} "
            f"address={inspection['recipient_address']} "
            f"amount={_format_qbt(inspection['recipient_amount_bits'])} QBT"
        )


def inspect_signed_qpet(
    rpc,
    signed_hex: str,
    expected_payload=None,
    expected_recipient=None,
) -> dict:
    """Decode and validate the QPET carried by one exact signed transaction."""
    signed_hex = _validate_signed_hex(signed_hex)
    tx = rpc("decoderawtransaction", signed_hex)
    output_index, blob = find_qpet_output(tx)
    if output_index != 0:
        raise RuntimeError("signed transaction moved the QPET away from output 0")
    manifest, sheet = decode_envelope(blob)
    sheet_digest = validate_manifest(manifest, sheet)
    if expected_payload is not None and blob != expected_payload:
        raise RuntimeError("signed transaction QPET payload differs from the requested envelope")

    txid = tx.get("txid") if isinstance(tx, dict) else None
    vsize = tx.get("vsize") if isinstance(tx, dict) else None
    if not isinstance(txid, str) or not SHA256_RE.fullmatch(txid):
        raise RuntimeError("decoded transaction has an invalid txid")
    if not _positive_int(vsize):
        raise RuntimeError("decoded transaction has an invalid vsize")
    inspection = {
        "txid": txid.lower(),
        "vsize": vsize,
        "output_index": output_index,
        "manifest": manifest,
        "envelope_length": len(blob),
        "envelope_sha256": hashlib.sha256(blob).hexdigest(),
        "sheet_length": len(sheet),
        "sheet_sha256": sheet_digest,
    }
    if expected_recipient is not None:
        inspection.update(_inspect_recipient_output(tx, expected_recipient))
    return inspection


def _test_mempool_accept(rpc, signed_hex: str, inspection: dict) -> dict:
    response = rpc("testmempoolaccept", [signed_hex])
    if not isinstance(response, list) or len(response) != 1 or not isinstance(response[0], dict):
        raise RuntimeError("testmempoolaccept returned an invalid response")
    accept = response[0]
    if not accept.get("allowed"):
        raise RuntimeError(f"rejected by mempool policy: {accept}")
    accept_txid = accept.get("txid")
    if accept_txid is not None and (
        not isinstance(accept_txid, str)
        or accept_txid.lower() != inspection["txid"]
    ):
        raise RuntimeError("testmempoolaccept returned a different txid")
    if accept.get("vsize") not in (None, inspection["vsize"]):
        raise RuntimeError("testmempoolaccept returned a different vsize")
    return accept


def _require_noninteractive_consent(yes: bool):
    if not yes and not sys.stdin.isatty():
        raise RuntimeError("refusing to broadcast without --yes in a non-interactive session")


def _rpc_port(value: str) -> int:
    try:
        port = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("RPC port must be an integer") from exc
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("RPC port must be between 1 and 65535")
    return port


def _sha256(value: str) -> str:
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
        raise argparse.ArgumentTypeError("expected SHA-256 must be exactly 64 hex characters")
    return value.lower()


def _qbt_amount_bits(value: str) -> int:
    """Parse one positive, at-most-eight-decimal QBT amount into integer bits."""
    try:
        amount = Decimal(value)
    except (InvalidOperation, ValueError) as exc:
        raise argparse.ArgumentTypeError("QBT amount must be a decimal number") from exc
    if not amount.is_finite() or amount <= 0:
        raise argparse.ArgumentTypeError("QBT amount must be positive and finite")
    bits = amount * BITS_PER_QBT
    if bits != bits.to_integral_value():
        raise argparse.ArgumentTypeError("QBT amount cannot have more than 8 decimals")
    integer_bits = int(bits)
    if integer_bits < MIN_P2MR_RECIPIENT_BITS:
        raise argparse.ArgumentTypeError(
            "QBT amount is below the Qbit v1 P2MR dust floor (0.00002855 QBT)"
        )
    if integer_bits > MAX_QBT_BITS:
        raise argparse.ArgumentTypeError("QBT amount exceeds the maximum money range")
    return integer_bits


def _format_qbt(bits: int) -> str:
    whole, fraction = divmod(bits, BITS_PER_QBT)
    return f"{whole}.{fraction:08d}"


def _recipient_from_args(args):
    address = getattr(args, "recipient", None)
    amount_bits = getattr(args, "recipient_amount", None)
    if (address is None) != (amount_bits is None):
        raise RuntimeError("--recipient and --recipient-amount must be provided together")
    if address is None:
        return None
    if not isinstance(address, str) or not 8 <= len(address) <= 128 or address.strip() != address:
        raise RuntimeError("recipient address is invalid")
    if not isinstance(amount_bits, int) or isinstance(amount_bits, bool) or not 1 <= amount_bits <= MAX_QBT_BITS:
        raise RuntimeError("recipient amount is invalid")
    return {"address": address, "amount_bits": amount_bits}


def _broadcast_identity_from_args(args) -> dict:
    txid = getattr(args, "expected_txid", None)
    envelope_sha256 = getattr(args, "expected_envelope_sha256", None)
    pet_id = getattr(args, "expected_pet_id", None)
    if not isinstance(txid, str) or not SHA256_RE.fullmatch(txid):
        raise RuntimeError("broadcast requires an exact expected transaction ID")
    if not isinstance(envelope_sha256, str) or not SHA256_RE.fullmatch(envelope_sha256):
        raise RuntimeError("broadcast requires an exact expected envelope SHA-256")
    if not _bounded_utf8_string(pet_id, 128):
        raise RuntimeError("broadcast requires an exact expected pet ID")
    return {
        "txid": txid.lower(),
        "envelope_sha256": envelope_sha256.lower(),
        "pet_id": pet_id,
    }


def _validate_recipient(rpc, recipient: dict) -> dict:
    """Resolve the exact destination script on the selected node and chain."""
    result = rpc("validateaddress", recipient["address"])
    if not isinstance(result, dict) or result.get("isvalid") is not True:
        raise RuntimeError("recipient address is not valid on the selected Qbit chain")
    normalized_address = result.get("address")
    script_hex = result.get("scriptPubKey")
    if normalized_address != recipient["address"]:
        raise RuntimeError("recipient address did not round-trip exactly through the selected node")
    if (
        not isinstance(script_hex, str)
        or not script_hex
        or len(script_hex) % 2
        or not HEX_RE.fullmatch(script_hex)
    ):
        raise RuntimeError("selected node returned an invalid recipient script")
    return {**recipient, "script_hex": script_hex.lower()}


def _decoded_qbt_bits(value) -> int:
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise RuntimeError("decoded recipient output has an invalid amount") from exc
    bits = amount * BITS_PER_QBT
    if not amount.is_finite() or bits != bits.to_integral_value():
        raise RuntimeError("decoded recipient output amount is not exact to one bit")
    return int(bits)


def _inspect_recipient_output(tx: dict, expected: dict) -> dict:
    outputs = tx.get("vout") if isinstance(tx, dict) else None
    if not isinstance(outputs, list):
        raise RuntimeError("decoded transaction has no output list")
    script_matches = []
    for vout in outputs:
        if not isinstance(vout, dict):
            continue
        script = vout.get("scriptPubKey")
        if not isinstance(script, dict) or str(script.get("hex", "")).lower() != expected["script_hex"]:
            continue
        script_matches.append(vout)
    if len(script_matches) != 1:
        raise RuntimeError("signed transaction does not contain exactly one requested recipient output")
    output = script_matches[0]
    if _decoded_qbt_bits(output.get("value")) != expected["amount_bits"]:
        raise RuntimeError("signed transaction recipient amount differs from the requested amount")
    output_index = output.get("n")
    if output_index != 1:
        raise RuntimeError("funded transaction moved the recipient away from output 1")
    return {
        "recipient_output_index": output_index,
        "recipient_address": expected["address"],
        "recipient_amount_bits": expected["amount_bits"],
    }


def cmd_inscribe(args):
    if not args.dry_run:
        # This must precede even RPC construction: funding and PQC signing are stateful.
        _require_noninteractive_consent(args.yes)
    if not getattr(args, "out_signed", None):
        raise RuntimeError(
            "--out-signed is required so stateful PQC signature bytes cannot be discarded"
        )
    requested_recipient = _recipient_from_args(args)

    pet = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    sheet = Path(args.sheet).read_bytes()
    manifest = build_manifest(pet, sheet)
    payload = encode_envelope(manifest, sheet)
    mlen = len(
        json.dumps(
            manifest,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        ).encode()
    )
    print(f"envelope: {len(payload)} bytes (manifest {mlen} B, sheet {len(sheet)} B)")

    reserved_path = None
    reserved_fd = None
    signed_available = False
    if getattr(args, "out_signed", None):
        reserved_path, reserved_fd = _reserve_signed_output(args.out_signed)

    try:
        rpc = _rpc_for_args(args)
        recipient = _validate_recipient(rpc, requested_recipient) if requested_recipient else None
        outputs = [{"data": payload.hex()}]
        if recipient:
            outputs.append({recipient["address"]: _format_qbt(recipient["amount_bits"])})
        raw = rpc("createrawtransaction", [], outputs)
        funded = rpc(
            "fundrawtransaction",
            raw,
            {
                "fee_rate": args.fee_rate,
                "changePosition": len(outputs),
                "lockUnspents": True,
            },
        )
        signed = rpc("signrawtransactionwithwallet", funded["hex"])
        signed_hex = _validate_signed_hex(signed.get("hex"))
        signed_available = True
        if reserved_fd is not None:
            fd_to_write = reserved_fd
            reserved_fd = None
            _write_reserved_signed_output(fd_to_write, signed_hex)
            print(f"signed transaction saved privately to {reserved_path}")
        if not signed.get("complete"):
            raise RuntimeError(f"signing incomplete: {signed}")

        inspection = inspect_signed_qpet(
            rpc,
            signed_hex,
            expected_payload=payload,
            expected_recipient=recipient,
        )
        _print_transaction_inspection(inspection)
        accept = _test_mempool_accept(rpc, signed_hex, inspection)
        vsize, fee = inspection["vsize"], funded["fee"]
        print(f"testmempoolaccept OK: vsize={vsize} fee={fee} QBT")

        if args.dry_run:
            print("dry run: not broadcasting")
            return
        if not args.yes:
            answer = input(
                f"Broadcast exact transaction {inspection['txid']} with fee {fee} QBT "
                f"and vsize {vsize}? Type 'broadcast' to continue: "
            )
            if answer.strip() != "broadcast":
                print("cancelled: not broadcasting")
                return
        txid = rpc("sendrawtransaction", signed_hex)
        if not isinstance(txid, str) or txid.lower() != inspection["txid"]:
            raise RuntimeError("sendrawtransaction returned a different txid")
        print(f"broadcast: txid={txid}")
    finally:
        if reserved_fd is not None:
            os.close(reserved_fd)
            if not signed_available and reserved_path is not None:
                reserved_path.unlink(missing_ok=True)


def cmd_broadcast(args):
    # Refuse before constructing the RPC client or decoding through the node.
    _require_noninteractive_consent(args.yes)
    requested_recipient = _recipient_from_args(args)
    qpet_only = getattr(args, "qpet_only", False)
    if requested_recipient is None and not qpet_only:
        raise RuntimeError(
            "broadcast requires recipient expectations or explicit --qpet-only acknowledgement"
        )
    if requested_recipient is not None and qpet_only:
        raise RuntimeError("--qpet-only cannot be combined with recipient expectations")
    expected_identity = _broadcast_identity_from_args(args)
    signed_hex = _read_signed_hex(args.signed)
    rpc = _rpc_for_args(args)
    recipient = _validate_recipient(rpc, requested_recipient) if requested_recipient else None
    inspection = inspect_signed_qpet(rpc, signed_hex, expected_recipient=recipient)
    if inspection["txid"] != expected_identity["txid"]:
        raise RuntimeError("saved transaction ID differs from the expected transaction")
    if inspection["envelope_sha256"] != expected_identity["envelope_sha256"]:
        raise RuntimeError("saved transaction envelope SHA-256 differs from the expected artifact")
    if inspection["manifest"]["id"] != expected_identity["pet_id"]:
        raise RuntimeError("saved transaction pet ID differs from the expected artifact")
    _print_transaction_inspection(inspection)
    accept = _test_mempool_accept(rpc, signed_hex, inspection)
    accepted_fees = accept.get("fees")
    accepted_fee = accepted_fees.get("base") if isinstance(accepted_fees, dict) else None
    fee_text = f" fee={accepted_fee} QBT" if accepted_fee is not None else ""
    print(f"testmempoolaccept OK: vsize={inspection['vsize']}{fee_text}")

    if not args.yes:
        answer = input(
            f"Broadcast exact transaction txid={inspection['txid']} "
            f"pet={expected_identity['pet_id']} "
            f"envelope={expected_identity['envelope_sha256']}? "
            "Type 'broadcast' to continue: "
        )
        if answer.strip() != "broadcast":
            print("cancelled: not broadcasting")
            return
    txid = rpc("sendrawtransaction", signed_hex)
    if not isinstance(txid, str) or txid.lower() != inspection["txid"]:
        raise RuntimeError("sendrawtransaction returned a different txid")
    print(f"broadcast: txid={txid}")


VIEWER = """<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; object-src 'none'; form-action 'none'">
<title>__TITLE__ — on-chain qbit pet</title>
<style>
  body { background:#0b1210; color:#d7e5dc; font:14px/1.5 ui-monospace,Menlo,monospace;
         display:flex; flex-direction:column; align-items:center; gap:14px; padding:28px; }
  h1 { font-size:18px; margin:0; } h1 small { color:#5f7a6c; font-weight:normal; }
  #stage { width:288px; height:312px; display:flex; align-items:flex-end; justify-content:center;
           background:radial-gradient(ellipse at 50% 85%, #14241c 0%, #0e1814 70%);
           border:1px solid #1e3529; border-radius:12px; }
  #pet { width:192px; height:208px; background-image:url(data:__CTYPE__;base64,__SHEET_B64__);
         background-repeat:no-repeat; image-rendering:pixelated; margin-bottom:20px; }
  #controls { display:flex; flex-wrap:wrap; gap:6px; justify-content:center; max-width:420px; }
  button { background:#12211a; color:#9fd4b4; border:1px solid #2a4a38; border-radius:6px;
           padding:5px 10px; font:inherit; cursor:pointer; }
  button.active { background:#1f5c3a; color:#e8fff1; }
  .meta { color:#5f7a6c; font-size:12px; max-width:560px; text-align:center; }
  .meta code { color:#8fb39e; word-break:break-all; }
</style>
<h1>__TITLE__ <small>· inscribed on qbit __CHAIN__</small></h1>
<div id="stage"><div id="pet"></div></div>
<div id="controls"></div>
<p class="meta">__DESC__</p>
<p class="meta">txid <code>__TXID__</code><br>__CONF__</p>
<script>
const M = JSON.parse(new TextDecoder().decode(
  Uint8Array.from(atob("__MANIFEST_B64__"), c => c.charCodeAt(0))
));
const pet = document.getElementById('pet');
const controls = document.getElementById('controls');
const CW = M.frame.width, CH = M.frame.height;
let state = M.states[0], frame = 0, timer = null;

function setFrame() {
  pet.style.backgroundPosition = `-${frame * CW}px -${state.row * CH}px`;
}
function play(s) {
  state = s; frame = 0; setFrame();
  clearInterval(timer);
  document.querySelectorAll('button').forEach(
    b => b.classList.toggle('active', b.dataset.id === s.id)
  );
  timer = setInterval(() => {
    frame += 1;
    if (frame >= state.frames) {
      if (state.loop) { frame = 0; }
      else { play(M.states[0]); return; }   // one-shot states settle back to idle
    }
    setFrame();
  }, 1000 / state.fps);
}
for (const s of M.states) {
  const b = document.createElement('button');
  b.textContent = s.id; b.dataset.id = s.id;
  b.onclick = () => play(s);
  controls.appendChild(b);
}
play(M.states[0]);
</script>
"""


def render_viewer(
    manifest,
    sheet: bytes,
    chain: str,
    txid: str,
    confirmations=None,
    blockhash=None,
) -> str:
    """Render a self-contained viewer without treating chain data as HTML or JS."""
    validate_manifest(manifest, sheet)
    manifest_json = json.dumps(
        manifest,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode()
    manifest_b64 = base64.b64encode(manifest_json).decode("ascii")

    if isinstance(confirmations, int) and not isinstance(confirmations, bool) and confirmations > 0:
        safe_blockhash = html.escape(str(blockhash or "?"), quote=True)
        conf_line = f"{confirmations} confirmations · block <code>{safe_blockhash}</code>"
    else:
        conf_line = "unconfirmed"

    replacements = {
        "__TITLE__": html.escape(manifest["displayName"], quote=True),
        "__CHAIN__": html.escape(str(chain), quote=True),
        "__DESC__": html.escape(manifest["description"], quote=True),
        "__CTYPE__": "image/webp",
        "__SHEET_B64__": base64.b64encode(sheet).decode("ascii"),
        "__TXID__": html.escape(str(txid), quote=True),
        "__CONF__": conf_line,
        "__MANIFEST_B64__": manifest_b64,
    }
    return VIEWER_PLACEHOLDER_RE.sub(lambda match: replacements[match.group(0)], VIEWER)


def find_qpet_output(tx: dict):
    """Return the unique QPET output index and its single-push envelope."""
    if not isinstance(tx, dict) or not isinstance(tx.get("vout"), list):
        raise RuntimeError("transaction response has no outputs")
    matches = []
    for index, vout in enumerate(tx["vout"]):
        try:
            script_hex = vout["scriptPubKey"]["hex"]
            if not isinstance(script_hex, str):
                continue
            spk = bytes.fromhex(script_hex)
            if spk[:1] != b"\x6a":
                continue
            data = script_pushes(spk)
        except (AttributeError, KeyError, TypeError, ValueError):
            # Transactions can carry unrelated or malformed OP_RETURN outputs.
            continue
        if data[:4] == MAGIC:
            matches.append((index, data))
    if len(matches) > 1:
        raise RuntimeError("transaction has multiple QPET OP_RETURN outputs")
    if matches:
        return matches[0]
    raise RuntimeError("no QPET OP_RETURN output in that transaction")


def find_qpet_payload(tx: dict) -> bytes:
    """Find the unique well-formed single-push QPET output in a transaction."""
    return find_qpet_output(tx)[1]


def cmd_view(args):
    rpc = _rpc_for_args(args)
    try:
        tx = rpc("getrawtransaction", args.txid, True)
    except RuntimeError:
        # no -txindex: fall back to the wallet's copy for the blockhash hint
        wtx = rpc("gettransaction", args.txid)
        tx = rpc("getrawtransaction", args.txid, True, wtx["blockhash"])

    blob = find_qpet_payload(tx)
    manifest, sheet = decode_envelope(blob)
    digest = validate_manifest(manifest, sheet)
    viewer_html = render_viewer(
        manifest,
        sheet,
        args.chain,
        args.txid,
        tx.get("confirmations"),
        tx.get("blockhash"),
    )
    Path(args.out).write_text(viewer_html, encoding="utf-8")
    print(f"sheet sha256 verified ({digest[:16]}…)")
    print(f"viewer written to {args.out}")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--cli",
        default=DEFAULT_CLI,
        help="qbit-cli binary (default: qbit-cli on PATH)",
    )
    ap.add_argument("--datadir", help="qbit data directory (default: qbit Core default)")
    ap.add_argument("--chain", default=DEFAULT_CHAIN, help="qbit chain (default: main)")
    ap.add_argument("--wallet", help="wallet name for inscription or wallet fallback")
    ap.add_argument("--rpc-port", type=_rpc_port, help="qbit RPC port override")
    sub = ap.add_subparsers(dest="cmd", required=True)

    ins = sub.add_parser("inscribe", help="inscribe a pet in one OP_RETURN transaction")
    ins.add_argument("--manifest", required=True, help="codex-pets pet.json")
    ins.add_argument("--sheet", required=True, help="spritesheet image")
    ins.add_argument("--fee-rate", type=int, default=1, help="bits/vB (default 1)")
    ins.add_argument(
        "--recipient",
        help="also send one exact output to this address (requires --recipient-amount)",
    )
    ins.add_argument(
        "--recipient-amount",
        type=_qbt_amount_bits,
        metavar="QBT",
        help="exact positive QBT amount, up to 8 decimals (requires --recipient)",
    )
    ins.add_argument(
        "--dry-run",
        action="store_true",
        help="fund, sign, save, inspect, and test the transaction without broadcasting",
    )
    ins.add_argument(
        "--out-signed",
        required=True,
        help="exclusively save the one signed transaction to a new mode-0600 file",
    )
    ins.add_argument(
        "--yes",
        action="store_true",
        help="broadcast without the interactive confirmation",
    )
    ins.set_defaults(fn=cmd_inscribe)

    broadcast = sub.add_parser(
        "broadcast",
        help="validate and broadcast exact signed transaction bytes without re-signing",
    )
    broadcast.add_argument("--signed", required=True, help="saved signed transaction hex")
    broadcast.add_argument(
        "--expected-txid",
        required=True,
        type=_sha256,
        help="require this exact decoded transaction ID",
    )
    broadcast.add_argument(
        "--expected-envelope-sha256",
        required=True,
        type=_sha256,
        help="require this exact QPET envelope SHA-256",
    )
    broadcast.add_argument(
        "--expected-pet-id",
        required=True,
        help="require this exact QPET manifest ID",
    )
    broadcast_mode = broadcast.add_mutually_exclusive_group(required=True)
    broadcast_mode.add_argument(
        "--recipient",
        help="require one exact output to this address (requires --recipient-amount)",
    )
    broadcast_mode.add_argument(
        "--qpet-only",
        action="store_true",
        help="explicitly acknowledge that only QPET output zero is pinned",
    )
    broadcast.add_argument(
        "--recipient-amount",
        type=_qbt_amount_bits,
        metavar="QBT",
        help="require this exact positive QBT amount, up to 8 decimals",
    )
    broadcast.add_argument(
        "--yes",
        action="store_true",
        help="broadcast without the interactive confirmation",
    )
    broadcast.set_defaults(fn=cmd_broadcast)

    vw = sub.add_parser("view", help="rebuild the animated viewer from chain data")
    vw.add_argument("txid")
    vw.add_argument("--out", default="pet.html")
    vw.set_defaults(fn=cmd_view)

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
