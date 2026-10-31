#!/usr/bin/env python3
"""Real subprocess CLI tests; all fixtures/results are retained under checks/."""

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
SOURCE = HERE / "handoff.py"
FIXTURE = json.loads((HERE / "inputs/incidents.json").read_text(encoding="utf-8"))


def record(identifier="INC-001", service="api", severity="high", **changes):
    result = dict(id=identifier, service=service, severity=severity, status="open",
                  summary="Fictional test incident.")
    result.update(changes)
    return result


def ids(markdown):
    return [line.split(" | ")[0][2:] for line in markdown.splitlines()
            if line.startswith("| INC-")]


class CLITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        (HERE / "checks").mkdir(exist_ok=True)
        cls.run_dir = Path(tempfile.mkdtemp(prefix="run-", dir=HERE / "checks"))
        cls.sequence = 0
        print(f"Retained CLI fixtures and transcripts: {cls.run_dir}", flush=True)

    def new_case(self, document=None, raw=None):
        type(self).sequence += 1
        case = self.run_dir / f"{self.sequence:03d}-{self._testMethodName}"
        case.mkdir()
        source, output = case / "input.json", case / "handoff.md"
        if raw is None:
            raw = json.dumps(FIXTURE if document is None else document, ensure_ascii=True).encode()
        with source.open("xb") as handle:
            handle.write(raw)
        return source, output

    def run_cli(self, source, output, *options):
        original = source.read_bytes() if source.is_file() else None
        command = [sys.executable, "-B", str(SOURCE), str(source), str(output), *options]
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", timeout=10)
        with (source.parent / "commands.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(dict(command=command, exit_code=result.returncode,
                                         stdout=result.stdout, stderr=result.stderr)) + "\n")
        if original is not None:
            self.assertEqual(source.read_bytes(), original, "CLI changed its input")
        return result

    def successful(self, source, output, *options):
        result = self.run_cli(source, output, *options)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertIn("Wrote ", result.stdout)
        return output.read_text(encoding="utf-8")

    def rejected(self, document=None, raw=None, message="", options=()):
        source, output = self.new_case(document, raw)
        result = self.run_cli(source, output, *options)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertIn(message, result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertFalse(output.exists(), "Invalid input produced an output")
        return result

    def test_default(self):
        source, output = self.new_case()
        text = self.successful(source, output)
        self.assertEqual(ids(text), ["INC-007", "INC-105", "INC-042"])
        self.assertIn("Incidents: 3 | Services: 2", text)
        self.assertIn("Open: 2 | Monitoring: 1 | Resolved: 0", text)
        self.assertIn("Count: 2 | Open: 2 | Monitoring: 0 | Resolved: 0", text)
        self.assertIn("| INC-007 | high | open | (not provided) |", text)
        self.assertIn("| INC-105 | low | open | (blank owner) |", text)
        self.assertIn("| INC-042 | medium | monitoring | (explicitly unassigned) |", text)
        for item in FIXTURE["incidents"]:
            if item["status"] != "resolved":
                self.assertIn(item["summary"], text)

    def test_include_resolved(self):
        source, output = self.new_case()
        text = self.successful(source, output, "--include-resolved")
        self.assertEqual(ids(text), ["INC-007", "INC-105", "INC-200", "INC-042"])
        self.assertIn("Incidents: 4 | Services: 2", text)
        self.assertIn("Open: 2 | Monitoring: 1 | Resolved: 1", text)
        self.assertIn("| INC-200 | high | resolved | Pat (fictional) |", text)

    def test_exact_service(self):
        for service, expected in [("api", ["INC-007", "INC-105"]), ("worker", ["INC-042"]),
                                  ("API", []), ("api ", []), ("ap", []), ("", [])]:
            with self.subTest(service=service):
                source, output = self.new_case()
                text = self.successful(source, output, "--service", service)
                self.assertEqual(ids(text), expected)
                if not expected:
                    self.assertIn("Incidents: 0 | Services: 0", text)
                    self.assertIn("No incidents match", text)

    def test_combined_options(self):
        source, output = self.new_case()
        text = self.successful(source, output, "--service", "worker", "--include-resolved")
        self.assertEqual(ids(text), ["INC-200", "INC-042"])
        self.assertIn("Incidents: 2 | Services: 1", text)

    def test_service_severity_id_order_and_determinism(self):
        items = [record("INC-z", "worker"), record("INC-a", "api", "low"),
                 record("INC-m", "api", "medium"), record("INC-2", "api"),
                 record("INC-10", "api"), record("INC-upper", "API"),
                 record("INC-space", "api ")]
        texts = []
        for permutation in [items, list(reversed(items)), items[3:] + items[:3]]:
            source, output = self.new_case({"incidents": permutation})
            text = self.successful(source, output)
            texts.append(text)
            self.assertEqual(ids(text), ["INC-upper", "INC-10", "INC-2", "INC-m",
                                         "INC-a", "INC-space", "INC-z"])
        self.assertEqual(texts[0], texts[1])
        self.assertEqual(texts[1], texts[2])

    def test_whitespace_and_unicode_owner_preserved(self):
        source, output = self.new_case({"incidents": [record(owner="  Zoë (fictional)  "),
                                                       record("INC-002", owner="   ")]})
        text = self.successful(source, output)
        self.assertIn("|   Zoë (fictional)   |", text)
        self.assertIn("|     |", text)
        self.assertNotIn("(blank owner)", text)

    def test_markdown_data_escaped(self):
        source, output = self.new_case({"incidents": [record(
            service="api|<test>", owner="[fictional] *owner*",
            summary="Synthetic | <script> & [link](url)\nNext line.")]})
        text = self.successful(source, output)
        self.assertIn("## Service: api&#124;&lt;test&gt;", text)
        self.assertIn("&#91;fictional&#93; &#42;owner&#42;", text)
        self.assertIn("Synthetic &#124; &lt;script&gt; &amp; &#91;link&#93;(url)<br>Next line.", text)
        self.assertNotIn("<script>", text)

    def test_empty_array(self):
        source, output = self.new_case({"incidents": []})
        self.assertIn("Incidents: 0 | Services: 0", self.successful(source, output))

    def test_resolved_only(self):
        source, output = self.new_case({"incidents": [record(status="resolved")]})
        self.assertIn("Incidents: 0 | Services: 0", self.successful(source, output))

    def test_invalid_root_and_array(self):
        for raw in [b"null", b"[]", b"42", b"{}", b'{"incidents":null}', b'{"incidents":{}}']:
            with self.subTest(raw=raw):
                self.rejected(raw=raw, message="must be")

    def test_malformed_record(self):
        for value in [None, [], "incident", 42, True]:
            with self.subTest(value=value):
                self.rejected({"incidents": [value]}, message="incidents[0] must be an object")

    def test_missing_required_fields(self):
        for field in ("id", "service", "severity", "status", "summary"):
            item = record()
            del item[field]
            with self.subTest(field=field):
                self.rejected({"incidents": [item]}, message=f"missing required field '{field}'")

    def test_invalid_required_field_types_and_blanks(self):
        for field, value in [("id", 7), ("id", ""), ("service", None), ("service", "  "),
                             ("severity", []), ("status", {}), ("summary", False), ("summary", "\n")]:
            with self.subTest(field=field, value=value):
                self.rejected({"incidents": [record(**{field: value})]}, message=f".{field} must be")

    def test_invalid_owner_types(self):
        for value in [42, True, [], {}]:
            with self.subTest(value=value):
                self.rejected({"incidents": [record(owner=value)]}, message=".owner must be a string")

    def test_unknown_severity_and_status(self):
        for field, value in [("severity", "critical"), ("severity", "High"),
                             ("status", "closed"), ("status", "OPEN")]:
            with self.subTest(field=field, value=value):
                self.rejected({"incidents": [record(**{field: value})]}, message=f".{field} must be")

    def test_duplicate_ids_across_services_and_excluded_statuses(self):
        self.rejected({"incidents": [record(), record(service="worker", status="resolved")]},
                      message="duplicates 'INC-001'", options=("--service", "api"))

    def test_invalid_excluded_records_still_rejected(self):
        for invalid in [record(service="worker", status="resolved", owner=99),
                        record(service="worker", severity="critical")]:
            with self.subTest(invalid=invalid):
                self.rejected({"incidents": [record("INC-000"), invalid]}, message="incidents[1]",
                              options=("--service", "api"))

    def test_invalid_json_and_utf8(self):
        for raw, message in [(b'{"incidents":[}', "line 1, column"),
                             (b'{"incidents":[]} extra', "Extra data"), (b"\xff", "utf-8")]:
            with self.subTest(raw=raw):
                self.rejected(raw=raw, message=message)

    def test_ambiguous_and_nonstandard_json_rejected(self):
        for raw, message in [(b'{"incidents":[],"incidents":[]}', "duplicate JSON key"),
                             (b'{"incidents":[],"extra":NaN}', "invalid JSON number")]:
            with self.subTest(raw=raw):
                self.rejected(raw=raw, message=message)
        self.rejected({"incidents": [record(summary="\ud800")]}, message="invalid Unicode surrogate")
        # Python may reject extremely long integer tokens before record validation.
        # Either way this malformed incident must fail cleanly, without a traceback.
        self.rejected(raw=b'{"incidents":[{"id":' + b'9' * 5000 + b'}]}',
                      message="error:")

    def test_existing_output_and_same_input_refused(self):
        source, output = self.new_case()
        with output.open("xb") as handle:
            handle.write(b"Previous output: preserve exactly.\n")
        previous = hashlib.sha256(output.read_bytes()).hexdigest()
        for target in [output, source]:
            result = self.run_cli(source, target)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, "")
            self.assertIn("output already exists", result.stderr)
        self.assertEqual(hashlib.sha256(output.read_bytes()).hexdigest(), previous)

    def test_symlinks_and_directory_refused(self):
        source, output = self.new_case()
        for name, target in [("existing-link", source), ("dangling-link", output)]:
            link = source.parent / name
            link.symlink_to(target.name)
            result = self.run_cli(source, link)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, "")
            self.assertIn("output already exists", result.stderr)
            self.assertTrue(link.is_symlink())
        self.assertFalse(output.exists())
        result = self.run_cli(source, source.parent)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertTrue(source.parent.is_dir())

    def test_missing_input_and_output_parent(self):
        source, output = self.new_case()
        for input_path, target in [(source.parent / "absent.json", output),
                                   (source, source.parent / "absent" / "output.md")]:
            result = self.run_cli(input_path, target)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, "")
            self.assertNotIn("Traceback", result.stderr)
            self.assertFalse(target.exists())

    def test_invalid_input_does_not_touch_existing_output(self):
        source, output = self.new_case({"incidents": [record(owner=42)]})
        with output.open("xb") as handle:
            handle.write(b"Previous handoff\n")
        result = self.run_cli(source, output)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertEqual(output.read_bytes(), b"Previous handoff\n")

    def test_help_and_bad_arguments(self):
        source, output = self.new_case()
        result = self.run_cli(source, output, "--help")
        self.assertEqual(result.returncode, 0)
        self.assertIn("--include-resolved", result.stdout)
        self.assertFalse(output.exists())
        for args in [("--service",), ("--serv", "api"), ("--unknown",)]:
            result = self.run_cli(source, output, *args)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, "")
            self.assertFalse(output.exists())

    def test_concurrent_creators_never_overwrite(self):
        source, output = self.new_case()
        command = [sys.executable, "-B", str(SOURCE), str(source), str(output)]
        first = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        second = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        results = []
        for process in [first, second]:
            stdout, stderr = process.communicate(timeout=10)
            results.append(dict(exit_code=process.returncode, stdout=stdout, stderr=stderr))
        with (source.parent / "concurrent.json").open("x", encoding="utf-8") as handle:
            json.dump(dict(command=command, results=results), handle, indent=2)
        self.assertEqual(sorted(item["exit_code"] for item in results), [0, 2])
        loser = next(item for item in results if item["exit_code"] == 2)
        self.assertEqual(loser["stdout"], "")
        self.assertIn("output already exists", loser["stderr"])
        self.assertEqual(ids(output.read_text(encoding="utf-8")), ["INC-007", "INC-105", "INC-042"])
        self.assertEqual(json.loads(source.read_text(encoding="utf-8")), FIXTURE)


if __name__ == "__main__":
    unittest.main(verbosity=2)
