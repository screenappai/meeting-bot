export type ProviderType =
  | 'S3'
  | 'S3:plugin'
  | 'S3:request'
  | 'IDB'
  | 'static'
  | 'S3:team';
export type LibraryTabType = 'personal' | 'plugin' | 'public' | 'team';

export interface FileSystemEntityType {
  type: 'File' | 'Folder';
  _id: string;
  teamId?: string;
  ownerId?: string;
  spaceId?: string;
  name: string;
  provider: ProviderType;
  createdAt: Date;
  updatedAt?: Date;
  parentId: null | string;
}

export type AVMediaType = 'audio' | 'video';

export interface FolderType extends FileSystemEntityType {
  type: 'Folder';
}

export interface Member {
  _id: string;
  email: string;
  name: string;
  picture: string;
  status: boolean;
  role: string;
  createdAt: string;
  inviteAccepted: boolean;
  unregistered: boolean;
  lastActiveAt: string;
  updatedAt: string;
  spaceInvited?: string;
  spaceFolderId?: string;
}

export type Speaker = Pick<Member, 'name' | 'picture' | 'email'> & {
  userId: string;
};

export interface TranscriptDataProps {
  transcriptRequestedAt?: string;
  transcriptCompletedAt?: string;
  transcriptProviderKey?: string;
  transcriptUrl?: string;
  vttSubtitlesProviderKey?: string;
  vttSubtitlesUrl?: string;
  speakers?: {
    [key: string]: Speaker;
  };
}

export type ProfileType = 'webm' | 'mp4' | 'mkv' | 'mp3' | 'wav';

export type SharePermission = 'askAi' | 'transcript' | 'summary' | 'download';
export interface ShareDetails {
  shareId: string;
  expirationDate?: Date;
  permissions?: SharePermission[];
}

export interface FileType extends FileSystemEntityType {
  type: 'File';
  description?: string;
  size: number;
  providerKey: string;
  url?: string;
  thumbProviderKey?: string;
  thumbUrl?: string;
  duration?: number;
  recordingId?: string;
  streams?: AVMediaType[];
  defaultProfile?: ProfileType;
  teamId: string;
  spaceId: string;
  alternativeFormats?: {
    [key in ProfileType]: {
      size: number;
      providerKey: string;
      url: string;
      createdAt: Date;
      updatedAt: Date;
    };
  };
  recorderEmail: string;
  recorderName: string;
  textData?: TranscriptDataProps;
  owner: {
    name: string;
    picture: string;
  };
  share?: ShareDetails;
}

export interface IVFSResponse<T> {
  success: boolean;
  data: T;
  message?: string;
}

export type ContentType =
  | 'video/webm'
  | 'video/mp4'
  | 'video/x-matroska'
  | 'audio/mpeg'
  | 'audio/wav';

export interface WaitPromise {
  promise: Promise<void>;
  resolveEarly: (value: void | PromiseLike<void>) => void;
}
export type BotStatus = 'processing' | 'joined' | 'finished' | 'failed';
export type WaitingAtLobbyCategory = {
  category: 'WaitingAtLobby',
  subCategory: 'Timeout' | 'StuckInLobby' | 'UserDeniedRequest',
}
