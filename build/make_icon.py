from PIL import Image, ImageDraw, ImageFilter

def lerp(a, b, t): return tuple(int(a[i] + (b[i]-a[i])*t) for i in range(3))

def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0,0,size-1,size-1], radius=radius, fill=255)
    return m

def make(size):
    S = size * 4
    img = Image.new("RGBA", (S, S), (0,0,0,0))
    grad = Image.new("RGBA", (S, S), (0,0,0,255))
    px = grad.load()
    A = (0x3D, 0x5A, 0xFF); B = (0x8B, 0x5C, 0xF6); C = (0x22, 0xD3, 0xA6)
    for y in range(S):
        for x in range(S):
            t = (x + y) / (2*S)
            col = lerp(A, B, t/0.5) if t < 0.5 else lerp(B, C, (t-0.5)/0.5)
            px[x,y] = (col[0], col[1], col[2], 255)
    sheen = Image.new("L", (S, S), 0)
    ImageDraw.Draw(sheen).ellipse([-S*0.3, -S*0.9, S*1.3, S*0.5], fill=70)
    sheen = sheen.filter(ImageFilter.GaussianBlur(S*0.06))
    white = Image.new("RGBA", (S,S), (255,255,255,255))
    grad = Image.composite(Image.blend(grad, white, 0.18), grad, sheen)
    img.paste(grad, (0,0), rounded_mask(S, int(S*0.22)))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([S*0.012, S*0.012, S-1-S*0.012, S-1-S*0.012],
                        radius=int(S*0.205), outline=(255,255,255,60), width=max(2,int(S*0.006)))
    cx, cy = S*0.40, S*0.30; sc = S*0.46
    pts = [(0.00,0.00),(0.00,0.72),(0.20,0.55),(0.33,0.86),(0.46,0.80),(0.33,0.49),(0.58,0.49)]
    poly = [(cx + p[0]*sc, cy + p[1]*sc) for p in pts]
    sh = Image.new("RGBA", (S,S), (0,0,0,0))
    off = S*0.02
    ImageDraw.Draw(sh).polygon([(x+off, y+off) for (x,y) in poly], fill=(0,0,0,120))
    img = Image.alpha_composite(img, sh.filter(ImageFilter.GaussianBlur(S*0.02)))
    d = ImageDraw.Draw(img)
    d.polygon(poly, fill=(255,255,255,255))
    d.polygon(poly, outline=(20,24,40,90), width=max(2,int(S*0.004)))
    rx, ry = cx + 0.60*sc, cy + 0.66*sc; rr = S*0.085
    glow = Image.new("RGBA", (S,S), (0,0,0,0))
    ImageDraw.Draw(glow).ellipse([rx-rr*1.9, ry-rr*1.9, rx+rr*1.9, ry+rr*1.9], fill=(255,77,94,150))
    img = Image.alpha_composite(img, glow.filter(ImageFilter.GaussianBlur(S*0.03)))
    d = ImageDraw.Draw(img)
    d.ellipse([rx-rr, ry-rr, rx+rr, ry+rr], fill=(255,77,94,255))
    d.ellipse([rx-rr*0.5, ry-rr*0.65, rx+rr*0.15, ry-rr*0.1], fill=(255,190,197,220))
    return img.resize((size,size), Image.LANCZOS)

make(1024).save("icon.png")
sizes = [16,24,32,48,64,128,256]
icons = [make(s) for s in sizes]
icons[0].save("icon.ico", format="ICO", sizes=[(s,s) for s in sizes], append_images=icons[1:])
make(128).save("tray.png")
print("OK")
