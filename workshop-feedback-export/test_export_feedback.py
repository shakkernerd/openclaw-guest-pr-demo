"""Focused, real-subprocess CLI tests; no imports of the implementation."""

import csv
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent
COMMAND = ROOT / 'export_feedback.py'
HEADER = ['response_id', 'contact_email', 'session', 'score', 'comment']
VALID_ROW = ['FIC-001', 'person@example.invalid', 'Session', '4', 'Valid first row.']


def csv_bytes(rows):
    stream = io.StringIO(newline='')
    writer = csv.writer(stream, lineterminator='\r\n')
    writer.writerows(rows)
    return stream.getvalue().encode('utf-8')


def read_csv(path):
    csv.field_size_limit(sys.maxsize)
    with path.open(encoding='utf-8', newline='') as stream:
        return list(csv.reader(stream, strict=True))


class ExportCLITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='feedback-cli-', dir=ROOT)
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.source = self.base / 'input.csv'
        self.output = self.base / 'result'

    def run_cli(self, source=None, output=None):
        return subprocess.run(
            [sys.executable, '-B', str(COMMAND),
             str(source if source is not None else self.source),
             str(output if output is not None else self.output)],
            cwd=self.base, capture_output=True, text=True, encoding='utf-8',
            timeout=15, env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'},
        )

    def assert_success(self, data):
        self.source.write_bytes(data)
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '')
        self.assertEqual(result.stderr, '')
        self.assertEqual(self.source.read_bytes(), data)
        self.assertEqual(
            sorted(path.name for path in self.output.iterdir()),
            ['feedback.csv', 'session-summary.csv'],
        )
        return read_csv(self.output / 'feedback.csv'), read_csv(self.output / 'session-summary.csv')

    def assert_invalid(self, data, diagnostic):
        self.source.write_bytes(data)
        before = sorted(path.name for path in self.base.iterdir())
        result = self.run_cli()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(result.stdout, '')
        self.assertIn(diagnostic, result.stderr)
        self.assertNotIn('Traceback', result.stderr)
        self.assertEqual(self.source.read_bytes(), data)
        self.assertFalse(os.path.lexists(self.output))
        self.assertEqual(sorted(path.name for path in self.base.iterdir()), before)

    def test_supplied_input_projection_summary_and_free_text(self):
        original = ROOT / 'examples' / 'fictional-workshop-feedback.csv'
        data = original.read_bytes()
        retained, summary = self.assert_success(data)
        expected = [row[2:5] for row in read_csv(original)]
        self.assertEqual(retained, expected)
        self.assertEqual(len(retained) - 1, 8)
        self.assertIn('mara@example.invalid', retained[7][2])
        self.assertEqual(summary, [
            ['session', 'response_count', 'score_total'],
            ['Paper circuits — débutants', '3', '11'],
            ['Textile & mending', '3', '8'],
            ['海辺の読書会', '2', '8'],
        ])
        self.assertEqual(original.read_bytes(), data)

    def test_decoded_values_bom_quotes_unicode_cr_lf_and_score_spelling(self):
        rows = [
            ['1', 'one@example.invalid', ' z, "session" ', ' +05 ', 'Line 1\r\nLine 2\rLine 3\n最後 café'],
            ['2', 'two@example.invalid', 'é', '0002', '  spaced, "quoted"  '],
            ['3', 'three@example.invalid', 'e\u0301', '3', 'Do not normalize Unicode.'],
            ['', '', '', '1', ''],
            ['4', 'four@example.invalid', 'é', '+4', '=keep this literal formula-like text'],
            ['5', '', ' z, "session" ', '5', 'x' * 150000],
        ]
        retained, summary = self.assert_success(b'\xef\xbb\xbf' + csv_bytes([HEADER] + rows))
        self.assertEqual(retained, [['session', 'score', 'comment']] + [row[2:5] for row in rows])
        self.assertEqual(summary, [
            ['session', 'response_count', 'score_total'],
            [rows[0][2], '2', '10'], ['é', '2', '6'], ['e\u0301', '1', '3'], ['', '1', '1'],
        ])

    def test_header_only_input(self):
        retained, summary = self.assert_success(csv_bytes([HEADER]))
        self.assertEqual(retained, [['session', 'score', 'comment']])
        self.assertEqual(summary, [['session', 'response_count', 'score_total']])

    def test_invalid_headers(self):
        cases = [b'', csv_bytes([HEADER[:-1]]), csv_bytes([HEADER + ['extra']]),
                 csv_bytes([HEADER[:-1] + ['score']]), csv_bytes([HEADER[::-1]]),
                 csv_bytes([['Response_id'] + HEADER[1:]]), b'\n']
        for data in cases:
            with self.subTest(data=data):
                self.assert_invalid(data, 'header must be exactly')

    def test_complete_row_structure_after_valid_data(self):
        for bad in [[], VALID_ROW[:-1], VALID_ROW + ['extra']]:
            with self.subTest(row=bad):
                self.assert_invalid(csv_bytes([HEADER, VALID_ROW, bad]), 'data row 2')

    def test_invalid_scores_after_valid_data(self):
        for score in ['', '0', '6', '-1', '2.0', '1e0', 'one', '1_0', '٥', '+', '5 0', '9' * 5000]:
            with self.subTest(score=score[:20]):
                bad = ['bad', 'bad@example.invalid', 'Session', score, 'Bad score']
                self.assert_invalid(csv_bytes([HEADER, VALID_ROW, bad]), 'data row 2')
                result = self.run_cli()
                self.assertIn('integer from 1 through 5', result.stderr)

    def test_malformed_quoting_after_valid_data(self):
        prefix = csv_bytes([HEADER, VALID_ROW])
        for suffix in [b'bad,bad@example.invalid,Session,3,"unclosed\ncomment',
                       b'bad,bad@example.invalid,Session,3,"closed"junk\n']:
            with self.subTest(suffix=suffix):
                self.assert_invalid(prefix + suffix, 'malformed CSV')

    def test_invalid_utf8_after_valid_data(self):
        self.assert_invalid(csv_bytes([HEADER, VALID_ROW]) + b'x,e,Session,3,\xff\n', 'invalid UTF-8')

    def test_existing_directory_is_untouched(self):
        data = csv_bytes([HEADER, VALID_ROW])
        self.source.write_bytes(data)
        self.output.mkdir()
        sentinel = self.output / 'feedback.csv'
        sentinel.write_bytes(b'keep existing output\n')
        result = self.run_cli()
        self.assertEqual(result.returncode, 1)
        self.assertIn('already exists', result.stderr)
        self.assertEqual(sentinel.read_bytes(), b'keep existing output\n')
        self.assertEqual(list(self.output.iterdir()), [sentinel])
        self.assertEqual(self.source.read_bytes(), data)
        sentinel.unlink()
        result = self.run_cli()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_existing_file_and_input_as_output_are_untouched(self):
        data = csv_bytes([HEADER, VALID_ROW])
        self.source.write_bytes(data)
        self.output.write_bytes(b'keep file')
        for output in [self.output, self.source, self.base]:
            with self.subTest(output=output):
                result = self.run_cli(output=output)
                self.assertEqual(result.returncode, 1)
                self.assertIn('already exists', result.stderr)
                self.assertEqual(self.source.read_bytes(), data)
                self.assertEqual(self.output.read_bytes(), b'keep file')

    def test_existing_symlinks_are_refused(self):
        data = csv_bytes([HEADER, VALID_ROW])
        self.source.write_bytes(data)
        for target in [self.source, self.base / 'missing-target']:
            with self.subTest(target=target):
                self.output.symlink_to(target)
                result = self.run_cli()
                self.assertEqual(result.returncode, 1)
                self.assertIn('already exists', result.stderr)
                self.assertTrue(self.output.is_symlink())
                self.assertEqual(self.output.readlink(), target)
                self.assertEqual(self.source.read_bytes(), data)
                self.output.unlink()

    def test_invalid_input_leaves_existing_output_untouched(self):
        data = csv_bytes([HEADER, VALID_ROW, ['bad', 'bad@example.invalid', 'Session', '9', 'Bad']])
        self.source.write_bytes(data)
        self.output.mkdir()
        sentinel = self.output / 'feedback.csv'
        sentinel.write_bytes(b'keep existing bytes')
        result = self.run_cli()
        self.assertEqual(result.returncode, 1)
        self.assertIn('data row 2', result.stderr)
        self.assertEqual(sentinel.read_bytes(), b'keep existing bytes')
        self.assertEqual(list(self.output.iterdir()), [sentinel])
        self.assertEqual(self.source.read_bytes(), data)

    def test_missing_input_and_missing_output_parent(self):
        result = self.run_cli()
        self.assertEqual(result.returncode, 1)
        self.assertIn('cannot read input', result.stderr)
        self.assertFalse(self.output.exists())
        data = csv_bytes([HEADER, VALID_ROW])
        self.source.write_bytes(data)
        result = self.run_cli(output=self.base / 'missing-parent' / 'result')
        self.assertEqual(result.returncode, 1)
        self.assertIn('cannot create output directory', result.stderr)
        self.assertFalse((self.base / 'missing-parent').exists())
        self.assertEqual(self.source.read_bytes(), data)


if __name__ == '__main__':
    unittest.main()
