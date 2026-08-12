import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright';
import {
  clickZoomJoinWithOptionalMediaPromptRetry,
  dismissZoomOptionalMediaPrompt,
  isZoomOptionalMediaPromptText,
} from './zoomPrejoinModal';

type PromptKind = 'see' | 'hear';

const promptTexts: Record<PromptKind, string> = {
  see: 'Do you want people to see you in the meeting? You can still turn off your microphone and camera anytime in the meeting Continue without microphone and camera',
  hear: 'Do you want people to hear you in the meeting? You can still turn off your microphone and camera anytime in the meeting Continue without microphone and camera',
};

const createPromptRoot = (
  initialPrompt?: PromptKind,
  transition?: { from: PromptKind; to: PromptKind; delay: number },
) => {
  let activePrompt = initialPrompt;
  let buttonVisible = activePrompt !== undefined;
  let pendingTransition: Promise<void> | undefined;
  const clicks: PromptKind[] = [];

  const waitForState = async (predicate: () => boolean, timeout: number) => {
    if (predicate()) return;
    const transitionPromise = pendingTransition;
    if (!transitionPromise) throw new Error('state is not available');

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('state timed out')), timeout);
      transitionPromise.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (!predicate()) throw new Error('state is not available');
  };

  const locatorFor = (hasText: RegExp) => {
    const matchesActivePrompt = () => activePrompt !== undefined
      && hasText.test(promptTexts[activePrompt]);
    const button = {
      first: () => button,
      click: async () => {
        if (!activePrompt || !matchesActivePrompt() || !buttonVisible) {
          throw new Error('button is not visible');
        }

        const clickedPrompt = activePrompt;
        clicks.push(clickedPrompt);
        buttonVisible = false;
        if (transition && clickedPrompt === transition.from) {
          pendingTransition = new Promise(resolve => {
            setTimeout(() => {
              activePrompt = transition.to;
              buttonVisible = true;
              pendingTransition = undefined;
              resolve();
            }, transition.delay);
          });
        } else {
          activePrompt = undefined;
        }
      },
      waitFor: async ({ state, timeout = 0 }: { state: 'visible' | 'hidden'; timeout?: number }) => {
        await waitForState(
          () => state === 'visible'
            ? matchesActivePrompt() && buttonVisible
            : !matchesActivePrompt() || !buttonVisible,
          timeout
        );
      },
    };
    const locator = {
      last: () => locator,
      waitFor: async ({ state, timeout = 0 }: { state: 'visible' | 'hidden'; timeout?: number }) => {
        await waitForState(
          () => state === 'visible' ? matchesActivePrompt() : !matchesActivePrompt(),
          timeout
        );
      },
      innerText: async () => activePrompt && matchesActivePrompt()
        ? promptTexts[activePrompt]
        : '',
      getByRole: () => button,
    };
    return locator;
  };

  return {
    root: {
      locator: () => ({ filter: ({ hasText }: { hasText: RegExp }) => locatorFor(hasText) }),
    } as unknown as Page,
    clicks,
    show: (prompt: PromptKind) => {
      activePrompt = prompt;
      buttonVisible = true;
    },
  };
};

test('recognizes only the optional Zoom media permission prompt', () => {
  assert.equal(isZoomOptionalMediaPromptText(
    'Do you want people to see you in the meeting? You can still turn off your microphone and camera anytime in the meeting Continue without microphone and camera'
  ), true);
  assert.equal(isZoomOptionalMediaPromptText(
    'Do you want people to hear you in the meeting? You can still turn off your microphone and camera anytime in the meeting Continue without microphone and camera'
  ), true);
  assert.equal(isZoomOptionalMediaPromptText(
    'The host requires you to consent before joining. Continue'
  ), false);
});

test('dismisses the optional Zoom media prompt through its accessible control', async () => {
  const prompt = createPromptRoot('see');

  assert.equal(await dismissZoomOptionalMediaPrompt(prompt.root), true);
  assert.deepEqual(prompt.clicks, ['see']);
});

test('dismisses sequential prompts after a delayed stale-overlay swap', async () => {
  const prompt = createPromptRoot('see', { from: 'see', to: 'hear', delay: 350 });

  assert.equal(await dismissZoomOptionalMediaPrompt(prompt.root), true);
  assert.deepEqual(prompt.clicks, ['see', 'hear']);
});

test('does not fail when Zoom keeps the reusable modal overlay visible', async () => {
  let overlayHiddenWaits = 0;
  let buttonVisible = true;
  const button = {
    first: () => button,
    click: async () => { buttonVisible = false; },
    waitFor: async ({ state }: { state: 'visible' | 'hidden' }) => {
      if (state === 'visible' ? buttonVisible : !buttonVisible) return;
      throw new Error('button state did not match');
    },
  };
  const prompt = {
    last: () => prompt,
    innerText: async () => promptTexts.see,
    getByRole: () => button,
    waitFor: async ({ state }: { state: 'visible' | 'hidden' }) => {
      if (state === 'visible') return;
      overlayHiddenWaits += 1;
      throw new Error('overlay remained visible');
    },
  };
  const missingPrompt = {
    last: () => missingPrompt,
    waitFor: async () => { throw new Error('prompt is not visible'); },
  };
  const root = {
    locator: () => ({
      filter: ({ hasText }: { hasText: RegExp }) => ({
        last: () => hasText.test(promptTexts.hear) && !hasText.test(promptTexts.see)
          ? missingPrompt
          : prompt,
      }),
    }),
  } as unknown as Page;

  assert.equal(await dismissZoomOptionalMediaPrompt(root), true);
  assert.equal(overlayHiddenWaits, 0);
});

test('returns false instead of throwing when Zoom does not dismiss the media prompt', async () => {
  const button = {
    first: () => button,
    click: async () => undefined,
    waitFor: async ({ state }: { state: 'visible' | 'hidden' }) => {
      if (state === 'visible') return;
      throw new Error('button remained visible');
    },
  };
  const prompt = {
    last: () => prompt,
    waitFor: async () => undefined,
    innerText: async () => promptTexts.see,
    getByRole: () => button,
  };
  const root = {
    locator: () => ({ filter: () => ({ last: () => prompt }) }),
  } as unknown as Page;

  assert.equal(await dismissZoomOptionalMediaPrompt(root), false);
});

test('does not interact with an unknown Zoom modal', async () => {
  let clicks = 0;
  const button = {
    first: () => button,
    click: async () => { clicks += 1; },
  };
  const prompt = {
    last: () => prompt,
    waitFor: async () => undefined,
    innerText: async () => 'The host requires you to consent before joining. Continue',
    getByRole: () => button,
  };
  const root = {
    locator: () => ({ filter: () => ({ last: () => prompt }) }),
  } as unknown as Page;

  assert.equal(await dismissZoomOptionalMediaPrompt(root), false);
  assert.equal(clicks, 0);
});

test('retries Join after dismissing a late optional media prompt', async () => {
  const prompt = createPromptRoot();
  const clickError = new Error('media overlay intercepted the click');
  let joinAttempts = 0;

  await clickZoomJoinWithOptionalMediaPromptRetry(prompt.root, async () => {
    joinAttempts += 1;
    if (joinAttempts === 1) {
      prompt.show('hear');
      throw clickError;
    }
  });

  assert.equal(joinAttempts, 2);
  assert.deepEqual(prompt.clicks, ['hear']);
});

test('propagates the Join error when no optional media prompt was dismissed', async () => {
  const prompt = createPromptRoot();
  const clickError = new Error('Join remained disabled');
  let joinAttempts = 0;

  await assert.rejects(
    clickZoomJoinWithOptionalMediaPromptRetry(prompt.root, async () => {
      joinAttempts += 1;
      throw clickError;
    }),
    error => error === clickError
  );
  assert.equal(joinAttempts, 1);
});

test('bounds Join retries when each failed click reveals another media prompt', async () => {
  const prompt = createPromptRoot();
  const clickErrors = [
    new Error('first click failed'),
    new Error('second click failed'),
    new Error('third click failed'),
  ];
  let joinAttempts = 0;

  await assert.rejects(
    clickZoomJoinWithOptionalMediaPromptRetry(prompt.root, async () => {
      const clickError = clickErrors[joinAttempts];
      joinAttempts += 1;
      if (joinAttempts < clickErrors.length) prompt.show('hear');
      throw clickError;
    }),
    error => error === clickErrors[2]
  );
  assert.equal(joinAttempts, 3);
  assert.deepEqual(prompt.clicks, ['hear', 'hear']);
});
