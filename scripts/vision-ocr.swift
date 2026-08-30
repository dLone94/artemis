#!/usr/bin/env swift
// Local, on-device OCR via Apple's Vision framework.
//
// Artemis invokes this as `swift vision-ocr.swift <image.png>` and reads a JSON
// object from stdout. No network, no cloud OCR — Vision runs entirely on the
// machine. This is the last-resort perception path; Accessibility is preferred.
//
// Output: { "text": "...", "confidence": 0.0-1.0, "blocks": [ { text, confidence, x, y, w, h } ] }

import Foundation
import Vision
import CoreImage
import AppKit

func fail(_ message: String) -> Never {
    let payload: [String: Any] = ["text": "", "blocks": [], "confidence": NSNull(), "error": message]
    if let data = try? JSONSerialization.data(withJSONObject: payload),
       let json = String(data: data, encoding: .utf8) {
        print(json)
    }
    exit(0) // exit 0 so the Node caller reads the structured error, not a crash
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: vision-ocr.swift <image>") }
let path = args[1]

guard let image = NSImage(contentsOfFile: path),
      let tiff = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let cgImage = bitmap.cgImage else {
    fail("could not load image at \(path)")
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    fail("vision failed: \(error.localizedDescription)")
}

var lines: [String] = []
var blocks: [[String: Any]] = []
var confidenceSum: Float = 0
var confidenceCount: Int = 0

for observation in (request.results ?? []) {
    guard let candidate = observation.topCandidates(1).first else { continue }
    lines.append(candidate.string)
    let box = observation.boundingBox // normalized, origin bottom-left
    blocks.append([
        "text": candidate.string,
        "confidence": Double(candidate.confidence),
        "x": Double(box.origin.x),
        "y": Double(box.origin.y),
        "w": Double(box.size.width),
        "h": Double(box.size.height)
    ])
    confidenceSum += candidate.confidence
    confidenceCount += 1
}

let avgConfidence: Any = confidenceCount > 0 ? Double(confidenceSum / Float(confidenceCount)) : NSNull()
let payload: [String: Any] = [
    "text": lines.joined(separator: "\n"),
    "confidence": avgConfidence,
    "blocks": blocks
]

if let data = try? JSONSerialization.data(withJSONObject: payload),
   let json = String(data: data, encoding: .utf8) {
    print(json)
} else {
    fail("could not serialize result")
}
