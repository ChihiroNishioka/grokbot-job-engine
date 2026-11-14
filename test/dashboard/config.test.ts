import { describe, expect, test } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/index.js';
import { aliasKey, dashboardEnv, dashboardToken } from './env.js';

describe('dashboard configuration', () => {
  test('D01 requires long dashboard token and alias key values without leaking them', () => {
    for (const key of ['DASHBOARD_TOKEN', 'DASHBOARD_ALIAS_KEY']) {
      for (const value of [undefined, '', 'short-dummy', 'x'.repeat(31)]) {
        const env = { ...dashboardEnv, [key]: value };
        expect(() => loadConfig(env)).toThrow(ConfigError);
        try { loadConfig(env); } catch (error) {
          if (error instanceof Error && value) expect(error.message).not.toContain(value);
        }
      }
    }
    expect(loadConfig(dashboardEnv)).toMatchObject({ DASHBOARD_TOKEN: dashboardToken, DASHBOARD_ALIAS_KEY: aliasKey });
  });

  test('D02 keeps dashboard credentials distinct from Job API and Genie', () => {
    for (const env of [
      { ...dashboardEnv, DASHBOARD_TOKEN: dashboardEnv.JOB_API_TOKEN },
      { ...dashboardEnv, DASHBOARD_TOKEN: dashboardEnv.GENIE_TOKEN },
      { ...dashboardEnv, DASHBOARD_ALIAS_KEY: dashboardEnv.JOB_API_TOKEN },
      { ...dashboardEnv, DASHBOARD_ALIAS_KEY: dashboardEnv.GENIE_TOKEN },
      { ...dashboardEnv, DASHBOARD_ALIAS_KEY: dashboardEnv.DASHBOARD_TOKEN },
    ]) expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  test('D03 validates dashboard loopback host and unique port defaults', () => {
    expect(loadConfig(dashboardEnv)).toMatchObject({ DASHBOARD_HOST: '127.0.0.1', DASHBOARD_PORT: 3322 });
    for (const DASHBOARD_HOST of ['0.0.0.0', '192.0.2.1', 'example.com']) {
      expect(() => loadConfig({ ...dashboardEnv, DASHBOARD_HOST })).toThrow(ConfigError);
    }
    for (const DASHBOARD_HOST of ['127.0.0.1', '::1', 'localhost']) {
      expect(loadConfig({ ...dashboardEnv, DASHBOARD_HOST }).DASHBOARD_HOST).toBe(DASHBOARD_HOST);
    }
    for (const DASHBOARD_PORT of ['0', '65536', 'bad', '3320', '3321']) {
      expect(() => loadConfig({ ...dashboardEnv, DASHBOARD_PORT })).toThrow(ConfigError);
    }
  });

  test('D36 accepts only unique family aliases keyed by lowercase HMAC hex', () => {
    const hmac = 'a'.repeat(64);
    expect(loadConfig({ ...dashboardEnv, DASHBOARD_ALIASES: JSON.stringify({ [hmac]: '家族A' }) }).DASHBOARD_ALIASES).toEqual({ [hmac]: '家族A' });
    for (const aliases of ['[', JSON.stringify({ ['A'.repeat(64)]: '家族A' }), JSON.stringify({ [hmac]: '本人' }), JSON.stringify({ [hmac]: '家族1' }), JSON.stringify({ [hmac]: '家族A', ['b'.repeat(64)]: '家族A' })]) {
      expect(() => loadConfig({ ...dashboardEnv, DASHBOARD_ALIASES: aliases })).toThrow(ConfigError);
    }
  });
});
