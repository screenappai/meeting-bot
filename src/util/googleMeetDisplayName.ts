const DEFAULT_GOOGLE_MEET_DISPLAY_NAME = 'ScreenApp AI Notes';

const RISKY_DISPLAY_NAME_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:ai[\s-]+)?note[\s-]*taker\b/gi, 'AI Notes'],
  [/\bbot\b/gi, 'AI Notes'],
  [/\brobot\b/gi, 'AI Notes'],
];

export const getGoogleMeetDisplayName = (name?: string): string => {
  let displayName = name?.trim() || DEFAULT_GOOGLE_MEET_DISPLAY_NAME;

  for (const [pattern, replacement] of RISKY_DISPLAY_NAME_PATTERNS) {
    displayName = displayName.replace(pattern, replacement);
  }

  displayName = displayName
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();

  return displayName || DEFAULT_GOOGLE_MEET_DISPLAY_NAME;
};
