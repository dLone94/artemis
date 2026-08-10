// Draws the Evie app icon and writes an .icns.
//
// Procedural rather than a pasted bitmap: every size is rendered at its own
// resolution instead of being downsampled into mush at 32px. The mark: a calm
// indigo-to-teal sphere, ONE thin platinum ring on a gentle tilt (behind the
// sphere at the top, in front at the bottom — the depth cue that makes it an
// object, not a logo), and a single bright morning-star point riding the near
// side of the ring. At 16px it reads as a ringed dot.
//
//   swiftc -O -o /tmp/makeicon app/makeicon.swift && /tmp/makeicon app/AppIcon.icns
import AppKit
import Foundation

let outPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.icns"

// Evie palette: dawn, not cockpit.
let ink = NSColor(srgbRed: 0.020, green: 0.024, blue: 0.055, alpha: 1)        // indigo-black
let lift = NSColor(srgbRed: 0.070, green: 0.090, blue: 0.220, alpha: 1)        // background glow
let sphereLight = NSColor(srgbRed: 0.480, green: 0.860, blue: 0.910, alpha: 1) // lit teal
let sphereMid = NSColor(srgbRed: 0.180, green: 0.310, blue: 0.760, alpha: 1)   // indigo-blue
let sphereDeep = NSColor(srgbRed: 0.070, green: 0.095, blue: 0.340, alpha: 1)  // shadowed edge
let platinum = NSColor(srgbRed: 0.890, green: 0.905, blue: 0.945, alpha: 1)    // the ring

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

    // background: indigo-black with a soft dawn lift behind the sphere
    ink.setFill()
    rect.fill()
    let c = CGPoint(x: rect.midX, y: rect.midY)
    if let glow = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                             colors: [lift.cgColor, ink.cgColor] as CFArray,
                             locations: [0, 1]) {
        ctx.drawRadialGradient(glow, startCenter: c, startRadius: 0,
                               endCenter: c, endRadius: rect.width * 0.60,
                               options: [])
    }

    // ONE ring, gently tilted. Geometry shared by both passes; the ring is
    // stroked fully here (behind), then its near half again after the sphere.
    let ringAngle: CGFloat = -0.35
    let ringRX = rect.width * 0.455
    let ringRY = rect.width * 0.150
    let ringWidth = max(S * 0.011, 0.7)
    func strokeRing(nearHalfOnly: Bool) {
        ctx.saveGState()
        ctx.translateBy(x: c.x, y: c.y)
        ctx.rotate(by: ringAngle)
        if nearHalfOnly {
            // in ring coordinates the near (front) side is the lower half
            ctx.clip(to: CGRect(x: -rect.width, y: -rect.width,
                                width: rect.width * 2, height: rect.width))
        }
        ctx.setStrokeColor(platinum.withAlphaComponent(nearHalfOnly ? 0.95 : 0.55).cgColor)
        ctx.setLineWidth(ringWidth)
        ctx.strokeEllipse(in: CGRect(x: -ringRX, y: -ringRY, width: ringRX * 2, height: ringRY * 2))
        ctx.restoreGState()
    }
    strokeRing(nearHalfOnly: false)

    // the sphere: indigo-to-teal, lit from the upper left like morning
    let coreR = rect.width * 0.295
    if let halo = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                             colors: [sphereMid.withAlphaComponent(0.55).cgColor,
                                      sphereMid.withAlphaComponent(0).cgColor] as CFArray,
                             locations: [0, 1]) {
        ctx.drawRadialGradient(halo, startCenter: c, startRadius: coreR * 0.8,
                               endCenter: c, endRadius: coreR * 1.9, options: [])
    }
    ctx.saveGState()
    let sphereRect = CGRect(x: c.x - coreR, y: c.y - coreR, width: coreR * 2, height: coreR * 2)
    ctx.addEllipse(in: sphereRect)
    ctx.clip()
    if let body = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                             colors: [sphereLight.cgColor, sphereMid.cgColor, sphereDeep.cgColor] as CFArray,
                             locations: [0, 0.52, 1]) {
        let lightC = CGPoint(x: c.x - coreR * 0.42, y: c.y + coreR * 0.48)
        ctx.drawRadialGradient(body, startCenter: lightC, startRadius: 0,
                               endCenter: lightC, endRadius: coreR * 2.05, options: [])
    }
    // specular kiss
    if let spec = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                             colors: [NSColor.white.withAlphaComponent(0.85).cgColor,
                                      NSColor.white.withAlphaComponent(0).cgColor] as CFArray,
                             locations: [0, 1]) {
        let sp = CGPoint(x: c.x - coreR * 0.38, y: c.y + coreR * 0.44)
        ctx.drawRadialGradient(spec, startCenter: sp, startRadius: 0,
                               endCenter: sp, endRadius: coreR * 0.55, options: [])
    }
    ctx.restoreGState()

    // ring again — only the near half, passing in front of the sphere
    strokeRing(nearHalfOnly: true)

    // the morning star: one bright point riding the near side of the ring
    let t: CGFloat = -0.62                      // parametric angle on the ellipse (near side)
    let starLocal = CGPoint(x: ringRX * cos(t), y: ringRY * sin(t))
    let star = CGPoint(
        x: c.x + starLocal.x * cos(ringAngle) - starLocal.y * sin(ringAngle),
        y: c.y + starLocal.x * sin(ringAngle) + starLocal.y * cos(ringAngle))
    let starR = rect.width * 0.026
    if let g = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                          colors: [NSColor.white.cgColor,
                                   sphereLight.withAlphaComponent(0).cgColor] as CFArray,
                          locations: [0, 1]) {
        ctx.drawRadialGradient(g, startCenter: star, startRadius: 0,
                               endCenter: star, endRadius: starR * 1.9, options: [])
    }
    ctx.setFillColor(NSColor.white.cgColor)
    ctx.fillEllipse(in: CGRect(x: star.x - starR / 2, y: star.y - starR / 2,
                               width: starR, height: starR))

    ctx.restoreGState()

    // a hairline edge so the plate reads as an object on light wallpapers
    ctx.setStrokeColor(platinum.withAlphaComponent(0.18).cgColor)
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
