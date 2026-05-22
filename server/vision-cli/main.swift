// vision-cli/main.swift
// Analyzes a video clip using AVFoundation + Vision Framework.
// Produces a JSON object to stdout with the same shape as clip-vision.js SAFE_DEFAULTS.
//
// Compile:
//   swiftc -O server/vision-cli/main.swift \
//     -o server/bin/vision-cli \
//     -framework AVFoundation -framework Vision \
//     -framework CoreImage -framework Foundation
//
// Usage: vision-cli <video-path>

import AVFoundation
import Vision
import CoreImage
import Foundation

// MARK: — Config thresholds

private let FACE_CONF_MIN:          Double = 0.50  // VNFaceObservation confidence floor
private let FACE_AREA_MIN:          Double = 0.015 // Min face bbox area (fraction of frame)
private let HASFAACE_RATIO:         Double = 0.10  // ≥10 % of frames must have a valid face
private let TALKING_FACE_RATIO:     Double = 0.35  // ≥35 % of frames need face for talking-head
private let TALKING_LARGE_RATIO:    Double = 0.20  // ≥20 % of frames need large + centred face
private let LARGE_FACE_AREA:        Double = 0.05  // Face area threshold for "large"
private let CENTRE_MIN_X:           Double = 0.20  // Face centre-X must be in [0.2, 0.8]
private let CENTRE_MAX_X:           Double = 0.80

// MARK: — Output model

struct AnalysisResult: Encodable {
    var hasFace:           Bool
    var isTalkingHead:     Bool
    var qualityScore:      Int
    var suggestedRotation: Int?         // nil → caller falls back to probe metadata
    var facePresenceRatio: Double
    var contentTags:       [String]     // always [] — Claude handles semantic tagging
    var description:       String       // always "" — Claude handles descriptions
    var bestFrame:         Int?         // index of sharpest sampled frame
}

// MARK: — Rotation from preferredTransform
//
// CGAffineTransform(a, b, c, d, tx, ty) — atan2(b, a) yields the CCW angle in
// standard math coords, but video coords have Y increasing downward (same as
// screen space), so the visual result is the clockwise angle we want for ffmpeg.
// e.g. iPhone portrait: transform=(0,1,-1,0) → atan2(1,0)=90° → 'transpose=1' ✓

func videoRotation(from transform: CGAffineTransform) -> Int {
    let rad  = atan2(Double(transform.b), Double(transform.a))
    let deg  = rad * 180.0 / .pi
    let norm = (deg + 360.0).truncatingRemainder(dividingBy: 360.0)
    return (Int((norm + 45.0) / 90.0) * 90) % 360
}

// MARK: — Adaptive sample count

func sampleCount(for duration: Double) -> Int {
    switch duration {
    case ..<10:   return 5
    case ..<30:   return 8
    case ..<60:   return 12
    case ..<180:  return 20
    case ..<600:  return 30
    default:      return 40
    }
}

// MARK: — Per-frame face info

struct FrameFaceInfo {
    var count:                 Int
    var maxArea:               Double
    var maxConf:               Double
    var hasLargeAndCentred:    Bool
}

func detectFaces(in cgImage: CGImage) -> FrameFaceInfo {
    var info = FrameFaceInfo(count: 0, maxArea: 0, maxConf: 0, hasLargeAndCentred: false)
    let req  = VNDetectFaceRectanglesRequest()
    do {
        try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([req])
        guard let obs = req.results else { return info }
        info.count = obs.count
        for face in obs {
            let bb   = face.boundingBox   // normalised 0–1, origin bottom-left
            let area = Double(bb.width * bb.height)
            let conf = Double(face.confidence)
            if area > info.maxArea { info.maxArea = area }
            if conf > info.maxConf { info.maxConf = conf }
            let cx = Double(bb.midX)
            if area > LARGE_FACE_AREA && cx > CENTRE_MIN_X && cx < CENTRE_MAX_X {
                info.hasLargeAndCentred = true
            }
        }
    } catch {}
    return info
}

// MARK: — Quality score (luminance variance via CoreGraphics)
//
// Renders the frame to a 16×16 thumbnail and computes the standard deviation
// of luminance values. Higher variance = more visual interest and contrast.
// This avoids CIImage coordinate-system issues and reliably returns non-zero
// values for any non-trivial footage.

private let THUMB = 16

func qualityScore(of cgImage: CGImage) -> Double {
    var buf = [UInt8](repeating: 0, count: THUMB * THUMB * 4)
    guard let ctx = CGContext(
        data: &buf,
        width:             THUMB,
        height:            THUMB,
        bitsPerComponent:  8,
        bytesPerRow:       THUMB * 4,
        space:             CGColorSpaceCreateDeviceRGB(),
        bitmapInfo:        CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return 50.0 }

    ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: THUMB, height: THUMB))

    let n = Double(THUMB * THUMB)
    var sum = 0.0, sumSq = 0.0

    for i in stride(from: 0, to: buf.count, by: 4) {
        // Rec. 601 luminance
        let lum = 0.299 * Double(buf[i]) + 0.587 * Double(buf[i + 1]) + 0.114 * Double(buf[i + 2])
        sum   += lum
        sumSq += lum * lum
    }

    let mean     = sum / n
    let variance = (sumSq / n) - (mean * mean)
    let stdDev   = sqrt(max(0.0, variance))

    // stdDev ranges: ~0 = uniform/black, ~30-70 = typical footage, ~100+ = high contrast
    // Map so stdDev=50 → score≈63, stdDev=80 → score≈100
    return min(100.0, stdDev * 100.0 / 80.0)
}

// MARK: — Safe default output

func outputSafeDefaults() {
    let r = AnalysisResult(hasFace: false, isTalkingHead: false, qualityScore: 50,
                           suggestedRotation: nil, facePresenceRatio: 0.0,
                           contentTags: [], description: "", bestFrame: nil)
    if let data = try? JSONEncoder().encode(r), let str = String(data: data, encoding: .utf8) {
        print(str)
    }
}

// MARK: — Entry point

guard CommandLine.arguments.count >= 2 else {
    fputs("usage: vision-cli <video-path>\n", stderr)
    exit(1)
}

let videoPath = CommandLine.arguments[1]

guard FileManager.default.fileExists(atPath: videoPath) else {
    fputs("vision-cli: file not found: \(videoPath)\n", stderr)
    outputSafeDefaults()
    exit(0)
}

let asset    = AVURLAsset(url: URL(fileURLWithPath: videoPath),
                          options: [AVURLAssetPreferPreciseDurationAndTimingKey: false])
let duration = CMTimeGetSeconds(asset.duration)

guard duration > 0.1 else {
    fputs("vision-cli: could not determine duration for \(videoPath)\n", stderr)
    outputSafeDefaults()
    exit(0)
}

// Rotation — read from the first video track's preferredTransform
var rotation: Int? = nil
if let track = asset.tracks(withMediaType: .video).first {
    rotation = videoRotation(from: track.preferredTransform)
    // 0° is the identity — we still return it so callers know we succeeded
}

// Frame generator
// appliesPreferredTrackTransform=true delivers upright frames so face detection
// works regardless of how the device stored the raw pixels.
let gen = AVAssetImageGenerator(asset: asset)
gen.appliesPreferredTrackTransform = true
gen.maximumSize                    = CGSize(width: 512, height: 512)
gen.requestedTimeToleranceBefore   = CMTimeMakeWithSeconds(0.5, preferredTimescale: 600)
gen.requestedTimeToleranceAfter    = CMTimeMakeWithSeconds(0.5, preferredTimescale: 600)

let n     = sampleCount(for: duration)
let times = (0..<n).map { i -> CMTime in
    let t = duration * Double(i + 1) / Double(n + 1)
    return CMTimeMakeWithSeconds(t, preferredTimescale: 600)
}

// Per-frame accumulators
var faceFrames         = 0
var largeAndCentredCnt = 0
var totalSharpness     = 0.0
var sampledCount       = 0
var bestFrameIdx: Int? = nil
var bestSharp          = 0.0

for (i, t) in times.enumerated() {
    var actual = CMTime.zero
    guard let img = try? gen.copyCGImage(at: t, actualTime: &actual) else { continue }

    let face  = detectFaces(in: img)
    let sharp = qualityScore(of: img)

    totalSharpness += sharp
    sampledCount   += 1
    if sharp > bestSharp { bestSharp = sharp; bestFrameIdx = i }

    let validFace = face.count > 0
                 && face.maxConf >= FACE_CONF_MIN
                 && face.maxArea >= FACE_AREA_MIN
    if validFace {
        faceFrames += 1
        if face.hasLargeAndCentred { largeAndCentredCnt += 1 }
    }
}

// Aggregate
let total         = max(1, sampledCount)
let faceRatio     = Double(faceFrames)         / Double(total)
let largeRatio    = Double(largeAndCentredCnt) / Double(total)
let avgSharp      = sampledCount > 0 ? totalSharpness / Double(sampledCount) : 50.0
let hasFace       = faceRatio  >= HASFAACE_RATIO
let isTalkingHead = faceRatio  >= TALKING_FACE_RATIO && largeRatio >= TALKING_LARGE_RATIO
let quality       = max(0, min(100, Int(avgSharp.rounded())))

let result = AnalysisResult(
    hasFace:           hasFace,
    isTalkingHead:     isTalkingHead,
    qualityScore:      quality,
    suggestedRotation: rotation,
    facePresenceRatio: faceRatio,
    contentTags:       [],
    description:       "",
    bestFrame:         bestFrameIdx
)

if let data = try? JSONEncoder().encode(result), let str = String(data: data, encoding: .utf8) {
    print(str)
} else {
    outputSafeDefaults()
}
