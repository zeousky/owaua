const image = '(?:images?|pictures?|pics?|photos?|portraits?|illustrations?|drawings?|logos?|wallpapers?|memes?|kepe?t?|kepet|fotot)';
const video = '(?:videos?|clips?|animations?|videot?|animaciot)';
const quantities = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const article = '(?:an?|the|this|that|my|our|egy)';
const modifiers = '(?:(?:new|short|animated|realistic|photorealistic|simple|cartoon|attached|same)\\s+)*';
const objectEnd = '(?=$|[,.!?;:]|\\s+(?:of|about|for|from|with|using|showing|featuring|that|in|at|as|and|egy|a|az)\\b)';
const object = noun => new RegExp(`^(?:me\\s+)?(?:${article}\\s+)?(?:(\\d+|${quantities.join('|')})\\s+)?${modifiers}${noun}\\b${objectEnd}`);
const imageObject = object(image);
const videoObject = object(video);
const create = /^(?:make|create|generate|draw|paint|render|design|produce|keszits|generalj|rajzolj|csinalj)\s+/;
const want = /^(?:i want|i'd like|id like|i need|szeretnek)\b/;
const edit = noun => new RegExp(`^(?:edit|change|crop|resize|recolor|modosits|valtoztasd)\\s+(?:${article}\\s+)?${modifiers}${noun}\\b(?=$|[,.!?;:]|\\s+(?:to|by|so|with|in|from|egy|a|az)\\b)`);
const editImage = edit(image), editVideo = edit(video);
const visualChange = /^(?:(?:remove|blur)\s+(?:(?:the|this|its)\s+)?(?:background|foreground|sky)|(?:make|change|recolor)\s+(?:(?:the|this|its)\s+)?(?:background|foreground|lighting|colors?|sky)\s+(?:to\s+)?(?:black|white|gray|grey|red|orange|yellow|green|blue|purple|pink|brown|transparent|grayscale))(?:\s+please)?[.!?]?$/;
const animateImage = new RegExp(`^animate\\s+(?:(?:this|that|it)(?=$|[,.!?;:]|\\s+(?:with|into|by|so|in)\\b)|(?:${article}\\s+)?${modifiers}${image}\\b${objectEnd})`);
const extendVideo = new RegExp(`^(?:extend|continue|lengthen)\\s+(?:(?:this|that|it)(?=$|[,.!?;:]|\\s+(?:by|for|with|so)\\b)|(?:${article}\\s+)?${modifiers}${video}\\b(?=$|[,.!?;:]|\\s+(?:by|for|with|so)\\b))`);
const customSettings = new RegExp(`\\b(?:2k|480p|1080p|\\d{1,2}:\\d{1,2}|(?:low|auto) quality|(?:lite|standard|classic) model|(?:\\d+|${quantities.join('|')})[-\\s]*(?:s|secs?|seconds?))\\b`);

// Only the current Discord message can skip review. The final provider payload
// must also stay within the settings authorized by that message.
export function requestsMedia(kind, text, { images = [], videos = [], proposal } = {}) {
  if (typeof text !== 'string') return false;
  const request = text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/```[\s\S]*?```|`[^`]*`|"[^"]*"|“[^”]*”|‘[^’]*’|(?<!\w)'[^'\n]*'(?!\w)/g, ' ')
    .replace(/’/g, "'")
    .replace(/^\s*(?:hey\s+)?(?:owaua[,!:]?\s+)?/, '').trim();
  if (/\b(?:don't|dont|do not|never|not (?:yet|now)|unless|if|maybe|perhaps|instead of|rather than|only after|(?:after|before|until|once|when) (?:i|my|we|you)|ask (?:me )?first|confirm(?:ation)? first|wait|hold off|just kidding|ne|nem)\b/.test(request)) return false;
  const direct = request.replace(/^(?:(?:please|pls|plz|just)\s+|(?:can|could|would|will)\s+(?:you|u)\s+|(?:i want|i'd like|id like|i need)\s+(?:you to\s+)?|(?:szeretnek|kerlek|tudnal)\s+)*/, '');
  const isVideo = kind.includes('video');
  let count = 1;
  let authorized;
  if (kind === 'image' || kind === 'video') {
    const verb = direct.match(create);
    const target = verb ? direct.slice(verb[0].length) : want.test(request) ? direct : '';
    const match = target.match(isVideo ? videoObject : imageObject);
    count = match?.[1] ? (/^\d+$/.test(match[1]) ? Number(match[1]) : quantities.indexOf(match[1]) + 1) : 1;
    authorized = Boolean(match) || isVideo && images.length > 0 && animateImage.test(direct);
  } else if (kind === 'extend_video') {
    authorized = videos.length > 0 && extendVideo.test(direct);
  } else {
    authorized = (isVideo ? videos : images).length > 0 &&
      ((isVideo ? editVideo : editImage).test(direct) || visualChange.test(direct));
  }
  return authorized && (!proposal || !customSettings.test(direct) && defaultSettings(kind, proposal, count));
}

function defaultSettings(kind, body, count) {
  if (!kind.includes('video')) {
    return body.n === count && body.quality === 'medium' && body.resolution === '1k' && body.aspect_ratio === undefined;
  }
  if (kind === 'edit_video') return true;
  if (kind === 'extend_video') return body.duration === 6;
  const defaultModel = body.reference_images?.length > 1 ? 'grok-imagine-video-1.5' : 'grok-imagine-video-1.5-lite';
  return body.model === defaultModel && body.duration === 6 && body.resolution === '720p' &&
    (body.aspect_ratio === undefined || body.aspect_ratio === '16:9');
}
