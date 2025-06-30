import axios from 'axios';
import config from '../config';

const baseURLV2 = config.authBaseUrlV2;

export const createApiV2 = (token: string, serviceKey?: string) => 
  axios.create({
    baseURL: baseURLV2,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(serviceKey && { 'x-sa-api-key': serviceKey }),
    },
  });
