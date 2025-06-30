export const getRecordingNamePrefix = (provider: 'google' | 'microsoft' | 'zoom') => {
  switch(provider) {
    case 'google':
      return 'Google Meet Recording';
    case 'microsoft':
      return 'Microsoft Teams Recording';
    case 'zoom':
      return 'Zoom Recording';
    default:
      return 'Recording';
  }
};
