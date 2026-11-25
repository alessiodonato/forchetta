// The icon of Forchetta.app: an amber fork on the dark of the app, in the shape of a macOS icon. Drawn as vectors
// at each size of the iconset, so that every size is sharp; iconutil then makes native/AppIcon.icns.
//
//   swift scripts/make-icon.swift <folder.iconset> [preview.png]
//
// And the one of Windows and Linux, of the window and of the Start menu (src/ui/forchetta.ico): the same fork, with no
// shadow around it and on whole pixels where it is small.
//
//   swift scripts/make-icon.swift src/ui/forchetta.ico
//
// The four tines are also the four terminals the app puts side by side.
import AppKit

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    print("uso: swift scripts/make-icon.swift <cartella.iconset> [anteprima.png] | <file.ico>")
    exit(1)
}

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
}

/// The fork, in a 1024 × 1024 space with the origin at the bottom left.
func fork() -> NSBezierPath {
    let path = NSBezierPath()
    // Four tines with round tips.
    let tineWidth: CGFloat = 42
    let gap: CGFloat = 36
    let total = 4 * tineWidth + 3 * gap
    let left = 512 - total / 2
    for index in 0..<4 {
        let x = left + CGFloat(index) * (tineWidth + gap)
        path.append(NSBezierPath(roundedRect: NSRect(x: x, y: 560, width: tineWidth, height: 262), xRadius: tineWidth / 2, yRadius: tineWidth / 2))
    }
    // The head that holds them, narrowing into the neck: one outline, so that shoulders and neck flow into each
    // other. Every part is drawn in the same direction: where two overlap, both stay filled.
    let right = left + total
    let head = NSBezierPath()
    head.move(to: NSPoint(x: left, y: 600))
    head.line(to: NSPoint(x: left, y: 556))
    head.curve(to: NSPoint(x: 476, y: 404), controlPoint1: NSPoint(x: left, y: 468), controlPoint2: NSPoint(x: 470, y: 474))
    head.line(to: NSPoint(x: 548, y: 404))
    head.curve(to: NSPoint(x: right, y: 556), controlPoint1: NSPoint(x: 554, y: 474), controlPoint2: NSPoint(x: right, y: 468))
    head.line(to: NSPoint(x: right, y: 600))
    head.close()
    path.append(head)
    // The handle, a little wider at its end.
    let handle = NSBezierPath()
    handle.move(to: NSPoint(x: 476, y: 430))
    handle.line(to: NSPoint(x: 548, y: 430))
    handle.curve(to: NSPoint(x: 556, y: 214), controlPoint1: NSPoint(x: 550, y: 340), controlPoint2: NSPoint(x: 556, y: 270))
    handle.curve(to: NSPoint(x: 468, y: 214), controlPoint1: NSPoint(x: 556, y: 156), controlPoint2: NSPoint(x: 468, y: 156))
    handle.curve(to: NSPoint(x: 476, y: 430), controlPoint1: NSPoint(x: 468, y: 270), controlPoint2: NSPoint(x: 474, y: 340))
    handle.close()
    path.append(handle.reversed)
    return path
}

func draw(pixels: Int) -> NSBitmapImageRep {
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4,
        hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    )!
    rep.size = NSSize(width: pixels, height: pixels)
    NSGraphicsContext.saveGraphicsState()
    let context = NSGraphicsContext(bitmapImageRep: rep)!
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    let scale = CGFloat(pixels) / 1024
    let transform = NSAffineTransform()
    transform.scale(by: scale)
    transform.concat()

    // The body of a macOS icon: 824 points in a 1024 grid, with its soft shadow.
    let body = NSBezierPath(roundedRect: NSRect(x: 100, y: 100, width: 824, height: 824), xRadius: 186, yRadius: 186)
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.4)
    shadow.shadowBlurRadius = 28
    shadow.shadowOffset = NSSize(width: 0, height: -12)
    shadow.set()
    color(0x15171a).setFill()
    body.fill()
    NSGraphicsContext.restoreGraphicsState()
    // The surface of the app, a little lighter at the top.
    NSGradient(starting: color(0x23262b), ending: color(0x0d0e10))!.draw(in: body, angle: -90)
    // A thin edge, as the boxes have.
    NSGraphicsContext.saveGraphicsState()
    body.addClip()
    let edge = NSBezierPath(roundedRect: NSRect(x: 101.5, y: 101.5, width: 821, height: 821), xRadius: 185, yRadius: 185)
    edge.lineWidth = 3
    color(0xffffff, 0.09).setStroke()
    edge.stroke()
    NSGraphicsContext.restoreGraphicsState()

    // The fork: the amber of the app, warmer at the bottom, with a faint glow behind it.
    let shape = fork()
    NSGraphicsContext.saveGraphicsState()
    let glow = NSShadow()
    glow.shadowColor = color(0xf0a43c, 0.35)
    glow.shadowBlurRadius = 46
    glow.shadowOffset = .zero
    glow.set()
    color(0xf0a43c).setFill()
    shape.fill()
    NSGraphicsContext.restoreGraphicsState()
    NSGradient(starting: color(0xf8bd5c), ending: color(0xe58a22))!.draw(in: shape, angle: -90)

    NSGraphicsContext.restoreGraphicsState()
    return rep
}

/// The fork of a small icon, on whole pixels: four tines of that width, with that gap between them, and the handle.
func smallFork(pixels: Int, tine: Int, gap: Int, handle: Int) -> NSBezierPath {
    let size = CGFloat(pixels)
    let width = CGFloat(tine)
    let total = CGFloat(4 * tine + 3 * gap)
    let left = (size - total) / 2
    let right = left + total
    // From the top: where the tines start, where they meet, where the head ends in the neck.
    let top = (size * 0.12).rounded()
    let meet = top + (size * 0.31).rounded()
    let neck = meet + (size * 0.17).rounded()
    let half = CGFloat(handle) / 2
    let radius = tine > 2 ? width / 2 : 0
    let path = NSBezierPath()
    for index in 0..<4 {
        let x = left + CGFloat(index * (tine + gap))
        path.append(NSBezierPath(roundedRect: NSRect(x: x, y: size - meet - width, width: width, height: meet + width - top), xRadius: radius, yRadius: radius))
    }
    let head = NSBezierPath()
    head.move(to: NSPoint(x: left, y: size - meet))
    head.curve(to: NSPoint(x: size / 2 - half, y: size - neck), controlPoint1: NSPoint(x: left, y: size - neck + (neck - meet) * 0.3), controlPoint2: NSPoint(x: size / 2 - half, y: size - neck + (neck - meet) * 0.4))
    head.line(to: NSPoint(x: size / 2 + half, y: size - neck))
    head.curve(to: NSPoint(x: right, y: size - meet), controlPoint1: NSPoint(x: size / 2 + half, y: size - neck + (neck - meet) * 0.4), controlPoint2: NSPoint(x: right, y: size - neck + (neck - meet) * 0.3))
    head.close()
    path.append(head)
    let end = handle > 2 ? half : 0
    path.append(NSBezierPath(roundedRect: NSRect(x: size / 2 - half, y: top, width: 2 * half, height: size - neck - top + half), xRadius: end, yRadius: end))
    return path
}

/// The sizes of Windows at its scales. The small ones have a fork of their own, the others that of the Mac.
let windowsSizes: [(pixels: Int, small: (tine: Int, gap: Int, handle: Int)?)] = [
    (16, (1, 2, 2)), (20, (1, 2, 2)), (24, (2, 2, 4)), (32, (2, 2, 4)), (40, (3, 2, 4)), (48, (3, 2, 6)), (64, nil), (128, nil), (256, nil),
]

/// One size of the icon of Windows, in sRGB whatever the display of this Mac.
func drawWindows(pixels: Int, small: (tine: Int, gap: Int, handle: Int)?) -> CGImage {
    let size = CGFloat(pixels)
    let bitmap = CGContext(
        data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: pixels * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: bitmap, flipped: false)
    let inset = pixels < 32 ? 0 : (size / 32).rounded()
    let frame = NSRect(x: inset, y: inset, width: size - 2 * inset, height: size - 2 * inset)
    let body = NSBezierPath(roundedRect: frame, xRadius: frame.width * 0.22, yRadius: frame.width * 0.22)
    NSGradient(starting: color(0x23262b), ending: color(0x0d0e10))!.draw(in: body, angle: -90)
    let shape: NSBezierPath
    if let small = small {
        shape = smallFork(pixels: pixels, tine: small.tine, gap: small.gap, handle: small.handle)
    } else {
        shape = fork()
        // The fork of the Mac is 652 of 1024 high: here it takes three quarters of the icon.
        let scale = AffineTransform(scale: size * 0.74 / 652)
        shape.transform(using: scale)
        let bounds = shape.bounds
        shape.transform(using: AffineTransform(translationByX: size / 2 - bounds.midX, byY: size / 2 - bounds.midY))
    }
    NSGradient(starting: color(0xf8bd5c), ending: color(0xe58a22))!.draw(in: shape, angle: -90)
    NSGraphicsContext.restoreGraphicsState()
    return bitmap.makeImage()!
}

/// An .ico: the large sizes as PNG, the others as the bitmaps that every Windows reads (BGRA from the bottom, and a mask).
func ico() -> Data {
    func bytes<T: FixedWidthInteger>(_ value: T) -> Data { withUnsafeBytes(of: value.littleEndian) { Data($0) } }
    let images: [(pixels: Int, data: Data)] = windowsSizes.map { entry in
        let pixels = entry.pixels
        let image = drawWindows(pixels: pixels, small: entry.small)
        if pixels >= 128 { return (pixels, NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])!) }
        let source = [UInt8](image.dataProvider!.data! as Data)
        let maskRow = (pixels + 31) / 32 * 4
        var data = bytes(UInt32(40)) + bytes(Int32(pixels)) + bytes(Int32(pixels * 2)) + bytes(UInt16(1)) + bytes(UInt16(32))
        data += bytes(UInt32(0)) + bytes(UInt32(pixels * pixels * 4 + maskRow * pixels)) + Data(count: 16)
        var mask = Data()
        for row in (0..<pixels).reversed() {
            var bits = [UInt8](repeating: 0, count: maskRow)
            for column in 0..<pixels {
                let at = row * pixels * 4 + column * 4
                let alpha = Int(source[at + 3])
                // Without the alpha that Core Graphics multiplies in.
                func plain(_ value: UInt8) -> UInt8 { alpha == 0 ? 0 : UInt8(min(255, (Int(value) * 255 + alpha / 2) / alpha)) }
                data += Data([plain(source[at + 2]), plain(source[at + 1]), plain(source[at]), UInt8(alpha)])
                if alpha == 0 { bits[column / 8] |= 0x80 >> UInt8(column % 8) }
            }
            mask += Data(bits)
        }
        return (pixels, data + mask)
    }
    var file = bytes(UInt16(0)) + bytes(UInt16(1)) + bytes(UInt16(images.count))
    var offset = 6 + 16 * images.count
    for image in images {
        // 256 is written 0: the size is one byte.
        file += Data([UInt8(image.pixels % 256), UInt8(image.pixels % 256), 0, 0]) + bytes(UInt16(1)) + bytes(UInt16(32))
        file += bytes(UInt32(image.data.count)) + bytes(UInt32(offset))
        offset += image.data.count
    }
    return images.reduce(file) { $0 + $1.data }
}

if arguments[1].hasSuffix(".ico") {
    try ico().write(to: URL(fileURLWithPath: arguments[1]))
    print("icona in \(arguments[1])")
    exit(0)
}

let folder = URL(fileURLWithPath: arguments[1])
try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
for points in [16, 32, 128, 256, 512] {
    for factor in [1, 2] {
        let name = factor == 1 ? "icon_\(points)x\(points).png" : "icon_\(points)x\(points)@2x.png"
        let data = draw(pixels: points * factor).representation(using: .png, properties: [:])!
        try data.write(to: folder.appendingPathComponent(name))
    }
}
if arguments.count >= 3 {
    try draw(pixels: 1024).representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: arguments[2]))
}
print("icone in \(folder.path)")
