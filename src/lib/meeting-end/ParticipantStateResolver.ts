import { Page } from 'playwright';
import { Logger } from 'winston';
import { ParticipantState } from './types';

type ParticipantStrategy = () => Promise<ParticipantState>;

class ParticipantStateResolver {
  private strategies: ParticipantStrategy[] = [];
  private page: Page;
  private logger: Logger;

  constructor(page: Page, logger: Logger) {
    this.page = page;
    this.logger = logger;
    this.strategies = [
      this.removalDetectionStrategy.bind(this),
      this.peopleButtonCountStrategy.bind(this),
      this.buttonTextScanStrategy.bind(this),
      this.leaveCallButtonAbsentStrategy.bind(this),
    ];
  }

  addStrategy(strategy: ParticipantStrategy): void {
    this.strategies.push(strategy);
  }

  async resolve(): Promise<ParticipantState> {
    for (let i = 0; i < this.strategies.length; i++) {
      try {
        const result = await this.strategies[i]();
        this.logger.debug('participant_strategy_result', { strategyIndex: i, result });
        if (result === 'participants_present' || result === 'alone_confirmed' || result === 'removed_from_meeting' || result === 'page_state_changed') {
          this.logger.info('participant_state', { state: result });
          return result;
        }
      } catch (err) {
        this.logger.warn('participant_strategy_error', { strategyIndex: i, error: err });
      }
    }
    this.logger.info('participant_state', { state: 'unknown' });
    return 'unknown';
  }

  private async peopleButtonCountStrategy(): Promise<ParticipantState> {
    const result = await this.page.evaluate(() => {
      const btn = document.querySelector('button[aria-label*="People"]') as HTMLElement | null;
      if (!btn) return null;
      const label = btn.getAttribute('aria-label') || '';
      const match = label.match(/(\d+)/);
      if (!match) return null;
      return parseInt(match[1], 10);
    });

    if (result === null) return 'unknown';
    return result >= 2 ? 'participants_present' : 'alone_confirmed';
  }

  private async buttonTextScanStrategy(): Promise<ParticipantState> {
    const result = await this.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const pattern = /(\d+)\s*(participant|people|joined)/i;
      for (const btn of buttons) {
        const text = (btn.textContent || '') + ' ' + (btn.getAttribute('aria-label') || '');
        const match = text.match(pattern);
        if (match) return parseInt(match[1], 10);
      }
      return null;
    });

    if (result === null) return 'unknown';
    return result >= 2 ? 'participants_present' : 'unknown';
  }

  private async removalDetectionStrategy(): Promise<ParticipantState> {
    const removed = await this.page.evaluate(() => {
      const text = document.body.innerText;
      return (
        text.includes('You\'ve been removed from the meeting') ||
        text.includes('No one responded to your request to join the call')
      );
    });

    return removed ? 'removed_from_meeting' : 'unknown';
  }

  private async leaveCallButtonAbsentStrategy(): Promise<ParticipantState> {
    const present = await this.page.evaluate(() => {
      return !!document.querySelector('button[aria-label="Leave call"]');
    });

    if (present) {
      return 'unknown';
    }

    const pageStateChanged = await this.page.evaluate(() => {
      const bodyText = document.body.innerText;
      const hasMeetingEndedUI = bodyText.includes('No one else is here') ||
                                bodyText.includes('The meeting has ended') ||
                                bodyText.includes('You left the meeting') ||
                                bodyText.includes('Return to home screen');
      const hasMeetingsListPattern = bodyText.includes('You can now return to the meeting summary') ||
                                     bodyText.includes('Back to home');
      return hasMeetingEndedUI || hasMeetingsListPattern;
    });

    return pageStateChanged ? 'page_state_changed' : 'unknown';
  }
}

export { ParticipantStateResolver };
export type { ParticipantStrategy };
