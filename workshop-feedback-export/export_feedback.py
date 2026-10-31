#!/usr/bin/env python3
"""Validate and project workshop feedback; standard library only."""

import argparse
import csv
import io
from pathlib import Path
import re
import sys


INPUT_HEADER = ['response_id', 'contact_email', 'session', 'score', 'comment']
FEEDBACK_HEADER = ['session', 'score', 'comment']
SUMMARY_HEADER = ['session', 'response_count', 'score_total']


class ExportError(Exception):
    """An input or output problem suitable for a CLI diagnostic."""


def render_csv(header, rows):
    stream = io.StringIO(newline='')
    # CRLF makes both CR and LF in field values trigger CSV quoting.
    writer = csv.writer(stream, lineterminator='\r\n')
    writer.writerow(header)
    writer.writerows(rows)
    return stream.getvalue().encode('utf-8')


def validate_and_render(source):
    """Read once, validate every record, then prepare both outputs in memory."""
    try:
        decoded = source.read_bytes().decode('utf-8-sig')
    except UnicodeDecodeError as exc:
        raise ExportError(f'{source}: invalid UTF-8: {exc.reason}') from exc
    except OSError as exc:
        raise ExportError(f'cannot read input {source}: {exc.strerror}') from exc

    # Do not impose the csv module's small default field-size limit.
    csv.field_size_limit(sys.maxsize)
    reader = csv.reader(io.StringIO(decoded, newline=''), strict=True)
    projected = []
    totals = {}  # Insertion order is the documented first-appearance order.
    record = 0
    try:
        header = next(reader, None)
        if header != INPUT_HEADER:
            raise ExportError(
                'header must be exactly: ' + ','.join(INPUT_HEADER)
                + ' (same order; no missing, extra or duplicate names)'
            )
        while True:
            record += 1
            row = next(reader, None)
            if row is None:
                break
            where = f'data row {record} (ending at physical line {reader.line_num})'
            if len(row) != len(INPUT_HEADER):
                raise ExportError(f'{where}: expected 5 fields, found {len(row)}')
            score_text = row[3].strip()
            if re.fullmatch(r'[+-]?[0-9]+', score_text) is None:
                raise ExportError(f'{where}: score must be an integer from 1 through 5')
            # Strip sign/leading zeroes for range checking, not for export.
            magnitude = score_text.lstrip('+-').lstrip('0')
            if score_text.startswith('-') or magnitude not in ('1', '2', '3', '4', '5'):
                raise ExportError(f'{where}: score must be an integer from 1 through 5')
            score = int(magnitude)
            session = row[2]
            projected.append(row[2:5])
            count, total = totals.get(session, (0, 0))
            totals[session] = (count + 1, total + score)
    except csv.Error as exc:
        location = 'header' if record == 0 else f'data row {record}'
        raise ExportError(
            f'{location}, near physical line {reader.line_num}: malformed CSV: {exc}'
        ) from exc

    summary = [(session, count, total) for session, (count, total) in totals.items()]
    return {
        'feedback.csv': render_csv(FEEDBACK_HEADER, projected),
        'session-summary.csv': render_csv(SUMMARY_HEADER, summary),
    }


def publish(output, files):
    """Claim a new directory exclusively, only after complete validation."""
    try:
        output.mkdir()
    except FileExistsError as exc:
        raise ExportError(f'output already exists: {output}; nothing overwritten') from exc
    except OSError as exc:
        raise ExportError(f'cannot create output directory {output}: {exc.strerror}') from exc

    created = []
    try:
        for name, data in files.items():
            path = output / name
            with path.open('xb') as stream:
                created.append(path)
                stream.write(data)
    except OSError as exc:
        # Only remove paths this invocation created, never existing user files.
        cleanup_errors = []
        for path in reversed(created):
            try:
                path.unlink()
            except OSError as cleanup_exc:
                cleanup_errors.append(str(cleanup_exc))
        try:
            output.rmdir()
        except OSError as cleanup_exc:
            cleanup_errors.append(str(cleanup_exc))
        detail = '; cleanup incomplete: ' + '; '.join(cleanup_errors) if cleanup_errors else ''
        raise ExportError(f'cannot write output: {exc}{detail}') from exc


def main(argv=None):
    parser = argparse.ArgumentParser(
        description='Project workshop CSV columns and summarize scores. Not anonymization.'
    )
    parser.add_argument('input_csv', type=Path, help='UTF-8 CSV with the required five columns')
    parser.add_argument('output_dir', type=Path, help='new directory; existing paths are refused')
    args = parser.parse_args(argv)
    try:
        files = validate_and_render(args.input_csv)
        publish(args.output_dir, files)
    except ExportError as exc:
        print(f'error: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
