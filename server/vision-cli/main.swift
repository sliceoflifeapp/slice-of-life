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

// MARK: — Quality score (contrast + Laplacian sharpness via CoreGraphics)
//
// Blends two metrics via geometric mean into a 0–100 score:
//   • Contrast : luminance std-dev on a 16×16 thumbnail — penalises dark/flat clips
//   • Sharpness: Laplacian variance on a 64×64 thumbnail — penalises blurry/motion-blur
//
// Geometric mean forces a clip to score well on BOTH axes.  A blurry but
// high-contrast interior shot (e.g. dark car seats + bright window) that
// previously scored well on contrast alone now receives a heavy sharpness
// penalty.  sqrt(70 * 10) ≈ 26 vs sqrt(70 * 60) ≈ 65 for a sharp equivalent.

private let THUMB_CONTRAST = 16   // small, fast contrast check
private let THUMB_SHARP    = 64   // larger thumbnail needed for Laplacian kernel

// Render cgImage to an N×N thumbnail and return Rec.601 luminance values.
func renderLuminance(_ cgImage: CGImage, size: Int) -> [Double]? {
    var raw = [UInt8](repeating: 0, count: size * size * 4)
    guard let ctx = CGContext(
        data:             &raw,
        width:            size,
        height:           size,
        bitsPerComponent: 8,
        bytesPerRow:      size * 4,
        space:            CGColorSpaceCreateDeviceRGB(),
        bitmapInfo:       CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }
    ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: size, height: size))
    return (0 ..< size * size).map { i in
        0.299 * Double(raw[i*4]) + 0.587 * Double(raw[i*4+1]) + 0.114 * Double(raw[i*4+2])
    }
}

func qualityScore(of cgImage: CGImage) -> Double {

    // ── Contrast: luminance std-dev ──────────────────────────────────────────
    var contrastScore = 50.0
    if let lum = renderLuminance(cgImage, size: THUMB_CONTRAST) {
        let n    = Double(lum.count)
        let mean = lum.reduce(0, +) / n
        let vari = lum.reduce(0.0) { $0 + ($1 - mean) * ($1 - mean) } / n
        // std≈0 = flat/dark, std≈50 → 63, std≈80 → 100
        contrastScore = min(100.0, sqrt(vari) * 100.0 / 80.0)
    }

    // ── Sharpness: Laplacian variance ────────────────────────────────────────
    // Laplacian highlights edges; its variance across the thumbnail is a
    // standard measure of focus.  Blurry or motion-blurred clips have low
    // edge content and therefore low Laplacian variance.
    var sharpScore = 50.0
    if let lum = renderLuminance(cgImage, size: THUMB_SHARP) {
        let S      = THUMB_SHARP
        let kernel: [Double] = [-1,-1,-1,  -1,8,-1,  -1,-1,-1]
        var responses = [Double]()
        responses.reserveCapacity((S - 2) * (S - 2))
        for y in 1 ..< (S - 1) {
            for x in 1 ..< (S - 1) {
                var v = 0.0
                for dy in -1...1 {
                    for dx in -1...1 {
                        v += kernel[(dy+1)*3 + (dx+1)] * lum[(y+dy)*S + (x+dx)]
                    }
                }
                responses.append(v)
            }
        }
        let n    = Double(responses.count)
        let mean = responses.reduce(0, +) / n
        let vari = responses.reduce(0.0) { $0 + ($1 - mean) * ($1 - mean) } / n
        // blurry ≈ 1–6, average ≈ 8–20, sharp ≈ 25–50+
        sharpScore = min(100.0, sqrt(vari) * 100.0 / 35.0)
    }

    // Geometric mean: both axes must score well.
    return sqrt(contrastScore * sharpScore)
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
