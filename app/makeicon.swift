// Draws the Artemis app icon and writes an .icns.
//
// Procedural rather than a pasted bitmap: the icon is the same object the app
// draws on screen — an amber core inside thin orbital rings on near-black — and
// generating it means every size is rendered at its own resolution instead of
// being downsampled into mush at 32px.
//
//   swiftc -O -o /tmp/makeicon app/makeicon.swift && /tmp/makeicon app/AppIcon.icns
import AppKit
import Foundation

let outPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.icns"

// Palette lifted from the cockpit UI (cyan reactor HUD).
let amber = NSColor(srgbRed: 0.13, green: 0.83, blue: 0.93, alpha: 1)   // cyan: matches the HUD
let amberDim = NSColor(srgbRed: 0.05, green: 0.45, blue: 0.57, alpha: 1)
let ink = NSColor(srgbRed: 0.016, green: 0.027, blue: 0.043, alpha: 1)

func drawIcon(size S: CGFloat) -> NSImage {
    let img = NSImage(size: NSSize(width: S, height: S))
    img.lockFocus()
    guard let ctx = NSGraphicsContext.current?.cgContext else { img.unlockFocus(); return img }
    ctx.setAllowsAntialiasing(true)

    // macOS icons sit on a rounded square with a margin; matching the system
    // curvature keeps it from looking foreign in the Dock.
    let inset = S * 0.06
    let rect = CGRect(x: inset, y: inset, width: S - inset * 2, height: S - inset * 2)
    let radius = rect.width * 0.2237                   // Apple's continuous-corner ratio
    let plate = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)

    ctx.saveGState()
    plate.addClip()

    // background: near-black with a warm lift toward the centre
    ink.setFill()
    rect.fill()
    let c = CGPoint(x: rect.midX, y: rect.midY)
    if let glow = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                             colors: [NSColor(srgbRed: 0.03, green: 0.20, blue: 0.26, alpha: 1).cgColor,
                                      ink.cgColor] as CFArray,
                             locations: [0, 1]) {
        ctx.drawRadialGradient(glow, startCenter: c, startRadius: 0,
                               endCenter: c, endRadius: rect.width * 0.62,
                               options: [])
    }

    // orbital rings — ellipses at different tilts, thin and slightly translucent
    let ringSpecs: [(rx: CGFloat, ry: CGFloat, angle: CGFloat, alpha: CGFloat)] = [
        (0.46, 0.17, -0.30, 0.85),
        (0.40, 0.13,  0.55, 0.55),
        (0.34, 0.30,  0.10, 0.30)
    ]
    for spec in ringSpecs {
        ctx.saveGState()
        ctx.translateBy(x: c.x, y: c.y)
        ctx.rotate(by: spec.angle)
        let r = CGRect(x: -rect.width * spec.rx, y: -rect.width * spec.ry,
                       width: rect.width * spec.rx * 2, height: rect.width * spec.ry * 2)
        ctx.setStrokeColor(amber.withAlphaComponent(spec.alpha).cgColor)
        ctx.setLineWidth(max(S * 0.006, 0.6))
        ctx.strokeEllipse(in: r)
        ctx.restoreGState()
    }

    // the core: a soft amber sphere
    let coreR = rect.width * 0.235
    if let core = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                             colors: [NSColor.white.withAlphaComponent(0.95).cgColor,
                                      amber.cgColor,
                                      amberDim.withAlphaComponent(0.0).cgColor] as CFArray,
                             locations: [0, 0.45, 1]) {
        ctx.drawRadialGradient(core, startCenter: CGPoint(x: c.x, y: c.y + coreR * 0.12), startRadius: 0,
                               endCenter: c, endRadius: coreR * 1.75, options: [])
    }
    ctx.setFillColor(amber.cgColor)
    ctx.fillEllipse(in: CGRect(x: c.x - coreR * 0.62, y: c.y - coreR * 0.62,
                               width: coreR * 1.24, height: coreR * 1.24))

    // two travelling points on the rings — the detail that reads as "orbit"
    for (dx, dy, rr) in [(0.40, 0.10, 0.028), (-0.30, -0.16, 0.020)] {
        let p = CGPoint(x: c.x + rect.width * CGFloat(dx), y: c.y + rect.width * CGFloat(dy))
        let pr = rect.width * CGFloat(rr)
        if let g = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                              colors: [NSColor.white.cgColor, amber.withAlphaComponent(0).cgColor] as CFArray,
                              locations: [0, 1]) {
            ctx.drawRadialGradient(g, startCenter: p, startRadius: 0, endCenter: p, endRadius: pr * 3, options: [])
        }
        ctx.setFillColor(NSColor.white.cgColor)
        ctx.fillEllipse(in: CGRect(x: p.x - pr / 2, y: p.y - pr / 2, width: pr, height: pr))
    }

    ctx.restoreGState()

    // a hairline edge so the plate reads as an object on light wallpapers
    ctx.setStrokeColor(amber.withAlphaComponent(0.22).cgColor)
    ctx.setLineWidth(max(S * 0.004, 0.5))
    plate.lineWidth = max(S * 0.004, 0.5)
    plate.stroke()

    img.unlockFocus()
    return img
}

func png(_ image: NSImage, _ size: CGFloat) -> Data? {
    guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return nil }
    rep.size = NSSize(width: size, height: size)
    return rep.representation(using: .png, properties: [:])
}

let fm = FileManager.default
let work = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("Artemis.iconset")
try? fm.removeItem(at: work)
try fm.createDirectory(at: work, withIntermediateDirectories: true)

// The set macOS actually wants; each rendered natively, not scaled.
let variants: [(name: String, px: CGFloat)] = [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024)
]
for v in variants {
    guard let data = png(drawIcon(size: v.px), v.px) else {
        FileHandle.standardError.write("failed to render \(v.name)\n".data(using: .utf8)!)
        exit(1)
    }
    try data.write(to: work.appendingPathComponent(v.name))
}

let p = Process()
p.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
p.arguments = ["-c", "icns", work.path, "-o", outPath]
try p.run()
p.waitUntilExit()
guard p.terminationStatus == 0 else {
    FileHandle.standardError.write("iconutil failed\n".data(using: .utf8)!)
    exit(1)
}
// keep a big PNG around for README/preview use
if let data = png(drawIcon(size: 1024), 1024) {
    try? data.write(to: URL(fileURLWithPath: outPath).deletingLastPathComponent()
        .appendingPathComponent("AppIcon-1024.png"))
}
print("wrote \(outPath)")
