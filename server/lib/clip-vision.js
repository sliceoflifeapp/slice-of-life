// Vision router — always uses Claude Vision backend.
// Apple Vision (vision-cli Swift binary) was removed; may be revisited later.
//
// Returns: { isTalkingHead, hasFace, qualityScore, contentTags, description,
//            suggestedRotation, facePresenceRatio, bestFrame, _source }

async function analyzeClip(clip, opts = {}) {
  return require('./clip-vision-claude').analyzeClip(clip, opts);
}

// No-op kept so api.js resetBackendCache() call doesn't throw.
function resetBackendCache() {}

module.exports = { analyzeClip, resetBackendCache };
