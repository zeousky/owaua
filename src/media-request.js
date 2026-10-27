// Only the current Discord message can skip review. Never pass history,
// transcripts, document text or model arguments to this recognizer.
export function requestsMedia(kind, text, { images = [], videos = [] } = {}) {
  if (typeof text !== 'string') return false;
  const request = text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/```[\s\S]*?```|`[^`]*`|"[^"]*"|“[^”]*”/g, ' ')
    .replace(/^\s*(?:hey\s+)?(?:owaua[,!:]?\s+)?/, '').trim();
  // Questions about generating media, negations and quoted examples are not
  // themselves requests to submit a generation.
  if (/\b(?:don't|dont|do not|never|not yet|ne|nem)\b/.test(request)) return false;
  const direct = request.replace(/^(?:(?:please|pls|plz|just)\s+|(?:can|could|would|will)\s+(?:you|u)\s+|(?:i want|i'd like|id like|i need)\s+(?:you to\s+)?|(?:szeretnek|kerlek|tudnal)\s+)*/, '');
  if (/^(?:how|explain|summarize|translate|example)\b/.test(direct) ||
    /^(?:make|create|generate|write)\s+(?:(?:me|an?|some|the)\s+)*(?:code|script|prompt|example|instructions|tutorial)\b/.test(direct)) return false;
  const image = /\b(?:images?|pictures?|pics?|photos?|portraits?|illustrations?|drawings?|logos?|wallpapers?|memes?|kepe?t?|kepet|fotot)\b/;
  const video = /\b(?:videos?|clips?|animations?|videot?|videot|animaciot)\b/;
  const create = /^(?:make|create|generate|draw|paint|render|design|animate|produce|keszits|generalj|rajzolj|csinalj)\b/;
  const isVideo = kind.includes('video');
  if (kind === 'image' || kind === 'video') {
    if (create.test(direct) && (isVideo ? video : image).test(direct)) return true;
    if (!isVideo && /^(?:draw|paint|rajzolj)\b/.test(direct)) return true;
    if (isVideo && images.length && /^animate\b/.test(direct)) return true;
    return /^(?:i want|i'd like|id like|i need|szeretnek)\b/.test(request) &&
      (isVideo ? video : image).test(direct);
  }
  const sources = isVideo ? videos : images;
  return sources.length > 0 && (kind === 'extend_video'
    ? /^(?:extend|continue|lengthen)\b/.test(direct)
    : /^(?:edit|change|make|replace|remove|add|turn|put|crop|resize|recolor|animate|modosits|valtoztasd)\b/.test(direct));
}
