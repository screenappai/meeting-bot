import { Page } from 'playwright';
import { AbstractMeetBot, JoinParams } from './AbstractMeetBot';
import { WaitingAtLobbyError } from '../error';
import { addBotLog } from '../services/botService';
import { Logger } from 'winston';
import { WaitingAtLobbyCategory } from '../types';
import { GOOGLE_REQUEST_DENIED } from './GoogleMeetBot';

// TODO complete modularise code with implementation classes
export class MeetBotBase extends AbstractMeetBot {
  protected page: Page;
  protected slightlySecretId: string; // Use any hard-to-guess identifier
  join(params: JoinParams): Promise<void> {
    throw new Error('Function not implemented.');
  }
}

export const handleWaitingAtLobbyError = async ({
  provider,
  eventId,
  botId,
  token,
  error,
}: {
  eventId?: string,
  token: string,
  botId?: string,
  provider: 'google' | 'microsoft' | 'zoom',
  error: WaitingAtLobbyError,
}, logger: Logger) => {
  const subCategory: WaitingAtLobbyCategory['subCategory'] = 'Timeout';

  const deniedMessage = GOOGLE_REQUEST_DENIED;
  const bodytext = error.documentBodyText;
  // TODO Enable on backend deploy
  // if (bodytext?.includes(deniedMessage)) {
  //   subCategory = 'UserDeniedRequest';
  // }

  const result = await addBotLog({
    level: 'error',
    message: error.message,
    provider,
    token,
    botId,
    eventId,
    category: 'WaitingAtLobby',
    subCategory: subCategory,
  }, logger);
  return result;
};
