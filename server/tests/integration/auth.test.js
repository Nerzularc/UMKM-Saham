import { describe, it, expect, afterAll } from '@jest/globals';
import { anon, login, query, closePool, PASSWORD } from '../helpers/api.js';
import { totp } from '../../src/utils/totp.js';

afterAll(closePool);

describe('authentication and sessions', () => {
  it('logs in with an HTTP-only session cookie and never returns the token in the body', async () => {
    const res = await anon().post('/api/v1/auth/login').send({ email: 'owner@demo.local', password: PASSWORD });
    expect(res.status).toBe(200);
    const cookies = res.headers['set-cookie'].join(';');
    expect(cookies).toMatch(/token=.*HttpOnly/i);
    expect(cookies).toMatch(/SameSite=Lax/i);
    expect(JSON.stringify(res.body)).not.toMatch(/eyJ/); // no JWT in the body
    expect(res.body.data.user.memberships.length).toBeGreaterThan(0);
  });

  it('rejects wrong passwords with a generic message and records the failure', async () => {
    const res = await anon().post('/api/v1/auth/login').send({ email: 'owner@demo.local', password: 'wrong-password1' });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid email or password.');
    const { rows } = await query("SELECT 1 FROM audit_events WHERE action = 'auth.login_failed' AND actor_email = 'owner@demo.local'");
    expect(rows.length).toBeGreaterThan(0);
  });

  it('reports the session state without an error status', async () => {
    const out = await anon().get('/api/v1/auth/session');
    expect(out.status).toBe(200);
    expect(out.body.data.user).toBeNull();
    const c = await login('owner@demo.local');
    const inn = await c.get('/api/v1/auth/session');
    expect(inn.body.data.user.email).toBe('owner@demo.local');
    const bogus = await anon().get('/api/v1/auth/session').set('Cookie', 'token=garbage');
    expect(bogus.status).toBe(200);
    expect(bogus.body.data.user).toBeNull();
  });

  it('returns the current user from /auth/me', async () => {
    const c = await login('manager@demo.local');
    const res = await c.get('/api/v1/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe('manager@demo.local');
  });

  it('requires a CSRF token for cookie-authenticated state changes', async () => {
    const c = await login('personal@demo.local');
    const noCsrf = await anon().post('/api/v1/watchlists').set('Cookie', c.cookie).send({ name: 'x' });
    expect(noCsrf.status).toBe(403);
    const wrongCsrf = await anon().post('/api/v1/watchlists').set('Cookie', c.cookie).set('X-CSRF-Token', 'nope').send({ name: 'x' });
    expect(wrongCsrf.status).toBe(403);
    const ok = await c.post('/api/v1/watchlists').send({ name: 'CSRF ok' });
    expect(ok.status).toBe(201);
  });

  it('accepts bearer tokens (non-browser clients) without CSRF', async () => {
    const c = await login('personal@demo.local');
    const res = await anon().post('/api/v1/watchlists').set('Authorization', `Bearer ${c.token}`).send({ name: 'Bearer list' });
    expect(res.status).toBe(201);
  });

  it('invalidates the session on logout', async () => {
    const c = await login('staff@demo.local');
    expect((await c.post('/api/v1/auth/logout')).status).toBe(200);
    const after = await c.get('/api/v1/auth/me');
    expect(after.status).toBe(401);
  });

  it('locks an account after repeated failures', async () => {
    const email = `lock-${Date.now()}@example.com`;
    expect((await anon().post('/api/v1/auth/register').send({ email, password: 'Secret123', fullName: 'Lock Test' })).status).toBe(201);
    for (let i = 0; i < 5; i++) await anon().post('/api/v1/auth/login').send({ email, password: 'Wrong1234' });
    const res = await anon().post('/api/v1/auth/login').send({ email, password: 'Secret123' });
    expect(res.status).toBe(423);
  });

  it('validates registration input and rejects duplicates', async () => {
    expect((await anon().post('/api/v1/auth/register').send({ email: 'bad', password: 'x', fullName: '' })).status).toBe(422);
    expect((await anon().post('/api/v1/auth/register').send({ email: 'owner@demo.local', password: 'Secret123', fullName: 'Dup' })).status).toBe(409);
  });

  it('supports TOTP two-factor authentication', async () => {
    const email = `tfa-${Date.now()}@example.com`;
    await anon().post('/api/v1/auth/register').send({ email, password: 'Secret123', fullName: 'Two Factor' });
    const c = await login(email, 'Secret123');
    const setup = await c.post('/api/v1/auth/2fa/setup');
    expect(setup.status).toBe(200);
    const { secret, otpauthUri } = setup.body.data;
    expect(otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect((await c.post('/api/v1/auth/2fa/enable').send({ code: '000000' })).status).toBe(400);
    expect((await c.post('/api/v1/auth/2fa/enable').send({ code: totp(secret) })).status).toBe(200);

    const noCode = await anon().post('/api/v1/auth/login').send({ email, password: 'Secret123' });
    expect(noCode.status).toBe(401);
    expect(noCode.body.code).toBe('TOTP_REQUIRED');
    const withCode = await anon().post('/api/v1/auth/login').send({ email, password: 'Secret123', totp: totp(secret) });
    expect(withCode.status).toBe(200);
    const { rows } = await query('SELECT two_factor_secret FROM users WHERE email = $1', [email]);
    expect(rows[0].two_factor_secret).not.toContain(secret); // stored encrypted
  });

  it('changing the password revokes all sessions', async () => {
    const email = `pw-${Date.now()}@example.com`;
    await anon().post('/api/v1/auth/register').send({ email, password: 'Secret123', fullName: 'Password Change' });
    const a = await login(email, 'Secret123');
    const b = await login(email, 'Secret123');
    expect((await a.post('/api/v1/auth/password').send({ currentPassword: 'Secret123', newPassword: 'Newpass456' })).status).toBe(200);
    expect((await b.get('/api/v1/auth/me')).status).toBe(401);
    await login(email, 'Newpass456');
  });
});
