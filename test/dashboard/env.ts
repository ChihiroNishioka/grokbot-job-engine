import { validEnv } from '../helpers/context.js';

export const dashboardToken = 'dummy-dashboard-token-'.repeat(2);
export const aliasKey = 'dummy-dashboard-alias-key-'.repeat(2);
export const dashboardEnv = {
  ...validEnv,
  DASHBOARD_TOKEN: dashboardToken,
  DASHBOARD_ALIAS_KEY: aliasKey,
  DASHBOARD_ALIASES: '{}',
};
