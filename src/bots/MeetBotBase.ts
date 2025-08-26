import { Page } from 'playwright';
import { AbstractMeetBot, JoinParams } from './AbstractMeetBot';
import { UnsupportedMeetingError, WaitingAtLobbyError } from '../error';
import { addBotLog } from '../services/botService';
import { Logger } from 'winston';
import { LogSubCategory, UnsupportedMeetingCategory, WaitingAtLobbyCategory } from '../types';
import { GOOGLE_REQUEST_DENIED, MICROSOFT_REQUEST_DENIED, ZOOM_REQUEST_DENIED } from '../constants';

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
  const getSubCategory = (provider: 'google' | 'microsoft' | 'zoom', bodytext: string | undefined | null): WaitingAtLobbyCategory['subCategory'] => {
    switch (provider) {
      case 'google':
        return bodytext?.includes(GOOGLE_REQUEST_DENIED) ? 'UserDeniedRequest' : 'Timeout';
      case 'microsoft':
        return bodytext?.includes(MICROSOFT_REQUEST_DENIED) ? 'UserDeniedRequest' : 'Timeout';
      case 'zoom':
        return bodytext?.includes(ZOOM_REQUEST_DENIED) ? 'UserDeniedRequest' : 'Timeout';
      default:
        return 'Timeout';
    }
  };

  const bodytext = error.documentBodyText;
  const subCategory = getSubCategory(provider, bodytext);

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

export const handleUnsupportedMeetingError = async ({
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
  error: UnsupportedMeetingError,
}, logger: Logger) => {
  const getSubCategory = (error: UnsupportedMeetingError): null | LogSubCategory<'UnsupportedMeeting'> => {
    if (error.googleMeetPageStatus === 'SIGN_IN_PAGE') {
      return 'RequiresSignIn';
    }
    return null;
  };

  const category: UnsupportedMeetingCategory['category'] = 'UnsupportedMeeting';
  const subCategory = getSubCategory(error);
  if (!subCategory) {
    return;
  }

  const result = await addBotLog({
    level: 'error',
    message: error.message,
    provider,
    token,
    botId,
    eventId,
    category,
    subCategory: subCategory,
  }, logger);
  return result;
};
