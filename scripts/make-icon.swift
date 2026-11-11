// The icon of Forchetta.app: an amber fork on the dark of the app, in the shape of a macOS icon. Drawn as vectors
// at each size of the iconset, so that every size is sharp; iconutil then makes native/AppIcon.icns.
//
//   swift scripts/make-icon.swift <folder.iconset> [preview.png]
//
// The four tines are also the four terminals the app puts side by side.
import AppKit

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    print("uso: swift scripts/make-icon.swift <cartella.iconset> [anteprima.png]")
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
