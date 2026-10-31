#!/usr/bin/env python3
"""Create a fictional, offline Markdown incident handoff (standard library only)."""

import argparse
from collections import Counter
import html
import json
from pathlib import Path
import sys


SEVERITY = {"high": 0, "medium": 1, "low": 2}
STATUSES = ("open", "monitoring", "resolved")


class InvalidInput(ValueError):
    """An input problem that can be reported without a traceback."""


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise InvalidInput(f"duplicate JSON key {key!r}; keep one value per key")
        result[key] = value
    return result


def reject_constant(value):
    raise InvalidInput(f"invalid JSON number {value!r}; use standard JSON values")


def check_text(value, location, allow_blank=False):
    if not isinstance(value, str) or (not allow_blank and not value.strip()):
        qualifier = "a string" if allow_blank else "a nonblank string"
        raise InvalidInput(f"{location} must be {qualifier}")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise InvalidInput(f"{location} contains an invalid Unicode surrogate") from exc


def load_incidents(path):
    with path.open("r", encoding="utf-8") as handle:
        document = json.load(
            handle, object_pairs_hook=unique_object, parse_constant=reject_constant
        )
    if not isinstance(document, dict):
        raise InvalidInput('root must be an object containing an "incidents" array')
    if "incidents" not in document or not isinstance(document["incidents"], list):
        raise InvalidInput('root field "incidents" must be an array')

    seen = {}
    for index, incident in enumerate(document["incidents"]):
        location = f"incidents[{index}]"
        if not isinstance(incident, dict):
            raise InvalidInput(f"{location} must be an object")
        for field in ("id", "service", "severity", "status", "summary"):
            if field not in incident:
                raise InvalidInput(f"{location} is missing required field {field!r}")
            check_text(incident[field], f"{location}.{field}")
        identifier = incident["id"]
        if identifier in seen:
            raise InvalidInput(
                f"{location}.id duplicates {identifier!r} from incidents[{seen[identifier]}]; "
                "each incident ID must be unique across the whole input"
            )
        seen[identifier] = index
        if incident["severity"] not in SEVERITY:
            raise InvalidInput(f"{location}.severity must be high, medium or low")
        if incident["status"] not in STATUSES:
            raise InvalidInput(f"{location}.status must be open, monitoring or resolved")
        if "owner" in incident and incident["owner"] is not None:
            check_text(incident["owner"], f"{location}.owner", allow_blank=True)
    return document["incidents"]


def markdown(value):
    """Escape data, not markup; never trim, case-fold or reinterpret a value."""
    value = html.escape(value, quote=True)
    for char in "\\|*_[]~" + chr(96):
        value = value.replace(char, f"&#{ord(char)};")
    return value.replace("\r", "&#13;").replace("\n", "<br>").replace("\t", "&#9;")


def owner_text(incident):
    if "owner" not in incident:
        return "(not provided)"
    if incident["owner"] is None:
        return "(explicitly unassigned)"
    if incident["owner"] == "":
        return "(blank owner)"
    return incident["owner"]


def status_counts(incidents):
    counts = Counter(item["status"] for item in incidents)
    return " | ".join(f"{status.capitalize()}: {counts[status]}" for status in STATUSES)


def render(incidents, service=None, include_resolved=False):
    selected = [
        item for item in incidents
        if (service is None or item["service"] == service)
        and (include_resolved or item["status"] != "resolved")
    ]
    selected.sort(key=lambda item: (item["service"], SEVERITY[item["severity"]], item["id"]))
    groups = {}
    for incident in selected:
        groups.setdefault(incident["service"], []).append(incident)
    scope = "All services" if service is None else f"Exact service: {markdown(service)}"
    lines = [
        "# Fictional incident handoff",
        "",
        "Offline exercise only; no operational actions were taken.",
        "",
        f"Scope: {scope}",
        f"Include resolved: {'yes' if include_resolved else 'no'}",
        "",
        f"Incidents: {len(selected)} | Services: {len(groups)}",
        status_counts(selected),
    ]
    if not selected:
        lines.extend(["", "No incidents match the selected filters."])
    for name, group in groups.items():
        lines.extend([
            "",
            f"## Service: {markdown(name)}",
            "",
            f"Count: {len(group)} | {status_counts(group)}",
            "",
            "| Incident ID | Severity | Status | Owner | Summary |",
            "| --- | --- | --- | --- | --- |",
        ])
        for incident in group:
            cells = [incident["id"], incident["severity"], incident["status"],
                     owner_text(incident), incident["summary"]]
            lines.append("| " + " | ".join(markdown(cell) for cell in cells) + " |")
    return "\n".join(lines) + "\n", len(selected)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("input", type=Path, help="UTF-8 JSON object with an incidents array")
    parser.add_argument("output", type=Path, help="new Markdown file; parent must already exist")
    parser.add_argument("--service", help="exact, case-sensitive service name (no trimming)")
    parser.add_argument("--include-resolved", action="store_true", help="also include resolved incidents")
    args = parser.parse_args(argv)
    try:
        incidents = load_incidents(args.input)  # Validate EVERY record before filtering/writing.
        if args.service is not None:
            check_text(args.service, "--service", allow_blank=True)
        handoff, count = render(incidents, args.service, args.include_resolved)
        encoded = handoff.encode("utf-8")
    except json.JSONDecodeError as exc:
        parser.error(f"invalid JSON in {args.input}: line {exc.lineno}, column {exc.colno}: {exc.msg}")
    except (ValueError, OSError, RecursionError) as exc:
        parser.error(f"cannot read/validate {args.input}: {exc}")

    try:
        # Exclusive creation, not an exists()-then-write race; also refuses symlinks.
        with args.output.open("xb") as handle:
            handle.write(encoded)
    except FileExistsError:
        parser.error(f"output already exists: {args.output}; choose a NEW output path")
    except OSError as exc:
        parser.error(
            f"cannot write {args.output}: {exc}; check its parent directory and permissions. "
            "If creation succeeded before an I/O failure, a partial new file may remain."
        )
    print(f"Wrote {count} incident(s) to {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
