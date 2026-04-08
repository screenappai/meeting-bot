export interface RetentionDecision {
  action: 'delete_temp' | 'retain_temp';
  reason: string;
}
