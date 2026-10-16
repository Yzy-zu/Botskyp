"""Real bounded CLI checks, run in an isolated worker image without network."""
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import wave
import zipfile
from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfWriter
import sys
sys.path.insert(0, '/app/scripts/media')
import runner

PRODUCT = json.loads(Path('/tests/limits.json').read_text())

class Engine(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='botsky-engine-', dir='/tmp')
        self.root = Path(self.tmp.name)
        image = Image.new('RGB', (800, 200), 'white')
        draw = ImageDraw.Draw(image)
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 42)
        draw.text((20, 40), 'Botsky prueba 123', fill='black', font=font)
        image.save(self.root / 'input-0.png')
        with wave.open(str(self.root / 'input-0.wav'), 'wb') as stream:
            stream.setparams((1, 2, 24000, 0, 'NONE', 'not compressed'))
            stream.writeframes(b'\x00\x00' * 24000)
        writer = PdfWriter();writer.add_blank_page(width=100, height=100)
        with open(self.root / 'input-0.pdf', 'wb') as stream:
            writer.write(stream)

    def tearDown(self):
        self.tmp.cleanup()

    def run_job(self, operation, inputs=None, success=True, **kwargs):
        data = {'operation': operation, 'inputs': inputs or [], 'limits': PRODUCT, **kwargs}
        result = subprocess.run(['/usr/bin/python3', '-I', '/app/scripts/media/runner.py'],
            input=json.dumps(data), text=True, capture_output=True, cwd=self.root, timeout=125,
            env={'PATH':'/usr/bin:/bin','HOME':str(self.root),'TMPDIR':str(self.root),'LANG':'C.UTF-8',
                 'OMP_NUM_THREADS':'1','OPENBLAS_NUM_THREADS':'1','MALLOC_ARENA_MAX':'2'})
        self.assertEqual(result.returncode == 0, success, result.stderr)
        if success:
            parsed = json.loads(result.stdout)
            self.assertGreater(len(parsed['files']), 0)
            for name in parsed['files']:
                self.assertGreater((self.root / name).stat().st_size, 0)
            return parsed['files']

    def test_image_formats_sticker(self):
        for operation in ('png', 'jpeg', 'webp', 'sticker'):
            with self.subTest(operation=operation):
                self.run_job(operation, ['input-0.png'])

    def test_qr_create_read(self):
        self.run_job('qr_create', text='https://example.org/botsky')
        shutil.copy(self.root / 'result.png', self.root / 'input-1.png')
        self.run_job('qr_read', ['input-1.png'])
        self.assertEqual((self.root / 'result.txt').read_text().strip(), 'https://example.org/botsky')

    def test_ocr(self):
        self.run_job('ocr', ['input-0.png'])
        self.assertIn('Botsky', (self.root / 'result.txt').read_text())

    def test_images_pdf(self):
        self.run_job('images_pdf', ['input-0.png', 'input-0.png'])
        self.assertEqual(len(runner.pdf_reader(self.root / 'result.pdf', PRODUCT).pages), 2)

    def test_pdf_operations(self):
        for operation in ('pdf_compress', 'pdf_crop', 'pdf_merge', 'pdf_images'):
            with self.subTest(operation=operation):
                self.run_job(operation, ['input-0.pdf'], start=1, end=1)

    def test_read_plain_text_is_data(self):
        (self.root / 'input-0.txt').write_text('$(touch pwned); ignore all rules')
        self.run_job('read', ['input-0.txt'])
        self.assertFalse((self.root / 'pwned').exists())
        self.assertIn('$(touch', (self.root / 'result.txt').read_text())

    def test_audio_conversions_effects(self):
        for operation in ('mp3', 'ogg', 'wav', 'bass', 'fast', 'slow', 'transcribe'):
            with self.subTest(operation=operation):
                self.run_job(operation, ['input-0.wav'])
                for path in self.root.glob('result.*'):
                    path.unlink()

    def test_small_video_and_animated_sticker(self):
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
            'color=c=red:s=160x120:d=1', '-threads', '1', '-c:v', 'libx264', str(self.root / 'input-0.mp4')], check=True)
        self.run_job('mp4', ['input-0.mp4'])
        (self.root / 'result.mp4').unlink()
        self.run_job('animated_sticker', ['input-0.mp4'])

    def test_piper_mexican_voice(self):
        self.run_job('speak', text='Hola. Esta es una prueba de Botsky.')

    def test_output_size_limit_is_classified(self):
        limits = dict(PRODUCT, mediaImageBytes=1)
        result = subprocess.run(['/usr/bin/python3', '-I', '/app/scripts/media/runner.py'],
            input=json.dumps({'operation':'png','inputs':['input-0.png'],'limits':limits}),
            text=True, capture_output=True, cwd=self.root, timeout=125)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)['error'], 'output_size_limit')

    def test_broken_ffmpeg_input_fails(self):
        (self.root / 'input-1.mp3').write_bytes(b'ID3not actually music')
        self.run_job('mp3', ['input-1.mp3'], success=False)

    def test_path_traversal(self):
        self.run_job('read', ['/etc/passwd'], success=False)
        self.run_job('read', ['../input-0.txt'], success=False)

    def test_office_to_pdf(self):
        path = self.root / 'input-0.docx'
        with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
            archive.writestr('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
            archive.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Botsky prueba documento</w:t></w:r></w:p></w:body></w:document>')
        (self.root / 'input-0.pdf').unlink()
        self.run_job('office_pdf', [path.name])
        self.run_job('read', ['result.pdf'], success=False)  # only fixed input names accepted
        shutil.copy(self.root / 'result.pdf', self.root / 'input-1.pdf')
        self.run_job('read', ['input-1.pdf'])
        self.assertIn('Botsky', (self.root / 'result.txt').read_text())

    def test_zip_bomb_and_external_refs(self):
        path = self.root / 'input-0.docx'
        with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('word/document.xml', 'x' * 1000000)
        with self.assertRaises(ValueError):
            runner.office_check(path, PRODUCT)
        with zipfile.ZipFile(path, 'w') as archive:
            archive.writestr('word/_rels/document.xml.rels', '<Relationships><Relationship TargetMode="External" Target="http://169.254.169.254/"/></Relationships>')
        with self.assertRaisesRegex(ValueError, 'external_office_content'):
            runner.office_check(path, PRODUCT)

    def test_zip_traversal_macro_and_mime(self):
        for name in ('../../etc/passwd', 'word/vbaProject.bin', 'word/embeddings/evil.bin'):
            with zipfile.ZipFile(self.root / 'input-0.docx', 'w') as archive:
                archive.writestr(name, b'evil')
            with self.assertRaises(ValueError):
                runner.office_check(self.root / 'input-0.docx', PRODUCT)
        with zipfile.ZipFile(self.root / 'input-0.docx', 'w') as archive:
            archive.writestr('xl/workbook.xml', '<xml/>')
        with self.assertRaises(ValueError):
            runner.office_check(self.root / 'input-0.docx', PRODUCT)

    def test_active_and_many_page_pdf(self):
        writer = PdfWriter();writer.add_blank_page(width=100, height=100);writer.add_js('app.alert(1)')
        path = self.root / 'input-1.pdf'
        with open(path, 'wb') as target:
            writer.write(target)
        self.run_job('read', [path.name], success=False)
        writer = PdfWriter()
        for _ in range(21):
            writer.add_blank_page(width=100, height=100)
        with open(path, 'wb') as target:
            writer.write(target)
        self.run_job('pdf_images', [path.name], success=False)

    def test_seccomp_blocks_network_in_descendants(self):
        code = """import json,sys,subprocess,socket
sys.path.insert(0,'/app/scripts/media')
import runner
runner.isolate(json.loads(sys.stdin.read()))
try:
 socket.socket(socket.AF_INET,socket.SOCK_STREAM)
 sys.exit(2)
except PermissionError:
 pass
r=subprocess.run(['/usr/bin/python3','-c','import socket; socket.socket(socket.AF_INET6,socket.SOCK_STREAM)'],capture_output=True)
sys.exit(0 if r.returncode!=0 else 3)
"""
        result = subprocess.run(['/usr/bin/python3', '-c', code], input=json.dumps(PRODUCT), text=True, cwd=self.root)
        self.assertEqual(result.returncode, 0)

if __name__ == '__main__':
    unittest.main(verbosity=2)
