"""Usage: python3 mkart.py <launcher.png> <foreground.png> <outdir>
       python3 mkart.py bg <foreground.png> <pic0.png>
Writes icon0.png (512x512) and pic1.png (3840x2160): the launcher's background
colour with the foreground logo centred. 8-bit RGBA non-interlaced PNGs only."""
import struct, sys, zlib


def read_png(path):
    data = open(path, "rb").read()
    pos, idat, w = 8, b"", 0
    while pos < len(data):
        n, kind = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + n]
        if kind == b"IHDR":
            w, h, depth, ctype, _, _, lace = struct.unpack(">IIBBBBB", body)
            assert (depth, ctype, lace) == (8, 6, 0), "need 8-bit RGBA"
        elif kind == b"IDAT":
            idat += body
        pos += 12 + n
    raw, bpp, stride = zlib.decompress(idat), 4, w * 4
    rows, prev = [], bytearray(stride)
    for y in range(h):
        f = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
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
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        rows.append(line)
        prev = line
    return w, h, rows


def write_png(path, w, h, rows):
    raw = b"".join(b"\x00" + bytes(r) for r in rows)

    def chunk(kind, body):
        return (struct.pack(">I", len(body)) + kind + body +
                struct.pack(">I", zlib.crc32(kind + body) & 0xffffffff))

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)))
        f.write(chunk(b"IDAT", zlib.compress(raw, 9)))
        f.write(chunk(b"IEND", b""))


def compose(w, h, bg, fg, size):
    """RGB canvas of colour bg with fg scaled (bilinear) to size x size, centred."""
    fw, fh, frows = fg
    ox, oy = (w - size) // 2, (h - size) // 2
    rows = []
    for y in range(h):
        row = bytearray(bg * w)
        sy = y - oy
        if 0 <= sy < size:
            fy = sy * (fh - 1) / max(size - 1, 1)
            y0 = int(fy)
            y1, ty = min(y0 + 1, fh - 1), fy - y0
            for x in range(max(ox, 0), min(ox + size, w)):
                fx = (x - ox) * (fw - 1) / max(size - 1, 1)
                x0 = int(fx)
                x1, tx = min(x0 + 1, fw - 1), fx - x0
                px = []
                for k in range(4):
                    top = frows[y0][x0 * 4 + k] * (1 - tx) + frows[y0][x1 * 4 + k] * tx
                    bot = frows[y1][x0 * 4 + k] * (1 - tx) + frows[y1][x1 * 4 + k] * tx
                    px.append(top * (1 - ty) + bot * ty)
                al = px[3] / 255
                for k in range(3):
                    row[x * 3 + k] = int(px[k] * al + bg[k] * (1 - al) + 0.5)
        rows.append(row)
    return rows


def background(w, h, fg, size, cx, cy, top, bottom, colour):
    """Vertical gradient top->bottom with fg's alpha painted in colour, centred
    at (cx, cy)."""
    fw, fh, frows = fg
    ox, oy = int(cx - size / 2), int(cy - size / 2)
    rows = []
    for y in range(h):
        t = y / (h - 1)
        bg = bytes(int(top[k] + (bottom[k] - top[k]) * t + 0.5) for k in range(3))
        row = bytearray(bg * w)
        sy = y - oy
        if 0 <= sy < size:
            fy = sy * (fh - 1) / (size - 1)
            y0 = int(fy)
            y1, ty = min(y0 + 1, fh - 1), fy - y0
            r0, r1 = frows[y0], frows[y1]
            for x in range(max(ox, 0), min(ox + size, w)):
                fx = (x - ox) * (fw - 1) / (size - 1)
                x0 = int(fx)
                x1, tx = min(x0 + 1, fw - 1), fx - x0
                a = ((r0[x0 * 4 + 3] * (1 - tx) + r0[x1 * 4 + 3] * tx) * (1 - ty) +
                     (r1[x0 * 4 + 3] * (1 - tx) + r1[x1 * 4 + 3] * tx) * ty) / 255
                if a > 0:
                    for k in range(3):
                        row[x * 3 + k] = int(colour[k] * a + bg[k] * (1 - a) + 0.5)
        rows.append(row)
    return rows


if sys.argv[1] == "bg":
    # mkart.py bg <foreground.png> <out.png>
    fg = read_png(sys.argv[2])
    W, H = 3840, 2160
    write_png(sys.argv[3], W, H,
              background(W, H, fg, 1900, int(W * 0.70), int(H * 0.55),
                         (0x0b, 0x0d, 0x10), (0x16, 0x1d, 0x0c), (0xb1, 0xfd, 0x00)))
    print("wrote", sys.argv[3])
else:
    launcher, fg, out = read_png(sys.argv[1]), read_png(sys.argv[2]), sys.argv[3]
    lw, lh, lrows = launcher
    bg = bytes(lrows[lh // 8][(lw // 2) * 4:(lw // 2) * 4 + 3])
    write_png(out + "/icon0.png", 512, 512, compose(512, 512, bg, fg, 512))
    write_png(out + "/pic1.png", 3840, 2160, compose(3840, 2160, bg, fg, 2160))
    print("bg #%02x%02x%02x" % tuple(bg))
