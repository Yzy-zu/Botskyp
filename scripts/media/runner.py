#!/usr/bin/python3
"""Closed media processor. Runs without network or inherited service credentials."""
import ctypes
import errno
import json
import os
from pathlib import Path
import resource
import re
import subprocess
import sys
import zipfile
import warnings


def isolate(limits):
    os.nice(10)
    resource.setrlimit(resource.RLIMIT_CPU, (limits['mediaCpuSeconds'], limits['mediaCpuSeconds'] + 5))
    resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
    resource.setrlimit(resource.RLIMIT_FSIZE, (limits['mediaOutputBytes'], limits['mediaOutputBytes']))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    # Fail closed if Linux seccomp cannot prevent IP sockets in every descendant.
    lib = ctypes.CDLL('libseccomp.so.2', use_errno=True)
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    lib.seccomp_load.argtypes = [ctypes.c_void_p]
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    class Compare(ctypes.Structure):
        _fields_ = [('arg', ctypes.c_uint), ('op', ctypes.c_uint), ('a', ctypes.c_uint64), ('b', ctypes.c_uint64)]
    ctx = lib.seccomp_init(0x7fff0000)
    if not ctx:
        raise ValueError('sandbox_unavailable')
    try:
        # SCMP_CMP_NE=1; only local AF_UNIX sockets are available (LibreOffice IPC).
        rule = lib.seccomp_rule_add(ctx, 0x50000 | errno.EPERM,
                                    lib.seccomp_syscall_resolve_name(b'socket'), 1, Compare(0, 1, 1, 0))
        if rule != 0 or lib.seccomp_load(ctx) != 0:
            raise ValueError('sandbox_unavailable')
    finally:
        lib.seccomp_release(ctx)


def command(args, text=None):
    result = subprocess.run(args, input=text, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=70, check=True)
    if len(result.stdout) > 200000:
        raise ValueError('process_output_limit')
    return result.stdout


def office_check(path, limits):
    from defusedxml import ElementTree
    with zipfile.ZipFile(path) as archive:
        items = archive.infolist()
        if len(items) > limits['mediaZipEntries'] or len({i.filename for i in items}) != len(items):
            raise ValueError('zip_entries_limit')
        total = 0
        for item in items:
            name = item.filename.lower()
            if (name.startswith('/') or '\\' in name or '..' in name.split('/') or item.flag_bits & 1
                or (item.external_attr >> 16) & 0o170000 == 0o120000
                or any(v in name for v in ('vbaproject', 'activex', 'embeddings/', 'externallinks/', 'macros/'))):
                raise ValueError('unsafe_office')
            total += item.file_size
            if (total > limits['mediaZipBytes'] or item.file_size > limits['mediaZipBytes']
                or item.file_size > max(1, item.compress_size) * limits['mediaZipRatio']):
                raise ValueError('zip_bomb')
            with archive.open(item) as stream:
                data = stream.read(limits['mediaZipBytes'] + 1)
            if len(data) != item.file_size or len(data) > limits['mediaZipBytes']:
                raise ValueError('zip_bomb')
            if name.endswith(('.xml', '.rels')):
                tree = ElementTree.fromstring(data)
                for node in tree.iter():
                    if (node.attrib.get('TargetMode') == 'External'
                        or any(('://' in str(v) or 'file:' in str(v).lower()) for k, v in node.attrib.items() if k.lower().endswith(('target', 'href')))
                        or (node.text and any(v in node.text.upper() for v in ('DDEAUTO', 'DDE(', 'WEBSERVICE(', 'HYPERLINK(')))):
                        raise ValueError('external_office_content')
        expected = {'docx': 'word/document.xml', 'xlsx': 'xl/workbook.xml', 'pptx': 'ppt/presentation.xml'}[path.suffix[1:]]
        if expected not in archive.namelist() or '[Content_Types].xml' not in archive.namelist():
            raise ValueError('office_mime_mismatch')


def pdf_reader(path, limits):
    from pypdf import PdfReader
    reader = PdfReader(path, strict=True)
    if reader.is_encrypted or not 0 < len(reader.pages) <= limits['mediaPdfPages']:
        raise ValueError('pdf_page_or_encryption_limit')
    # Never follow or propagate actions, scripts, launch targets or embedded files.
    visited = set()
    def inspect(value, depth=0):
        if depth > 40 or len(visited) > 50000:
            raise ValueError('pdf_complexity_limit')
        if hasattr(value, 'get_object'):
            value = value.get_object()
        if isinstance(value, (dict, list)):
            ident = id(value)
            if ident in visited:
                return
            visited.add(ident)
        if isinstance(value, dict):
            if '/OpenAction' in value:
                destination = value['/OpenAction']
                # LibreOffice emits a passive initial page/zoom destination, not executable code.
                if not (isinstance(destination, list) and 2 <= len(destination) <= 6
                        and str(destination[1]) in ('/XYZ', '/Fit', '/FitH', '/FitV', '/FitR', '/FitB', '/FitBH', '/FitBV')):
                    raise ValueError('active_pdf_content')
            if any(k in value for k in ('/JS', '/JavaScript', '/Launch', '/EmbeddedFiles', '/EmbeddedFile', '/AA', '/XFA', '/RichMedia', '/GoToR')):
                raise ValueError('active_pdf_content')
            for entry in value.values():
                inspect(entry, depth + 1)
        elif isinstance(value, list):
            for entry in value:
                inspect(entry, depth + 1)
    inspect(reader.trailer)
    return reader


def image(path, limits):
    from PIL import Image, ImageOps
    Image.MAX_IMAGE_PIXELS = limits['mediaPixels']
    warnings.simplefilter('error', Image.DecompressionBombWarning)
    obj = Image.open(path)
    if obj.width > limits['mediaDimension'] or obj.height > limits['mediaDimension']:
        raise ValueError('image_dimensions_limit')
    obj.load()
    return ImageOps.exif_transpose(obj).convert('RGB')


def probe(path, limits):
    data = json.loads(command(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist',
        'mov,mp3,ogg,wav,matroska,webm,image2,png_pipe,jpeg_pipe,webp_pipe,gif',
        '-show_format', '-show_streams', '-of', 'json', str(path)]))
    streams = data.get('streams', [])
    duration = float(data.get('format', {}).get('duration', 0))
    video = [s for s in streams if s['codec_type'] == 'video' and not s.get('disposition', {}).get('attached_pic')]
    if not duration > 0 or duration > (limits['mediaVideoSeconds'] if video else limits['mediaDurationSeconds']):
        raise ValueError('duration_limit')
    if any(s.get('width', 0) > limits['mediaDimension'] or s.get('height', 0) > limits['mediaDimension']
           or s.get('width', 0) * s.get('height', 0) > limits['mediaPixels'] for s in streams):
        raise ValueError('media_dimensions_limit')
    return data


def process(req):
    limits = req['limits']
    isolate(limits)
    op = req['operation']
    if op == 'download' and req['inputs'] and Path(req['inputs'][0]).suffix in ('.png', '.jpg', '.jpeg', '.webp', '.gif'):
        op = 'png'
    inputs = [Path(p) for p in req['inputs']]
    if any(not p.name.startswith('input-') or p.parent != Path('.') or not p.is_file() or p.is_symlink() for p in inputs):
        raise ValueError('unsafe_path')
    src = inputs[0] if inputs else None
    files = []
    text = None
    if op == 'qr_create':
        import qrcode
        qrcode.make(req['text']).save('result.png')
        files = ['result.png']
    elif op in ('png', 'jpeg', 'webp', 'sticker'):
        img = image(src, limits)
        ext = {'jpeg': 'jpg', 'sticker': 'webp'}.get(op, op)
        if op == 'sticker':
            from PIL import ImageOps
            img = ImageOps.pad(img, (512, 512))
        path = 'result.' + ext
        img.save(path, quality=75)
        files = [path]
    elif op in ('images_pdf',):
        images = []
        pixels = 0
        for path in inputs:
            img = image(path, limits)
            pixels += img.width * img.height
            if pixels > limits['mediaPixels']:
                raise ValueError('collection_pixels_limit')
            images.append(img)
        images[0].save('result.pdf', save_all=True, append_images=images[1:])
        files = ['result.pdf']
    elif op in ('read', 'pdf_compress', 'pdf_crop', 'pdf_merge', 'pdf_images') and src.suffix == '.pdf':
        from pypdf import PdfWriter
        readers = [pdf_reader(p, limits) for p in inputs]
        pages = [p for r in readers for p in r.pages]
        if len(pages) > limits['mediaPdfPages']:
            raise ValueError('pdf_page_limit')
        if op == 'read':
            text = '\n'.join((p.extract_text() or '')[:limits['mediaTextChars']] for p in pages)[:limits['mediaTextChars']]
        elif op == 'pdf_images':
            for i in range(len(pages)):
                command(['pdftoppm', '-f', str(i+1), '-l', str(i+1), '-singlefile', '-scale-to', '1280', '-png', str(src), 'result-' + str(i+1)])
                files.append('result-' + str(i+1) + '.png')
        else:
            if op == 'pdf_crop':
                if not 1 <= req['start'] <= req['end'] <= len(pages):
                    raise ValueError('pdf_page_range')
                pages = pages[req['start']-1:req['end']]
            writer = PdfWriter()
            for page in pages:
                writer.add_page(page)
            if op == 'pdf_compress':
                for page in writer.pages:
                    page.compress_content_streams()
            with open('result.pdf', 'wb') as target:
                writer.write(target)
            files = ['result.pdf']
    elif op == 'office_pdf':
        office_check(src, limits)
        profile = Path('lo-profile');profile.mkdir()
        (profile / 'user').mkdir()
        (profile / 'user/registrymodifications.xcu').write_text('''<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>''')
        command(['libreoffice', '-env:UserInstallation=' + profile.resolve().as_uri(), '--headless', '--nologo', '--nodefault', '--nolockcheck', '--nofirststartwizard', '--convert-to', 'pdf', '--outdir', '.', str(src)])
        output = src.with_suffix('.pdf')
        pdf_reader(output, limits)
        output.rename('result.pdf');files = ['result.pdf']
    elif op in ('ocr', 'qr_read'):
        paths = [src]
        if src.suffix == '.pdf':
            reader = pdf_reader(src, limits)
            if len(reader.pages) > limits['mediaOcrPages']:
                raise ValueError('ocr_page_limit')
            command(['pdftoppm', '-scale-to', '1600', '-png', str(src), 'ocr'])
            paths = sorted(Path('.').glob('ocr-*.png'))
        for p in paths:
            image(p, limits)
        if op == 'ocr':
            text = '\n'.join(command(['tesseract', str(p), 'stdout', '-l', 'spa+eng'])[:limits['mediaTextChars']] for p in paths)
        else:
            text = '\n'.join(command(['zbarimg', '--quiet', '--raw', str(p)]) for p in paths)
        text = text[:limits['mediaTextChars']]
    elif op == 'read' and src.suffix == '.txt':
        text = src.read_text('utf-8')[:limits['mediaTextChars']]
    elif op == 'speak':
        command(['/opt/piper/bin/python', '-m', 'piper', '-m', '/opt/voices/es_MX-ald-medium.onnx', '-f', 'voice.wav', '--input-file', 'speech.txt'])
        command(['ffmpeg', '-nostdin', '-v', 'error', '-threads', '1', '-i', 'voice.wav', '-c:a', 'libopus', '-b:a', '32k', 'result.ogg'])
        files = ['result.ogg']
    elif op in ('mp3', 'ogg', 'wav', 'mp4', 'animated_sticker', 'bass', 'fast', 'slow', 'transcribe', 'download'):
        info = probe(src, limits)
        if op == 'download':
            # Search/download always normalizes to a bounded delivery format.
            op = 'mp4' if any(s['codec_type'] == 'video' for s in info['streams']) else 'mp3'
        ext = {'animated_sticker':'webp', 'bass':'mp3', 'fast':'mp3', 'slow':'mp3', 'transcribe':'ogg'}.get(op, op)
        args = ['ffmpeg', '-nostdin', '-v', 'error', '-threads', '1', '-filter_threads', '1', '-protocol_whitelist', 'file', '-format_whitelist', 'mov,mp3,ogg,wav,matroska,webm,image2,png_pipe,jpeg_pipe,webp_pipe,gif', '-i', str(src), '-map_metadata', '-1']
        if op == 'mp4':
            args += ['-map', '0:v:0', '-map', '0:a:0?', '-vf', "scale='min(640,iw)':-2", '-c:v', 'libx264', '-threads', '1', '-preset', 'veryfast', '-b:v', '180k', '-maxrate', '220k', '-bufsize', '440k', '-c:a', 'aac', '-b:a', '32k', '-movflags', '+faststart']
        elif op == 'animated_sticker':
            args += ['-t', str(limits['mediaStickerSeconds']), '-vf', 'fps=10,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000', '-an', '-c:v', 'libwebp_anim', '-loop', '0', '-q:v', '40']
        else:
            args += ['-vn', '-map', '0:a:0', '-ac', '1', '-ar', '24000']
            if op in ('bass', 'fast', 'slow'):
                args += ['-af', {'bass':'bass=g=8', 'fast':'atempo=1.25', 'slow':'atempo=0.8'}[op]]
            args += {'mp3':['-c:a', 'libmp3lame', '-b:a', '64k'], 'ogg':['-c:a','libopus','-b:a','32k'], 'wav':['-c:a','pcm_s16le']}[ext]
        path = 'result.' + ext
        command(args + [path]);files = [path]
        if op != 'animated_sticker':
            probe(Path(path), limits)
    else:
        raise ValueError('unsupported_conversion')
    if text is not None:
        if not text.strip():
            raise ValueError('no_text_found')
        Path('result.txt').write_text(text, encoding='utf8');files = ['result.txt']
    total = 0
    for name in files:
        path = Path(name)
        size = path.stat().st_size
        total += size
        max_size = limits['mediaOutputBytes']
        if path.suffix in ('.png', '.jpg', '.webp'):
            max_size = limits['mediaImageBytes']
        if op == 'sticker':
            max_size = limits['mediaStickerBytes']
        if op == 'animated_sticker':
            max_size = limits['mediaAnimatedStickerBytes']
        if path.suffix == '.mp4':
            max_size = limits['mediaVideoBytes']
        if not 0 < size <= max_size or total > limits['mediaOutputBytes']:
            raise ValueError('output_size_limit')
    return {'files': files}


if __name__ == '__main__':
    try:
        request = json.load(sys.stdin)
        # Literal voice input is kept in a file, never passed as CLI options.
        if request['operation'] == 'speak':
            Path('speech.txt').write_text(request['text'], encoding='utf8')
        print(json.dumps(process(request)))
    except Exception as error:
        # Preserve only our fixed machine codes, never parser messages or CLI stderr.
        code = 'process_failed'
        if isinstance(error, ValueError) and re.fullmatch(r'[a-z_]{1,80}', str(error)):
            code = str(error)
        elif isinstance(error, subprocess.TimeoutExpired):
            code = 'process_timeout'
        elif isinstance(error, MemoryError):
            code = 'resource_limit'
        print(json.dumps({'error': code}))
        print('media_processing_failed', file=sys.stderr)
        sys.exit(1)
