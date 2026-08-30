// Builds the macOS .icns from the production Artemis master artwork.
//
//   swiftc -O -o /tmp/makeicon app/makeicon.swift
//   /tmp/makeicon app/AppIcon.icns app/AppIcon-source.png
import AppKit
import Foundation

let outPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.icns"
let sourcePath: String = {
    if CommandLine.arguments.count > 2 { return CommandLine.arguments[2] }
    return URL(fileURLWithPath: outPath)
        .deletingLastPathComponent()
        .appendingPathComponent("AppIcon-source.png")
        .path
}()

guard let source = NSImage(contentsOfFile: sourcePath) else {
    FileHandle.standardError.write("failed to load \(sourcePath)\n".data(using: .utf8)!)
    exit(1)
}

func png(size: Int) -> Data? {
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: size,
        pixelsHigh: size,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else { return nil }

    bitmap.size = NSSize(width: size, height: size)
    NSGraphicsContext.saveGraphicsState()
    guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
        NSGraphicsContext.restoreGraphicsState()
        return nil
    }
    context.imageInterpolation = .high
    NSGraphicsContext.current = context
    NSColor.clear.setFill()
    NSRect(x: 0, y: 0, width: size, height: size).fill()
    source.draw(
        in: NSRect(x: 0, y: 0, width: size, height: size),
        from: NSRect(origin: .zero, size: source.size),
        operation: .copy,
        fraction: 1,
        respectFlipped: true,
        hints: [.interpolation: NSImageInterpolation.high]
    )
    context.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()
    return bitmap.representation(using: .png, properties: [:])
}

let fileManager = FileManager.default
let work = URL(fileURLWithPath: NSTemporaryDirectory())
    .appendingPathComponent("Artemis-\(ProcessInfo.processInfo.processIdentifier).iconset")
try? fileManager.removeItem(at: work)
try fileManager.createDirectory(at: work, withIntermediateDirectories: true)
defer { try? fileManager.removeItem(at: work) }

let variants: [(name: String, px: Int)] = [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024)
]

for variant in variants {
    guard let data = png(size: variant.px) else {
        FileHandle.standardError.write("failed to render \(variant.name)\n".data(using: .utf8)!)
        exit(1)
    }
    try data.write(to: work.appendingPathComponent(variant.name))
}

let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", work.path, "-o", outPath]
try iconutil.run()
iconutil.waitUntilExit()
guard iconutil.terminationStatus == 0 else {
    FileHandle.standardError.write("iconutil failed\n".data(using: .utf8)!)
    exit(1)
}

if let preview = png(size: 1024) {
    try preview.write(to: URL(fileURLWithPath: outPath)
        .deletingLastPathComponent()
        .appendingPathComponent("AppIcon-1024.png"))
}
print("wrote \(outPath)")
