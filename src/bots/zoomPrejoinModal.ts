import type { Frame, Page } from 'playwright';

type ZoomPrejoinRoot = Frame | Page;

type ZoomOptionalMediaPromptKind = 'see' | 'hear';

const OPTIONAL_MEDIA_PROMPTS: Record<ZoomOptionalMediaPromptKind, RegExp> = {
  see: /Do you want people to see you in the meeting\?/i,
  hear: /Do you want people to hear you in the meeting\?/i,
};
const OPTIONAL_MEDIA_PROMPT = /Do you want people to (?:see|hear) you in the meeting\?/i;
const CONTINUE_WITHOUT_MEDIA = /^(?:Continue without microphone and camera|Ohne Mikrofon und Kamera fortfahren)$/i;
const NEXT_OPTIONAL_MEDIA_PROMPT_TIMEOUT = 1_500;
const ZOOM_JOIN_CLICK_ATTEMPTS = 3;

const getZoomOptionalMediaPromptKind = (text: string): ZoomOptionalMediaPromptKind | undefined =>
  (Object.keys(OPTIONAL_MEDIA_PROMPTS) as ZoomOptionalMediaPromptKind[])
    .find(kind => OPTIONAL_MEDIA_PROMPTS[kind].test(text));

export const isZoomOptionalMediaPromptText = (text?: string | null): boolean => {
  const promptText = text ?? '';
  return getZoomOptionalMediaPromptKind(promptText) !== undefined
    && /microphone and camera/i.test(promptText)
    && /Continue without microphone and camera/i.test(promptText);
};

export async function dismissZoomOptionalMediaPrompt(
  root: ZoomPrejoinRoot,
  timeout = 2_500,
): Promise<boolean> {
  const overlays = root.locator('.ReactModal__Overlay.ReactModal__Overlay--after-open');
  const prompt = overlays
    .filter({ hasText: OPTIONAL_MEDIA_PROMPT })
    .last();

  if (!await prompt
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false)) return false;

  const dismissedKinds = new Set<ZoomOptionalMediaPromptKind>();
  let dismissed = false;
  let currentPrompt = prompt;

  for (let attempt = 0; attempt < Object.keys(OPTIONAL_MEDIA_PROMPTS).length; attempt += 1) {
    const promptText = await currentPrompt.innerText().catch(() => '');
    const promptKind = getZoomOptionalMediaPromptKind(promptText);
    if (!promptKind || !isZoomOptionalMediaPromptText(promptText)) return dismissed;

    const continueWithoutMedia = overlays
      .filter({ hasText: OPTIONAL_MEDIA_PROMPTS[promptKind] })
      .last()
      .getByRole('button', { name: CONTINUE_WITHOUT_MEDIA })
      .first();
    if (!await continueWithoutMedia
      .waitFor({ state: 'visible', timeout: 1_000 })
      .then(() => true)
      .catch(() => false)) return dismissed;
    if (dismissedKinds.has(promptKind)) return false;

    if (!await continueWithoutMedia
      .click()
      .then(() => true)
      .catch(() => false)) return false;
    const didDismiss = await continueWithoutMedia
      .waitFor({ state: 'hidden', timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!didDismiss) return false;

    dismissedKinds.add(promptKind);
    dismissed = true;
    if (attempt === Object.keys(OPTIONAL_MEDIA_PROMPTS).length - 1) return true;

    const nextPromptKind = (Object.keys(OPTIONAL_MEDIA_PROMPTS) as ZoomOptionalMediaPromptKind[])
      .find(kind => !dismissedKinds.has(kind));
    if (!nextPromptKind) return true;

    currentPrompt = overlays
      .filter({ hasText: OPTIONAL_MEDIA_PROMPTS[nextPromptKind] })
      .last();
    const nextPromptIsVisible = await currentPrompt
        .waitFor({ state: 'visible', timeout: NEXT_OPTIONAL_MEDIA_PROMPT_TIMEOUT })
        .then(() => true)
        .catch(() => false);
    if (!nextPromptIsVisible) return true;
  }

  return dismissed;
}

export async function clickZoomJoinWithOptionalMediaPromptRetry(
  root: ZoomPrejoinRoot,
  clickJoin: () => Promise<void>,
): Promise<void> {
  for (let attempt = 0; attempt < ZOOM_JOIN_CLICK_ATTEMPTS; attempt += 1) {
    try {
      await clickJoin();
      return;
    } catch (clickError) {
      if (attempt === ZOOM_JOIN_CLICK_ATTEMPTS - 1) throw clickError;
      if (!await dismissZoomOptionalMediaPrompt(root, 1_000).catch(() => false)) {
        throw clickError;
      }
    }
  }
}
