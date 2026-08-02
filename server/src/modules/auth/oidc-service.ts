import * as oidc from 'openid-client'

import type { AuthConfig } from '../../config/env.js'
import { type Clock, ValueCipher } from '../users/crypto.js'
import { assertDomain, DomainError } from '../users/errors.js'

interface OidcTransaction {
  state: string
  nonce: string
  codeVerifier: string
  expiresAt: string
}

export class OidcService {
  private configurationPromise: Promise<oidc.Configuration> | null = null

  constructor(
    private readonly config: Extract<AuthConfig, { mode: 'oidc' }>,
    private readonly publicUrl: string,
    private readonly cipher: ValueCipher,
    private readonly clock: Clock,
  ) {}

  async begin(): Promise<{ redirectUrl: string; transactionCookie: string }> {
    const configuration = await this.configuration()
    const codeVerifier = oidc.randomPKCECodeVerifier()
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier)
    const state = oidc.randomState()
    const nonce = oidc.randomNonce()
    const redirectUri = new URL('/api/auth/callback', this.publicUrl).toString()
    const redirectUrl = oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: this.config.scopes,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    })
    const transaction: OidcTransaction = {
      state,
      nonce,
      codeVerifier,
      expiresAt: new Date(this.clock.now().getTime() + 10 * 60_000).toISOString(),
    }
    const sealed = this.cipher.seal(JSON.stringify(transaction), 'oidc-login-transaction')
    return {
      redirectUrl: redirectUrl.toString(),
      transactionCookie: `${sealed.nonce}.${sealed.ciphertext}`,
    }
  }

  async complete(
    currentUrl: URL,
    cookie: string | undefined,
  ): Promise<{ provider: string; subject: string; mfaAuthenticated: boolean }> {
    assertDomain(cookie, 'OIDC_TRANSACTION_MISSING', 401, 'OIDC 登录事务不存在或已过期')
    const separator = cookie.indexOf('.')
    assertDomain(separator > 0, 'OIDC_TRANSACTION_INVALID', 401, 'OIDC 登录事务无效')
    const serialized = this.cipher.open(
      { nonce: cookie.slice(0, separator), ciphertext: cookie.slice(separator + 1) },
      'oidc-login-transaction',
    )
    let transaction: OidcTransaction
    try {
      transaction = JSON.parse(serialized) as OidcTransaction
    } catch {
      throw new DomainError('OIDC_TRANSACTION_INVALID', 401, 'OIDC 登录事务无效')
    }
    assertDomain(
      Date.parse(transaction.expiresAt) >= this.clock.now().getTime(),
      'OIDC_TRANSACTION_EXPIRED',
      401,
      'OIDC 登录事务已过期',
    )
    const tokens = await oidc.authorizationCodeGrant(await this.configuration(), currentUrl, {
      pkceCodeVerifier: transaction.codeVerifier,
      expectedState: transaction.state,
      expectedNonce: transaction.nonce,
      idTokenExpected: true,
    })
    const claims = tokens.claims()
    assertDomain(claims?.sub, 'OIDC_SUBJECT_MISSING', 401, 'OIDC ID Token 缺少 subject')
    const authenticationMethods = Array.isArray(claims.amr) ? claims.amr : []
    return {
      provider: this.config.providerName,
      subject: claims.sub,
      mfaAuthenticated: authenticationMethods.includes('mfa'),
    }
  }

  private configuration(): Promise<oidc.Configuration> {
    if (!this.configurationPromise) {
      this.configurationPromise = oidc.discovery(
        new URL(this.config.issuer),
        this.config.clientId,
        this.config.clientSecret || undefined,
      )
    }
    return this.configurationPromise
  }
}
