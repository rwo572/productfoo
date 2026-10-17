#!/usr/bin/env python3
"""Independent verifier for the published Foo signed-envelope V1 vector."""

import base64
import hashlib
import json
import math
import os
import struct
import subprocess
import sys
import tempfile


def assert_unicode_scalars(value):
    for char in value:
        if 0xD800 <= ord(char) <= 0xDFFF:
            raise ValueError("unpaired Unicode surrogate")


def ecmascript_number(value):
    value = float(value)
    if not math.isfinite(value):
        raise ValueError("non-finite JSON number")
    if value == 0:
        return "0"

    rendered = repr(value).lower()
    sign = ""
    if rendered.startswith("-"):
        sign = "-"
        rendered = rendered[1:]

    if "e" not in rendered:
        if rendered.endswith(".0"):
            rendered = rendered[:-2]
        return sign + rendered

    coefficient, exponent_text = rendered.split("e", 1)
    exponent = int(exponent_text)
    digits = coefficient.replace(".", "")
    if -6 <= exponent < 21:
        decimal_position = exponent + 1
        if decimal_position <= 0:
            body = "0." + ("0" * -decimal_position) + digits
        elif decimal_position >= len(digits):
            body = digits + ("0" * (decimal_position - len(digits)))
        else:
            body = digits[:decimal_position] + "." + digits[decimal_position:]
        return sign + body

    coefficient = digits[0]
    if len(digits) > 1:
        coefficient += "." + digits[1:]
    exponent_sign = "+" if exponent >= 0 else "-"
    return sign + coefficient + "e" + exponent_sign + str(abs(exponent))


def canonicalize(value):
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        assert_unicode_scalars(value)
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, (int, float)):
        return ecmascript_number(value)
    if isinstance(value, list):
        return "[" + ",".join(canonicalize(item) for item in value) + "]"
    if isinstance(value, dict):
        for key in value:
            if not isinstance(key, str):
                raise ValueError("non-string object key")
            assert_unicode_scalars(key)
        keys = sorted(value.keys(), key=lambda key: key.encode("utf-16-be"))
        return "{" + ",".join(
            json.dumps(key, ensure_ascii=False, separators=(",", ":")) + ":" + canonicalize(value[key])
            for key in keys
        ) + "}"
    raise ValueError("value is outside the JSON domain")


def verify_signature(public_key_pem, signature, message):
    try:
        from cryptography.hazmat.primitives import serialization

        key = serialization.load_pem_public_key(public_key_pem)
        key.verify(signature, message)
        return
    except ImportError:
        pass

    with tempfile.TemporaryDirectory(prefix="foo-trust-vector-") as directory:
        public_path = os.path.join(directory, "public.pem")
        signature_path = os.path.join(directory, "signature.bin")
        message_path = os.path.join(directory, "message.bin")
        with open(public_path, "wb") as handle:
            handle.write(public_key_pem)
        with open(signature_path, "wb") as handle:
            handle.write(signature)
        with open(message_path, "wb") as handle:
            handle.write(message)
        result = subprocess.run(
            [
                "openssl", "pkeyutl", "-verify", "-pubin", "-inkey", public_path,
                "-sigfile", signature_path, "-rawin", "-in", message_path,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if result.returncode != 0:
            raise ValueError("Ed25519 signature did not verify: " + result.stderr.decode("utf-8", "replace"))


def main():
    if len(sys.argv) != 4:
        raise SystemExit(
            "usage: verify_vector.py <signed-envelope-v1.json> <jcs-vectors.json> <jcs-number-vectors.json>"
        )
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        vector = json.load(handle, parse_int=float, parse_float=float)

    with open(sys.argv[2], "r", encoding="utf-8") as handle:
        canonical_vectors = json.load(handle, parse_int=float, parse_float=float)
    for item in canonical_vectors:
        if canonicalize(item["value"]) != item["canonical"]:
            raise ValueError("JCS vector mismatch: " + item["name"])

    with open(sys.argv[3], "r", encoding="utf-8") as handle:
        number_corpus = json.load(handle)
    if len(number_corpus["vectors"]) != 24:
        raise ValueError("RFC 8785 Appendix B corpus is incomplete")
    for item in number_corpus["vectors"]:
        number = struct.unpack(">d", bytes.fromhex(item["ieee754_hex"]))[0]
        if ecmascript_number(number) != item["canonical"]:
            raise ValueError("JCS number mismatch: " + item["ieee754_hex"])

    envelope = vector["envelope"]
    unsigned = dict(envelope)
    signature = base64.b64decode(unsigned.pop("signature"), validate=True)
    canonical_unsigned = canonicalize(unsigned)
    if canonical_unsigned != vector["canonical_unsigned_json"]:
        raise ValueError("canonical unsigned JSON does not match the published bytes")

    prefix = (
        "foo.signed-envelope.v1\0"
        + unsigned["namespace"]
        + "\0"
        + unsigned["artifact_kind"]
        + "\0"
    ).encode("utf-8")
    signing_bytes = prefix + canonical_unsigned.encode("utf-8")
    if base64.b64encode(signing_bytes).decode("ascii") != vector["signing_bytes_base64"]:
        raise ValueError("domain-separated signing bytes do not match the published vector")

    canonical_signed = canonicalize(envelope).encode("utf-8")
    envelope_hash = hashlib.sha256(b"foo.signed-envelope-hash.v1\0" + canonical_signed).hexdigest()
    if envelope_hash != vector["envelope_hash"]:
        raise ValueError("envelope hash does not match the published vector")

    verify_signature(vector["public_key_pem"].encode("utf-8"), signature, signing_bytes)
    print("trust-envelope vectors ok")


if __name__ == "__main__":
    main()
