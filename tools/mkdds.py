"""Usage: python mkdds.py <in.png> <out.dds>
PNG (8-bit RGB/RGBA, non-interlaced) -> BC7 DDS with a DX10 header laid out
exactly like the pic0.dds a working PS5 homebrew ships (DXGI 98, 1 mip)."""
import struct, sys, zlib

import etcpak
import texture2ddecoder


def read_png(path):
    data = open(path, "rb").read()
    pos, idat = 8, b""
    while pos < len(data):
        n, kind = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + n]
        if kind == b"IHDR":
            w, h, depth, ctype, _, _, lace = struct.unpack(">IIBBBBB", body)
            assert depth == 8 and ctype in (2, 6) and lace == 0
        elif kind == b"IDAT":
            idat += body
        pos += 12 + n
    bpp = 4 if ctype == 6 else 3
    raw, stride = zlib.decompress(idat), w * bpp
    out, prev = bytearray(), bytearray(stride)
    for y in range(h):
        f = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        if f:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                if f == 1:
                    line[i] = (line[i] + a) & 255
                elif f == 2:
                    line[i] = (line[i] + b) & 255
                elif f == 3:
                    line[i] = (line[i] + (a + b) // 2) & 255
                else:
                    p = a + b - c
                    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                    line[i] = (line[i] + (a if pa <= pb and pa <= pc else (b if pb <= pc else c))) & 255
        prev = line
        if bpp == 4:
            out += line
        else:
            rgba = bytearray(w * 4)
            rgba[0::4], rgba[1::4], rgba[2::4] = line[0::3], line[1::3], line[2::3]
            rgba[3::4] = b"\xff" * w
            out += rgba
    return w, h, bytes(out)


w, h, rgba = read_png(sys.argv[1])
assert w % 4 == 0 and h % 4 == 0
blocks = etcpak.compress_bc7(rgba, w, h)
assert len(blocks) == w * h, len(blocks)

DDSD_CAPS, DDSD_HEIGHT, DDSD_WIDTH, DDSD_PIXELFORMAT = 0x1, 0x2, 0x4, 0x1000
DDSD_MIPMAPCOUNT, DDSD_LINEARSIZE = 0x20000, 0x80000
flags = DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT | DDSD_MIPMAPCOUNT | DDSD_LINEARSIZE
header = struct.pack("<4s7I44x", b"DDS ", 124, flags, h, w, len(blocks), 1, 1)
header += struct.pack("<2I4s5I", 32, 0x4, b"DX10", 0, 0, 0, 0, 0)   # pixel format
header += struct.pack("<5I", 0x1000, 0, 0, 0, 0)                    # caps
header += struct.pack("<5I", 98, 3, 0, 1, 1)                        # DX10: BC7_UNORM, 2D
open(sys.argv[2], "wb").write(header + blocks)

# Round trip: decode and compare a few pixels with the source.
back = texture2ddecoder.decode_bc7(blocks, w, h)  # BGRA
worst = 0
for x, y in ((0, 0), (w // 2, h // 2), (int(w * 0.7), int(h * 0.55)), (w - 1, h - 1), (w // 3, h - 5)):
    i = (y * w + x) * 4
    worst = max(worst, max(abs(back[i + 2 - k] - rgba[i + k]) for k in range(3)))
print("%s %dx%d %d bytes, max channel error on samples %d" % (sys.argv[2], w, h, len(header) + len(blocks), worst))
